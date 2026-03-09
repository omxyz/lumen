#!/usr/bin/env tsx
/**
 * Unified WebVoyager Comparison Runner: Lumen vs Stagehand vs browser-use
 *
 * Runs the same 30 tasks on all 3 frameworks with the same model and judge.
 * Task-first order: for each task, run all selected frameworks sequentially.
 *
 * Usage:
 *   npx tsx --env-file .env evals/webvoyager/run-comparison.ts
 *   FRAMEWORKS=lumen TRIALS=1 npx tsx --env-file .env evals/webvoyager/run-comparison.ts
 *   FRAMEWORKS=lumen,stagehand npx tsx --env-file .env evals/webvoyager/run-comparison.ts
 *
 * Config (env vars):
 *   MODEL=anthropic/claude-sonnet-4-6   # same model for all frameworks
 *   FRAMEWORKS=lumen,stagehand,browser-use  # comma-separated subset
 *   TRIALS=3                            # retry count per framework per task
 *   MAX_STEPS=50                        # max steps per attempt
 *   DATA_FILE=diverse_sample.jsonl      # task dataset
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";
import { lumenAdapter } from "./frameworks/lumen-adapter.js";
import { stagehandAdapter } from "./frameworks/stagehand-adapter.js";
import { browserUseAdapter } from "./frameworks/browseruse-adapter.js";
import type {
  FrameworkName,
  FrameworkAdapter,
  FrameworkAttemptResult,
  JudgedResult,
  TaskComparison,
  ComparisonReport,
  FrameworkSummary,
} from "./frameworks/types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface WebVoyagerTask {
  web_name: string;
  id: string;
  ques: string;
  web: string;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = join(__dirname, process.env.DATA_FILE ?? "diverse_sample.jsonl");
const MAX_STEPS = parseInt(process.env.MAX_STEPS ?? "50");
const TASK_TIMEOUT_MS = 600_000;
const TRIALS = parseInt(process.env.TRIALS ?? "3");
const JUDGE_MODEL = "gemini-2.5-flash";

const ALL_ADAPTERS: Record<FrameworkName, FrameworkAdapter> = {
  lumen: lumenAdapter,
  stagehand: stagehandAdapter,
  "browser-use": browserUseAdapter,
};

function resolveFrameworks(): FrameworkAdapter[] {
  const env = process.env.FRAMEWORKS ?? "lumen,stagehand,browser-use";
  const names = env.split(",").map((s) => s.trim()) as FrameworkName[];
  return names.map((n) => {
    const adapter = ALL_ADAPTERS[n];
    if (!adapter) throw new Error(`Unknown framework: ${n}`);
    return adapter;
  });
}

function resolveModelAndKey(): { model: string; apiKey: string | undefined } {
  const model = process.env.MODEL ?? "anthropic/claude-sonnet-4-6";
  const apiKey = model.startsWith("google/")
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
  return { model, apiKey };
}

// ─── Date adaptation (from run.ts) ───────────────────────────────────────────

function adaptDatesInInstruction(instruction: string): string {
  const now = new Date();
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 86400000);

  const monthNames =
    "January|February|March|April|May|June|July|August|September|October|November|December";
  const yearPattern = /\b(20(?:23|24|25))\b/g;

  const yearsFound = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = yearPattern.exec(instruction)) !== null) {
    const year = parseInt(match[1]!);
    const start = Math.max(0, match.index - 50);
    const end = Math.min(instruction.length, match.index + 50);
    const context = instruction.slice(start, end);
    if (new RegExp(monthNames, "i").test(context)) {
      yearsFound.add(year);
    }
  }

  if (yearsFound.size > 0) {
    // Original path: explicit years found — shift them forward
    const minYear = Math.min(...yearsFound);
    let yearShift = twoWeeksFromNow.getFullYear() - minYear;
    if (yearShift <= 0) return instruction;

    const monthPattern2 = new RegExp(`(${monthNames})\\s+(\\d{1,2})`, "gi");
    let earliestParsed: Date | null = null;
    while ((match = monthPattern2.exec(instruction)) !== null) {
      const d = new Date(`${match[1]} ${match[2]}, ${minYear + yearShift}`);
      if (!earliestParsed || d < earliestParsed) earliestParsed = d;
    }
    if (earliestParsed && earliestParsed < twoWeeksFromNow) yearShift++;

    let result = instruction.replace(/\b(20(?:23|24|25))\b/g, (yearStr) => {
      const year = parseInt(yearStr);
      return yearsFound.has(year) ? String(year + yearShift) : yearStr;
    });
    return result.replace(/today\s*\([^)]*\)/gi, "today");
  }

  // Fallback: no explicit years, but month+day patterns exist (e.g. "December 28th",
  // "January 1-4", "December 25-26"). Inject a future year so travel sites accept them.
  const yearlessDatePattern = new RegExp(
    `(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?`,
    "gi",
  );
  const yearlessDates: Array<{ month: string; day: number; index: number; fullMatch: string }> = [];
  while ((match = yearlessDatePattern.exec(instruction)) !== null) {
    yearlessDates.push({
      month: match[1]!,
      day: parseInt(match[2]!),
      index: match.index,
      fullMatch: match[0],
    });
  }

  if (yearlessDates.length === 0) return instruction;

  const currentYear = now.getFullYear();
  let needsYear = false;
  let targetYear = currentYear;

  for (const d of yearlessDates) {
    const dateThisYear = new Date(`${d.month} ${d.day}, ${currentYear}`);
    if (dateThisYear < twoWeeksFromNow) {
      needsYear = true;
      break;
    }
  }

  if (!needsYear) return instruction;

  targetYear = currentYear;
  for (let attempt = 0; attempt < 3; attempt++) {
    targetYear = currentYear + attempt;
    const allFuture = yearlessDates.every((d) => {
      const date = new Date(`${d.month} ${d.day}, ${targetYear}`);
      return date >= twoWeeksFromNow;
    });
    if (allFuture) break;
  }

  // Inject the target year after each year-less date
  let result = instruction;
  for (const d of [...yearlessDates].reverse()) {
    const end = d.index + d.fullMatch.length;
    const after = result.slice(end, end + 10).trim();
    if (/^,?\s*20\d{2}/.test(after)) continue;
    result = result.slice(0, end) + `, ${targetYear}` + result.slice(end);
  }

  return result.replace(/today\s*\([^)]*\)/gi, "today");
}

// ─── Dataset loading ─────────────────────────────────────────────────────────

function loadTasks(): WebVoyagerTask[] {
  const raw = readFileSync(DATA_PATH, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const task = JSON.parse(line) as WebVoyagerTask;
      task.ques = adaptDatesInInstruction(task.ques);
      return task;
    });
}

// ─── Judge (Gemini 2.5 Flash — same as run.ts) ──────────────────────────────

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
});

async function judgeResult(
  question: string,
  agentResult: string,
  screenshot?: Buffer,
): Promise<{ pass: boolean; reason: string }> {
  try {
    const systemPrompt = screenshot
      ? `You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved. You have access to a screenshot that you can use to evaluate the tasks completion. Provide detailed reasoning for your answer.\nToday's date is ${new Date().toLocaleDateString()}`
      : `You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved. You have access to the agents reasoning and actions throughout the task that you can use to evaluate the tasks completion. Provide detailed reasoning for your answer.\nToday's date is ${new Date().toLocaleDateString()}`;

    const userParts: Array<
      { text: string } | { inlineData: { mimeType: string; data: string } }
    > = [
      {
        text: `Question: Did the agent successfully complete this task: "${question}"?\n\nAgent's reasoning and actions taken:\n${agentResult}`,
      },
    ];

    if (screenshot) {
      userParts.push({
        inlineData: {
          mimeType: "image/jpeg",
          data: screenshot.toString("base64"),
        },
      });
    }

    const response = await gemini.models.generateContent({
      model: JUDGE_MODEL,
      contents: [{ role: "user", parts: userParts }],
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object" as const,
          properties: {
            evaluation: { type: "string" as const, enum: ["YES", "NO"] },
            reasoning: { type: "string" as const },
          },
          required: ["evaluation", "reasoning"],
        },
      },
    });

    const text = response.text ?? "";
    const parsed = JSON.parse(text) as { evaluation: string; reasoning: string };
    return {
      pass: parsed.evaluation === "YES",
      reason: parsed.reasoning?.slice(0, 300) ?? "No reasoning provided",
    };
  } catch (err) {
    return { pass: false, reason: `Judge error: ${String(err).slice(0, 200)}` };
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run a single framework on a task with TRIALS attempts (cross-trial feedback).
 */
async function runFrameworkOnTask(
  adapter: FrameworkAdapter,
  task: WebVoyagerTask,
  model: string,
  apiKey: string | undefined,
): Promise<JudgedResult> {
  let lastFeedback: string | undefined;

  for (let trial = 1; trial <= TRIALS; trial++) {
    let instruction = task.ques;
    if (lastFeedback && trial > 1) {
      instruction += `\n\n[IMPORTANT: A previous attempt at this task failed. The evaluator said: "${lastFeedback}". Try a DIFFERENT approach this time. If form interactions (date pickers, dropdowns) aren't working, try typing values directly into input fields, or construct a URL with the required parameters and navigate directly.]`;
    }

    let attempt: FrameworkAttemptResult;
    try {
      attempt = await adapter.run({
        instruction,
        startUrl: task.web,
        maxSteps: MAX_STEPS,
        model,
        apiKey,
        timeoutMs: TASK_TIMEOUT_MS,
      });
    } catch (err) {
      attempt = {
        framework: adapter.name,
        result: "",
        status: "error",
        steps: 0,
        tokens: 0,
        durationMs: 0,
        error: String(err),
      };
    }

    // Judge
    const judge = await judgeResult(task.ques, attempt.result, attempt.screenshot);

    // Free screenshot memory
    attempt.screenshot = undefined;

    const judged: JudgedResult = {
      ...attempt,
      judgePass: judge.pass,
      judgeReason: judge.reason,
      trial,
      taskId: task.id,
      webName: task.web_name,
      question: task.ques,
    };

    if (judge.pass || trial === TRIALS) {
      return judged;
    }

    lastFeedback = judge.reason;
    process.stdout.write(`  [${adapter.name} retry ${trial}/${TRIALS}] `);
  }

  throw new Error("Unreachable");
}

// ─── Report ──────────────────────────────────────────────────────────────────

function buildSummary(
  frameworkName: FrameworkName,
  comparisons: TaskComparison[],
): FrameworkSummary {
  const results = comparisons
    .map((c) => c.results[frameworkName])
    .filter((r): r is JudgedResult => r !== null && r !== undefined);

  const passed = results.filter((r) => r.judgePass).length;
  const nonError = results.filter((r) => r.status !== "error");

  return {
    framework: frameworkName,
    total: results.length,
    passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    avgSteps:
      nonError.length > 0
        ? Math.round((nonError.reduce((s, r) => s + r.steps, 0) / nonError.length) * 10) / 10
        : 0,
    avgTokens:
      nonError.length > 0
        ? Math.round(nonError.reduce((s, r) => s + r.tokens, 0) / nonError.length)
        : 0,
    avgDurationMs:
      nonError.length > 0
        ? Math.round(nonError.reduce((s, r) => s + r.durationMs, 0) / nonError.length)
        : 0,
  };
}

function saveReport(
  outFile: string,
  model: string,
  frameworks: FrameworkAdapter[],
  comparisons: TaskComparison[],
): void {
  const summary: Record<string, FrameworkSummary> = {};
  for (const fw of frameworks) {
    summary[fw.name] = buildSummary(fw.name, comparisons);
  }

  const report: ComparisonReport = {
    timestamp: new Date().toISOString(),
    model,
    judgeModel: JUDGE_MODEL,
    trials: TRIALS,
    frameworks: frameworks.map((f) => f.name),
    tasks: comparisons,
    summary: summary as Record<FrameworkName, FrameworkSummary>,
  };

  writeFileSync(outFile, JSON.stringify(report, null, 2));
}

function printReport(
  frameworks: FrameworkAdapter[],
  comparisons: TaskComparison[],
  model: string,
  outFile: string,
): void {
  console.log("\n" + "=".repeat(70));
  console.log("COMPARISON RESULTS");
  console.log("=".repeat(70));
  console.log(`  Model: ${model}`);
  console.log(`  Judge: ${JUDGE_MODEL}`);
  console.log(`  Tasks: ${comparisons.length}`);
  console.log(`  Trials: ${TRIALS}`);
  console.log();

  // Header row
  const fwNames = frameworks.map((f) => f.name);
  const colWidth = 16;
  const header = "  " + "".padEnd(22) + fwNames.map((n) => n.padEnd(colWidth)).join("");
  console.log(header);
  console.log("  " + "-".repeat(22 + fwNames.length * colWidth));

  // Per-task rows
  for (const comp of comparisons) {
    const label = `${comp.webName}`.padEnd(22);
    const cells = fwNames.map((fw) => {
      const r = comp.results[fw as FrameworkName];
      if (!r) return "---".padEnd(colWidth);
      if (r.status === "error") return "ERROR".padEnd(colWidth);
      const tag = r.judgePass ? "PASS" : "FAIL";
      const trialTag = r.trial > 1 ? `(t${r.trial})` : "";
      return `${tag}${trialTag}`.padEnd(colWidth);
    });
    console.log(`  ${label}${cells.join("")}`);
  }

  // Summary
  console.log("\n  " + "-".repeat(22 + fwNames.length * colWidth));
  const summaryRow = (label: string, getter: (s: FrameworkSummary) => string) => {
    const cells = fwNames.map((fw) => {
      const s = buildSummary(fw as FrameworkName, comparisons);
      return getter(s).padEnd(colWidth);
    });
    console.log(`  ${label.padEnd(22)}${cells.join("")}`);
  };

  summaryRow("Pass rate", (s) => `${(s.passRate * 100).toFixed(1)}% (${s.passed}/${s.total})`);
  summaryRow("Avg steps", (s) => String(s.avgSteps));
  summaryRow("Avg tokens", (s) => s.avgTokens.toLocaleString());
  summaryRow("Avg time", (s) => `${(s.avgDurationMs / 1000).toFixed(1)}s`);

  // Per-site breakdown per framework
  console.log("\n  Per-site breakdown:");
  const sites = [...new Set(comparisons.map((c) => c.webName))].sort();
  for (const site of sites) {
    const siteTasks = comparisons.filter((c) => c.webName === site);
    const cells = fwNames.map((fw) => {
      const results = siteTasks
        .map((c) => c.results[fw as FrameworkName])
        .filter((r): r is JudgedResult => r != null);
      const passed = results.filter((r) => r.judgePass).length;
      return `${passed}/${results.length}`.padEnd(colWidth);
    });
    console.log(`    ${site.padEnd(20)}${cells.join("")}`);
  }

  console.log(`\nReport saved: ${outFile}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const tasks = loadTasks();
  const frameworks = resolveFrameworks();
  const { model, apiKey } = resolveModelAndKey();

  const siteDistribution = new Map<string, number>();
  for (const t of tasks) {
    siteDistribution.set(t.web_name, (siteDistribution.get(t.web_name) ?? 0) + 1);
  }

  console.log("WebVoyager Comparison: " + frameworks.map((f) => f.name).join(" vs "));
  console.log(`  Model: ${model}`);
  console.log(`  Judge: ${JUDGE_MODEL}`);
  console.log(`  Tasks: ${tasks.length}`);
  console.log(`  Sites: ${[...siteDistribution.entries()].map(([s, n]) => `${s}(${n})`).join(", ")}`);
  console.log(`  Trials per task: ${TRIALS}`);
  console.log(`  Max steps: ${MAX_STEPS}`);
  console.log(`  Timeout: ${TASK_TIMEOUT_MS / 1000}s`);
  console.log();

  const outDir = join(__dirname, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(
    outDir,
    `comparison-${frameworks.map((f) => f.name).join("-")}-${Date.now()}.json`,
  );

  const comparisons: TaskComparison[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    console.log(
      `\n[${i + 1}/${tasks.length}] ${task.id} (${task.web_name})`,
    );

    const taskComp: TaskComparison = {
      taskId: task.id,
      webName: task.web_name,
      question: task.ques,
      startUrl: task.web,
      results: {} as Record<FrameworkName, JudgedResult | null>,
    };

    // Initialize all to null
    for (const fw of ["lumen", "stagehand", "browser-use"] as FrameworkName[]) {
      taskComp.results[fw] = null;
    }

    // Run each framework sequentially for this task
    for (const adapter of frameworks) {
      process.stdout.write(`  ${adapter.name}... `);

      const result = await runFrameworkOnTask(adapter, task, model, apiKey);
      taskComp.results[adapter.name] = result;

      const status = result.judgePass ? "PASS" : "FAIL";
      const trialTag = result.trial > 1 ? ` (trial ${result.trial})` : "";
      const time = (result.durationMs / 1000).toFixed(1);

      if (result.status === "error") {
        console.log(`ERROR — ${(result.error ?? "").slice(0, 80)}`);
      } else {
        console.log(
          `[${status}${trialTag}] steps=${result.steps} tokens=${result.tokens.toLocaleString()} time=${time}s`,
        );
      }
    }

    comparisons.push(taskComp);

    // Save incrementally every 3 tasks
    if (comparisons.length % 3 === 0) {
      saveReport(outFile, model, frameworks, comparisons);
    }
  }

  // Final save + summary
  saveReport(outFile, model, frameworks, comparisons);
  printReport(frameworks, comparisons, model, outFile);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
