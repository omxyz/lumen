import type { RunResult } from "../src/types.js";

export interface EvalTask {
  name: string;
  instruction: string;
  url: string;
  maxSteps?: number;
  score(result: RunResult): number;  // 0.0 to 1.0
}

export interface EvalResult {
  task: string;
  passed: boolean;
  score: number;
  steps: number;
  totalTokens: number;
  status: RunResult["status"];
  durationMs: number;
}

export async function runEval(
  task: EvalTask,
  runAgent: (instruction: string, url: string, maxSteps: number) => Promise<RunResult>,
): Promise<EvalResult> {
  const start = Date.now();
  const result = await runAgent(task.instruction, task.url, task.maxSteps ?? 30);
  const score = task.score(result);
  return {
    task: task.name,
    passed: score >= 0.5,
    score,
    steps: result.steps,
    totalTokens: result.tokenUsage.inputTokens + result.tokenUsage.outputTokens,
    status: result.status,
    durationMs: Date.now() - start,
  };
}

export function printEvalReport(results: EvalResult[]): void {
  console.log("\n=== Lumen Eval Report ===");
  for (const r of results) {
    const icon = r.passed ? "PASS" : "FAIL";
    console.log(`[${icon}] ${r.task}: score=${r.score.toFixed(2)}, steps=${r.steps}, tokens=${r.totalTokens}, status=${r.status}`);
  }
  const passed = results.filter((r) => r.passed).length;
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length;
  console.log(`\nPassed: ${passed}/${results.length}, avg score: ${avgScore.toFixed(2)}`);
}
