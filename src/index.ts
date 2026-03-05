// Public API — primary entry point
export { Agent } from "./agent.js";
export type { AgentOptions, AgentResult, AgentEvent, SerializedAgent, BrowserOptions } from "./types.js";

// Logger
export { LumenLogger } from "./logger.js";

// Session API
export { Session } from "./session.js";
export type { SessionOptions } from "./session.js";

// Types
export type {
  CUAAction,
  CUAEvent,
  CUAResult,
  RunOptions,
  LoopOptions,
  LoopResult,
  TaskState,
  SemanticStep,
  SerializedHistory,
  ScreenshotResult,
  ScreenshotOptions,
  ActionOutcome,
  ActionExecution,
  TokenUsage,
  LogLine,
  ViewportSize,
  Point,
  PreActionHook,
  PreActionDecision,
} from "./types.js";

// Errors
export { CUAError } from "./errors.js";
export type { CUAErrorCode } from "./errors.js";

// Browser
export type { BrowserTab, ClickOptions, TypeOptions, DragOptions } from "./browser/tab.js";
export { CDPTab } from "./browser/cdptab.js";
export { CdpConnection } from "./browser/cdp.js";
export { ViewportManager } from "./browser/viewport.js";
export { launchChrome } from "./browser/launch/local.js";
export { connectBrowserbase } from "./browser/launch/browserbase.js";
export type { BrowserbaseOptions } from "./browser/launch/browserbase.js";

// Model adapters
export type { ModelAdapter, StepContext, ModelResponse } from "./model/adapter.js";
export { denormalize, normalize, denormalizePoint } from "./model/adapter.js";
export { ActionDecoder } from "./model/decoder.js";
export { AnthropicAdapter } from "./model/anthropic.js";
export { GoogleAdapter } from "./model/google.js";
export { OpenAIAdapter } from "./model/openai.js";
export { CustomAdapter } from "./model/custom.js";

// Loop primitives (for custom integrations)
export { StateStore } from "./loop/state.js";
export { HistoryManager } from "./loop/history.js";
export { ActionRouter } from "./loop/router.js";
export type { RouterTiming } from "./loop/router.js";
export { PerceptionLoop } from "./loop/perception.js";
export type { PerceptionLoopOptions } from "./loop/perception.js";
export { ChildLoop } from "./loop/child.js";
export type { ChildLoopOptions, ChildLoopResult } from "./loop/child.js";
export { runPlanner } from "./loop/planner.js";
export { RepeatDetector } from "./loop/repeat-detector.js";
export { ActionCache } from "./loop/action-cache.js";

// Policy
export { SessionPolicy } from "./loop/policy.js";
export type { SessionPolicyOptions, SessionPolicyResult } from "./loop/policy.js";

// Verifiers (completion gates)
export { UrlMatchesGate, CustomGate, ModelVerifier } from "./loop/gate.js";
export type { Verifier, CompletionGate, GateResult } from "./loop/gate.js";

// Monitors
export { ConsoleMonitor, NoopMonitor } from "./loop/monitor.js";
export type { LoopMonitor } from "./loop/monitor.js";
export { StreamingMonitor } from "./loop/streaming-monitor.js";
