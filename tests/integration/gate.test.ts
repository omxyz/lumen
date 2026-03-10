import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception";
import { HistoryManager } from "../../src/loop/history";
import { StateStore } from "../../src/loop/state";
import { CustomGate } from "../../src/loop/verifier";
import { MockBrowserTab } from "./mock-tab";
import { MockAdapter } from "./mock-adapter";

describe("Verifier integration in PerceptionLoop", () => {
  it("rejects terminate when verifier fails and loop continues", async () => {
    const adapter = new MockAdapter();
    // First step: try to terminate (verifier will reject)
    adapter.queueActions([{ type: "terminate", status: "success", result: "done too early" }]);
    // Second step: terminate again (verifier will pass this time)
    adapter.queueActions([{ type: "terminate", status: "success", result: "actually done" }]);

    const tab = new MockBrowserTab();
    let verifierCallCount = 0;
    // Verifier fails first time, passes second time
    const verifier = new CustomGate(async () => {
      verifierCallCount++;
      return verifierCallCount > 1;
    }, "not ready yet");

    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab,
      adapter,
      history,
      state: new StateStore(),
      verifier,
    });

    const result = await loop.run({ maxSteps: 10 });

    // Should succeed on the second terminate
    expect(result.status).toBe("success");
    expect(result.result).toBe("actually done");
    expect(result.steps).toBe(2);
    expect(verifierCallCount).toBe(2);
  });

  it("accepts terminate immediately when verifier passes", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "terminate", status: "success", result: "task complete" }]);

    const tab = new MockBrowserTab();
    const verifier = new CustomGate(async () => true);

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: new StateStore(),
      verifier,
    });

    const result = await loop.run({ maxSteps: 5 });
    expect(result.status).toBe("success");
    expect(result.steps).toBe(1);
  });
});
