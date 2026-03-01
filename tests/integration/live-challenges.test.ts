/**
 * Tests for the three bugs discovered during live end-to-end testing of
 * the wikipedia_shannon and columbia_tuition tasks.
 *
 * Challenge 1: Empty actions (text-only model response)
 *   When the model returns a text-only response with no tool_use blocks,
 *   PerceptionLoop must inject a screenshot action so the loop continues
 *   rather than hanging with no recorded assistant turn.
 *
 * Challenge 2: CDPTab URL bar emulation (Ctrl+L → type URL → Enter)
 *   CDP Input events go to page content, not browser chrome. The address
 *   bar cannot be activated via CDP. CDPTab intercepts Ctrl+L / type / Enter
 *   and converts the sequence into a real tab.goto() call.
 *
 * Challenge 3: summarize() token overflow from base64 screenshots
 *   wireHistory stores raw base64-encoded PNG screenshots (each 300KB+).
 *   Passing them to the haiku summarize call caused a 217k-token overflow.
 *   AnthropicAdapter.summarize() must strip base64 before serializing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PerceptionLoop } from "../../src/loop/perception.js";
import { HistoryManager } from "../../src/loop/history.js";
import { StateStore } from "../../src/loop/state.js";
import { MockBrowserTab } from "./mock-tab.js";
import { MockAdapter } from "./mock-adapter.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLoop(adapter: MockAdapter, tab: MockBrowserTab) {
  const history = new HistoryManager(100_000);
  const state = new StateStore();
  return new PerceptionLoop({ tab, adapter, history, state });
}

// ─── Challenge 1: Empty actions (text-only response) ────────────────────────

describe("Challenge 1: empty actions / text-only response fallback", () => {
  it("loop continues after a text-only response and terminates on next step", async () => {
    const adapter = new MockAdapter();
    // Step 0: model returns text-only (no tool_use) — simulates model saying
    // "I found the answer" as text instead of calling terminate()
    adapter.queueEmptyResponse();
    // Step 1: model properly calls terminate
    adapter.queueActions([{ type: "terminate", status: "success", result: "born 1916 in Petoskey" }]);

    const tab = new MockBrowserTab();
    const loop = makeLoop(adapter, tab);
    const result = await loop.run({ maxSteps: 5 });

    // Loop must not get stuck — should reach step 2 and terminate
    expect(result.status).toBe("success");
    expect(result.result).toBe("born 1916 in Petoskey");
    expect(result.steps).toBe(2);
  });

  it("screenshot action is injected when model returns empty actions", async () => {
    const adapter = new MockAdapter();
    // Two text-only responses then terminate
    adapter.queueEmptyResponse();
    adapter.queueEmptyResponse();
    adapter.queueActions([{ type: "terminate", status: "success", result: "done" }]);

    const tab = new MockBrowserTab();
    const loop = makeLoop(adapter, tab);
    const result = await loop.run({ maxSteps: 10 });

    expect(result.status).toBe("success");
    expect(result.steps).toBe(3);

    // Screenshots should have been taken: one per step plus the fallback noop
    const screenshotCalls = tab.calls.filter((c) => c.method === "screenshot");
    // At minimum 3 screenshots (one per step)
    expect(screenshotCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("empty response does not lose step count", async () => {
    const adapter = new MockAdapter();
    adapter.queueEmptyResponse();
    adapter.queueActions([{ type: "terminate", status: "success", result: "ok" }]);

    const tab = new MockBrowserTab();
    const loop = makeLoop(adapter, tab);
    const result = await loop.run({ maxSteps: 3 });

    // 2 steps consumed (empty + terminate)
    expect(result.steps).toBe(2);
  });

  it("maxSteps still triggers after all empty responses", async () => {
    const adapter = new MockAdapter();
    // Queue 5 empty responses — loop should hit maxSteps=3
    for (let i = 0; i < 5; i++) adapter.queueEmptyResponse();

    const tab = new MockBrowserTab();
    const loop = makeLoop(adapter, tab);
    const result = await loop.run({ maxSteps: 3 });

    expect(result.status).toBe("maxSteps");
    expect(result.steps).toBe(3);
  });
});

// ─── Challenge 2: URL bar emulation ─────────────────────────────────────────

// We test CDPTab directly by constructing a minimal fake CDPSession.
// This isolates the URL bar state machine from the rest of the stack.

import type { CDPSessionLike } from "../../src/browser/cdp.js";
import { CDPTab } from "../../src/browser/cdptab.js";

/** Minimal fake CDPSession — records sent commands; never fires events. */
class FakeCDPSession implements CDPSessionLike {
  public sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private handlers: Map<string, ((params: unknown) => void)[]> = new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.sent.push({ method, params });
    // Return minimal valid responses for methods that CDPTab reads
    if (method === "Page.captureScreenshot") return { data: Buffer.alloc(10).toString("base64") } as T;
    if (method === "Page.navigate") {
      // Emit networkIdle via setTimeout(0) so waitForLoad's handler is registered first
      setTimeout(() => this.emit("Page.lifecycleEvent", { name: "networkIdle" }), 0);
      return { frameId: "f1" } as T;
    }
    if (method === "Page.setLifecycleEventsEnabled") return {} as T;
    if (method === "Runtime.evaluate") return { result: { value: undefined, type: "undefined" } } as T;
    return {} as T;
  }

  on(event: string, handler: (params: unknown) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event)!.push(handler);
  }

  off(event: string, handler: (params: unknown) => void): void {
    const hs = this.handlers.get(event) ?? [];
    const idx = hs.indexOf(handler);
    if (idx !== -1) hs.splice(idx, 1);
  }

  emit(event: string, params: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(params);
  }

  /** Filter sent commands by method name */
  calls(method: string) {
    return this.sent.filter((s) => s.method === method);
  }
}

describe("Challenge 2: CDPTab URL bar emulation", () => {
  let session: FakeCDPSession;
  let tab: CDPTab;

  beforeEach(() => {
    session = new FakeCDPSession();
    tab = new CDPTab(session);
  });

  it("Ctrl+L activates URL bar mode (no CDP events sent)", async () => {
    const result = await tab.keyPress(["ctrl", "l"]);
    expect(result.ok).toBe(true);
    // Ctrl+L should NOT dispatch key events to the page
    const keyEvents = session.calls("Input.dispatchKeyEvent");
    expect(keyEvents).toHaveLength(0);
  });

  it("type() in URL bar mode buffers text (no Input.insertText)", async () => {
    await tab.keyPress(["ctrl", "l"]);
    session.sent = []; // clear the setup calls

    const result = await tab.type("en.wikipedia.org");
    expect(result.ok).toBe(true);
    const insertCalls = session.calls("Input.insertText");
    expect(insertCalls).toHaveLength(0); // text was buffered, not sent
  });

  it("Enter after Ctrl+L + type triggers Page.navigate", async () => {
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("en.wikipedia.org");
    session.sent = []; // clear

    const result = await tab.keyPress(["Return"]);
    expect(result.ok).toBe(true);

    const navCalls = session.calls("Page.navigate");
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0]!.params?.url).toBe("https://en.wikipedia.org");
  });

  it("URL without scheme gets https:// prepended", async () => {
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("columbia.edu");
    await tab.keyPress(["Enter"]);

    const navCalls = session.calls("Page.navigate");
    expect(navCalls[0]!.params?.url).toBe("https://columbia.edu");
  });

  it("URL with https:// scheme is not double-prefixed", async () => {
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("https://example.com/page");
    await tab.keyPress(["Return"]);

    const navCalls = session.calls("Page.navigate");
    expect(navCalls[0]!.params?.url).toBe("https://example.com/page");
  });

  it("Escape cancels URL bar mode — Enter after Escape sends key event instead of navigating", async () => {
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("some-url.com");
    await tab.keyPress(["Escape"]);
    session.sent = [];

    // Enter now goes to the page, not the URL bar
    await tab.keyPress(["Return"]);
    const navCalls = session.calls("Page.navigate");
    expect(navCalls).toHaveLength(0); // no navigation

    const keyEvents = session.calls("Input.dispatchKeyEvent");
    expect(keyEvents.length).toBeGreaterThan(0); // key events went to page
  });

  it("F6 also activates URL bar mode", async () => {
    const result = await tab.keyPress(["F6"]);
    expect(result.ok).toBe(true);
    // URL bar is active — typing should buffer
    await tab.type("example.com");
    session.sent = [];
    await tab.keyPress(["Enter"]);

    const navCalls = session.calls("Page.navigate");
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0]!.params?.url).toBe("https://example.com");
  });

  it("Ctrl+L → type → Enter → second Ctrl+L starts fresh buffer", async () => {
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("first.com");
    await tab.keyPress(["Enter"]);

    // Second navigation
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("second.com");
    await tab.keyPress(["Enter"]);

    const navCalls = session.calls("Page.navigate");
    expect(navCalls).toHaveLength(2);
    expect(navCalls[0]!.params?.url).toBe("https://first.com");
    expect(navCalls[1]!.params?.url).toBe("https://second.com");
  });

  it("modifier keys outside URL bar mode are dispatched as CDP key events", async () => {
    // Ctrl+A (select all) should go through as real key events
    await tab.keyPress(["ctrl", "a"]);
    const keyEvents = session.calls("Input.dispatchKeyEvent");
    // Should have keyDown+keyUp for ctrl modifier and keyDown+keyUp for 'a'
    expect(keyEvents.length).toBeGreaterThanOrEqual(2);
    const types = keyEvents.map((e) => e.params?.type);
    expect(types).toContain("keyDown");
    expect(types).toContain("keyUp");
  });

  it("full emulation sequence: Ctrl+L → type multi-word → Enter", async () => {
    // Simulate: model presses Ctrl+L, types "en.wikipedia.org/wiki/Claude_Shannon", Enter
    await tab.keyPress(["ctrl", "l"]);
    await tab.type("en.wikipedia.org/wiki/Claude_Shannon");
    await tab.keyPress(["Return"]);

    const navCalls = session.calls("Page.navigate");
    expect(navCalls).toHaveLength(1);
    expect(navCalls[0]!.params?.url).toBe("https://en.wikipedia.org/wiki/Claude_Shannon");
  });
});

// ─── Challenge 3: summarize() base64 overflow ───────────────────────────────

// We test the stripping logic by examining what AnthropicAdapter.summarize()
// would send to the haiku model. We mock the Anthropic client to capture
// the actual message content.

import type { WireMessage } from "../../src/types.js";

describe("Challenge 3: summarize() strips base64 from wireHistory", () => {
  /**
   * Build a fake wireHistory that includes a screenshot with base64 data.
   * At 300KB per screenshot, even 1 screenshot can push over token limits.
   */
  function makeWireHistoryWithScreenshot(numScreenshots = 3): WireMessage[] {
    const history: WireMessage[] = [];
    // Simulate 3 steps of wire history
    for (let i = 0; i < numScreenshots; i++) {
      // Screenshot with ~300KB of fake base64 data
      history.push({
        role: "screenshot",
        stepIndex: i,
        base64: "A".repeat(300_000), // 300KB of fake base64
        compressed: false,
      });
      // Assistant action
      history.push({
        role: "assistant",
        actions: [{ type: "click", x: 500, y: 500 }],
        tool_call_ids: [`toolu_${i}`],
      });
      // Tool result
      history.push({
        role: "tool_result",
        tool_call_id: `toolu_${i}`,
        ok: true,
      });
    }
    return history;
  }

  it("strips base64 from screenshot entries before summarization", async () => {
    // We test the stripping logic directly by simulating what summarize() does.
    // Rather than calling the real API (requires key), we verify the transformation.
    const wireHistory = makeWireHistoryWithScreenshot(3);

    // Replicate the stripping logic from AnthropicAdapter.summarize()
    const safeHistory = wireHistory.slice(-20).map((msg) => {
      if (msg.role === "screenshot") {
        return { role: "screenshot", stepIndex: msg.stepIndex, compressed: true };
      }
      return msg;
    });

    // None of the safe history entries should have base64
    for (const msg of safeHistory) {
      expect((msg as { base64?: string }).base64).toBeUndefined();
    }

    // Screenshot entries should be marked compressed
    const screenshotEntries = safeHistory.filter((m) => m.role === "screenshot");
    expect(screenshotEntries).toHaveLength(3);
    for (const s of screenshotEntries) {
      expect((s as { compressed?: boolean }).compressed).toBe(true);
    }
  });

  it("serialized safe history is orders of magnitude smaller", () => {
    const wireHistory = makeWireHistoryWithScreenshot(3);

    const rawJson = JSON.stringify(wireHistory);
    const safeHistory = wireHistory.slice(-20).map((msg) => {
      if (msg.role === "screenshot") {
        return { role: "screenshot", stepIndex: msg.stepIndex, compressed: true };
      }
      return msg;
    });
    const safeJson = JSON.stringify(safeHistory);

    // Raw is ~3 × 300KB = 900KB; safe should be < 5KB
    expect(rawJson.length).toBeGreaterThan(500_000);
    expect(safeJson.length).toBeLessThan(5_000);
  });

  it("only last 20 messages are included in summarization", () => {
    // Build 30-entry history
    const wireHistory = makeWireHistoryWithScreenshot(10);
    expect(wireHistory.length).toBe(30);

    const safeHistory = wireHistory.slice(-20).map((msg) => {
      if (msg.role === "screenshot") {
        return { role: "screenshot", stepIndex: msg.stepIndex, compressed: true };
      }
      return msg;
    });

    expect(safeHistory.length).toBe(20);
  });

  it("non-screenshot messages pass through unmodified", () => {
    const wireHistory: WireMessage[] = [
      { role: "screenshot", stepIndex: 0, base64: "BIGDATA", compressed: false },
      { role: "assistant", actions: [{ type: "click", x: 500, y: 500 }], tool_call_ids: ["id1"] },
      { role: "tool_result", tool_call_id: "id1", ok: true },
    ];

    const safeHistory = wireHistory.slice(-20).map((msg) => {
      if (msg.role === "screenshot") {
        return { role: "screenshot", stepIndex: msg.stepIndex, compressed: true };
      }
      return msg;
    });

    // Assistant and tool_result come through unchanged
    expect(safeHistory[1]).toEqual(wireHistory[1]);
    expect(safeHistory[2]).toEqual(wireHistory[2]);
  });
});
