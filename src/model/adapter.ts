import type { CUAAction, ScreenshotResult, TaskState, TokenUsage, ViewportSize, WireMessage } from "../types.js";

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
  actions: CUAAction[];
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
  stream(context: StepContext): AsyncIterable<CUAAction>;

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
