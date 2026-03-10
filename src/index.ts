// Public API — primary entry point
export { Agent } from "./agent";
export type { AgentOptions, SerializedAgent, BrowserOptions } from "./types";

// Logger
export { LumenLogger } from "./logger";

// Session API
export { Session } from "./session";
export type { SessionOptions } from "./session";

// Types
export type {
  Action,
  StreamEvent,
  RunResult,
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
} from "./types";

// Errors
export { LumenError } from "./errors";
export type { LumenErrorCode } from "./errors";

// Browser
export type { BrowserTab, ClickOptions, TypeOptions, DragOptions } from "./browser/tab";
export { CDPTab } from "./browser/cdptab";
export { CdpConnection } from "./browser/cdp";
export { ViewportManager } from "./browser/viewport";
export { launchChrome } from "./browser/launch/local";
export { connectBrowserbase } from "./browser/launch/browserbase";
export type { BrowserbaseOptions } from "./browser/launch/browserbase";

// Model adapters
export type { ModelAdapter, StepContext, ModelResponse } from "./model/adapter";
export { denormalize, normalize, denormalizePoint } from "./model/adapter";
export { ActionDecoder } from "./model/decoder";
export { AnthropicAdapter } from "./model/anthropic";
export { GoogleAdapter } from "./model/google";
export { OpenAIAdapter } from "./model/openai";
export { CustomAdapter } from "./model/custom";

// Loop primitives (for custom integrations)
export { StateStore } from "./loop/state";
export { HistoryManager } from "./loop/history";
export { ActionRouter } from "./loop/router";
export type { RouterTiming } from "./loop/router";
export { PerceptionLoop } from "./loop/perception";
export type { PerceptionLoopOptions } from "./loop/perception";
export { ChildLoop } from "./loop/child";
export type { ChildLoopOptions, ChildLoopResult } from "./loop/child";
export { runPlanner } from "./loop/planner";
export { RepeatDetector } from "./loop/repeat-detector";
export { ActionCache, viewportMismatch } from "./loop/action-cache";

// Policy
export { SessionPolicy } from "./loop/policy";
export type { SessionPolicyOptions, SessionPolicyResult } from "./loop/policy";

// Verifiers (completion gates)
export { UrlMatchesGate, CustomGate, ModelVerifier } from "./loop/verifier";
export type { Verifier, VerifyResult } from "./loop/verifier";

// Monitors
export { ConsoleMonitor, NoopMonitor } from "./loop/monitor";
export type { LoopMonitor } from "./loop/monitor";
export { StreamingMonitor } from "./loop/streaming-monitor";

// Optional features
export { ConfidenceGate } from "./loop/confidence-gate";
export type { ConfidenceGateOptions } from "./loop/confidence-gate";
export { ActionVerifier } from "./loop/action-verifier";
export type { ActionVerification } from "./loop/action-verifier";
export { CheckpointManager } from "./loop/checkpoint";
export type { BrowserCheckpoint } from "./loop/checkpoint";
export { SiteKB } from "./memory/site-kb";
export type { SiteRule } from "./memory/site-kb";
export { WorkflowMemory } from "./memory/workflow";
export type { Workflow } from "./memory/workflow";
