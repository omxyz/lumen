import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception.js";
import { HistoryManager } from "../../src/loop/history.js";
import { FactStore } from "../../src/loop/facts.js";
import { StateStore } from "../../src/loop/state.js";
import { CustomGate } from "../../src/loop/gate.js";
import { MockBrowserTab } from "./mock-tab.js";
import { MockAdapter } from "./mock-adapter.js";

describe("CompletionGate integration in PerceptionLoop", () => {
  it("rejects terminate when gate fails and loop continues", async () => {
    const adapter = new MockAdapter();
    // First step: try to terminate (gate will reject)
    adapter.queueActions([{ type: "terminate", status: "success", result: "done too early" }]);
    // Second step: terminate again (gate will pass this time)
    adapter.queueActions([{ type: "terminate", status: "success", result: "actually done" }]);

    const tab = new MockBrowserTab();
    let gateCallCount = 0;
    // Gate fails first time, passes second time
    const gate = new CustomGate(async () => {
      gateCallCount++;
      return gateCallCount > 1;
    }, "not ready yet");

    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab,
      adapter,
      history,
      facts: new FactStore(),
      state: new StateStore(),
      gate,
    });

    const result = await loop.run({ maxSteps: 10 });

    // Should succeed on the second terminate
    expect(result.status).toBe("success");
    expect(result.result).toBe("actually done");
    expect(result.steps).toBe(2);
    expect(gateCallCount).toBe(2);
  });

  it("accepts terminate immediately when gate passes", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "terminate", status: "success", result: "task complete" }]);

    const tab = new MockBrowserTab();
    const gate = new CustomGate(async () => true);

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      facts: new FactStore(),
      state: new StateStore(),
      gate,
    });

    const result = await loop.run({ maxSteps: 5 });
    expect(result.status).toBe("success");
    expect(result.steps).toBe(1);
  });
});
