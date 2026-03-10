#!/usr/bin/env tsx
/**
 * WebVoyager Evaluation Runner
 *
 * Usage:
 *   npm run eval                    # 25 tasks, lumen (default)
 *   npm run eval -- 5               # 5 tasks, lumen
 *   npm run eval -- 25 stagehand    # 25 tasks, stagehand
 *   npm run eval -- 25 browser-use  # 25 tasks, browser-use
 *
 * Optional env vars:
 *   MODEL=google/gemini-2.0-flash   # agent model (default: anthropic/claude-sonnet-4-6)
 *   SITES=Allrecipes,GitHub         # filter to specific sites
 *   DATA_FILE=diverse_sample.jsonl  # alternate dataset
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, ModelVerifier } from "../../src/index.js";
import { AnthropicAdapter } from "../../src/model/anthropic.js";
import { GoogleGenAI } from "@google/genai";

// ─── Types ───────────────────────────────────────────────────────────────────

type Framework = "lumen" | "stagehand" | "browser-use";

interface WebVoyagerTask {
  web_name: string;
  id: string;
  ques: string;
  web: string;
}

interface AttemptResult {
  result: string;
  status: string;
  steps: number;
  tokens: number;
  durationMs: number;
  screenshot?: Buffer;
  error?: string;
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
  framework: string;
  model: string;
  judgeModel: string;
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
const MAX_STEPS = 50;
const TASK_TIMEOUT_MS = 600_000;
const TRIALS = 3;
const DEFAULT_LIMIT = 25;
const JUDGE_MODEL = "gemini-2.5-flash";
const VENV_PYTHON = join(__dirname, ".venv/bin/python3");
const BROWSER_USE_SCRIPT = join(__dirname, "browser_use_webvoyager.py");

function parseArgs(): { limit: number; framework: Framework } {
  const args = process.argv.slice(2);
  let limit = DEFAULT_LIMIT;
  let framework: Framework = "lumen";
  for (const arg of args) {
    if (/^\d+$/.test(arg)) {
      limit = parseInt(arg);
    } else if (arg === "lumen" || arg === "stagehand" || arg === "browser-use") {
      framework = arg;
    }
  }
  return { limit, framework };
}

function resolveModelAndKey(): { model: string; apiKey: string | undefined } {
  const model = process.env.MODEL ?? "anthropic/claude-sonnet-4-6";
  const apiKey = model.startsWith("google/")
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
  return { model, apiKey };
}

// ─── Date adaptation ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Shift stale dates in task instructions to equivalent future dates.
 * The WebVoyager dataset contains hardcoded 2023/2024 dates that travel
 * sites reject. This shifts them forward preserving relative gaps.
 */
function adaptDatesInInstruction(instruction: string): string {
  const now = new Date();
  const twoWeeksFromNow = new Date(now.getTime() + 14 * 86400000);

  const monthNames = "January|February|March|April|May|June|July|August|September|October|November|December";
  const monthAbbrev = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";
  const allMonths = `${monthNames}|${monthAbbrev}`;
  const expandMonth = (m: string): string => {
    const full = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const abbr = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const idx = abbr.findIndex((a) => a.toLowerCase() === m.replace(".", "").toLowerCase());
    return idx >= 0 ? full[idx]! : m;
  };
  const yearPattern = /\b(20(?:23|24|25))\b/g;

  const yearsFound = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = yearPattern.exec(instruction)) !== null) {
    const year = parseInt(match[1]!);
    const start = Math.max(0, match.index - 50);
    const end = Math.min(instruction.length, match.index + 50);
    const context = instruction.slice(start, end);
    if (new RegExp(allMonths, "i").test(context)) {
      yearsFound.add(year);
    }
  }

  if (yearsFound.size > 0) {
    const monthsFull = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];

    const fullDateRe = new RegExp(
      `(${allMonths})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?`,
      "gi",
    );
    const dayFirstRe = new RegExp(
      `(\\d{1,2})\\s+(${allMonths})\\.?(?:\\s+(20\\d{2}))?`,
      "gi",
    );
    interface ParsedDate { month: string; day: number; year: number; fullMatch: string; index: number; }
    const parsedDates: ParsedDate[] = [];
    const coveredRanges: Array<[number, number]> = [];

    while ((match = dayFirstRe.exec(instruction)) !== null) {
      const day = parseInt(match[1]!);
      if (day < 1 || day > 31) continue;
      const month = expandMonth(match[2]!);
      const year = match[3] ? parseInt(match[3]) : Math.min(...yearsFound);
      parsedDates.push({ month, day, year, fullMatch: match[0], index: match.index });
      coveredRanges.push([match.index, match.index + match[0].length]);
    }

    while ((match = fullDateRe.exec(instruction)) !== null) {
      const mi = match.index;
      const me = mi + match[0].length;
      if (coveredRanges.some(([s, e]) => mi >= s && mi < e)) continue;
      const month = expandMonth(match[1]!);
      const day = parseInt(match[2]!);
      if (day > 31) continue;
      let year = match[3] ? parseInt(match[3]) : 0;
      if (!year) {
        const after = instruction.slice(me, me + 20);
        const yearMatch = after.match(/^,?\s*(20\d{2})/);
        if (yearMatch) year = parseInt(yearMatch[1]!);
      }
      if (!year) year = Math.min(...yearsFound);
      parsedDates.push({ month, day, year, fullMatch: match[0], index: match.index });
      coveredRanges.push([mi, me]);
    }

    if (parsedDates.length === 0) {
      const minYear = Math.min(...yearsFound);
      const yearShift = twoWeeksFromNow.getFullYear() - minYear;
      if (yearShift <= 0) return instruction;
      let result = instruction.replace(/\b(20(?:23|24|25))\b/g, (yearStr) => {
        const year = parseInt(yearStr);
        return yearsFound.has(year) ? String(year + yearShift) : yearStr;
      });
      return result.replace(/today\s*\([^)]*\)/gi, "today");
    }

    const earliest = parsedDates.reduce((min, d) => {
      const date = new Date(`${d.month} ${d.day}, ${d.year}`);
      const minDate = new Date(`${min.month} ${min.day}, ${min.year}`);
      return date < minDate ? d : min;
    });
    const earliestDate = new Date(`${earliest.month} ${earliest.day}, ${earliest.year}`);
    const targetDate = new Date(now.getTime() + 45 * 86400000);
    const dayDelta = Math.round((targetDate.getTime() - earliestDate.getTime()) / 86400000);

    if (dayDelta <= 0) return instruction;

    const maxFuture = new Date(now.getTime() + 300 * 86400000);
    const shiftedDates = parsedDates.map((d) => {
      const orig = new Date(`${d.month} ${d.day}, ${d.year}`);
      const shifted = new Date(orig.getTime() + dayDelta * 86400000);
      return { ...d, shifted };
    });

    const allValid = shiftedDates.every(
      (d) => d.shifted >= twoWeeksFromNow && d.shifted <= maxFuture,
    );
    if (!allValid) {
      const minYear = Math.min(...yearsFound);
      const yearShift = now.getFullYear() - minYear;
      if (yearShift <= 0) return instruction;
      let result = instruction.replace(/\b(20(?:23|24|25))\b/g, (yearStr) => {
        const year = parseInt(yearStr);
        return yearsFound.has(year) ? String(year + yearShift) : yearStr;
      });
      return result.replace(/today\s*\([^)]*\)/gi, "today");
    }

    let result = instruction;
    for (const d of [...shiftedDates].sort((a, b) => b.index - a.index)) {
      const newMonth = monthsFull[d.shifted.getMonth()]!;
      const newDay = d.shifted.getDate();
      const newYear = d.shifted.getFullYear();

      const origSlice = result.slice(d.index, d.index + d.fullMatch.length + 10);
      const hasYear = /^,?\s*20\d{2}/.test(origSlice.slice(d.fullMatch.length));
      const endPos = hasYear
        ? d.index + origSlice.match(new RegExp(`^${escapeRegex(d.fullMatch)},?\\s*20\\d{2}`))![0].length
        : d.index + d.fullMatch.length;

      result = result.slice(0, d.index) + `${newMonth} ${newDay}, ${newYear}` + result.slice(endPos);
    }

    const minYear = Math.min(...yearsFound);
    const yearShift = Math.round(dayDelta / 365);
    result = result.replace(/\b(20(?:23|24|25))\b/g, (yearStr) => {
      const year = parseInt(yearStr);
      return yearsFound.has(year) ? String(year + (yearShift || 1)) : yearStr;
    });
    return result.replace(/today\s*\([^)]*\)/gi, "today");
  }

  const monthsFull = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const yearlessDatePattern = new RegExp(
    `(${allMonths})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?`,
    "gi",
  );
  const yearlessDates: Array<{ month: string; day: number; index: number; fullMatch: string }> = [];
  while ((match = yearlessDatePattern.exec(instruction)) !== null) {
    const day = parseInt(match[2]!);
    if (day > 31) continue;
    yearlessDates.push({ month: match[1]!, day, index: match.index, fullMatch: match[0] });
  }
  const yearlessDayFirstRe = new RegExp(`(\\d{1,2})\\s+(${allMonths})\\.?`, "gi");
  while ((match = yearlessDayFirstRe.exec(instruction)) !== null) {
    const day = parseInt(match[1]!);
    if (day < 1 || day > 31) continue;
    if (yearlessDates.some((d) => match!.index >= d.index && match!.index < d.index + d.fullMatch.length)) continue;
    yearlessDates.push({ month: match[2]!, day, index: match.index, fullMatch: match[0] });
  }

  if (yearlessDates.length === 0) return instruction;

  const currentYear = now.getFullYear();
  let needsShift = false;
  for (const d of yearlessDates) {
    const dateThisYear = new Date(`${expandMonth(d.month)} ${d.day}, ${currentYear}`);
    if (dateThisYear < twoWeeksFromNow) { needsShift = true; break; }
  }
  if (!needsShift) return instruction;

  const earliestYearless = yearlessDates.reduce((min, d) => {
    const date = new Date(`${expandMonth(d.month)} ${d.day}, ${currentYear}`);
    const minDate = new Date(`${expandMonth(min.month)} ${min.day}, ${currentYear}`);
    return date < minDate ? d : min;
  });
  const earliestDate = new Date(`${expandMonth(earliestYearless.month)} ${earliestYearless.day}, ${currentYear}`);
  const targetDate = new Date(now.getTime() + 45 * 86400000);
  const dayDelta = Math.round((targetDate.getTime() - earliestDate.getTime()) / 86400000);
  if (dayDelta <= 0) return instruction;

  const maxFuture = new Date(now.getTime() + 300 * 86400000);
  let result = instruction;
  for (const d of [...yearlessDates].sort((a, b) => b.index - a.index)) {
    const orig = new Date(`${expandMonth(d.month)} ${d.day}, ${currentYear}`);
    const shifted = new Date(orig.getTime() + dayDelta * 86400000);
    if (shifted < twoWeeksFromNow || shifted > maxFuture) continue;
    const newMonth = monthsFull[shifted.getMonth()]!;
    const newDay = shifted.getDate();
    const newYear = shifted.getFullYear();
    const end = d.index + d.fullMatch.length;
    const after = result.slice(end, end + 10).trim();
    if (/^,?\s*20\d{2}/.test(after)) continue;
    result = result.slice(0, d.index) + `${newMonth} ${newDay}, ${newYear}` + result.slice(end);
  }

  return result.replace(/today\s*\([^)]*\)/gi, "today");
}

function adaptTimeSensitiveInstruction(instruction: string): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400000);
  const formatDate = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  let result = instruction;
  result = result.replace(/\byesterday\b/gi, formatDate(yesterday));
  result = result.replace(/\btoday(?:'s date)?\b/gi, formatDate(now));
  const currentSeasonStart = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  const currentSeason = `${currentSeasonStart}-${String(currentSeasonStart + 1).slice(2)}`;
  result = result.replace(/\b2023-24\b/g, currentSeason);
  return result;
}

// ─── Dataset loading ─────────────────────────────────────────────────────────

/** Seeded PRNG (mulberry32) for deterministic sampling across frameworks */
function seededRng(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const rng = seededRng(42);

function shuffle<T>(arr: T[]): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

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
    const pool = shuffle(bySite.get(site)!);
    result.push(...pool.slice(0, perSite));
  }
  return result.length > total ? shuffle(result).slice(0, total) : result;
}

function loadTasks(limit: number): WebVoyagerTask[] {
  const raw = readFileSync(DATA_PATH, "utf-8");
  const allTasks = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const task = JSON.parse(line) as WebVoyagerTask;
      task.ques = adaptDatesInInstruction(task.ques);
      task.ques = adaptTimeSensitiveInstruction(task.ques);
      return task;
    });

  const sitesEnv = process.env.SITES;
  let filtered = allTasks;
  if (sitesEnv) {
    const sites = new Set(sitesEnv.split(",").map((s) => s.trim().toLowerCase()));
    filtered = allTasks.filter((t) => sites.has(t.web_name.toLowerCase()));
  }

  // TASKS env var: run specific task IDs (comma-separated)
  const tasksEnv = process.env.TASKS;
  if (tasksEnv) {
    const ids = new Set(tasksEnv.split(",").map((s) => s.trim()));
    return filtered.filter((t) => ids.has(t.id));
  }

  return sampleStratified(filtered, limit);
}

// ─── Judge ───────────────────────────────────────────────────────────────────

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

    const userParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
      {
        text: `Question: Did the agent successfully complete this task: "${question}"?\n\nAgent's reasoning and actions taken:\n${agentResult}`,
      },
    ];

    if (screenshot) {
      userParts.push({
        inlineData: { mimeType: "image/jpeg", data: screenshot.toString("base64") },
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

// ─── Framework runners ───────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function runLumen(
  instruction: string,
  startUrl: string,
  model: string,
  apiKey: string | undefined,
): Promise<AttemptResult> {
  const start = Date.now();
  // Build a lightweight adapter for the ModelVerifier (termination gate)
  const verifierAdapter = new AnthropicAdapter(
    model.replace("anthropic/", ""),
    apiKey,
  );
  const agent = new Agent({
    model,
    apiKey,
    browser: { type: "local" },
    maxSteps: MAX_STEPS,
    compactionThreshold: 0.6,
    verbose: 0,
    siteKB: join(__dirname, "../../src/memory/default-site-kb.json"),
    actionVerifier: true,
    checkpointInterval: 5,
    verifier: new ModelVerifier(verifierAdapter, instruction),
  });

  try {
    const agentResult = await withTimeout(
      agent.run({ instruction, maxSteps: MAX_STEPS, startUrl }),
      TASK_TIMEOUT_MS,
      "lumen",
    );

    let screenshot: Buffer | undefined;
    try { screenshot = (await agent.tab.screenshot()).data; } catch { /* page may have crashed */ }
    await agent.close();

    return {
      result: agentResult.status === "success"
        ? agentResult.result
        : `[${agentResult.status}] ${agentResult.result}`,
      status: agentResult.status,
      steps: agentResult.steps,
      tokens: agentResult.tokenUsage.inputTokens + agentResult.tokenUsage.outputTokens,
      durationMs: Date.now() - start,
      screenshot,
    };
  } catch (err) {
    await agent.close().catch(() => {});
    return { result: "", status: "error", steps: 0, tokens: 0, durationMs: Date.now() - start, error: String(err) };
  }
}

async function runStagehand(
  instruction: string,
  startUrl: string,
  model: string,
): Promise<AttemptResult> {
  const start = Date.now();
  let stagehand: any = null;

  try {
    const { Stagehand } = await import("@browserbasehq/stagehand");
    stagehand = new Stagehand({ env: "LOCAL", verbose: 0, disablePino: true, localBrowserLaunchOptions: { headless: false } });
    await stagehand.init();

    const pages = (stagehand as any).context.pages();
    if (pages.length > 0) await pages[0].goto(startUrl, { waitUntil: "domcontentloaded" });

    const agent = stagehand.agent({ mode: "cua", model: model as any } as any);
    const agentResult: any = await withTimeout(agent.execute({ instruction, maxSteps: MAX_STEPS }), TASK_TIMEOUT_MS, "stagehand");

    let screenshot: Buffer | undefined;
    try {
      const currentPages = (stagehand as any).context.pages();
      if (currentPages.length > 0) screenshot = await currentPages[0].screenshot({ type: "jpeg", quality: 75 });
    } catch { /* page may have closed */ }

    await stagehand.close();

    return {
      result: agentResult.success ? (agentResult.message ?? "") : `[incomplete] ${agentResult.message ?? ""}`,
      status: agentResult.success ? "success" : "maxSteps",
      steps: agentResult.actions?.length ?? 0,
      tokens: agentResult.usage ? agentResult.usage.input_tokens + agentResult.usage.output_tokens : 0,
      durationMs: Date.now() - start,
      screenshot,
    };
  } catch (err) {
    if (stagehand) try { await stagehand.close(); } catch { /* ignore */ }
    return { result: "", status: "error", steps: 0, tokens: 0, durationMs: Date.now() - start, error: String(err) };
  }
}

async function runBrowserUse(
  instruction: string,
  startUrl: string,
  model: string,
): Promise<AttemptResult> {
  const start = Date.now();

  const args = JSON.stringify({ task_name: "webvoyager", instruction, start_url: startUrl, max_steps: MAX_STEPS });

  return new Promise<AttemptResult>((resolve) => {
    const proc = spawn(VENV_PYTHON, [BROWSER_USE_SCRIPT, args], {
      env: { ...process.env, MODEL: model },
      timeout: TASK_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("close", () => {
      try {
        const json = JSON.parse(stdout.trim());
        let screenshot: Buffer | undefined;
        if (json.screenshot_b64) screenshot = Buffer.from(json.screenshot_b64, "base64");
        resolve({
          result: json.result ?? "",
          status: json.passed ? "success" : json.error ? "error" : "maxSteps",
          steps: json.steps ?? 0,
          tokens: json.tokens ?? 0,
          durationMs: Date.now() - start,
          screenshot,
          error: json.error ?? undefined,
        });
      } catch {
        resolve({
          result: "",
          status: "error",
          steps: 0,
          tokens: 0,
          durationMs: Date.now() - start,
          error: `parse error — stdout: ${stdout.slice(0, 200)} | stderr: ${stderr.slice(0, 200)}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({ result: "", status: "error", steps: 0, tokens: 0, durationMs: Date.now() - start, error: `spawn error: ${err.message}` });
    });
  });
}

// ─── Task runner ─────────────────────────────────────────────────────────────

async function runSingleAttempt(
  framework: Framework,
  task: WebVoyagerTask,
  model: string,
  apiKey: string | undefined,
  trial: number,
  previousFeedback?: string,
): Promise<TaskResult> {
  let instruction = task.ques;
  if (previousFeedback && trial > 1) {
    instruction += `\n\n[IMPORTANT: A previous attempt at this task failed. The evaluator said: "${previousFeedback}". Try a DIFFERENT approach this time.]`;
  }

  let attempt: AttemptResult;
  switch (framework) {
    case "lumen":
      attempt = await runLumen(instruction, task.web, model, apiKey);
      break;
    case "stagehand":
      attempt = await runStagehand(instruction, task.web, model);
      break;
    case "browser-use":
      attempt = await runBrowserUse(instruction, task.web, model);
      break;
  }

  const judge = await judgeResult(task.ques, attempt.result, attempt.screenshot);

  return {
    id: task.id,
    web_name: task.web_name,
    question: task.ques,
    startUrl: task.web,
    agentResult: attempt.result,
    agentStatus: attempt.status,
    steps: attempt.steps,
    tokens: attempt.tokens,
    durationMs: attempt.durationMs,
    judgePass: judge.pass,
    judgeReason: judge.reason,
    trial,
    error: attempt.error,
  };
}

async function runTask(
  framework: Framework,
  task: WebVoyagerTask,
  model: string,
  apiKey: string | undefined,
): Promise<TaskResult> {
  let lastFeedback: string | undefined;
  for (let trial = 1; trial <= TRIALS; trial++) {
    const result = await runSingleAttempt(framework, task, model, apiKey, trial, lastFeedback);
    if (result.judgePass || trial === TRIALS) return result;
    lastFeedback = result.judgeReason;
    process.stdout.write(`  [retry ${trial}/${TRIALS}] `);
  }
  throw new Error("Unreachable");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { limit, framework } = parseArgs();
  const tasks = loadTasks(limit);
  const { model, apiKey } = resolveModelAndKey();

  const siteDistribution = new Map<string, number>();
  for (const t of tasks) {
    siteDistribution.set(t.web_name, (siteDistribution.get(t.web_name) ?? 0) + 1);
  }

  console.log("WebVoyager Evaluation");
  console.log(`  Framework: ${framework}  |  Model: ${model}  |  Judge: ${JUDGE_MODEL}`);
  console.log(`  Tasks: ${tasks.length}  |  Trials: ${TRIALS}  |  Max steps: ${MAX_STEPS}`);
  console.log(`  Sites: ${[...siteDistribution.entries()].map(([s, n]) => `${s}(${n})`).join(", ")}`);
  console.log();

  const outDir = join(__dirname, "results");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `webvoyager-${framework}-${model.replace("/", "-")}-${Date.now()}.json`);

  const results: TaskResult[] = [];
  let passed = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    process.stdout.write(`[${i + 1}/${tasks.length}] ${task.id} (${task.web_name})... `);

    const result = await runTask(framework, task, model, apiKey);
    results.push(result);

    if (result.judgePass) passed++;
    const status = result.judgePass ? "PASS" : "FAIL";
    const trialTag = result.trial > 1 ? ` (trial ${result.trial})` : "";
    const time = (result.durationMs / 1000).toFixed(1);
    console.log(`[${status}${trialTag}] steps=${result.steps} tokens=${result.tokens.toLocaleString()} time=${time}s`);
    if (!result.judgePass) {
      console.log(`    Reason: ${result.judgeReason.slice(0, 120)}`);
    }

    if (results.length % 5 === 0) saveReport(outFile, framework, model, results, passed);
  }

  saveReport(outFile, framework, model, results, passed);
  printSummary(framework, model, results, passed, outFile);
}

function saveReport(outFile: string, framework: string, model: string, results: TaskResult[], passed: number): void {
  const successResults = results.filter((r) => !r.error);
  const avg = (fn: (r: TaskResult) => number) =>
    successResults.length > 0 ? successResults.reduce((s, r) => s + fn(r), 0) / successResults.length : 0;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    framework,
    model,
    judgeModel: JUDGE_MODEL,
    trials: TRIALS,
    total: results.length,
    passed,
    passRate: results.length > 0 ? passed / results.length : 0,
    avgSteps: Math.round(avg((r) => r.steps) * 10) / 10,
    avgTokens: Math.round(avg((r) => r.tokens)),
    avgDurationMs: Math.round(avg((r) => r.durationMs)),
    results,
  };

  writeFileSync(outFile, JSON.stringify(report, null, 2));
}

function printSummary(framework: string, model: string, results: TaskResult[], passed: number, outFile: string): void {
  const successResults = results.filter((r) => !r.error);
  const avg = (fn: (r: TaskResult) => number) =>
    successResults.length > 0 ? successResults.reduce((s, r) => s + fn(r), 0) / successResults.length : 0;
  const retriedCount = results.filter((r) => r.trial > 1).length;

  console.log("\n" + "=".repeat(60));
  console.log("RESULTS");
  console.log("=".repeat(60));
  console.log(`  Framework:   ${framework}`);
  console.log(`  Model:       ${model}  |  Judge: ${JUDGE_MODEL}`);
  console.log(`  Pass rate:   ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`);
  console.log(`  Retried:     ${retriedCount} tasks`);
  console.log(`  Avg steps:   ${avg((r) => r.steps).toFixed(1)}  |  Avg tokens: ${Math.round(avg((r) => r.tokens)).toLocaleString()}  |  Avg time: ${(avg((r) => r.durationMs) / 1000).toFixed(1)}s`);

  const siteMap = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const entry = siteMap.get(r.web_name) ?? { pass: 0, total: 0 };
    entry.total++;
    if (r.judgePass) entry.pass++;
    siteMap.set(r.web_name, entry);
  }
  console.log("\n  Per-site:");
  for (const [site, { pass, total }] of [...siteMap.entries()].sort()) {
    console.log(`    ${site.padEnd(20)} ${pass}/${total} (${((pass / total) * 100).toFixed(0)}%)`);
  }

  console.log(`\nReport saved: ${outFile}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
