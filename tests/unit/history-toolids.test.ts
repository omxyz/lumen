import { describe, it, expect } from "vitest";
import { HistoryManager } from "../../src/loop/history.js";
import type { Action } from "../../src/types.js";
import type { ModelResponse } from "../../src/model/adapter.js";

/** Helper to make a response with explicit tool call IDs. */
function makeResponseWithIds(
  actions: Action[],
  toolCallIds: string[],
  inputTokens = 100,
): ModelResponse {
  return {
    actions,
    toolCallIds,
    usage: { inputTokens, outputTokens: 50 },
    rawResponse: null,
  };
}

describe("HistoryManager — tool call ID correlation", () => {
  it("tool_result references the correct tool_call_id from the matching tool_use", () => {
    const h = new HistoryManager(100_000);
    const clickAction: Action = { type: "click", x: 500, y: 500 };

    // Simulate adapter returning a response with a real tool_use ID
    const response = makeResponseWithIds([clickAction], ["toolu_abc123"]);
    h.appendResponse(response);

    // Simulate action execution outcome
    h.appendActionOutcome(clickAction, { ok: true });

    const wire = h.wireHistory();
    // wire[0] = assistant with tool_call_ids
    // wire[1] = tool_result with tool_call_id
    const assistantMsg = wire[0];
    const toolResultMsg = wire[1];

    expect(assistantMsg?.role).toBe("assistant");
    expect((assistantMsg?.tool_call_ids as string[])[0]).toBe("toolu_abc123");

    expect(toolResultMsg?.role).toBe("tool_result");
    expect(toolResultMsg?.tool_call_id).toBe("toolu_abc123");
  });

  it("multiple actions in one step each get their own tool_call_id", () => {
    const h = new HistoryManager(100_000);
    const click: Action = { type: "click", x: 100, y: 100 };
    const type_: Action = { type: "type", text: "hello" };

    const response = makeResponseWithIds([click, type_], ["toolu_click1", "toolu_type2"]);
    h.appendResponse(response);
    h.appendActionOutcome(click, { ok: true });
    h.appendActionOutcome(type_, { ok: true });

    const wire = h.wireHistory();
    // wire[0] = assistant
    // wire[1] = tool_result for click
    // wire[2] = tool_result for type
    expect((wire[1] as { tool_call_id: string }).tool_call_id).toBe("toolu_click1");
    expect((wire[2] as { tool_call_id: string }).tool_call_id).toBe("toolu_type2");
  });

  it("falls back to a generated ID when no toolCallIds provided", () => {
    const h = new HistoryManager(100_000);
    const action: Action = { type: "screenshot" };

    // Response without toolCallIds (e.g. non-Anthropic adapters)
    h.appendResponse({
      actions: [action],
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: null,
    });
    h.appendActionOutcome(action, { ok: true });

    const wire = h.wireHistory();
    const toolResult = wire[1] as { role: string; tool_call_id: string };
    expect(toolResult.role).toBe("tool_result");
    // Should have some ID, not undefined
    expect(typeof toolResult.tool_call_id).toBe("string");
    expect(toolResult.tool_call_id.length).toBeGreaterThan(0);
  });
});
