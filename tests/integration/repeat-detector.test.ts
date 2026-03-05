import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception.js";
import { HistoryManager } from "../../src/loop/history.js";
import { StateStore } from "../../src/loop/state.js";
import { MockBrowserTab } from "./mock-tab.js";
import { MockAdapter } from "./mock-adapter.js";

describe("RepeatDetector integration", () => {
  it("agent self-corrects after repeat nudge", async () => {
    const adapter = new MockAdapter();
    // Queue 6 identical click actions (triggers nudge at 5)
    for (let i = 0; i < 6; i++) {
      adapter.queueActions([{ type: "click", x: 500, y: 500 }]);
    }
    // After nudge, model terminates (simulating self-correction)
    adapter.queueActions([{ type: "terminate", status: "success", result: "recovered" }]);

    const tab = new MockBrowserTab();
    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab,
      adapter,
      history,
      state: new StateStore(),
    });

    const result = await loop.run({ maxSteps: 10 });
    expect(result.status).toBe("success");
    expect(result.result).toBe("recovered");
    // Should have taken 7 steps: 6 repeated clicks + 1 terminate
    expect(result.steps).toBe(7);
  });

  it("reaches maxSteps if agent never self-corrects", async () => {
    const adapter = new MockAdapter();
    // Queue infinite identical clicks — never terminates
    for (let i = 0; i < 20; i++) {
      adapter.queueActions([{ type: "click", x: 500, y: 500 }]);
    }

    const tab = new MockBrowserTab();
    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab,
      adapter,
      history,
      state: new StateStore(),
    });

    const result = await loop.run({ maxSteps: 10 });
    expect(result.status).toBe("maxSteps");
    expect(result.steps).toBe(10);
  });
});
