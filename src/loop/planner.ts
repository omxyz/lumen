import type { ModelAdapter } from "../model/adapter";
import type { ScreenshotResult } from "../types";

export async function runPlanner(
  instruction: string,
  screenshot: ScreenshotResult,
  adapter: ModelAdapter,
): Promise<string> {
  const response = await adapter.step({
    screenshot,
    wireHistory: [],
    agentState: null,
    stepIndex: 0,
    maxSteps: 1,
    url: "",
    systemPrompt: [
      "You are a task planner. Given the current screenshot and instruction, produce a numbered step-by-step plan.",
      "Be concise. Output ONLY the numbered plan, no other text.",
      `Instruction: ${instruction}`,
    ].join("\n"),
  });

  // Try to extract text from thinking or from action reasoning
  if (response.thinking) return response.thinking;

  // Fallback: generate a generic plan
  return `Plan for: ${instruction}\n1. Analyze the current screen\n2. Execute the required steps\n3. Verify completion and terminate`;
}
