import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception";
import { HistoryManager } from "../../src/loop/history";
import { StateStore } from "../../src/loop/state";
import { SessionPolicy } from "../../src/loop/policy";
import { MockBrowserTab } from "./mock-tab";
import { MockAdapter } from "./mock-adapter";

function makeLoop(adapter: MockAdapter, tab: MockBrowserTab, policy?: SessionPolicy) {
  const history = new HistoryManager(100_000);
  const state = new StateStore();
  return new PerceptionLoop({ tab, adapter, history, state, policy });
}

describe("PerceptionLoop", () => {
  it("terminates on terminate action", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "terminate", status: "success", result: "task done" }]);
    const tab = new MockBrowserTab();
    const loop = makeLoop(adapter, tab);
    const result = await loop.run({ maxSteps: 10 });
    expect(result.status).toBe("success");
    expect(result.result).toBe("task done");
    expect(result.steps).toBe(1);
  });

  it("exits with maxSteps when no terminate", async () => {
    const adapter = new MockAdapter();
    // Queue screenshot actions that never terminate
    for (let i = 0; i < 5; i++) {
      adapter.queueActions([{ type: "screenshot" }]);
    }
    const tab = new MockBrowserTab();
    const loop = makeLoop(adapter, tab);
    const result = await loop.run({ maxSteps: 3 });
    expect(result.status).toBe("maxSteps");
    expect(result.steps).toBe(3);
  });

  it("records semantic steps", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "click", x: 500, y: 500 }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);
    const tab = new MockBrowserTab();
    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab, adapter, history, state: new StateStore(),
    });
    const result = await loop.run({ maxSteps: 10 });
    expect(result.history.length).toBeGreaterThan(0);
  });

  it("policy blocks goto action", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "goto", url: "https://blocked.com" }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);
    const tab = new MockBrowserTab();
    const policy = new SessionPolicy({ blockedDomains: ["blocked.com"] });
    const loop = makeLoop(adapter, tab, policy);
    const result = await loop.run({ maxSteps: 10 });
    // The goto should be blocked but loop should continue and eventually terminate
    const gotoCall = tab.calls.find((c) => c.method === "goto");
    expect(gotoCall).toBeUndefined(); // goto was blocked, never called on tab
    expect(result.status).toBe("success");
  });
});
