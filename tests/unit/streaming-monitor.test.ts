import { describe, it, expect } from "vitest";
import { StreamingMonitor } from "../../src/loop/streaming-monitor";
import type { Action, RunResult } from "../../src/types";
import type { ModelResponse, StepContext } from "../../src/model/adapter";

const mockScreenshot = {
  data: Buffer.alloc(10, 0),
  width: 1280,
  height: 720,
  mimeType: "image/png" as const,
};

const mockContext: StepContext = {
  screenshot: mockScreenshot,
  wireHistory: [],
  agentState: null,
  stepIndex: 0,
  maxSteps: 10,
  url: "https://example.com",
};

const mockResponse: ModelResponse = {
  actions: [{ type: "click", x: 500, y: 500 } as Action],
  usage: { inputTokens: 100, outputTokens: 50 },
  rawResponse: null,
};

const mockResult: RunResult = {
  status: "success",
  result: "done",
  steps: 1,
  history: [],
  agentState: null,
  tokenUsage: { inputTokens: 100, outputTokens: 50 },
};

describe("StreamingMonitor", () => {
  it("emits step_start and screenshot events on stepStarted", async () => {
    const monitor = new StreamingMonitor();

    monitor.stepStarted(0, mockContext);
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("step_start");
    expect(types).toContain("screenshot");
    expect(types).toContain("done");
  });

  it("emits thinking event when response has thinking", async () => {
    const monitor = new StreamingMonitor();

    monitor.stepCompleted(0, { ...mockResponse, thinking: "I think I should click" });
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    const thinkingEvent = events.find((e) => e.type === "thinking");
    expect(thinkingEvent).toBeDefined();
    if (thinkingEvent?.type === "thinking") {
      expect(thinkingEvent.text).toBe("I think I should click");
    }
  });

  it("does not emit thinking event when response has no thinking", async () => {
    const monitor = new StreamingMonitor();
    monitor.stepCompleted(0, mockResponse);
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    expect(events.find((e) => e.type === "thinking")).toBeUndefined();
  });

  it("emits action and action_result events on actionExecuted", async () => {
    const monitor = new StreamingMonitor();
    const action: Action = { type: "click", x: 500, y: 500 };

    monitor.actionExecuted(0, action, { ok: true });
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    expect(events.find((e) => e.type === "action")).toBeDefined();
    expect(events.find((e) => e.type === "action_result")).toBeDefined();
  });

  it("emits state_written event when writeState action is executed", async () => {
    const monitor = new StreamingMonitor();
    const action: Action = { type: "writeState", data: { min_price: "£3.49" } };

    monitor.actionExecuted(0, action, { ok: true });
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    const stateEvent = events.find((e) => e.type === "state_written");
    expect(stateEvent).toBeDefined();
    if (stateEvent?.type === "state_written") {
      expect(stateEvent.data).toEqual({ min_price: "£3.49" });
    }
  });

  it("emits action_blocked event on actionBlocked", async () => {
    const monitor = new StreamingMonitor();
    const action: Action = { type: "goto", url: "https://evil.com" };

    monitor.actionBlocked(0, action, "domain not allowed");
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    const blockedEvent = events.find((e) => e.type === "action_blocked");
    expect(blockedEvent).toBeDefined();
    if (blockedEvent?.type === "action_blocked") {
      expect(blockedEvent.reason).toBe("domain not allowed");
    }
  });

  it("emits compaction event on compactionTriggered", async () => {
    const monitor = new StreamingMonitor();

    monitor.compactionTriggered(0, 90_000, 13_500);
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    const compactionEvent = events.find((e) => e.type === "compaction");
    expect(compactionEvent).toBeDefined();
    if (compactionEvent?.type === "compaction") {
      expect(compactionEvent.tokensBefore).toBe(90_000);
      expect(compactionEvent.tokensAfter).toBe(13_500);
    }
  });

  it("emits done event with the final result", async () => {
    const monitor = new StreamingMonitor();
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      expect(doneEvent.result.status).toBe("success");
      expect(doneEvent.result.result).toBe("done");
    }
  });

  it("terminates the generator after the done event", async () => {
    const monitor = new StreamingMonitor();
    monitor.complete(mockResult);

    const events = [];
    for await (const event of monitor.events()) {
      events.push(event);
    }

    expect(events[events.length - 1]?.type).toBe("done");
  });
});
