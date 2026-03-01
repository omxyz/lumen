import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception.js";
import { HistoryManager } from "../../src/loop/history.js";
import { FactStore } from "../../src/loop/facts.js";
import { StateStore } from "../../src/loop/state.js";
import { MockBrowserTab } from "./mock-tab.js";
import { MockAdapter } from "./mock-adapter.js";
import type { TaskState } from "../../src/types.js";

const exampleState: TaskState = {
  currentUrl: "https://example.com/step2",
  completedSteps: ["step1"],
  nextStep: "step2",
  blockers: [],
  data: { orderId: "12345" },
};

describe("writeState action in PerceptionLoop", () => {
  it("writeState persists state that is visible in finalState", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "writeState", state: exampleState }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();
    const stateStore = new StateStore();

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      facts: new FactStore(),
      state: stateStore,
    });

    const result = await loop.run({ maxSteps: 10 });

    expect(result.finalState).toMatchObject({
      currentUrl: "https://example.com/step2",
      nextStep: "step2",
      data: { orderId: "12345" },
    });
    expect(result.status).toBe("success");
  });

  it("writeState appears in semantic step history", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "writeState", state: exampleState }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      facts: new FactStore(),
      state: new StateStore(),
    });

    const result = await loop.run({ maxSteps: 10 });

    // The first step should have taskStateAfter populated
    const firstStep = result.history[0];
    expect(firstStep?.taskStateAfter).toMatchObject({ currentUrl: "https://example.com/step2" });
  });
});
