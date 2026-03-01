import { describe, it, expect } from "vitest";
import { ChildLoop } from "../../src/loop/child.js";
import { MockBrowserTab } from "./mock-tab.js";
import { MockAdapter } from "./mock-adapter.js";

describe("ChildLoop", () => {
  it("returns success when child terminates successfully", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "terminate", status: "success", result: "subtask done" }]);
    const tab = new MockBrowserTab();
    const result = await ChildLoop.run(
      "Do subtask",
      { tab, adapter, parentFacts: ["parent fact"] },
      { maxSteps: 5 },
    );
    expect(result.status).toBe("success");
    expect(result.steps).toBe(1);
  });

  it("bubbles back facts discovered by child", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "memorize", fact: "child discovered this" }]);
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);
    const tab = new MockBrowserTab();
    const result = await ChildLoop.run(
      "Find a fact",
      { tab, adapter, parentFacts: ["parent fact"] },
      { maxSteps: 5 },
    );
    expect(result.factsDiscovered).toContain("child discovered this");
  });

  it("does not include parent facts in factsDiscovered", async () => {
    const adapter = new MockAdapter();
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);
    const tab = new MockBrowserTab();
    const result = await ChildLoop.run(
      "Just terminate",
      { tab, adapter, parentFacts: ["existing parent fact"] },
      { maxSteps: 5 },
    );
    expect(result.factsDiscovered).not.toContain("existing parent fact");
  });

  it("maxSteps status when child does not terminate", async () => {
    const adapter = new MockAdapter();
    for (let i = 0; i < 3; i++) adapter.queueActions([{ type: "screenshot" }]);
    const tab = new MockBrowserTab();
    const result = await ChildLoop.run(
      "Never terminate",
      { tab, adapter, parentFacts: [] },
      { maxSteps: 2 },
    );
    expect(result.status).toBe("maxSteps");
  });
});
