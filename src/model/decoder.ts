import type { CUAAction, TaskState, ViewportSize } from "../types.js";
import { normalize } from "./adapter.js";

export class ActionDecoder {
  /** Anthropic tool_use block → CUAAction. Coordinates are pixels → normalize to 0-1000. */
  fromAnthropic(
    block: { name: string; input: Record<string, unknown> },
    viewport: ViewportSize,
  ): CUAAction {
    const { name, input } = block;

    if (name === "computer") {
      const action = input.action as string;

      if (action === "screenshot") return { type: "screenshot" };
      if (action === "cursor_position") return { type: "screenshot" }; // fallback

      if (action === "left_click" || action === "right_click" || action === "middle_click") {
        const [px, py] = input.coordinate as [number, number];
        const button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
        return { type: "click", x: normalize(px, viewport.width), y: normalize(py, viewport.height), button };
      }

      if (action === "double_click") {
        const [px, py] = input.coordinate as [number, number];
        return { type: "doubleClick", x: normalize(px, viewport.width), y: normalize(py, viewport.height) };
      }

      if (action === "mouse_move") {
        const [px, py] = input.coordinate as [number, number];
        return { type: "hover", x: normalize(px, viewport.width), y: normalize(py, viewport.height) };
      }

      if (action === "left_click_drag") {
        const [sx, sy] = input.start_coordinate as [number, number];
        const [ex, ey] = input.coordinate as [number, number];
        return {
          type: "drag",
          startX: normalize(sx, viewport.width),
          startY: normalize(sy, viewport.height),
          endX: normalize(ex, viewport.width),
          endY: normalize(ey, viewport.height),
        };
      }

      if (action === "scroll") {
        const [px, py] = input.coordinate as [number, number];
        const direction = (input.direction as string) ?? "down";
        const amount = (input.amount as number) ?? 3;
        return {
          type: "scroll",
          x: normalize(px, viewport.width),
          y: normalize(py, viewport.height),
          direction: direction as "up" | "down" | "left" | "right",
          amount,
        };
      }

      if (action === "type") {
        return { type: "type", text: input.text as string };
      }

      if (action === "key") {
        const keys = (input.text as string).split("+").map((k) => k.trim());
        return { type: "keyPress", keys };
      }
    }

    // Tool-specific actions (computer_20250124 schema)
    if (name === "str_replace_based_edit_tool" || name === "text_editor") {
      return { type: "screenshot" }; // fallback
    }

    // Fallback
    return { type: "screenshot" };
  }

  /** Google function_call → CUAAction. Coordinates are already 0-1000. */
  fromGoogle(call: { name: string; args: Record<string, unknown> }): CUAAction {
    const { name, args } = call;

    if (name === "computer_use") {
      const action = args.action as string;

      if (action === "screenshot") return { type: "screenshot" };

      if (action === "click") {
        return {
          type: "click",
          x: args.x as number,
          y: args.y as number,
          button: (args.button as "left" | "right" | "middle") ?? "left",
        };
      }

      if (action === "double_click") {
        return { type: "doubleClick", x: args.x as number, y: args.y as number };
      }

      if (action === "hover" || action === "move") {
        return { type: "hover", x: args.x as number, y: args.y as number };
      }

      if (action === "drag") {
        return {
          type: "drag",
          startX: args.startX as number,
          startY: args.startY as number,
          endX: args.endX as number,
          endY: args.endY as number,
        };
      }

      if (action === "scroll") {
        return {
          type: "scroll",
          x: args.x as number,
          y: args.y as number,
          direction: (args.direction as "up" | "down" | "left" | "right") ?? "down",
          amount: (args.amount as number) ?? 3,
        };
      }

      if (action === "type") return { type: "type", text: args.text as string };
      if (action === "key") return { type: "keyPress", keys: [args.key as string] };
      if (action === "navigate") return { type: "goto", url: args.url as string };
      if (action === "terminate") return { type: "terminate", status: (args.status as "success" | "failure") ?? "success", result: (args.result as string) ?? "" };
    }

    return { type: "screenshot" };
  }

  /** OpenAI computer_call → CUAAction. Coordinates are pixels → normalize to 0-1000. */
  fromOpenAI(
    call: { type: string; action?: Record<string, unknown> },
    viewport: ViewportSize,
  ): CUAAction {
    if (call.type !== "computer_call" || !call.action) return { type: "screenshot" };
    const action = call.action;
    const actionType = action.type as string;

    if (actionType === "screenshot") return { type: "screenshot" };

    if (actionType === "click") {
      const button = (action.button as string) ?? "left";
      return {
        type: "click",
        x: normalize(action.x as number, viewport.width),
        y: normalize(action.y as number, viewport.height),
        button: button as "left" | "right" | "middle",
      };
    }

    if (actionType === "double_click") {
      return {
        type: "doubleClick",
        x: normalize(action.x as number, viewport.width),
        y: normalize(action.y as number, viewport.height),
      };
    }

    if (actionType === "scroll") {
      return {
        type: "scroll",
        x: normalize(action.x as number, viewport.width),
        y: normalize(action.y as number, viewport.height),
        direction: (action.direction as "up" | "down" | "left" | "right") ?? "down",
        amount: (action.amount as number) ?? 3,
      };
    }

    if (actionType === "type") return { type: "type", text: action.text as string };
    if (actionType === "key") return { type: "keyPress", keys: Array.isArray(action.keys) ? action.keys as string[] : [action.keys as string] };

    return { type: "screenshot" };
  }

  /** Generic function call → CUAAction. For CustomAdapter. */
  fromGeneric(call: { name: string; input: Record<string, unknown> }): CUAAction {
    const { name, input } = call;

    switch (name) {
      case "click":
        return { type: "click", x: input.x as number, y: input.y as number, button: (input.button as "left" | "right" | "middle") ?? "left" };
      case "doubleClick":
        return { type: "doubleClick", x: input.x as number, y: input.y as number };
      case "hover":
        return { type: "hover", x: input.x as number, y: input.y as number };
      case "drag":
        return { type: "drag", startX: input.startX as number, startY: input.startY as number, endX: input.endX as number, endY: input.endY as number };
      case "type":
        return { type: "type", text: input.text as string };
      case "keyPress":
        return { type: "keyPress", keys: input.keys as string[] };
      case "scroll":
        return { type: "scroll", x: input.x as number, y: input.y as number, direction: (input.direction as "up" | "down" | "left" | "right") ?? "down", amount: (input.amount as number) ?? 3 };
      case "goto":
        return { type: "goto", url: input.url as string };
      case "memorize":
        return { type: "memorize", fact: input.fact as string };
      case "writeState":
        return { type: "writeState", state: input.state as TaskState };
      case "terminate":
        return { type: "terminate", status: (input.status as "success" | "failure") ?? "success", result: (input.result as string) ?? "" };
      case "wait":
        return { type: "wait", ms: (input.ms as number) ?? 1000 };
      case "screenshot":
        return { type: "screenshot" };
      default:
        return { type: "screenshot" };
    }
  }
}
