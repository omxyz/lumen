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
      { tab, adapter },
      { maxSteps: 5 },
    );
    expect(result.status).toBe("success");
    expect(result.steps).toBe(1);
  });

  it("maxSteps status when child does not terminate", async () => {
    const adapter = new MockAdapter();
    for (let i = 0; i < 3; i++) adapter.queueActions([{ type: "screenshot" }]);
    const tab = new MockBrowserTab();
    const result = await ChildLoop.run(
      "Never terminate",
      { tab, adapter },
      { maxSteps: 2 },
    );
    expect(result.status).toBe("maxSteps");
  });
});
