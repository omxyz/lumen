import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception";
import { HistoryManager } from "../../src/loop/history";
import { StateStore } from "../../src/loop/state";
import { MockBrowserTab } from "./mock-tab";
import { MockAdapter } from "./mock-adapter";
import type { StepContext, ModelResponse } from "../../src/model/adapter";
import type { Action, TaskState, WireMessage } from "../../src/types";

/** Adapter that returns high token counts to trigger compaction, then terminates. */
class HighTokenAdapter {
  readonly modelId = "high-token-model";
  readonly provider = "test";
  readonly nativeComputerUse = false;
  readonly contextWindowTokens = 100_000;

  private stepIndex = 0;
  compactionCalled = false;
  private _lastResponse: ModelResponse | null = null;

  private readonly steps: Action[][] = [
    [{ type: "screenshot" }],
    [{ type: "terminate", status: "success", result: "done" }],
  ];

  async step(_context: StepContext): Promise<ModelResponse> {
    const actions = this.steps[this.stepIndex] ?? [{ type: "terminate" as const, status: "success" as const, result: "done" }];
    this.stepIndex++;
    const response: ModelResponse = {
      actions,
      usage: { inputTokens: 90_000, outputTokens: 1_000 },
      rawResponse: null,
    };
    this._lastResponse = response;
    return response;
  }

  async *stream(context: StepContext): AsyncIterable<Action> {
    const response = await this.step(context);
    for (const action of response.actions) yield action;
  }

  estimateTokens(_context: StepContext): number {
    return 90_000;
  }

  async summarize(_wireHistory: WireMessage[], _currentState: TaskState | null): Promise<string> {
    this.compactionCalled = true;
    return "Compacted summary.";
  }

  /** Required for PerceptionLoop to pick up token usage via getLastStreamResponse(). */
  getLastStreamResponse(): ModelResponse | null {
    return this._lastResponse;
  }
}

describe("Compaction integration in PerceptionLoop", () => {
  it("triggers compaction when tokenUtilization exceeds threshold", async () => {
    const adapter = new HighTokenAdapter();
    const tab = new MockBrowserTab();
    let compactionEventFired = false;

    const loop = new PerceptionLoop({
      tab,
      adapter: adapter as unknown as import("../../src/model/adapter.js").ModelAdapter,
      history: new HistoryManager(100_000), // 100k context, 90k tokens = 90% utilization
      state: new StateStore(),
      monitor: {
        stepStarted() {},
        stepCompleted() {},
        actionExecuted() {},
        actionBlocked() {},
        terminationRejected() {},
        compactionTriggered() { compactionEventFired = true; },
        terminated() {},
        error() {},
      },
    });

    await loop.run({ maxSteps: 5, compactionThreshold: 0.8 });

    // After step 0 runs (90k tokens appended), step 1 check fires compaction (90% > 80%)
    expect(compactionEventFired).toBe(true);
    expect(adapter.compactionCalled).toBe(true);
  });

  it("does not trigger compaction below threshold", async () => {
    const adapter = new MockAdapter(); // low token usage (100 tokens per step)
    adapter.queueActions([{ type: "screenshot" }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();
    let compactionEventFired = false;

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: new StateStore(),
      monitor: {
        stepStarted() {},
        stepCompleted() {},
        actionExecuted() {},
        actionBlocked() {},
        terminationRejected() {},
        compactionTriggered() { compactionEventFired = true; },
        terminated() {},
        error() {},
      },
    });

    await loop.run({ maxSteps: 5, compactionThreshold: 0.8 });
    // MockAdapter uses only 100 tokens per step; 100/100_000 = 0.1% << 80% threshold
    expect(compactionEventFired).toBe(false);
  });
});
