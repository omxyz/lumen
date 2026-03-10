import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception";
import { HistoryManager } from "../../src/loop/history";
import { StateStore } from "../../src/loop/state";
import { MockBrowserTab } from "./mock-tab";
import { MockAdapter } from "./mock-adapter";

const exampleStateData = { orderId: "12345", currentUrl: "https://example.com/step2", nextStep: "step2" };

describe("writeState action in PerceptionLoop", () => {
  it("writeState persists state that is visible in agentState", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "writeState", data: exampleStateData }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();
    const stateStore = new StateStore();

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: stateStore,
    });

    const result = await loop.run({ maxSteps: 10 });

    expect(result.agentState).toMatchObject({
      currentUrl: "https://example.com/step2",
      nextStep: "step2",
      orderId: "12345",
    });
    expect(result.status).toBe("success");
  });

  it("writeState appears in semantic step history", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "writeState", data: exampleStateData }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: new StateStore(),
    });

    const result = await loop.run({ maxSteps: 10 });

    // The first step should have agentState populated
    const firstStep = result.history[0];
    expect(firstStep?.agentState).toMatchObject({ currentUrl: "https://example.com/step2" });
  });
});
