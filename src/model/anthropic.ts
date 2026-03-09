import Anthropic from "@anthropic-ai/sdk";
import type { ModelAdapter, StepContext } from "./adapter.js";
import type { ModelResponse } from "./adapter.js";
import { withRetry } from "./adapter.js";
import type { Action, TaskState, WireMessage } from "../types.js";
import { ActionDecoder } from "./decoder.js";

const decoder = new ActionDecoder();

function buildSystemPrompt(context: StepContext): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(context.systemPrompt);
  parts.push(`Current URL: ${context.url || "(unknown)"}`);
  parts.push(`Step ${context.stepIndex + 1} of ${context.maxSteps}.`);
  parts.push(
    "RULES:\n" +
    "- Screenshots are automatic — never request one.\n" +
    "- Use navigate for URLs.\n" +
    "- TERMINATE IMMEDIATELY: If the answer is visible on screen, call task_complete RIGHT NOW. Do not scroll, click, or take any other action first.\n" +
    "- Use search/filter features on sites instead of scrolling through all results.\n" +
    "- If the page has a cookie/consent banner, dismiss it first, then proceed.\n" +
    "- EFFICIENT SCROLLING: Use key Page_Down to scroll instead of small mouse scrolls — each press advances a full screen.\n" +
    "- LIST VIEWS: When items in a list show visible values (prices, ratings, names), read them directly. Do NOT click into individual items to verify data already shown.\n" +
    "- TRUST MEMORY: If you already recorded data from a page, do NOT go back to re-verify. Use what you have.\n" +
    "- BE DECISIVE: Once you have sufficient information, call task_complete immediately. Do not keep browsing to double-check.\n" +
    "- THINK FIRST: Before acting, briefly consider: What key information is visible? What have I accomplished? What is my next step?\n" +
    "- CHECKPOINT PROGRESS: Call update_state every 3-5 steps to save your findings so far. Include ALL data collected — this persists even if history is compacted.\n" +
    "- Use fold() to compress completed sub-goals into permanent summaries that persist even if history is compacted.\n" +
    "- VERIFY ACTIONS: After any form interaction (date picker, dropdown, filter, checkbox), CHECK the next screenshot to confirm your selection was applied correctly. If the field shows a wrong value or the filter shows wrong results, try again with a different approach.\n" +
    "- DATE PICKERS: 1) First try typing the date directly into the input field (common formats: MM/DD/YYYY, YYYY-MM-DD). 2) If using a calendar widget, navigate to the correct MONTH first using arrow buttons, then click the specific date. 3) After selecting, READ the date field value in the next screenshot to verify it matches your intent.\n" +
    "- FORMS: Fill one field at a time. For dropdowns, click to open then click the exact option text. If an element doesn't respond to clicks, try Tab key to move between fields, or type directly into focused inputs.\n" +
    "- URL FALLBACK: If form filling (especially date pickers or complex filters) fails after 2-3 attempts, construct the search URL with query parameters and navigate directly. Most sites encode search parameters in the URL (e.g. check-in/check-out dates, destinations, filters).\n" +
    "- COMPLETE ALL SUB-TASKS: If the task asks for multiple pieces of information, track each one with update_state. Do NOT call task_complete until ALL requested items are found.\n" +
    "- NEVER HALLUCINATE: Only report information you can see on screen. If a specific piece of data is not visible, say so rather than guessing.",
  );
  if (context.agentState && Object.keys(context.agentState).length > 0) {
    parts.push(`State: ${JSON.stringify(context.agentState)}`);
  }
  // Urgency warning when nearing step limit
  const stepsRemaining = context.maxSteps - context.stepIndex - 1;
  if (stepsRemaining <= Math.max(3, Math.floor(context.maxSteps * 0.1))) {
    parts.push(
      `⚠️ URGENT: Only ${stepsRemaining} step(s) remaining! You MUST call task_complete on your NEXT action with your best answer based on what you have found so far. Do NOT continue browsing.`,
    );
  }
  return parts.join("\n");
}

function buildMessages(context: StepContext): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  // Pending content for the next user message (flushed before each assistant turn).
  // Wire order per step: [screenshot] → [assistant] → [tool_result...] → [screenshot] → ...
  //
  // Screenshots are embedded INSIDE tool_results (matching Anthropic's computer-use protocol).
  // The model sees: tool_result(content=[image, "ok"]) — clearly linking the screenshot to the action.
  // Only the initial screenshot (before any assistant turn) is a standalone user image.
  let pendingUserContent: Anthropic.MessageParam["content"] = [];
  // Track the latest screenshot to embed in the next tool_result batch
  let pendingScreenshot: { base64: string; compressed: boolean; stepIndex: number } | null = null;
  // Track whether we've seen an assistant turn yet (to distinguish initial vs action screenshots)
  let seenAssistant = false;
  // Track tool_result IDs in the current batch — the screenshot attaches to the last computer action's result
  let toolResultBatch: Array<{ toolUseId: string; ok: boolean; error?: string; isComputer: boolean }> = [];

  const flushUserMessage = () => {
    if (pendingUserContent.length === 0) return;
    messages.push({ role: "user", content: pendingUserContent });
    pendingUserContent = [];
  };

  // Emit accumulated tool_results, embedding the pending screenshot in the last computer result
  const flushToolResults = () => {
    for (let i = 0; i < toolResultBatch.length; i++) {
      const tr = toolResultBatch[i]!;
      const isLast = i === toolResultBatch.length - 1;
      // Attach screenshot to the last computer tool_result (or last result if no computer actions)
      const attachScreenshot = pendingScreenshot && isLast;

      if (attachScreenshot && !pendingScreenshot!.compressed) {
        // Rich content: [screenshot_image, result_text]
        const resultText = tr.ok
          ? "Action completed successfully"
          : `Error: ${tr.error ?? "unknown"}`;
        pendingUserContent = [...pendingUserContent, {
          type: "tool_result" as const,
          tool_use_id: tr.toolUseId,
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: pendingScreenshot!.base64,
              },
            },
            { type: "text", text: resultText },
          ],
          ...(!tr.ok ? { is_error: true as const } : {}),
        } as unknown as Anthropic.ImageBlockParam];
        pendingScreenshot = null;
      } else {
        // Simple text content
        pendingUserContent = [...pendingUserContent, {
          type: "tool_result" as const,
          tool_use_id: tr.toolUseId,
          content: tr.ok
            ? "Action completed successfully"
            : `Error: ${tr.error ?? "unknown"}`,
          ...(!tr.ok ? { is_error: true as const } : {}),
        } as unknown as Anthropic.ImageBlockParam];
      }
    }

    // If screenshot wasn't attached to any tool_result (compressed, or no tool_results),
    // add it as a standalone content block
    if (pendingScreenshot) {
      if (pendingScreenshot.compressed) {
        pendingUserContent = [...pendingUserContent, {
          type: "text",
          text: `[screenshot: step ${pendingScreenshot.stepIndex + 1}]`,
        } as Anthropic.TextBlockParam];
      } else {
        pendingUserContent = [...pendingUserContent, {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: pendingScreenshot.base64,
          },
        } as Anthropic.ImageBlockParam];
      }
      pendingScreenshot = null;
    }

    toolResultBatch = [];
  };

  for (const msg of context.wireHistory) {
    if (msg.role === "screenshot") {
      if (!seenAssistant) {
        // Initial screenshot (before first assistant turn) — standalone user image
        if (msg.compressed) {
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
      } else {
        // Post-action screenshot — will be embedded in the last tool_result
        // Flush any pending tool_results first (from a previous step's batch)
        flushToolResults();
        pendingScreenshot = {
          base64: msg.base64 as string,
          compressed: Boolean(msg.compressed),
          stepIndex: msg.stepIndex as number,
        };
      }
    } else if (msg.role === "assistant") {
      // Flush any remaining tool_results + screenshot from previous step
      flushToolResults();
      // Flush accumulated user content before emitting the assistant turn
      flushUserMessage();
      seenAssistant = true;

      const content: Anthropic.ContentBlock[] = [];
      if (msg.thinking) {
        content.push({ type: "text", text: msg.thinking as string } as unknown as Anthropic.ContentBlock);
      }
      if (Array.isArray(msg.actions)) {
        const actions = msg.actions as Action[];
        const toolCallIds = (msg.tool_call_ids as string[] | undefined) ?? [];
        for (let i = 0; i < actions.length; i++) {
          const action = actions[i]!;
          const id = toolCallIds[i] ?? `toolu_${i}_${action.type}`;
          if (action.type === "terminate") {
            if (id === "text_end_turn") {
              // Text-only response: no tool_use block was emitted — skip
            } else {
              content.push({
                type: "tool_use" as const,
                id,
                name: "task_complete",
                input: { result: (action as { result: string }).result },
              } as unknown as Anthropic.ContentBlock);
            }
          } else if (action.type === "goto") {
            content.push({
              type: "tool_use" as const,
              id,
              name: "navigate",
              input: { url: (action as { url: string }).url },
            } as unknown as Anthropic.ContentBlock);
          } else if (action.type === "writeState") {
            content.push({
              type: "tool_use" as const,
              id,
              name: "update_state",
              input: { data: action.data },
            } as unknown as Anthropic.ContentBlock);
          } else if (action.type === "fold") {
            content.push({
              type: "tool_use" as const,
              id,
              name: "fold",
              input: { summary: action.summary },
            } as unknown as Anthropic.ContentBlock);
          } else {
            content.push({
              type: "tool_use" as const,
              id,
              name: "computer",
              input: action,
            } as unknown as Anthropic.ContentBlock);
          }
        }
      }
      if (content.length > 0) {
        messages.push({ role: "assistant", content });
      }
    } else if (msg.role === "tool_result") {
      const toolUseId = (msg.tool_call_id as string | undefined) ?? `toolu_unknown`;
      if (toolUseId === "text_end_turn") {
        // nothing — no tool_use was emitted for this
      } else {
        const actionType = msg.action as string | undefined;
        // Computer tool actions are everything except goto/writeState/terminate
        const isComputer = actionType !== "goto" && actionType !== "writeState" && actionType !== "terminate" && actionType !== "fold";
        toolResultBatch.push({
          toolUseId,
          ok: msg.ok as boolean,
          error: msg.error as string | undefined,
          isComputer,
        });
      }
    } else if (msg.role === "summary") {
      pendingUserContent = [...pendingUserContent, {
        type: "text",
        text: `<summary>${msg.content as string}</summary>`,
      } as Anthropic.TextBlockParam];
    }
  }

  // Flush remaining tool_results + screenshot (current step)
  flushToolResults();
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
      tools: [
        {
          type: toolType as "computer_20250124",
          name: "computer",
          display_width_px: context.screenshot.width,
          display_height_px: context.screenshot.height,
        },
        {
          name: "navigate",
          description: "Navigate the browser to a URL. Use this instead of clicking the address bar.",
          input_schema: {
            type: "object" as const,
            properties: {
              url: { type: "string", description: "The full URL to navigate to (include https://)" },
            },
            required: ["url"],
          },
        } as unknown as Anthropic.Beta.BetaTool,
        {
          name: "update_state",
          description: "Persist data you need to remember across scrolls/pages. Replaces previous state on every call — include ALL data collected so far. Use for running best values, current minimum price, page count, any facts needed later.",
          input_schema: {
            type: "object" as const,
            properties: {
              data: {
                type: "object" as const,
                description: "Structured tracking data, e.g. {\"min_price\": \"£3.49\", \"min_title\": \"Sharp Objects\"}",
                additionalProperties: true,
              },
            },
            required: ["data"],
          },
        } as unknown as Anthropic.Beta.BetaTool,
        {
          name: "task_complete",
          description: "Call this when you have found the answer to the task. Provide your complete final answer in the 'result' field.",
          input_schema: {
            type: "object" as const,
            properties: {
              result: { type: "string", description: "Your final answer to the task" },
            },
            required: ["result"],
          },
        } as unknown as Anthropic.Beta.BetaTool,
        {
          name: "fold",
          description: "Compress a completed sub-goal into a permanent summary. Call when you finish a sub-task (e.g. 'Found cheapest flight: $342 Delta'). The summary persists even if history is compacted. Use this to keep your context clean.",
          input_schema: {
            type: "object" as const,
            properties: {
              summary: { type: "string", description: "Concise summary of what was accomplished" },
            },
            required: ["summary"],
          },
        } as unknown as Anthropic.Beta.BetaTool,
      ],
      betas,
    };

    // Apply temperature if set (used by ConfidenceGate for multi-sampling)
    if (context.temperature !== undefined) {
      (requestParams as unknown as Record<string, unknown>).temperature = context.temperature;
    }

    if (this.thinkingBudget > 0) {
      (requestParams as unknown as Record<string, unknown>).thinking = {
        type: "enabled",
        budget_tokens: this.thinkingBudget,
      };
    }

    const response = await withRetry(() => this.client.beta.messages.create({
      ...requestParams,
      stream: false,
    })) as Anthropic.Beta.BetaMessage;

    const actions: Action[] = [];
    const toolCallIds: string[] = [];
    let thinking: string | undefined;
    let finalText = "";

    for (const block of response.content) {
      if (block.type === "thinking") {
        thinking = (block as { type: "thinking"; thinking: string }).thinking;
      } else if (block.type === "tool_use") {
        const toolBlock = block as { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
        if (toolBlock.name === "task_complete") {
          const result = (toolBlock.input.result as string) ?? "";
          actions.push({ type: "terminate", status: "success", result });
          toolCallIds.push(toolBlock.id);
        } else if (toolBlock.name === "navigate") {
          const url = (toolBlock.input.url as string) ?? "";
          actions.push({ type: "goto", url });
          toolCallIds.push(toolBlock.id);
        } else if (toolBlock.name === "update_state") {
          const data = (toolBlock.input.data as TaskState) ?? {};
          actions.push({ type: "writeState", data });
          toolCallIds.push(toolBlock.id);
        } else if (toolBlock.name === "fold") {
          const summary = (toolBlock.input.summary as string) ?? "";
          actions.push({ type: "fold", summary });
          toolCallIds.push(toolBlock.id);
        } else {
          actions.push(decoder.fromAnthropic(toolBlock, {
            width: context.screenshot.width,
            height: context.screenshot.height,
          }));
          toolCallIds.push(toolBlock.id);
        }
      } else if (block.type === "text") {
        finalText = (block as { type: "text"; text: string }).text.trim();
      }
    }

    // Fallback: text-only end_turn (model ignored task_complete tool) → treat as task completion
    if (actions.length === 0 && finalText && response.stop_reason === "end_turn") {
      actions.push({ type: "terminate", status: "success", result: finalText });
      toolCallIds.push("text_end_turn");
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

  async *stream(context: StepContext): AsyncIterable<Action> {
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
      tools: [
        {
          type: toolType as "computer_20250124",
          name: "computer",
          display_width_px: context.screenshot.width,
          display_height_px: context.screenshot.height,
        },
        {
          name: "navigate",
          description: "Navigate the browser to a URL. Use this instead of clicking the address bar.",
          input_schema: {
            type: "object" as const,
            properties: {
              url: { type: "string", description: "The full URL to navigate to (include https://)" },
            },
            required: ["url"],
          },
        },
        {
          name: "update_state",
          description: "Persist data you need to remember across scrolls/pages. Replaces previous state on every call — include ALL data collected so far. Use for running best values, current minimum price, page count, any facts needed later.",
          input_schema: {
            type: "object" as const,
            properties: {
              data: {
                type: "object" as const,
                description: "Structured tracking data, e.g. {\"min_price\": \"£3.49\", \"min_title\": \"Sharp Objects\"}",
                additionalProperties: true,
              },
            },
            required: ["data"],
          },
        },
        {
          name: "task_complete",
          description: "Call this when you have found the answer to the task. Provide your complete final answer in the 'result' field.",
          input_schema: {
            type: "object" as const,
            properties: {
              result: { type: "string", description: "Your final answer to the task" },
            },
            required: ["result"],
          },
        },
        {
          name: "fold",
          description: "Compress a completed sub-goal into a permanent summary. Call when you finish a sub-task. The summary persists even if history is compacted.",
          input_schema: {
            type: "object" as const,
            properties: {
              summary: { type: "string", description: "Concise summary of what was accomplished" },
            },
            required: ["summary"],
          },
        },
      ],
      betas,
      ...(this.thinkingBudget > 0 ? { thinking: { type: "enabled" as const, budget_tokens: this.thinkingBudget } } : {}),
      ...(context.temperature !== undefined ? { temperature: context.temperature } : {}),
    };

    // Accumulate partial JSON inputs and metadata for each content block
    const blockInputs = new Map<number, string>();
    const blockIds = new Map<number, string>();
    const blockNames = new Map<number, string>();
    const allActions: Action[] = [];
    const allToolCallIds: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let thinking: string | undefined;
    let currentBlockIndex = -1;
    let currentBlockType = "";
    // Track text content — when model responds with text only (end_turn, no tool_use),
    // that IS the final answer. We emit a synthetic terminate action.
    let finalTextAccum = "";
    let pendingTerminate: Action | null = null;

    // Use try-finally so _lastStreamResponse is always set even if consumer breaks early
    try {
      const msgStream = await withRetry(() => Promise.resolve(this.client.beta.messages.stream(
        streamParams as unknown as Parameters<typeof this.client.beta.messages.stream>[0],
      )));

      for await (const event of msgStream) {
        const evType = event.type;
        if (evType === "message_start") {
          inputTokens = (event as { message: { usage: { input_tokens: number } } }).message.usage.input_tokens;
        } else if (evType === "content_block_start") {
          const ev = event as { index: number; content_block: { type: string; id?: string; name?: string } };
          currentBlockIndex = ev.index;
          currentBlockType = ev.content_block.type;
          if (currentBlockType === "tool_use" && ev.content_block.id) {
            blockIds.set(currentBlockIndex, ev.content_block.id);
            blockInputs.set(currentBlockIndex, "");
            blockNames.set(currentBlockIndex, ev.content_block.name ?? "computer");
          }
          if (currentBlockType === "text") {
            blockInputs.set(currentBlockIndex, "");
          }
        } else if (evType === "content_block_delta") {
          const ev = event as { index: number; delta: { type: string; partial_json?: string; text?: string; thinking?: string } };
          if (ev.delta.type === "input_json_delta" && ev.delta.partial_json !== undefined) {
            blockInputs.set(ev.index, (blockInputs.get(ev.index) ?? "") + ev.delta.partial_json);
          } else if (ev.delta.type === "text_delta" && ev.delta.text) {
            blockInputs.set(ev.index, (blockInputs.get(ev.index) ?? "") + ev.delta.text);
          } else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
            thinking = (thinking ?? "") + ev.delta.thinking;
          }
        } else if (evType === "content_block_stop") {
          if (currentBlockType === "tool_use") {
            const ev = event as { index: number };
            const jsonStr = blockInputs.get(ev.index) ?? "{}";
            const input = JSON.parse(jsonStr) as Record<string, unknown>;
            const id = blockIds.get(ev.index) ?? `toolu_${ev.index}`;
            const blockName = blockNames.get(ev.index) ?? "computer";
            let action: Action;
            if (blockName === "task_complete") {
              const result = (input.result as string) ?? "";
              action = { type: "terminate", status: "success", result };
            } else if (blockName === "navigate") {
              const url = (input.url as string) ?? "";
              action = { type: "goto", url };
            } else if (blockName === "update_state") {
              const data = (input.data as TaskState) ?? {};
              action = { type: "writeState", data };
            } else if (blockName === "fold") {
              const summary = (input.summary as string) ?? "";
              action = { type: "fold", summary };
            } else {
              action = decoder.fromAnthropic(
                { name: "computer", input },
                { width: context.screenshot.width, height: context.screenshot.height },
              );
            }
            allActions.push(action);
            allToolCallIds.push(id);
            yield action;
          } else if (currentBlockType === "text") {
            const text = (blockInputs.get(currentBlockIndex) ?? "").trim();
            if (text) finalTextAccum = text;
          }
        } else if (evType === "message_delta") {
          const ev = event as { usage: { output_tokens: number }; delta?: { stop_reason?: string } };
          outputTokens = ev.usage.output_tokens;
          // Detect end_turn with no tool calls → model is done, treat as success termination
          if (ev.delta?.stop_reason === "end_turn" && allActions.length === 0 && finalTextAccum) {
            pendingTerminate = { type: "terminate", status: "success", result: finalTextAccum };
          }
        }
      }

      // Emit terminate after the stream loop if end_turn was detected
      if (pendingTerminate) {
        allActions.push(pendingTerminate);
        allToolCallIds.push("text_end_turn");
        yield pendingTerminate;
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

    const response = await withRetry(() => this.client.messages.create({
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
    }));

    const firstBlock = response.content[0];
    return firstBlock?.type === "text" ? firstBlock.text : "Session history summarized.";
  }
}
