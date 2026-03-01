import type { BenchmarkTask, BenchmarkReport, FrameworkResult, Framework } from "./types.js";
import { runWithLumen } from "./frameworks/lumen.js";
import { runWithStagehand } from "./frameworks/stagehand.js";
import { runWithBrowserUse } from "./frameworks/browseruse.js";

export const ALL_FRAMEWORKS: Framework[] = ["lumen", "stagehand", "browser-use"];

export async function runBenchmark(
  tasks: BenchmarkTask[],
  frameworks: Framework[] = ALL_FRAMEWORKS,
): Promise<BenchmarkReport> {
  const results: FrameworkResult[] = [];

  for (const task of tasks) {
    console.log(`\n[task] ${task.name}`);
    for (const framework of frameworks) {
      process.stdout.write(`  [${framework}] running... `);
      const result = await runOne(task, framework);
      results.push(result);

      const status = result.passed ? "PASS" : "FAIL";
      const tokens = result.tokens != null ? ` ${result.tokens.toLocaleString()}tok` : "";
      const err = result.error ? ` ERR: ${result.error.slice(0, 80)}` : "";
      const time = (result.durationMs / 1000).toFixed(1);
      console.log(`[${status}] steps=${result.steps}${tokens} time=${time}s${err}`);
    }
  }

  return {
    timestamp: new Date().toISOString(),
    model: process.env.MODEL ?? "anthropic/claude-sonnet-4-6",
    results,
  };
}

async function runOne(task: BenchmarkTask, framework: Framework): Promise<FrameworkResult> {
  switch (framework) {
    case "lumen":      return runWithLumen(task);
    case "stagehand":  return runWithStagehand(task);
    case "browser-use": return runWithBrowserUse(task);
  }
}
