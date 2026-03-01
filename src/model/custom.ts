import OpenAI from "openai";
import type { ModelAdapter, StepContext } from "./adapter.js";
import type { ModelResponse } from "./adapter.js";
import type { CUAAction, TaskState, WireMessage } from "../types.js";
import { ActionDecoder } from "./decoder.js";

const decoder = new ActionDecoder();

// Function schemas for all CUA actions using 0-1000 normalized coordinates
const CUA_FUNCTION_TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "click",
      description: "Click at a position. Coordinates are 0-1000 normalized (0=left/top, 1000=right/bottom).",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0, maximum: 1000, description: "Normalized X coordinate (0-1000)" },
          y: { type: "integer", minimum: 0, maximum: 1000, description: "Normalized Y coordinate (0-1000)" },
          button: { type: "string", enum: ["left", "right", "middle"], default: "left" },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "doubleClick",
      description: "Double-click at a position.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0, maximum: 1000 },
          y: { type: "integer", minimum: 0, maximum: 1000 },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "hover",
      description: "Move mouse to a position without clicking.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0, maximum: 1000 },
          y: { type: "integer", minimum: 0, maximum: 1000 },
        },
        required: ["x", "y"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "drag",
      description: "Drag from one position to another.",
      parameters: {
        type: "object",
        properties: {
          startX: { type: "integer", minimum: 0, maximum: 1000 },
          startY: { type: "integer", minimum: 0, maximum: 1000 },
          endX: { type: "integer", minimum: 0, maximum: 1000 },
          endY: { type: "integer", minimum: 0, maximum: 1000 },
        },
        required: ["startX", "startY", "endX", "endY"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "Type text into the focused element.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "keyPress",
      description: "Press keyboard keys (e.g. ['Enter'], ['Control', 'c']).",
      parameters: {
        type: "object",
        properties: { keys: { type: "array", items: { type: "string" } } },
        required: ["keys"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll at a position.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "integer", minimum: 0, maximum: 1000 },
          y: { type: "integer", minimum: 0, maximum: 1000 },
          direction: { type: "string", enum: ["up", "down", "left", "right"] },
          amount: { type: "integer", minimum: 1, maximum: 20, description: "Number of scroll units" },
        },
        required: ["x", "y", "direction", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goto",
      description: "Navigate to a URL.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "screenshot",
      description: "Take a screenshot to see the current state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait for the specified duration.",
      parameters: {
        type: "object",
        properties: { ms: { type: "integer", minimum: 100, maximum: 10000 } },
        required: ["ms"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "terminate",
      description: "Signal task completion.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["success", "failure"] },
          result: { type: "string", description: "Summary of what was accomplished" },
        },
        required: ["status", "result"],
      },
    },
  },
];

function buildSystemPrompt(context: StepContext): string {
  const parts = [
    context.systemPrompt ?? "You are a computer use agent that controls a web browser.",
    `Current URL: ${context.url || "(unknown)"}`,
    `Step ${context.stepIndex + 1} of ${context.maxSteps}`,
    "Use the provided tools to interact with the browser. All coordinates are 0-1000 normalized (0=top-left, 1000=bottom-right).",
    "Call terminate() when the task is complete.",
  ];
  if (context.agentState && Object.keys(context.agentState).length > 0) {
    parts.push(`Current state: ${JSON.stringify(context.agentState)}`);
  }
  return parts.join("\n\n");
}

export class CustomAdapter implements ModelAdapter {
  readonly provider = "custom";
  readonly nativeComputerUse = false;
  readonly contextWindowTokens = 128_000;

  private readonly client: OpenAI;

  constructor(
    readonly modelId: string,
    opts: { baseURL?: string; apiKey?: string } = {},
  ) {
    this.client = new OpenAI({
      baseURL: opts.baseURL,
      apiKey: opts.apiKey ?? "not-needed",
    });
  }

  async step(context: StepContext): Promise<ModelResponse> {
    const systemPrompt = buildSystemPrompt(context);
    const screenshotBase64 = context.screenshot.data.toString("base64");

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: `Step ${context.stepIndex + 1}: What action should I take?` },
          { type: "image_url", image_url: { url: `data:image/png;base64,${screenshotBase64}` } },
        ],
      },
    ];

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      tools: CUA_FUNCTION_TOOLS,
      tool_choice: "required",
    });

    const actions: CUAAction[] = [];
    const choice = response.choices[0];
    if (choice?.message?.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        try {
          const input = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
          actions.push(decoder.fromGeneric({ name: toolCall.function.name, input }));
        } catch {
          actions.push({ type: "screenshot" });
        }
      }
    }

    return {
      actions,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      rawResponse: response,
    };
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    const response = await this.step(context);
    for (const action of response.actions) yield action;
  }

  estimateTokens(context: StepContext): number {
    return context.wireHistory.length * 200 + 1500;
  }

  async summarize(wireHistory: WireMessage[], currentState: Record<string, unknown> | null): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages: [{
        role: "user",
        content: [
          "Summarize this computer use session history concisely.",
          currentState ? `Current state: ${JSON.stringify(currentState)}` : "",
          `History (${wireHistory.length} messages): ${JSON.stringify(wireHistory.slice(-10))}`,
        ].filter(Boolean).join("\n\n"),
      }],
    });

    return response.choices[0]?.message?.content ?? "Session history summarized.";
  }
}
