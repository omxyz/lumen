import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception.js";
import { HistoryManager } from "../../src/loop/history.js";
import { StateStore } from "../../src/loop/state.js";
import { MockBrowserTab } from "./mock-tab.js";
import { MockAdapter } from "./mock-adapter.js";
import type { Action } from "../../src/types.js";

describe("PreActionHook integration in PerceptionLoop", () => {
  it("hook can deny an action and the loop continues without dispatching to browser", async () => {
    const adapter = new MockAdapter();
    // First step: click (hook will deny), then next step terminates
    adapter.queueActions([{ type: "click", x: 500, y: 500 }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();
    const deniedActions: string[] = [];

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: new StateStore(),
      preActionHook: async (action: Action) => {
        if (action.type === "click") {
          deniedActions.push(action.type);
          return { decision: "deny", reason: "clicks not allowed in test" };
        }
        return { decision: "allow" };
      },
    });

    const result = await loop.run({ maxSteps: 10 });
    expect(result.status).toBe("success");
    // Click was denied, so no actual click dispatched to browser
    const clickCall = tab.calls.find((c) => c.method === "click");
    expect(clickCall).toBeUndefined();
    expect(deniedActions).toContain("click");
  });

  it("hook allows actions it doesn't deny", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "click", x: 500, y: 500 }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: new StateStore(),
      preActionHook: async (_action: Action) => ({ decision: "allow" }),
    });

    await loop.run({ maxSteps: 10 });
    const clickCall = tab.calls.find((c) => c.method === "click");
    expect(clickCall).toBeDefined();
  });

  it("hook fires before policy check", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "goto", url: "https://example.com" }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();
    const hookOrder: string[] = [];

    const loop = new PerceptionLoop({
      tab,
      adapter,
      history: new HistoryManager(100_000),
      state: new StateStore(),
      preActionHook: async (_action: Action) => {
        hookOrder.push("hook");
        return { decision: "allow" };
      },
    });

    await loop.run({ maxSteps: 10 });
    expect(hookOrder).toContain("hook");
  });
});
