// ─── Coordinates ─────────────────────────────────────────────────────────────

/** Pixel coordinate in viewport space. Sent directly to browser. */
export type PixelCoord = number;

export interface Point {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

// ─── Screenshot ───────────────────────────────────────────────────────────────

export interface ScreenshotResult {
  data: Buffer;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
}

export interface ScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
  /** Composite a cursor dot at last click position. Default: true */
  cursorOverlay?: boolean;
  fullPage?: boolean;
}

// ─── Task State ───────────────────────────────────────────────────────────────

/** Persistent structured state written by the model via writeState.
 *  Last-write-wins, re-injected every step — survives history compaction.
 *  Mirrors Claude Code's task state pattern: replace-on-write structured data. */
export type TaskState = Record<string, unknown>;

// ─── CUA Actions ─────────────────────────────────────────────────────────────

/** All coordinates are in viewport pixel space. Decoders convert from each
 *  provider's native format (Anthropic/OpenAI pixels, Google 0-1000) to pixels
 *  at decode time. ActionRouter uses coords directly without conversion. */
export type CUAAction =
  | { type: "click"; x: PixelCoord; y: PixelCoord; button?: "left" | "right" | "middle" }
  | { type: "doubleClick"; x: PixelCoord; y: PixelCoord }
  | { type: "drag"; startX: PixelCoord; startY: PixelCoord; endX: PixelCoord; endY: PixelCoord }
  | { type: "scroll"; x: PixelCoord; y: PixelCoord; direction: "up" | "down" | "left" | "right"; amount: number }
  | { type: "type"; text: string }
  | { type: "keyPress"; keys: string[] }
  | { type: "wait"; ms: number }
  | { type: "goto"; url: string }
  | { type: "writeState"; data: TaskState }
  | { type: "screenshot" }
  | { type: "terminate"; status: "success" | "failure"; result: string }
  | { type: "hover"; x: PixelCoord; y: PixelCoord }
  | { type: "delegate"; instruction: string; maxSteps?: number };

// ─── Action Outcome ───────────────────────────────────────────────────────────

/** Returned by every BrowserTab input method. Never throws — errors are context. */
export interface ActionOutcome {
  ok: boolean;
  error?: string;
}

/** Returned by ActionRouter after executing a CUAAction. */
export interface ActionExecution {
  ok: boolean;
  error?: string;
  terminated?: boolean;
  status?: "success" | "failure";
  result?: string;
  isScreenshotRequest?: boolean;
  isDelegateRequest?: boolean;
  delegateInstruction?: string;
  delegateMaxSteps?: number;
}

// ─── Token Usage ──────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ─── History ──────────────────────────────────────────────────────────────────

/** Human-readable record of one loop step. Never compressed. */
export interface SemanticStep {
  stepIndex: number;
  url: string;
  screenshotBase64: string;
  thinking?: string;
  actions: Array<{
    action: CUAAction;
    outcome: { ok: boolean; error?: string };
  }>;
  agentState: TaskState | null;
  tokenUsage: TokenUsage;
  durationMs: number;
}

export type WireMessage = Record<string, unknown>;

export interface SerializedHistory {
  wireHistory: WireMessage[];
  semanticSteps: SemanticStep[];
  agentState: TaskState | null;
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

export interface LoopOptions {
  maxSteps: number;
  systemPrompt?: string;
  /** 0.0–1.0. Trigger LLM compaction at this utilization level. Default: 0.8 */
  compactionThreshold?: number;
  /** Hash of the original task instruction, used as part of the action cache key. */
  instructionHash?: string;
}

export interface LoopResult {
  status: "success" | "failure" | "maxSteps";
  result: string;
  steps: number;
  history: SemanticStep[];
  agentState: TaskState | null;
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface CUAResult {
  status: "success" | "failure" | "maxSteps";
  result: string;
  steps: number;
  history: SemanticStep[];
  agentState: TaskState | null;
  tokenUsage: TokenUsage;
}

export interface RunOptions {
  instruction: string;
  maxSteps?: number;
  /** Navigate to this URL before the first model step. Saves 1-2 steps vs putting URL in instruction. */
  startUrl?: string;
}

// ─── Streaming Events ─────────────────────────────────────────────────────────

export type CUAEvent =
  | { type: "step_start"; step: number; maxSteps: number; url: string }
  | { type: "screenshot"; step: number; imageBase64: string }
  | { type: "thinking"; step: number; text: string }
  | { type: "action"; step: number; action: CUAAction }
  | { type: "action_result"; step: number; action: CUAAction; ok: boolean; error?: string }
  | { type: "action_blocked"; step: number; action: CUAAction; reason: string }
  | { type: "state_written"; step: number; data: TaskState }
  | { type: "compaction"; step: number; tokensBefore: number; tokensAfter: number }
  | { type: "termination_rejected"; step: number; reason: string }
  | { type: "done"; result: CUAResult };

// ─── Pre-Action Hook ──────────────────────────────────────────────────────────

/** Decision returned by a PreActionHook. */
export type PreActionDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

/**
 * Optional intercept fired before every model-emitted action.
 * Complements SessionPolicy (declarative) with imperative custom logic.
 * Common uses: audit logging, rate limiting, custom deny rules.
 */
export type PreActionHook = (action: CUAAction) => Promise<PreActionDecision> | PreActionDecision;

// ─── Logging ──────────────────────────────────────────────────────────────────

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
}

// ─── Agent (public facade) ────────────────────────────────────────────────────

export type AgentResult = CUAResult;
export type AgentEvent = CUAEvent;
export interface SerializedAgent extends SerializedHistory { modelId: string; }

export type BrowserOptions =
  | { type: "local"; port?: number; headless?: boolean; userDataDir?: string }
  | { type: "cdp"; url: string }
  | { type: "browserbase"; apiKey: string; projectId: string; sessionId?: string };

export interface AgentOptions {
  /** e.g. "anthropic/claude-opus-4-6", "google/gemini-2.0-flash", "openai/computer-use-preview" */
  model: string;
  apiKey?: string;
  baseURL?: string;   // for CustomAdapter
  browser: BrowserOptions;
  plannerModel?: string;
  autoAlignViewport?: boolean;
  systemPrompt?: string;
  maxSteps?: number;
  /** Anthropic extended thinking token budget. Default: 0 (disabled). */
  thinkingBudget?: number;
  /** Trigger LLM summarization compaction at this utilization. Default: 0.8 */
  compactionThreshold?: number;
  /** Override model used for compaction summarization (defaults to main model). */
  compactionModel?: string;
  /** Keep this many recent screenshots in wire history. Default: 2. */
  keepRecentScreenshots?: number;
  /** Composite a cursor dot at last click position. Default: true. */
  cursorOverlay?: boolean;
  /** 0=silent, 1=minimal, 2=full. Default: 1. */
  verbose?: 0 | 1 | 2;
  /** Structured log callback. Called alongside ConsoleMonitor when set. */
  logger?: (line: import("./types.js").LogLine) => void;
  timing?: import("./loop/router.js").RouterTiming;
  policy?: import("./loop/policy.js").SessionPolicyOptions;
  /** Optional hook called before every action. Return deny to block with reason. */
  preActionHook?: PreActionHook;
  completionGate?: import("./loop/gate.js").Verifier;
  monitor?: import("./loop/monitor.js").LoopMonitor;
  /** Resume with pre-loaded history. Prefer Agent.resume() for full roundtrip. */
  initialHistory?: import("./types.js").SerializedHistory;
  initialState?: TaskState;
}
