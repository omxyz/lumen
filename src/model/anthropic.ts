import Anthropic from "@anthropic-ai/sdk";
import type { ModelAdapter, StepContext } from "./adapter.js";
import type { ModelResponse } from "./adapter.js";
import type { CUAAction, TaskState, WireMessage } from "../types.js";
import { ActionDecoder } from "./decoder.js";

const decoder = new ActionDecoder();

function buildSystemPrompt(context: StepContext): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(context.systemPrompt);
  parts.push(`You are a computer use agent. Current URL: ${context.url || "(unknown)"}`);
  parts.push(`Step ${context.stepIndex + 1} of ${context.maxSteps}`);
  if (context.factStore.length > 0) {
    parts.push("Memory:\n" + context.factStore.map((f) => `- ${f}`).join("\n"));
  }
  if (context.taskState) {
    parts.push(`Task state: ${JSON.stringify(context.taskState)}`);
  }
  return parts.join("\n\n");
}

function buildMessages(context: StepContext): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  // All pending content for the next user message.
  // Flushed as a single user turn whenever an assistant message is encountered.
  // This correctly handles:
  //   - screenshot entries (visual context for each step)
  //   - tool_result entries (outcome of each action)
  //   - summary entries (post-compaction anchor)
  // Wire order per step: [screenshot] → [assistant] → [tool_result...] → [screenshot] → ...
  // Message order:  user:[screenshot] → asst:[tool_use] → user:[results+screenshot] → ...
  let pendingUserContent: Anthropic.MessageParam["content"] = [];

  const flushUserMessage = () => {
    if (pendingUserContent.length === 0) return;
    messages.push({ role: "user", content: pendingUserContent });
    pendingUserContent = [];
  };

  for (const msg of context.wireHistory) {
    if (msg.role === "screenshot") {
      if (msg.compressed) {
        // Compressed: use a text token so the model knows a step happened
        pendingUserContent = [...pendingUserContent, {
          type: "text",
          text: `[screenshot: step ${(msg.stepIndex as number) + 1}]`,
        } as Anthropic.TextBlockParam];
      } else {
        pendingUserContent = [...pendingUserContent, {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: msg.base64 as string,
          },
        } as Anthropic.ImageBlockParam];
      }
    } else if (msg.role === "assistant") {
      // Flush accumulated user content (screenshots, tool_results, summaries)
      // before emitting the assistant turn.
      flushUserMessage();

      const content: Anthropic.ContentBlock[] = [];
      if (msg.thinking) {
        content.push({ type: "text", text: msg.thinking as string } as unknown as Anthropic.ContentBlock);
      }
      if (Array.isArray(msg.actions)) {
        const actions = msg.actions as CUAAction[];
        const toolCallIds = (msg.tool_call_ids as string[] | undefined) ?? [];
        for (let i = 0; i < actions.length; i++) {
          const id = toolCallIds[i] ?? `toolu_${i}_${actions[i]!.type}`;
          content.push({
            type: "tool_use" as const,
            id,
            name: "computer",
            input: actions[i],
          } as unknown as Anthropic.ContentBlock);
        }
      }
      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool_result") {
      const toolUseId = (msg.tool_call_id as string | undefined) ?? `toolu_unknown`;
      pendingUserContent = [...pendingUserContent, {
        type: "tool_result" as const,
        tool_use_id: toolUseId,
        content: (msg.ok as boolean)
          ? "Action completed successfully"
          : `Error: ${(msg.error as string | undefined) ?? "unknown"}`,
        ...(!(msg.ok as boolean) ? { is_error: true as const } : {}),
      } as unknown as Anthropic.ImageBlockParam];
    } else if (msg.role === "summary") {
      pendingUserContent = [...pendingUserContent, {
        type: "text",
        text: `<summary>${msg.content as string}</summary>`,
      } as Anthropic.TextBlockParam];
    }
  }

  // Flush remaining pending content (current step's screenshot + any trailing tool_results)
  flushUserMessage();

  return messages;
}

// Claude 4.6+ models use computer_20251124 / computer-use-2025-11-24
// Earlier models use computer_20250124 / computer-use-2025-01-24
const CLAUDE_46_PLUS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5-20251101"];

function computerToolVersion(modelId: string): { type: string; beta: string } {
  const base = modelId.includes("/") ? modelId.split("/")[1]! : modelId;
  if (CLAUDE_46_PLUS.some((m) => base.startsWith(m))) {
    return { type: "computer_20251124", beta: "computer-use-2025-11-24" };
  }
  return { type: "computer_20250124", beta: "computer-use-2025-01-24" };
}

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  readonly nativeComputerUse = true;
  readonly supportsThinking = true;
  readonly patchSize = 28;
  readonly maxImageDimension = 1344;

  get contextWindowTokens(): number {
    return 200_000;
  }

  private readonly client: Anthropic;
  private readonly thinkingBudget: number;

  constructor(readonly modelId: string, apiKey?: string, thinkingBudget = 0) {
    this.client = new Anthropic({ apiKey });
    this.thinkingBudget = thinkingBudget;
  }

  async step(context: StepContext): Promise<ModelResponse> {
    const messages = buildMessages(context);
    const systemPrompt = buildSystemPrompt(context);
    const { type: toolType, beta } = computerToolVersion(this.modelId);

    const betas: string[] = [beta];
    // Extended thinking requires interleaved-thinking beta as well
    if (this.thinkingBudget > 0) {
      betas.push("interleaved-thinking-2025-05-14");
    }

    const requestParams: Parameters<typeof this.client.beta.messages.create>[0] = {
      model: this.modelId,
      max_tokens: this.thinkingBudget > 0 ? this.thinkingBudget + 4096 : 4096,
      system: systemPrompt,
      messages,
      tools: [{
        type: toolType as "computer_20250124",
        name: "computer",
        display_width_px: context.screenshot.width,
        display_height_px: context.screenshot.height,
      }],
      betas,
    };

    if (this.thinkingBudget > 0) {
      (requestParams as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: this.thinkingBudget,
      };
    }

    const response = await this.client.beta.messages.create({
      ...requestParams,
      stream: false,
    }) as Anthropic.Beta.BetaMessage;

    const actions: CUAAction[] = [];
    const toolCallIds: string[] = [];
    let thinking: string | undefined;

    for (const block of response.content) {
      if (block.type === "thinking") {
        thinking = (block as { type: "thinking"; thinking: string }).thinking;
      } else if (block.type === "tool_use") {
        const toolBlock = block as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
        actions.push(decoder.fromAnthropic(toolBlock, {
          width: context.screenshot.width,
          height: context.screenshot.height,
        }));
        // Capture the real tool_use ID from the API response for correlation
        toolCallIds.push(toolBlock.id);
      }
    }

    return {
      actions,
      toolCallIds,
      thinking,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens,
        cacheWriteTokens: (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens,
      },
      rawResponse: response,
    };
  }

  // Cached response from the most recent stream() call — used by PerceptionLoop for token tracking.
  private _lastStreamResponse: ModelResponse | null = null;

  getLastStreamResponse(): ModelResponse | null {
    return this._lastStreamResponse;
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    const messages = buildMessages(context);
    const systemPrompt = buildSystemPrompt(context);
    const { type: toolType, beta } = computerToolVersion(this.modelId);
    const betas: string[] = [beta];
    if (this.thinkingBudget > 0) betas.push("interleaved-thinking-2025-05-14");

    const streamParams = {
      model: this.modelId,
      max_tokens: this.thinkingBudget > 0 ? this.thinkingBudget + 4096 : 4096,
      system: systemPrompt,
      messages,
      tools: [{
        type: toolType as "computer_20250124",
        name: "computer",
        display_width_px: context.screenshot.width,
        display_height_px: context.screenshot.height,
      }],
      betas,
      ...(this.thinkingBudget > 0 ? { thinking: { type: "enabled" as const, budget_tokens: this.thinkingBudget } } : {}),
    };

    // Accumulate partial JSON inputs and metadata for each content block
    const blockInputs = new Map<number, string>();
    const blockIds = new Map<number, string>();
    const allActions: CUAAction[] = [];
    const allToolCallIds: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let thinking: string | undefined;
    let currentBlockIndex = -1;
    let currentBlockType = "";

    // Use try-finally so _lastStreamResponse is always set even if consumer breaks early
    try {
      const msgStream = this.client.beta.messages.stream(
        streamParams as unknown as Parameters<typeof this.client.beta.messages.stream>[0],
      );

      for await (const event of msgStream) {
        const evType = event.type;
        if (evType === "message_start") {
          inputTokens = (event as { message: { usage: { input_tokens: number } } }).message.usage.input_tokens;
        } else if (evType === "content_block_start") {
          const ev = event as { index: number; content_block: { type: string; id?: string } };
          currentBlockIndex = ev.index;
          currentBlockType = ev.content_block.type;
          if (currentBlockType === "tool_use" && ev.content_block.id) {
            blockIds.set(currentBlockIndex, ev.content_block.id);
            blockInputs.set(currentBlockIndex, "");
          }
        } else if (evType === "content_block_delta") {
          const ev = event as { index: number; delta: { type: string; partial_json?: string; thinking?: string } };
          if (ev.delta.type === "input_json_delta" && ev.delta.partial_json !== undefined) {
            blockInputs.set(ev.index, (blockInputs.get(ev.index) ?? "") + ev.delta.partial_json);
          } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
            thinking = (thinking ?? "") + ev.delta.thinking;
          }
        } else if (evType === "content_block_stop") {
          if (currentBlockType === "tool_use") {
            const ev = event as { index: number };
            const jsonStr = blockInputs.get(ev.index) ?? "{}";
            const input = JSON.parse(jsonStr) as Record<string, unknown>;
            const id = blockIds.get(ev.index) ?? `toolu_${ev.index}`;
            const action = decoder.fromAnthropic(
              { name: "computer", input },
              { width: context.screenshot.width, height: context.screenshot.height },
            );
            allActions.push(action);
            allToolCallIds.push(id);
            yield action;
          }
        } else if (evType === "message_delta") {
          const ev = event as { usage: { output_tokens: number } };
          outputTokens = ev.usage.output_tokens;
        }
      }
    } finally {
      // Always cache the accumulated response so PerceptionLoop can call appendResponse()
      this._lastStreamResponse = {
        actions: allActions,
        toolCallIds: allToolCallIds,
        thinking,
        usage: { inputTokens, outputTokens },
        rawResponse: null,
      };
    }
  }

  estimateTokens(context: StepContext): number {
    return context.wireHistory.length * 200 + 1500;
  }

  async summarize(wireHistory: WireMessage[], currentState: TaskState | null): Promise<string> {
    // Strip base64 image data before serializing — screenshots can be megabytes of base64
    const safeHistory = wireHistory.slice(-20).map((msg) => {
      if (msg.role === "screenshot") {
        return { role: "screenshot", stepIndex: msg.stepIndex, compressed: true };
      }
      return msg;
    });

    const response = await this.client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          "Summarize this computer use session history concisely. Focus on what was accomplished, key facts discovered, and current state.",
          currentState ? `Current state: ${JSON.stringify(currentState)}` : "",
          `History (${wireHistory.length} messages): ${JSON.stringify(safeHistory)}`,
        ].filter(Boolean).join("\n\n"),
      }],
    });

    const firstBlock = response.content[0];
    return firstBlock?.type === "text" ? firstBlock.text : "Session history summarized.";
  }
}
