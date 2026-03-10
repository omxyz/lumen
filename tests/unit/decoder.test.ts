import { describe, it, expect } from "vitest";
import { ActionDecoder } from "../../src/model/decoder";

const decoder = new ActionDecoder();
const viewport = { width: 1280, height: 720 };

describe("ActionDecoder.fromAnthropic", () => {
  it("decodes left_click and passes pixel coordinates through", () => {
    const action = decoder.fromAnthropic(
      { name: "computer", input: { action: "left_click", coordinate: [640, 360] } },
      viewport,
    );
    expect(action.type).toBe("click");
    if (action.type === "click") {
      expect(action.x).toBe(640); // pixel pass-through
      expect(action.y).toBe(360); // pixel pass-through
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
  it("denormalizes 0-1000 coordinates to pixels", () => {
    const action = decoder.fromGoogle({
      name: "computer_use",
      args: { action: "click", x: 500, y: 500, button: "left" },
    }, viewport);
    expect(action.type).toBe("click");
    if (action.type === "click") {
      expect(action.x).toBe(640); // 500/1000 * 1280
      expect(action.y).toBe(360); // 500/1000 * 720
    }
  });

  it("decodes navigate to goto", () => {
    const action = decoder.fromGoogle({
      name: "computer_use",
      args: { action: "navigate", url: "https://example.com" },
    }, viewport);
    expect(action.type).toBe("goto");
    if (action.type === "goto") expect(action.url).toBe("https://example.com");
  });

  it("falls back to screenshot for unknown action", () => {
    const action = decoder.fromGoogle({ name: "unknown", args: { action: "unknown" } }, viewport);
    expect(action.type).toBe("screenshot");
  });
});

describe("ActionDecoder.fromGeneric", () => {
  it("decodes click and denormalizes coordinates", () => {
    const action = decoder.fromGeneric({ name: "click", input: { x: 250, y: 750, button: "right" } }, viewport);
    expect(action.type).toBe("click");
    if (action.type === "click") {
      expect(action.x).toBe(320);  // 250/1000 * 1280
      expect(action.y).toBe(540);  // 750/1000 * 720
      expect(action.button).toBe("right");
    }
  });

  it("decodes terminate", () => {
    const action = decoder.fromGeneric({ name: "terminate", input: { status: "success", result: "Done!" } }, viewport);
    expect(action.type).toBe("terminate");
    if (action.type === "terminate") {
      expect(action.status).toBe("success");
      expect(action.result).toBe("Done!");
    }
  });

  it("falls back to screenshot for unknown name", () => {
    const action = decoder.fromGeneric({ name: "unknownFn", input: {} }, viewport);
    expect(action.type).toBe("screenshot");
  });
});
