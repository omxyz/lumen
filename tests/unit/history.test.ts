import { describe, it, expect } from "vitest";
import { HistoryManager } from "../../src/loop/history";
import type { Action, SemanticStep } from "../../src/types";
import type { ModelResponse } from "../../src/model/adapter";

function makeResponse(inputTokens: number): ModelResponse {
  return {
    actions: [{ type: "screenshot" } as Action],
    usage: { inputTokens, outputTokens: 50 },
    rawResponse: null,
  };
}

function makeSemanticStep(stepIndex: number): SemanticStep {
  return {
    stepIndex,
    url: "https://example.com",
    screenshotBase64: "abc123",
    actions: [],
    agentState: null,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
    durationMs: 500,
  };
}

describe("HistoryManager", () => {
  it("starts with empty wire history", () => {
    const h = new HistoryManager(100_000);
    expect(h.wireHistory()).toHaveLength(0);
  });

  it("tokenUtilization increases after appendResponse", () => {
    const h = new HistoryManager(100_000);
    expect(h.tokenUtilization()).toBe(0);
    h.appendResponse(makeResponse(1000));
    expect(h.tokenUtilization()).toBeGreaterThan(0);
  });

  it("tokenUtilization is capped at 1.0", () => {
    const h = new HistoryManager(100);
    h.appendResponse(makeResponse(500));
    expect(h.tokenUtilization()).toBe(1.0);
  });

  it("compressScreenshots replaces screenshots beyond keepRecent", () => {
    const h = new HistoryManager(100_000);
    // Use appendScreenshot to add 4 screenshot entries
    for (let i = 0; i < 4; i++) {
      h.appendScreenshot(`data${i}`, i);
    }
    h.compressScreenshots(2);
    const wire = h.wireHistory();
    // First 2 should be compressed (base64 nulled, compressed: true)
    expect((wire[0] as { compressed: boolean }).compressed).toBe(true);
    expect((wire[0] as { base64: unknown }).base64).toBeNull();
    expect((wire[1] as { compressed: boolean }).compressed).toBe(true);
    // Last 2 should be full images
    expect((wire[2] as { compressed: boolean }).compressed).toBe(false);
    expect((wire[2] as { base64: string }).base64).toBe("data2");
    expect((wire[3] as { base64: string }).base64).toBe("data3");
  });

  it("toJSON / fromJSON round-trips", () => {
    const h = new HistoryManager(100_000);
    h.appendResponse(makeResponse(500));
    h.appendSemanticStep(makeSemanticStep(0));
    const state = { min_price: "£3.49", min_title: "Sharp Objects" };
    const json = h.toJSON(state);
    const { history: h2, agentState: s2 } = HistoryManager.fromJSON(json, 100_000);
    expect(h2.wireHistory()).toHaveLength(h.wireHistory().length);
    expect(s2).toEqual(state);
  });

  it("aggregateTokenUsage sums semantic steps", () => {
    const h = new HistoryManager(100_000);
    h.appendSemanticStep(makeSemanticStep(0));
    h.appendSemanticStep(makeSemanticStep(1));
    const usage = h.aggregateTokenUsage();
    expect(usage.inputTokens).toBe(200);
    expect(usage.outputTokens).toBe(100);
  });
});
