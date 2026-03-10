import { describe, it, expect } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception";
import { HistoryManager } from "../../src/loop/history";
import { StateStore } from "../../src/loop/state";
import { SessionPolicy } from "../../src/loop/policy";
import { MockBrowserTab } from "./mock-tab";
import { MockAdapter } from "./mock-adapter";

describe("Policy integration within loop", () => {
  it("blocked action is not dispatched to browser", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "goto", url: "https://evil.com/page" }]);
    adapter.queueActions([{ type: "terminate", status: "failure", result: "could not navigate" }]);
    const tab = new MockBrowserTab();
    const policy = new SessionPolicy({ blockedDomains: ["evil.com"] });
    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab, adapter, history,
      state: new StateStore(),
      policy,
    });
    await loop.run({ maxSteps: 5 });
    const gotoCall = tab.calls.find((c) => c.method === "goto");
    expect(gotoCall).toBeUndefined();
  });

  it("allowed action passes through policy", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "goto", url: "https://allowed.com/page" }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);
    const tab = new MockBrowserTab();
    const policy = new SessionPolicy({ allowedDomains: ["allowed.com"] });
    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab, adapter, history,
      state: new StateStore(),
      policy,
    });
    await loop.run({ maxSteps: 5 });
    const gotoCall = tab.calls.find((c) => c.method === "goto");
    expect(gotoCall).toBeDefined();
    expect(gotoCall?.args[0]).toBe("https://allowed.com/page");
  });
});
