import type { Action, ScreenshotResult, TaskState, TokenUsage, ViewportSize, WireMessage } from "../types.js";

// ─── Retry utility ───────────────────────────────────────────────────────────

function retrySleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryable(e: unknown): boolean {
  if (e instanceof Error) {
    const msg = e.message;
    return msg.includes("429") || msg.includes("529") || msg.includes("overloaded") ||
           msg.includes("500") || msg.includes("503");
  }
  const status = (e as { status?: number }).status;
  return status === 429 || status === 500 || status === 503 || status === 529;
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1 || !isRetryable(e)) throw e;
      await retrySleep(1000 * 2 ** i);
    }
  }
  throw new Error("unreachable");
}

export interface StepContext {
  screenshot: ScreenshotResult;
  wireHistory: WireMessage[];
  agentState: TaskState | null;
  stepIndex: number;
  maxSteps: number;
  url: string;
  systemPrompt?: string;
}

export interface ModelResponse {
  actions: Action[];
  /** Stable IDs assigned to each tool call, parallel to `actions[]`.
   *  Used to correlate tool_result messages with their tool_use messages.
   *  Must be populated by adapters that use the Anthropic message format. */
  toolCallIds?: string[];
  thinking?: string;
  usage: TokenUsage;
  rawResponse: unknown;
}

/** Single interface all model providers implement. */
export interface ModelAdapter {
  readonly modelId: string;
  readonly provider: string;

  // Capabilities — used by ViewportManager and HistoryManager
  readonly patchSize?: number;
  readonly maxImageDimension?: number;
  readonly supportsThinking?: boolean;
  readonly nativeComputerUse: boolean;
  readonly contextWindowTokens: number;

  /** Streaming variant — yields actions as each tool call input block completes.
   *  PerceptionLoop executes each action immediately without waiting for message_stop. */
  stream(context: StepContext): AsyncIterable<Action>;

  /** Single-shot variant — waits for all actions before returning. */
  step(context: StepContext): Promise<ModelResponse>;

  /** Estimate token count for a given context (used by HistoryManager). */
  estimateTokens(context: StepContext): number;

  /** Called by HistoryManager.compactWithSummary() to generate the <summary> block. */
  summarize(wireHistory: WireMessage[], agentState: TaskState | null): Promise<string>;
}

// ─── Coordinate helpers ───────────────────────────────────────────────────────

/** Model-space (0–1000) → viewport pixels */
export function denormalize(coord: number, dimension: number): number {
  return Math.round((coord / 1000) * dimension);
}

/** Viewport pixels → model-space (0–1000) */
export function normalize(pixel: number, dimension: number): number {
  return Math.round((pixel / dimension) * 1000);
}

export function clampNormalized(coord: number): number {
  return Math.max(0, Math.min(1000, coord));
}

export function denormalizePoint(
  x: number,
  y: number,
  viewport: ViewportSize,
): { x: number; y: number } {
  return {
    x: denormalize(x, viewport.width),
    y: denormalize(y, viewport.height),
  };
}
