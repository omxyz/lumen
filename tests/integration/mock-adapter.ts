import type { ModelAdapter, StepContext, ModelResponse } from "../../src/model/adapter.js";
import type { CUAAction, TaskState, WireMessage } from "../../src/types.js";

export class MockAdapter implements ModelAdapter {
  readonly modelId = "mock-model";
  readonly provider = "mock";
  readonly nativeComputerUse = false;
  readonly contextWindowTokens = 100_000;

  private actionQueue: CUAAction[][] = [];
  private stepCount = 0;

  /** Queue actions to return on successive step() calls */
  queueActions(actions: CUAAction[]): this {
    this.actionQueue.push(actions);
    return this;
  }

  /** Queue an empty (text-only) response — simulates model returning no tool_use blocks */
  queueEmptyResponse(): this {
    this.actionQueue.push([]); // empty array = no actions
    return this;
  }

  async step(_context: StepContext): Promise<ModelResponse> {
    const actions = this.actionQueue[this.stepCount] ?? [{ type: "terminate" as const, status: "success" as const, result: "done" }];
    this.stepCount++;
    return {
      actions,
      usage: { inputTokens: 100, outputTokens: actions.length === 0 ? 20 : 50 },
      rawResponse: null,
    };
  }

  private _lastStreamResponse: ModelResponse | null = null;

  getLastStreamResponse(): ModelResponse | null {
    return this._lastStreamResponse;
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    const response = await this.step(context);
    this._lastStreamResponse = response;
    for (const action of response.actions) yield action;
  }

  estimateTokens(_context: StepContext): number {
    return 1000;
  }

  async summarize(_wireHistory: WireMessage[], _currentState: TaskState | null): Promise<string> {
    return "Session summary.";
  }
}
