import { Agent } from "../../../src/index.js";
import type { BenchmarkTask, FrameworkResult } from "../types.js";

function resolveModelAndKey(): { model: string; apiKey: string | undefined } {
  const model = process.env.MODEL ?? "anthropic/claude-sonnet-4-6";
  const apiKey = model.startsWith("google/")
    ? (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
    : process.env.ANTHROPIC_API_KEY;
  return { model, apiKey };
}

export async function runWithLumen(task: BenchmarkTask): Promise<FrameworkResult> {
  const start = Date.now();
  const { model, apiKey } = resolveModelAndKey();
  try {
    const agentResult = await Agent.run({
      model,
      apiKey,
      browser: { type: "local" },
      startUrl: task.startUrl,
      instruction: task.instruction,
      maxSteps: task.maxSteps,
      verbose: 0,
    });

    // Only mark as passed if the agent explicitly succeeded (not maxSteps/failure)
    const { passed, score } = agentResult.status === "success"
      ? task.check(agentResult.result)
      : { passed: false, score: 0 };
    return {
      framework: "lumen",
      task: task.name,
      passed,
      score,
      steps: agentResult.steps,
      tokens: agentResult.tokenUsage.inputTokens + agentResult.tokenUsage.outputTokens,
      durationMs: Date.now() - start,
      result: agentResult.status === "success" ? agentResult.result : `[${agentResult.status}] ${agentResult.result}`,
    };
  } catch (e) {
    return {
      framework: "lumen",
      task: task.name,
      passed: false,
      score: 0,
      steps: 0,
      tokens: null,
      durationMs: Date.now() - start,
      result: "",
      error: String(e),
    };
  }
}
