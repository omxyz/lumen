import type { BrowserTab } from "../browser/tab.js";
import type { ModelAdapter } from "../model/adapter.js";
import { HistoryManager } from "./history.js";
import { StateStore } from "./state.js";
import { PerceptionLoop } from "./perception.js";

export interface ChildLoopOptions {
  maxSteps?: number;  // default: 20
}

export interface ChildLoopResult {
  status: "success" | "failure" | "maxSteps";
  result: string;
  steps: number;
}

export class ChildLoop {
  static async run(
    instruction: string,
    parent: { tab: BrowserTab; adapter: ModelAdapter },
    options: ChildLoopOptions = {},
  ): Promise<ChildLoopResult> {
    const maxSteps = options.maxSteps ?? 20;

    const history = new HistoryManager(parent.adapter.contextWindowTokens);
    const stateStore = new StateStore();

    const loop = new PerceptionLoop({
      tab: parent.tab,
      adapter: parent.adapter,
      history,
      state: stateStore,
    });

    const loopResult = await loop.run({
      maxSteps,
      systemPrompt: `Sub-task: ${instruction}\n\nCall terminate when done.`,
    });

    return {
      status: loopResult.status,
      result: loopResult.result,
      steps: loopResult.steps,
    };
  }
}
