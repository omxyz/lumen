import { describe, it, expect } from "vitest";
import { ActionDecoder } from "../../src/model/decoder.js";

const decoder = new ActionDecoder();
const viewport = { width: 1280, height: 720 };

describe("ActionDecoder.fromAnthropic", () => {
  it("decodes left_click and normalizes coordinates", () => {
    const action = decoder.fromAnthropic(
      { name: "computer", input: { action: "left_click", coordinate: [640, 360] } },
      viewport,
    );
    expect(action.type).toBe("click");
    if (action.type === "click") {
      expect(action.x).toBe(500); // 640/1280 * 1000
      expect(action.y).toBe(500); // 360/720 * 1000
      expect(action.button).toBe("left");
    }
  });

  it("decodes right_click", () => {
    const action = decoder.fromAnthropic(
      { name: "computer", input: { action: "right_click", coordinate: [0, 0] } },
      viewport,
    );
    expect(action.type).toBe("click");
    if (action.type === "click") expect(action.button).toBe("right");
  });

  it("decodes screenshot action", () => {
    const action = decoder.fromAnthropic(
      { name: "computer", input: { action: "screenshot" } },
      viewport,
    );
    expect(action.type).toBe("screenshot");
  });

  it("decodes type action", () => {
    const action = decoder.fromAnthropic(
      { name: "computer", input: { action: "type", text: "hello world" } },
      viewport,
    );
    expect(action.type).toBe("type");
    if (action.type === "type") expect(action.text).toBe("hello world");
  });

  it("decodes key action with + separator", () => {
    const action = decoder.fromAnthropic(
      { name: "computer", input: { action: "key", text: "Control+c" } },
      viewport,
    );
    expect(action.type).toBe("keyPress");
    if (action.type === "keyPress") expect(action.keys).toContain("Control");
  });

  it("falls back to screenshot for unknown tool name", () => {
    const action = decoder.fromAnthropic(
      { name: "unknown_tool", input: {} },
      viewport,
    );
    expect(action.type).toBe("screenshot");
  });
});

describe("ActionDecoder.fromGoogle", () => {
  it("passes through coordinates without normalization", () => {
    const action = decoder.fromGoogle({
      name: "computer_use",
      args: { action: "click", x: 500, y: 500, button: "left" },
    });
    expect(action.type).toBe("click");
    if (action.type === "click") {
      expect(action.x).toBe(500); // No normalization for Google
      expect(action.y).toBe(500);
    }
  });

  it("decodes navigate to goto", () => {
    const action = decoder.fromGoogle({
      name: "computer_use",
      args: { action: "navigate", url: "https://example.com" },
    });
    expect(action.type).toBe("goto");
    if (action.type === "goto") expect(action.url).toBe("https://example.com");
  });

  it("falls back to screenshot for unknown action", () => {
    const action = decoder.fromGoogle({ name: "unknown", args: { action: "unknown" } });
    expect(action.type).toBe("screenshot");
  });
});

describe("ActionDecoder.fromGeneric", () => {
  it("decodes click", () => {
    const action = decoder.fromGeneric({ name: "click", input: { x: 250, y: 750, button: "right" } });
    expect(action.type).toBe("click");
    if (action.type === "click") {
      expect(action.x).toBe(250);
      expect(action.y).toBe(750);
      expect(action.button).toBe("right");
    }
  });

  it("decodes terminate", () => {
    const action = decoder.fromGeneric({ name: "terminate", input: { status: "success", result: "Done!" } });
    expect(action.type).toBe("terminate");
    if (action.type === "terminate") {
      expect(action.status).toBe("success");
      expect(action.result).toBe("Done!");
    }
  });

  it("falls back to screenshot for unknown name", () => {
    const action = decoder.fromGeneric({ name: "unknownFn", input: {} });
    expect(action.type).toBe("screenshot");
  });
});
