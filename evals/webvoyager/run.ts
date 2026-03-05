#!/usr/bin/env tsx
/**
 * WebVoyager Evaluation Runner for Lumen
 *
 * Matches Stagehand's evaluation methodology for apples-to-apples comparison:
 *   - Judge: Gemini 2.5 Flash (same as Stagehand's V3Evaluator)
 *   - Judge prompt: "expert evaluator that confidently returns YES or NO" (same prompt)
 *   - Screenshots: Final screenshot sent to judge with agent reasoning
 *   - Trials: 3 per task (same as Stagehand's trialCount: 3)
 *   - Tasks: 25 default (same as Stagehand's default)
 *   - Max steps: 50 (same as Stagehand)
 *
 * Usage:
 *   npx tsx --env-file .env evals/webvoyager/run.ts                # default: 25 tasks, 3 trials, stratified
 *   LIMIT=642 TRIALS=1 npx tsx --env-file .env evals/webvoyager/run.ts  # all tasks, no retries
 *   SAMPLE=random npx tsx --env-file .env evals/webvoyager/run.ts  # Stagehand-style random sampling
 *   SAMPLE=sequential npx tsx --env-file .env evals/webvoyager/run.ts  # first 25 tasks in order
 *   MODEL=google/gemini-2.0-flash npx tsx --env-file .env evals/webvoyager/run.ts
 *   SITES=Allrecipes,GitHub npx tsx --env-file .env evals/webvoyager/run.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../../src/index.js";
import { GoogleGenAI } from "@google/genai";

// ─── Types ───────────────────────────────────────────────────────────────────

interface WebVoyagerTask {
  web_name: string;
  id: string;
  ques: string;
  web: string;
}

interface TaskResult {
  id: string;
  web_name: string;
  question: string;
  startUrl: string;
  agentResult: string;
  agentStatus: string;
  steps: number;
  tokens: number;
  durationMs: number;
  judgePass: boolean;
  judgeReason: string;
  trial: number;
  error?: string;
}

interface EvalReport {
  timestamp: string;
  model: string;
  judgeModel: string;
  methodology: string;
  trials: number;
  total: number;
  passed: number;
  passRate: number;
  avgSteps: number;
  avgTokens: number;
  avgDurationMs: number;
  results: TaskResult[];
}

// ─── Config ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = process.env.DATA_FILE
  ? join(__dirname, process.env.DATA_FILE)
  : join(__dirname, "data.jsonl");
const MAX_STEPS = parseInt(process.env.MAX_STEPS ?? "50");
const TASK_TIMEOUT_MS = 600_000; // 10 minutes per task attempt
const TRIALS = parseInt(process.env.TRIALS ?? "3"); // Stagehand default: 3
const DEFAULT_LIMIT = 25; // Stagehand default: 25 tasks
const JUDGE_MODEL = "gemini-2.5-flash";

function resolveModelAndKey(): { model: string; apiKey: string | undefined } {
  const model = process.env.MODEL ?? "anthropic/claude-sonnet-4-6";
  const apiKey = model.startsWith("google/")
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
  return { model, apiKey };
}

// ─── Date adaptation ─────────────────────────────────────────────────────────

/**
 * Shift stale dates in task instructions to equivalent future dates.
 *
 * The WebVoyager dataset was created in late 2023 / early 2024 and contains
 * hardcoded dates (e.g. "January 25, 2024"). Travel sites (Google Flights,
 * Booking.com) reject past dates, making these tasks impossible on the live web.
 *
 * This function shifts past dates forward by the minimum number of whole years
 * needed to make them at least 2 weeks in the future, preserving month/day and
 * relative date gaps within a single instruction.
 */
function adaptDatesInInstruction(instruction: string): string {
  const now = new Date();
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 86400000);

  // Simple approach: find all year tokens (2023, 2024) that appear near month names
  // and shift them forward by the minimum years needed to be future.
  const monthNames = "January|February|March|April|May|June|July|August|September|October|November|December";
  const yearPattern = /\b(20(?:23|24|25))\b/g;

  // Check if any stale years exist
  const yearsFound = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = yearPattern.exec(instruction)) !== null) {
    const year = parseInt(match[1]!);
    // Verify this year appears within 50 chars of a month name (date context)
    const start = Math.max(0, match.index - 50);
    const end = Math.min(instruction.length, match.index + 50);
    const context = instruction.slice(start, end);
    if (new RegExp(monthNames, "i").test(context)) {
      yearsFound.add(year);
    }
  }

  if (yearsFound.size === 0) return instruction;

  const minYear = Math.min(...yearsFound);
  let yearShift = twoWeeksFromNow.getFullYear() - minYear;
  if (yearShift <= 0) return instruction;

  // Check if shifting by yearShift makes all months future enough.
  // If the earliest month in the instruction is before the current month,
  // we may need +1 year.
  const monthPattern = new RegExp(`(${monthNames})\\s+(\\d{1,2})`, "gi");
  let earliestParsed: Date | null = null;
  while ((match = monthPattern.exec(instruction)) !== null) {
    const d = new Date(`${match[1]} ${match[2]}, ${minYear + yearShift}`);
    if (!earliestParsed || d < earliestParsed) earliestParsed = d;
  }
  if (earliestParsed && earliestParsed < twoWeeksFromNow) yearShift++;

  // Replace all stale years with shifted years (single pass, no double-shift)
  let result = instruction.replace(/\b(20(?:23|24|25))\b/g, (yearStr) => {
    const year = parseInt(yearStr);
    return yearsFound.has(year) ? String(year + yearShift) : yearStr;
  });

  // Handle "today (February 17, 2024)" — replace with just "today"
  return result.replace(/today\s*\([^)]*\)/gi, "today");
}

// ─── Dataset loading ─────────────────────────────────────────────────────────

/** Fisher-Yates shuffle (same algorithm as Stagehand's sampleUniform) */
function sampleUniform<T>(arr: T[], k: number): T[] {
  const n = arr.length;
  if (k >= n) return arr.slice();
  const copy = arr.slice();
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy.slice(0, k);
}

/** Stratified sampling: pick up to `perSite` tasks per site, randomly */
function sampleStratified(tasks: WebVoyagerTask[], total: number): WebVoyagerTask[] {
  const bySite = new Map<string, WebVoyagerTask[]>();
  for (const t of tasks) {
    const list = bySite.get(t.web_name) ?? [];
    list.push(t);
    bySite.set(t.web_name, list);
  }
  const sites = [...bySite.keys()].sort();
  const perSite = Math.max(1, Math.ceil(total / sites.length));
  const result: WebVoyagerTask[] = [];
  for (const site of sites) {
    const pool = bySite.get(site)!;
    const sampled = sampleUniform(pool, perSite);
    result.push(...sampled);
  }
  // If we have more than needed (due to rounding), trim
  return result.length > total ? sampleUniform(result, total) : result;
}

function loadTasks(): WebVoyagerTask[] {
  const raw = readFileSync(DATA_PATH, "utf-8");
  const allTasks = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const task = JSON.parse(line) as WebVoyagerTask;
      // Adapt stale dates so travel sites (Booking, Google Flights) work with live web
      task.ques = adaptDatesInInstruction(task.ques);
      return task;
    });

  // Filter by site if specified
  const sitesEnv = process.env.SITES;
  let filtered = allTasks;
  if (sitesEnv) {
    const sites = new Set(sitesEnv.split(",").map((s) => s.trim().toLowerCase()));
    filtered = allTasks.filter((t) => sites.has(t.web_name.toLowerCase()));
  }

  const limit = parseInt(process.env.LIMIT ?? String(DEFAULT_LIMIT));

  // SAMPLE=random — Stagehand-style random uniform sampling
  // SAMPLE=stratified (default) — even distribution across sites
  // SAMPLE=sequential — first N tasks in order
  const sampleMode = process.env.SAMPLE ?? "stratified";
  if (sampleMode === "random") {
    return sampleUniform(filtered, limit);
  } else if (sampleMode === "sequential") {
    const offset = parseInt(process.env.OFFSET ?? "0");
    return filtered.slice(offset, offset + limit);
  } else {
    // stratified: ensure diverse site coverage
    return sampleStratified(filtered, limit);
  }
}

// ─── Gemini 2.5 Flash Judge (matches Stagehand V3Evaluator) ─────────────────

const gemini = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
});

/**
 * Judge using Gemini 2.5 Flash with screenshot — matches Stagehand's V3Evaluator exactly.
 *
 * Stagehand's evaluator prompt:
 *   System: "You are an expert evaluator that confidently returns YES or NO based on
 *            if the original goal was achieved."
 *   User: "Question: {question}\n\nAgent's reasoning and actions taken:\n{agentReasoning}"
 *          + screenshot image
 *   Output: { evaluation: "YES"|"NO", reasoning: string }
 */
async function judgeResult(
  question: string,
  agentResult: string,
  screenshot?: Buffer,
): Promise<{ pass: boolean; reason: string }> {
  try {
    const systemPrompt = screenshot
      ? `You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved. You have access to a screenshot that you can use to evaluate the tasks completion. Provide detailed reasoning for your answer.\nToday's date is ${new Date().toLocaleDateString()}`
      : `You are an expert evaluator that confidently returns YES or NO based on if the original goal was achieved. You have access to the agents reasoning and actions throughout the task that you can use to evaluate the tasks completion. Provide detailed reasoning for your answer.\nToday's date is ${new Date().toLocaleDateString()}`;

    const userParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Run a single attempt of a task. Uses the Agent class directly (not Agent.run())
 * so we can capture a final screenshot before closing the browser.
 *
 * If previousFeedback is provided (from a failed trial's judge), it's appended
 * to the instruction so the agent can learn from the previous failure.
 */
async function runSingleAttempt(
  task: WebVoyagerTask,
  model: string,
  apiKey: string | undefined,
  trial: number,
  previousFeedback?: string,
): Promise<TaskResult> {
  const start = Date.now();
  const agent = new Agent({
    model,
    apiKey,
    browser: { type: "local" },
    maxSteps: MAX_STEPS,
    compactionThreshold: 0.6,
    verbose: 0,
  });

  // Build instruction with cross-trial feedback
  let instruction = task.ques;
  if (previousFeedback && trial > 1) {
    instruction += `\n\n[IMPORTANT: A previous attempt at this task failed. The evaluator said: "${previousFeedback}". Try a DIFFERENT approach this time. If form interactions (date pickers, dropdowns) aren't working, try typing values directly into input fields, or construct a URL with the required parameters and navigate directly.]`;
  }

  try {
    const agentResult = await withTimeout(
      agent.run({
        instruction,
        maxSteps: MAX_STEPS,
        startUrl: task.web,
      }),
      TASK_TIMEOUT_MS,
      task.id,
    );

    // Capture final screenshot before closing the browser
    let screenshot: Buffer | undefined;
    try {
      const screenshotResult = await agent.tab.screenshot();
      screenshot = screenshotResult.data;
    } catch {
      // Screenshot may fail if page crashed; that's ok
    }

    await agent.close();

    const resultText =
      agentResult.status === "success"
        ? agentResult.result
        : `[${agentResult.status}] ${agentResult.result}`;
    const totalTokens =
      agentResult.tokenUsage.inputTokens + agentResult.tokenUsage.outputTokens;

    // Judge: always send to judge (including maxSteps) — Stagehand judges all results
    const judge = await judgeResult(task.ques, resultText, screenshot);

    return {
      id: task.id,
      web_name: task.web_name,
      question: task.ques,
      startUrl: task.web,
      agentResult: resultText,
      agentStatus: agentResult.status,
      steps: agentResult.steps,
      tokens: totalTokens,
      durationMs: Date.now() - start,
      judgePass: judge.pass,
      judgeReason: judge.reason,
      trial,
    };
  } catch (err) {
    await agent.close().catch(() => {});
    return {
      id: task.id,
      web_name: task.web_name,
      question: task.ques,
      startUrl: task.web,
      agentResult: "",
      agentStatus: "error",
      steps: 0,
      tokens: 0,
      durationMs: Date.now() - start,
      judgePass: false,
      judgeReason: `Runtime error: ${String(err).slice(0, 200)}`,
      error: String(err),
      trial,
    };
  }
}

/**
 * Run a task with up to TRIALS attempts (matching Stagehand's trial system).
 * Returns the first passing result, or the last attempt if all fail.
 */
async function runTask(
  task: WebVoyagerTask,
  model: string,
  apiKey: string | undefined,
): Promise<TaskResult> {
  let lastFeedback: string | undefined;
  for (let trial = 1; trial <= TRIALS; trial++) {
    const result = await runSingleAttempt(task, model, apiKey, trial, lastFeedback);
    if (result.judgePass || trial === TRIALS) {
      return result;
    }
    // Pass judge feedback to next trial so agent can try a different approach
    lastFeedback = result.judgeReason;
    process.stdout.write(`  [retry ${trial}/${TRIALS}] `);
  }
  // Unreachable, but TypeScript needs this
  throw new Error("Unreachable");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const tasks = loadTasks();
  const { model, apiKey } = resolveModelAndKey();

  const sampleMode = process.env.SAMPLE ?? "stratified";
  // Log which tasks were selected (for reproducibility)
  const siteDistribution = new Map<string, number>();
  for (const t of tasks) {
    siteDistribution.set(t.web_name, (siteDistribution.get(t.web_name) ?? 0) + 1);
  }

  console.log("WebVoyager Evaluation (Stagehand methodology)");
  console.log(`  Agent model: ${model}`);
  console.log(`  Judge model: ${JUDGE_MODEL}`);
  console.log(`  Tasks: ${tasks.length} (${sampleMode} sampling)`);
  console.log(`  Sites: ${[...siteDistribution.entries()].map(([s, n]) => `${s}(${n})`).join(", ")}`);
  console.log(`  Trials per task: ${TRIALS}`);
  console.log(`  Max steps per task: ${MAX_STEPS}`);
  console.log(`  Timeout per attempt: ${TASK_TIMEOUT_MS / 1000}s`);
  console.log();

  // Incremental results file
  const outDir = join(__dirname, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(
    outDir,
    `webvoyager-stagehand-${model.replace("/", "-")}-${Date.now()}.json`,
  );

  const results: TaskResult[] = [];
  let passed = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    process.stdout.write(
      `[${i + 1}/${tasks.length}] ${task.id} (${task.web_name})... `,
    );

    const result = await runTask(task, model, apiKey);
    results.push(result);

    if (result.judgePass) passed++;
    const status = result.judgePass ? "PASS" : "FAIL";
    const trialTag = result.trial > 1 ? ` (trial ${result.trial})` : "";
    const time = (result.durationMs / 1000).toFixed(1);
    console.log(
      `[${status}${trialTag}] steps=${result.steps} tokens=${result.tokens.toLocaleString()} time=${time}s`,
    );
    if (!result.judgePass) {
      console.log(`    Reason: ${result.judgeReason.slice(0, 120)}`);
    }

    // Save incrementally every 5 tasks
    if (results.length % 5 === 0) {
      saveReport(outFile, model, results, passed);
    }
  }

  // Final save + summary
  saveReport(outFile, model, results, passed);
  printSummary(model, results, passed, outFile);
}

function saveReport(outFile: string, model: string, results: TaskResult[], passed: number): void {
  const successResults = results.filter((r) => !r.error);
  const avgSteps =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.steps, 0) / successResults.length
      : 0;
  const avgTokens =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.tokens, 0) / successResults.length
      : 0;
  const avgDuration =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.durationMs, 0) / successResults.length
      : 0;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    model,
    judgeModel: JUDGE_MODEL,
    methodology: "stagehand-compatible",
    trials: TRIALS,
    total: results.length,
    passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    avgSteps: Math.round(avgSteps * 10) / 10,
    avgTokens: Math.round(avgTokens),
    avgDurationMs: Math.round(avgDuration),
    results,
  };

  writeFileSync(outFile, JSON.stringify(report, null, 2));
}

function printSummary(model: string, results: TaskResult[], passed: number, outFile: string): void {
  const successResults = results.filter((r) => !r.error);
  const avgSteps =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.steps, 0) / successResults.length
      : 0;
  const avgTokens =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.tokens, 0) / successResults.length
      : 0;
  const avgDuration =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.durationMs, 0) / successResults.length
      : 0;
  const retriedCount = results.filter((r) => r.trial > 1).length;

  console.log("\n" + "=".repeat(60));
  console.log("RESULTS (Stagehand-compatible methodology)");
  console.log("=".repeat(60));
  console.log(`  Agent model:  ${model}`);
  console.log(`  Judge model:  ${JUDGE_MODEL}`);
  console.log(`  Trials:       ${TRIALS} per task`);
  console.log(`  Total tasks:  ${results.length}`);
  console.log(`  Passed:       ${passed}`);
  console.log(`  Pass rate:    ${((passed / results.length) * 100).toFixed(1)}%`);
  console.log(`  Retried:      ${retriedCount} tasks needed retry`);
  console.log(`  Avg steps:    ${avgSteps.toFixed(1)}`);
  console.log(`  Avg tokens:   ${Math.round(avgTokens).toLocaleString()}`);
  console.log(`  Avg time:     ${(avgDuration / 1000).toFixed(1)}s`);

  // Per-site breakdown
  const siteMap = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const entry = siteMap.get(r.web_name) ?? { pass: 0, total: 0 };
    entry.total++;
    if (r.judgePass) entry.pass++;
    siteMap.set(r.web_name, entry);
  }
  console.log("\n  Per-site:");
  for (const [site, { pass, total }] of [...siteMap.entries()].sort()) {
    console.log(
      `    ${site.padEnd(20)} ${pass}/${total} (${((pass / total) * 100).toFixed(0)}%)`,
    );
  }

  console.log(`\nReport saved: ${outFile}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
