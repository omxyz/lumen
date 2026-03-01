import { GoogleGenAI, Environment } from "@google/genai";
import type { ModelAdapter, StepContext } from "./adapter.js";
import type { ModelResponse } from "./adapter.js";
import type { CUAAction, TaskState, WireMessage } from "../types.js";
import { ActionDecoder } from "./decoder.js";

const decoder = new ActionDecoder();

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildSystemInstruction(context: StepContext): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(context.systemPrompt);
  parts.push(`You are a computer use agent. Current URL: ${context.url || "(unknown)"}`);
  parts.push(`Step ${context.stepIndex + 1} of ${context.maxSteps}`);
  if (context.factStore.length > 0) {
    parts.push("Memory:\n" + context.factStore.map((f) => `- ${f}`).join("\n"));
  }
  return parts.join("\n\n");
}

export class GoogleAdapter implements ModelAdapter {
  readonly provider = "google";
  readonly nativeComputerUse = true;
  readonly patchSize = 56;
  readonly maxImageDimension = 1568;

  get contextWindowTokens(): number {
    return 1_000_000;
  }

  private readonly client: GoogleGenAI;

  constructor(readonly modelId: string, apiKey?: string) {
    this.client = new GoogleGenAI({ apiKey: apiKey ?? process.env.GOOGLE_API_KEY ?? "" });
  }

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let delay = 1000;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        const error = err as { status?: number; code?: number };
        if ((error.status === 429 || error.status === 503 || error.code === 429) && attempt < 3) {
          await sleep(delay + Math.random() * 500);
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  async step(context: StepContext): Promise<ModelResponse> {
    return this.callWithRetry(async () => {
      const systemInstruction = buildSystemInstruction(context);

      const contents = [
        {
          role: "user" as const,
          parts: [
            { text: `Step ${context.stepIndex + 1}: ${context.url}` },
            {
              inlineData: {
                mimeType: "image/png" as const,
                data: context.screenshot.data.toString("base64"),
              },
            },
          ],
        },
      ];

      const response = await this.client.models.generateContent({
        model: this.modelId,
        contents,
        config: {
          systemInstruction,
          tools: [{ computerUse: { environment: Environment.ENVIRONMENT_BROWSER } }],
        },
      });

      const actions: CUAAction[] = [];

      const candidates = response.candidates ?? [];
      for (const candidate of candidates) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall) {
            actions.push(decoder.fromGoogle({
              name: part.functionCall.name ?? "",
              args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            }));
          }
        }
      }

      return {
        actions,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
        rawResponse: response,
      };
    });
  }

  private _lastStreamResponse: ModelResponse | null = null;

  getLastStreamResponse(): ModelResponse | null {
    return this._lastStreamResponse;
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    // Delegate to step() for correct token tracking; cache response for PerceptionLoop
    try {
      const response = await this.step(context);
      this._lastStreamResponse = response;
      for (const action of response.actions) {
        yield action;
      }
    } finally {
      // _lastStreamResponse set inside try block; no-op here if step() throws
    }
  }

  estimateTokens(context: StepContext): number {
    return context.wireHistory.length * 200 + 1500;
  }

  async summarize(wireHistory: WireMessage[], currentState: TaskState | null): Promise<string> {
    const response = await this.client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{
        role: "user" as const,
        parts: [{
          text: [
            "Summarize this computer use session history concisely.",
            currentState ? `Current state: ${JSON.stringify(currentState)}` : "",
            `History (${wireHistory.length} messages): ${JSON.stringify(wireHistory.slice(-10))}`,
          ].filter(Boolean).join("\n\n"),
        }],
      }],
    });

    return response.candidates?.[0]?.content?.parts?.[0]?.text ?? "Session history summarized.";
  }
}
