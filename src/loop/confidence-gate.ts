import type { ModelAdapter, StepContext, ModelResponse } from "../model/adapter.js";
import type { Action } from "../types.js";

export interface ConfidenceGateOptions {
  adapter: ModelAdapter;
  /** Number of candidate samples on hard steps. Default: 3 */
  samples?: number;
}

/**
 * CATTS-inspired confidence gate.
 * On easy steps: single model call (zero overhead).
 * On hard steps: sample N candidates, compare. If unanimous → use first.
 * If split → pick the majority or fall back to first sample.
 */
export class ConfidenceGate {
  private readonly adapter: ModelAdapter;
  private readonly samples: number;

  constructor(opts: ConfidenceGateOptions) {
    this.adapter = opts.adapter;
    this.samples = opts.samples ?? 3;
  }

  /**
   * Determine if this is a "hard" step where multi-sampling helps.
   */
  isHardStep(pendingNudge: string | undefined, lastOutcomeFailed: boolean): boolean {
    return Boolean(pendingNudge) || lastOutcomeFailed;
  }

  /**
   * On easy steps, delegates to adapter.step() directly.
   * On hard steps, samples N candidates and picks the best.
   */
  async decide(context: StepContext, isHard: boolean): Promise<ModelResponse> {
    if (!isHard) {
      return this.adapter.step(context);
    }

    // Sample N candidates with varied temperature
    const candidates: ModelResponse[] = [];
    const temps = [0.3, 0.7, 0.9].slice(0, this.samples);

    for (const temp of temps) {
      const ctx: StepContext = { ...context, temperature: temp };
      const response = await this.adapter.step(ctx);
      candidates.push(response);
    }

    // Check agreement: do all candidates agree on the first action?
    const firstActions = candidates.map((c) => c.actions[0]).filter(Boolean) as Action[];
    if (firstActions.length === 0) return candidates[0]!;

    const allAgree = firstActions.every((a) => actionsMatch(a, firstActions[0]!));
    if (allAgree) {
      // Unanimous — return first candidate (cheapest temperature)
      return mergeUsage(candidates[0]!, candidates);
    }

    // Disagreement — pick majority action
    const actionCounts = new Map<string, { count: number; index: number }>();
    for (let i = 0; i < firstActions.length; i++) {
      const key = actionKey(firstActions[i]!);
      const existing = actionCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        actionCounts.set(key, { count: 1, index: i });
      }
    }

    // Pick the action with highest count (ties go to first seen)
    let bestIndex = 0;
    let bestCount = 0;
    for (const { count, index } of actionCounts.values()) {
      if (count > bestCount) {
        bestCount = count;
        bestIndex = index;
      }
    }

    return mergeUsage(candidates[bestIndex]!, candidates);
  }
}

/** Bucket coordinates to 64px grid for comparison */
function bucket(n: number): number {
  return Math.round(n / 64) * 64;
}

/** Generate a comparison key for an action */
function actionKey(action: Action): string {
  switch (action.type) {
    case "click":
      return `click:${bucket(action.x)},${bucket(action.y)}`;
    case "doubleClick":
      return `dblclick:${bucket(action.x)},${bucket(action.y)}`;
    case "type":
      return `type:${action.text.slice(0, 50)}`;
    case "keyPress":
      return `key:${action.keys.join("+")}`;
    case "goto":
      return `goto:${action.url}`;
    case "scroll":
      return `scroll:${action.direction}`;
    case "terminate":
      return `terminate:${action.result.slice(0, 50)}`;
    case "writeState":
      return `writeState`;
    case "hover":
      return `hover:${bucket(action.x)},${bucket(action.y)}`;
    default:
      return action.type;
  }
}

/** Check if two actions are functionally equivalent */
function actionsMatch(a: Action, b: Action): boolean {
  return actionKey(a) === actionKey(b);
}

/** Merge token usage from all candidates into the chosen one */
function mergeUsage(chosen: ModelResponse, all: ModelResponse[]): ModelResponse {
  const totalInput = all.reduce((sum, c) => sum + c.usage.inputTokens, 0);
  const totalOutput = all.reduce((sum, c) => sum + c.usage.outputTokens, 0);
  return {
    ...chosen,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
  };
}
