import OpenAI from "openai";
import type { ModelAdapter, StepContext } from "./adapter";
import type { ModelResponse } from "./adapter";
import { withRetry } from "./adapter";
import type { Action, TaskState, WireMessage } from "../types";
import { ActionDecoder } from "./decoder";

const decoder = new ActionDecoder();

function buildSystemPrompt(context: StepContext): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(context.systemPrompt);
  parts.push(`You are a computer use agent. Current URL: ${context.url || "(unknown)"}`);
  parts.push(`Step ${context.stepIndex + 1} of ${context.maxSteps}`);
  if (context.agentState && Object.keys(context.agentState).length > 0) {
    parts.push(`Current state: ${JSON.stringify(context.agentState)}`);
  }
  return parts.join("\n\n");
}

export class OpenAIAdapter implements ModelAdapter {
  readonly provider = "openai";
  readonly nativeComputerUse = true;
  readonly contextWindowTokens = 128_000;

  private readonly client: OpenAI;
  private previousResponseId: string | null = null;

  constructor(readonly modelId: string, apiKey?: string) {
    this.client = new OpenAI({ apiKey: apiKey ?? process.env.OPENAI_API_KEY });
  }

  async step(context: StepContext): Promise<ModelResponse> {
    const systemPrompt = buildSystemPrompt(context);

    const screenshotBase64 = context.screenshot.data.toString("base64");

    // Build input for Responses API
    const input: OpenAI.Responses.ResponseInput = [
      {
        role: "user" as const,
        content: [
          { type: "input_text" as const, text: systemPrompt },
          {
            type: "input_image" as const,
            image_url: `data:image/png;base64,${screenshotBase64}`,
            detail: "auto" as const,
          },
        ],
      },
    ];

    const params: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: this.modelId,
      tools: [{
        type: "computer-preview" as const,
        display_width: context.screenshot.width,
        display_height: context.screenshot.height,
        environment: "browser" as const,
      }],
      input,
      truncation: "auto" as const,
    };

    if (this.previousResponseId) {
      (params as unknown as Record<string, unknown>).previous_response_id = this.previousResponseId;
    }

    const response = await withRetry(() => this.client.responses.create(params));
    this.previousResponseId = response.id;

    const actions: Action[] = [];
    for (const item of response.output ?? []) {
      if (item.type === "computer_call") {
        actions.push(decoder.fromOpenAI(
          { type: "computer_call", action: item.action as unknown as Record<string, unknown> },
          { width: context.screenshot.width, height: context.screenshot.height }
        ));
      }
    }

    return {
      actions,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
      rawResponse: response,
    };
  }

  private _lastStreamResponse: ModelResponse | null = null;

  getLastStreamResponse(): ModelResponse | null {
    return this._lastStreamResponse;
  }

  async *stream(context: StepContext): AsyncIterable<Action> {
    // Delegate to step() for correct token tracking; cache response for PerceptionLoop
    const response = await this.step(context);
    this._lastStreamResponse = response;
    for (const action of response.actions) {
      yield action;
    }
  }

  estimateTokens(context: StepContext): number {
    return context.wireHistory.length * 200 + 1500;
  }

  async summarize(wireHistory: WireMessage[], currentState: Record<string, unknown> | null): Promise<string> {
    const response = await withRetry(() => this.client.responses.create({
      model: "gpt-4o-mini",
      input: [{
        role: "user" as const,
        content: [
          "Summarize this computer use session history concisely.",
          currentState ? `Current state: ${JSON.stringify(currentState)}` : "",
          `History (${wireHistory.length} messages): ${JSON.stringify(wireHistory.slice(-10))}`,
        ].filter(Boolean).join("\n\n"),
      }],
    }));

    const firstOutput = response.output?.[0];
    if (firstOutput?.type === "message") {
      const content = firstOutput.content?.[0];
      if (content?.type === "output_text") return content.text;
    }
    return "Session history summarized.";
  }
}
