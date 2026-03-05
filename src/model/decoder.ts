import type { CUAAction, TaskState, ViewportSize } from "../types.js";
import { denormalize } from "./adapter.js";

export class ActionDecoder {
  /** Anthropic tool_use block → CUAAction. Coordinates are pixels — pass through directly. */
  fromAnthropic(
    block: { name: string; input: Record<string, unknown> },
    _viewport: ViewportSize,
  ): CUAAction {
    const { name, input } = block;

    if (name === "computer") {
      const action = input.action as string;

      if (action === "screenshot") return { type: "screenshot" };
      if (action === "cursor_position") return { type: "screenshot" }; // fallback

      if (action === "left_click" || action === "right_click" || action === "middle_click") {
        const [px, py] = input.coordinate as [number, number];
        const button = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
        return { type: "click", x: px, y: py, button };
      }

      if (action === "double_click") {
        const [px, py] = input.coordinate as [number, number];
        return { type: "doubleClick", x: px, y: py };
      }

      if (action === "mouse_move") {
        const [px, py] = input.coordinate as [number, number];
        return { type: "hover", x: px, y: py };
      }

      if (action === "left_click_drag") {
        const [sx, sy] = input.start_coordinate as [number, number];
        const [ex, ey] = input.coordinate as [number, number];
        return {
          type: "drag",
          startX: sx,
          startY: sy,
          endX: ex,
          endY: ey,
        };
      }

      if (action === "scroll") {
        const [px, py] = input.coordinate as [number, number];
        const direction = (input.direction as string) ?? "down";
        const amount = (input.amount as number) ?? 3;
        return {
          type: "scroll",
          x: px,
          y: py,
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

  /** Google function_call → CUAAction. Coordinates are 0-1000 → denormalize to pixels. */
  fromGoogle(
    call: { name: string; args: Record<string, unknown> },
    viewport: ViewportSize,
  ): CUAAction {
    const { name, args } = call;

    // Legacy computer_use tool (older Google models)
    if (name === "computer_use") {
      const action = args.action as string;

      if (action === "screenshot") return { type: "screenshot" };

      if (action === "click") {
        return {
          type: "click",
          x: denormalize(args.x as number, viewport.width),
          y: denormalize(args.y as number, viewport.height),
          button: (args.button as "left" | "right" | "middle") ?? "left",
        };
      }

      if (action === "double_click") {
        return {
          type: "doubleClick",
          x: denormalize(args.x as number, viewport.width),
          y: denormalize(args.y as number, viewport.height),
        };
      }

      if (action === "hover" || action === "move") {
        return {
          type: "hover",
          x: denormalize(args.x as number, viewport.width),
          y: denormalize(args.y as number, viewport.height),
        };
      }

      if (action === "drag") {
        return {
          type: "drag",
          startX: denormalize(args.startX as number, viewport.width),
          startY: denormalize(args.startY as number, viewport.height),
          endX: denormalize(args.endX as number, viewport.width),
          endY: denormalize(args.endY as number, viewport.height),
        };
      }

      if (action === "scroll") {
        return {
          type: "scroll",
          x: denormalize(args.x as number, viewport.width),
          y: denormalize(args.y as number, viewport.height),
          direction: (args.direction as "up" | "down" | "left" | "right") ?? "down",
          amount: (args.amount as number) ?? 3,
        };
      }

      if (action === "type") return { type: "type", text: args.text as string };
      if (action === "key") return { type: "keyPress", keys: [args.key as string] };
      if (action === "navigate") return { type: "goto", url: args.url as string };
      if (action === "terminate") return { type: "terminate", status: (args.status as "success" | "failure") ?? "success", result: (args.result as string) ?? "" };
    }

    // Native function call names from gemini-2.5-computer-use-preview models
    if (name === "click_at") {
      return {
        type: "click",
        x: denormalize(args.x as number, viewport.width),
        y: denormalize(args.y as number, viewport.height),
        button: (args.button as "left" | "right" | "middle") ?? "left",
      };
    }
    if (name === "type_text_at") {
      return { type: "type", text: args.text as string };
    }
    if (name === "navigate" || name === "go_to_url") {
      return { type: "goto", url: args.url as string };
    }
    if (name === "search") {
      // Treat as a navigate to Google search if a query is provided
      const query = (args.query as string) ?? (args.text as string) ?? "";
      const url = query
        ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
        : "https://www.google.com";
      return { type: "goto", url };
    }
    if (name === "scroll_at" || name === "scroll") {
      return {
        type: "scroll",
        x: denormalize((args.x as number) ?? 500, viewport.width),
        y: denormalize((args.y as number) ?? 500, viewport.height),
        direction: (args.direction as "up" | "down" | "left" | "right") ?? "down",
        amount: (args.amount as number) ?? 3,
      };
    }
    if (name === "key_press" || name === "press_key") {
      const key = (args.key as string) ?? (args.keys as string) ?? "Return";
      return { type: "keyPress", keys: [key] };
    }
    if (name === "wait" || name === "wait_5_seconds" || name === "wait_for_page_load") {
      const ms = name === "wait_5_seconds" ? 5000 : ((args.ms as number) ?? (args.seconds as number ? (args.seconds as number) * 1000 : 2000));
      return { type: "wait", ms };
    }
    if (name === "back" || name === "go_back") {
      return { type: "keyPress", keys: ["Alt+ArrowLeft"] };
    }
    if (name === "forward" || name === "go_forward") {
      return { type: "keyPress", keys: ["Alt+ArrowRight"] };
    }
    if (name === "terminate" || name === "done" || name === "finish") {
      return {
        type: "terminate",
        status: (args.status as "success" | "failure") ?? "success",
        result: (args.result as string) ?? (args.answer as string) ?? "",
      };
    }
    if (name === "open_web_browser") {
      return { type: "screenshot" }; // noop — browser already open
    }

    return { type: "screenshot" };
  }

  /** OpenAI computer_call → CUAAction. Coordinates are pixels — pass through directly. */
  fromOpenAI(
    call: { type: string; action?: Record<string, unknown> },
    _viewport: ViewportSize,
  ): CUAAction {
    if (call.type !== "computer_call" || !call.action) return { type: "screenshot" };
    const action = call.action;
    const actionType = action.type as string;

    if (actionType === "screenshot") return { type: "screenshot" };

    if (actionType === "click") {
      const button = (action.button as string) ?? "left";
      return {
        type: "click",
        x: action.x as number,
        y: action.y as number,
        button: button as "left" | "right" | "middle",
      };
    }

    if (actionType === "double_click") {
      return {
        type: "doubleClick",
        x: action.x as number,
        y: action.y as number,
      };
    }

    if (actionType === "scroll") {
      return {
        type: "scroll",
        x: action.x as number,
        y: action.y as number,
        direction: (action.direction as "up" | "down" | "left" | "right") ?? "down",
        amount: (action.amount as number) ?? 3,
      };
    }

    if (actionType === "type") return { type: "type", text: action.text as string };
    if (actionType === "key") return { type: "keyPress", keys: Array.isArray(action.keys) ? action.keys as string[] : [action.keys as string] };

    return { type: "screenshot" };
  }

  /** Generic function call → CUAAction. Coordinates are 0-1000 → denormalize to pixels. */
  fromGeneric(
    call: { name: string; input: Record<string, unknown> },
    viewport: ViewportSize,
  ): CUAAction {
    const { name, input } = call;

    switch (name) {
      case "click":
        return { type: "click", x: denormalize(input.x as number, viewport.width), y: denormalize(input.y as number, viewport.height), button: (input.button as "left" | "right" | "middle") ?? "left" };
      case "doubleClick":
        return { type: "doubleClick", x: denormalize(input.x as number, viewport.width), y: denormalize(input.y as number, viewport.height) };
      case "hover":
        return { type: "hover", x: denormalize(input.x as number, viewport.width), y: denormalize(input.y as number, viewport.height) };
      case "drag":
        return { type: "drag", startX: denormalize(input.startX as number, viewport.width), startY: denormalize(input.startY as number, viewport.height), endX: denormalize(input.endX as number, viewport.width), endY: denormalize(input.endY as number, viewport.height) };
      case "type":
        return { type: "type", text: input.text as string };
      case "keyPress":
        return { type: "keyPress", keys: input.keys as string[] };
      case "scroll":
        return { type: "scroll", x: denormalize(input.x as number, viewport.width), y: denormalize(input.y as number, viewport.height), direction: (input.direction as "up" | "down" | "left" | "right") ?? "down", amount: (input.amount as number) ?? 3 };
      case "goto":
        return { type: "goto", url: input.url as string };
      case "writeState":
        return { type: "writeState", data: input.data as TaskState };
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
