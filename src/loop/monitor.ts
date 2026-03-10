import type { Action, LoopResult, SemanticStep } from "../types";
import type { ActionExecution } from "../types";
import type { ModelResponse } from "../model/adapter";
import type { StepContext } from "../model/adapter";

export interface LoopMonitor {
  stepStarted(step: number, context: StepContext): void;
  stepCompleted(step: number, response: ModelResponse): void;
  actionExecuted(step: number, action: Action, outcome: ActionExecution): void;
  actionBlocked(step: number, action: Action, reason: string): void;
  terminationRejected(step: number, reason: string): void;
  compactionTriggered(step: number, tokensBefore: number, tokensAfter: number): void;
  terminated(result: LoopResult): void;
  error(err: Error): void;
}

export class ConsoleMonitor implements LoopMonitor {
  stepStarted(step: number, context: StepContext): void {
    console.log(`[lumen] step ${step + 1}/${context.maxSteps} — ${context.url}`);
  }

  stepCompleted(step: number, response: ModelResponse): void {
    console.log(
      `[lumen] step ${step + 1} complete — ${response.actions.length} action(s), ${response.usage.inputTokens} input tokens`,
    );
  }

  actionExecuted(step: number, action: Action, outcome: ActionExecution): void {
    if (!outcome.ok) {
      console.warn(`[lumen] step ${step + 1} action "${action.type}" failed: ${outcome.error}`);
    }
  }

  actionBlocked(step: number, action: Action, reason: string): void {
    console.warn(`[lumen] step ${step + 1} action "${action.type}" blocked: ${reason}`);
  }

  terminationRejected(step: number, reason: string): void {
    console.warn(`[lumen] step ${step + 1} termination rejected: ${reason}`);
  }

  compactionTriggered(step: number, tokensBefore: number, tokensAfter: number): void {
    console.log(
      `[lumen] step ${step + 1} compaction — ${tokensBefore} → ${tokensAfter} tokens`,
    );
  }

  terminated(result: LoopResult): void {
    console.log(`[lumen] done — status: ${result.status}, steps: ${result.steps}`);
    console.log(`[lumen] result: ${result.result}`);
  }

  error(err: Error): void {
    console.error(`[lumen] error: ${err.message}`);
  }
}

export class NoopMonitor implements LoopMonitor {
  stepStarted(): void {}
  stepCompleted(): void {}
  actionExecuted(): void {}
  actionBlocked(): void {}
  terminationRejected(): void {}
  compactionTriggered(): void {}
  terminated(): void {}
  error(): void {}
}
