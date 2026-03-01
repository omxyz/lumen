import type { BrowserTab } from "../browser/tab.js";
import type { ModelAdapter } from "../model/adapter.js";
import { HistoryManager } from "./history.js";
import { StateStore } from "./state.js";
import { FactStore } from "./facts.js";
import { PerceptionLoop } from "./perception.js";

export interface ChildLoopOptions {
  maxSteps?: number;  // default: 20
}

export interface ChildLoopResult {
  status: "success" | "failure" | "maxSteps";
  result: string;
  factsDiscovered: string[];
  steps: number;
}

export class ChildLoop {
  static async run(
    instruction: string,
    parent: { tab: BrowserTab; adapter: ModelAdapter; parentFacts: string[] },
    options: ChildLoopOptions = {},
  ): Promise<ChildLoopResult> {
    const maxSteps = options.maxSteps ?? 20;

    // Fresh stores for child
    const history = new HistoryManager(parent.adapter.contextWindowTokens);
    const stateStore = new StateStore();
    const factStore = new FactStore();

    // Pre-load parent facts as read-only anchor
    const initialSnapshot = [...parent.parentFacts];
    factStore.load(initialSnapshot);

    const loop = new PerceptionLoop({
      tab: parent.tab,
      adapter: parent.adapter,
      history,
      facts: factStore,
      state: stateStore,
    });

    const loopResult = await loop.run({
      maxSteps,
      systemPrompt: `Sub-task: ${instruction}\n\nCall terminate when done.`,
    });

    // Facts discovered by child = facts in store that weren't in initial snapshot
    const allFacts = factStore.all();
    const factsDiscovered = allFacts.filter((f) => !initialSnapshot.includes(f));

    return {
      status: loopResult.status,
      result: loopResult.result,
      factsDiscovered,
      steps: loopResult.steps,
    };
  }
}
