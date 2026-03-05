import type { RunResult } from "../src/types.js";

/** 1.0 if result text contains all keywords, 0.0 otherwise */
export function exactMatch(keywords: string[]): (result: RunResult) => number {
  return (result: RunResult) => {
    const text = result.result.toLowerCase();
    const allMatch = keywords.every((kw) => text.includes(kw.toLowerCase()));
    return allMatch ? 1.0 : 0.0;
  };
}

/** 1.0 if completed in <= targetSteps, linearly decaying to 0.0 at 2x targetSteps */
export function stepCount(targetSteps: number): (result: RunResult) => number {
  return (result: RunResult) => {
    if (result.status !== "success") return 0.0;
    if (result.steps <= targetSteps) return 1.0;
    const ratio = result.steps / (targetSteps * 2);
    return Math.max(0, 1 - ratio);
  };
}

/** 1.0 if total tokens <= tokenBudget, linearly decaying to 0.0 at 2x budget */
export function tokenUsage(tokenBudget: number): (result: RunResult) => number {
  return (result: RunResult) => {
    const total = result.tokenUsage.inputTokens + result.tokenUsage.outputTokens;
    if (total <= tokenBudget) return 1.0;
    const ratio = total / (tokenBudget * 2);
    return Math.max(0, 1 - ratio);
  };
}
