# Lumen Architecture

Deep dive into every layer of the engine. Start here if you are extending Lumen, writing a custom adapter, or debugging surprising behavior.

## Table of Contents

- [Layered Overview](#layered-overview)
- [The Loop](#the-loop)
  - [PerceptionLoop.run()](#perceptionlooprun)
  - [Wire order](#wire-order)
  - [Compaction lifecycle](#compaction-lifecycle)
- [Coordinate Model](#coordinate-model)
- [History](#history)
  - [Dual representation](#dual-representation)
  - [Tier-1: Screenshot compression](#tier-1-screenshot-compression)
  - [Tier-2: LLM summarization](#tier-2-llm-summarization)
- [Memory: StateStore](#memory-statestore)
- [ActionRouter](#actionrouter)
- [ModelAdapter interface](#modeladapter-interface)
  - [AnthropicAdapter](#anthropicadapter)
  - [GoogleAdapter](#googleadapter)
  - [OpenAIAdapter](#openaiadapter)
  - [CustomAdapter](#customadapter)
- [Browser layer](#browser-layer)
  - [BrowserTab interface](#browsertab-interface)
  - [CDPTab](#cdptab)
  - [ViewportManager](#viewportmanager)
- [Safety layer](#safety-layer)
  - [SessionPolicy](#sessionpolicy)
  - [PreActionHook](#preactionhook)
  - [CompletionGate](#completiongate)
- [ChildLoop (delegation)](#childloop-delegation)
- [Planner](#planner)
- [Observability](#observability)
  - [LoopMonitor](#loopmonitor)
  - [StreamingMonitor](#streamingmonitor)
- [Public API layers](#public-api-layers)
  - [Agent (facade)](#agent-facade)
  - [Session](#session)
- [Error model](#error-model)
- [Module graph](#module-graph)

---

## Layered Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Agent (public facade)                 │
│   lazy connection · planner pass · serialize/resume      │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                         Session                          │
│        assembles loop components · owns lifecycle        │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│                    PerceptionLoop                        │
│  screenshot → model.stream() → router.execute() → ...    │
│  compaction · policy · gate · child delegation           │
└─────┬────────────────┬───────────────┬──────────────────┘
      │                │               │
┌─────▼──────┐  ┌──────▼──────┐ ┌─────▼──────┐
│HistoryMgr  │  │ActionRouter │ │ModelAdapter│
│wire+semantic│  │denormalize  │ │stream/step │
│compress    │  │browser calls│ │summarize   │
└────────────┘  └──────┬──────┘ └────────────┘
                        │
                ┌───────▼────────┐
                │  BrowserTab    │
                │  (CDPTab impl) │
                └────────────────┘
```

---

## The Loop

### PerceptionLoop.run()

Every step of the perception loop follows this sequence:

```
1. Proactive compaction (if token utilization > threshold)
2. Take screenshot (with optional cursor overlay)
3. Store screenshot in wire history
4. Build StepContext (screenshot + wire history + state)
5. Notify monitor: stepStarted
6. Stream actions from adapter.stream(context)
   For each action emitted mid-stream:
   a. PreActionHook check
   b. SessionPolicy check
   c. ActionRouter.execute()
   d. Buffer outcome (not written to wire yet)
   e. If terminate: verify with CompletionGate, drain stream
   f. If delegate: run ChildLoop
7. Record assistant turn in wire history (adapter.getLastStreamResponse)
8. Replay buffered action outcomes as tool_results in wire history
9. Notify monitor: stepCompleted
10. Tier-1 screenshot compression (compressScreenshots)
11. Append SemanticStep to semantic history
12. Repeat or exit if maxSteps
```

The buffering in step 6 is critical. Actions are executed immediately as the stream arrives (low latency), but their wire format is not recorded until after the assistant turn is committed. This maintains the correct Anthropic message format:

```
user:  [screenshot image]
asst:  [tool_use: click]
user:  [tool_result: ok] [screenshot image]
asst:  [tool_use: goto]
...
```

### Wire order

The wire history is a flat array of tagged records:

```typescript
type WireMessage =
  | { role: "screenshot"; base64: string | null; stepIndex: number; compressed: boolean }
  | { role: "assistant"; actions: CUAAction[]; tool_call_ids?: string[]; thinking?: string }
  | { role: "tool_result"; tool_call_id: string; action: string; ok: boolean; error?: string }
  | { role: "summary"; content: string; compactedAt: number }
```

Each adapter's `buildMessages()` function translates this flat array into the provider-specific message format. The wire format is provider-agnostic.

### Compaction lifecycle

```
Token utilization = totalInputTokens / contextWindowTokens

At start of each step:
  if utilization > compactionThreshold (default 0.8):
    Tier-2: compactWithSummary() — LLM writes a <summary> block, replaces all wire history
    Tier-1: compressScreenshots(keepRecent) — runs unconditionally

After each step:
  Tier-1: compressScreenshots(keepRecent) — always
```

Tier-2 compaction resets `totalInputTokens` to 15% of pre-compaction value (rough estimate). This gives the loop headroom to continue without hitting the hard context limit.

---

## Coordinate Model

Every coordinate in the codebase lives in one of two spaces:

| Space | Range | Who uses it |
|---|---|---|
| **Normalized** (NormalizedCoord) | 0–1000 | Models, CUAAction, wire history |
| **Pixels** | 0–width/height | BrowserTab methods, CDP protocol |

The conversion happens exactly once, in `ActionRouter.execute()`:

```typescript
// src/loop/router.ts
const x = denormalize(action.x, viewport.width);   // NormalizedCoord → px
const y = denormalize(action.y, viewport.height);
await tab.click(x, y, { button: action.button });
```

And the helpers:

```typescript
// src/model/adapter.ts
export function denormalize(coord: number, dimension: number): number {
  return Math.round((coord / 1000) * dimension);
}

export function normalize(pixel: number, dimension: number): number {
  return Math.round((pixel / dimension) * 1000);
}
```

Models that natively use different coordinate spaces (e.g. Anthropic's `computer_20250124` uses pixels, `computer_20251124` uses a patch grid) have that handled entirely inside the adapter's `ActionDecoder` — the CUAAction that emerges is always in 0–1000 space.

---

## History

### Dual representation

Every agent session maintains two parallel histories:

**Wire history** (`HistoryManager.wire: WireMessage[]`)
- Provider-facing. Fed into every model call via `buildMessages()`.
- Compressed aggressively: tier-1 nulls out old screenshot base64, tier-2 replaces the entire array with a summary anchor.
- The source of truth for what the model "sees."

**Semantic history** (`HistoryManager.semantic: SemanticStep[]`)
- Human/developer-facing. Never compressed or mutated.
- Contains full screenshots, thinking text, all actions and their outcomes, token counts, timing.
- Returned in `AgentResult.history` and `agent.history()`.
- Used for debugging, auditing, and replay.

### Tier-1: Screenshot compression

```typescript
compressScreenshots(keepRecent = 2): void
```

Runs after every step. Finds all `screenshot` entries in the wire array, keeps the last `keepRecent` entries intact, and replaces earlier entries with `{ ...entry, base64: null, compressed: true }`.

Compressed entries are rendered as text tokens in `buildMessages()`:
```
[screenshot: step 3]
```

This alone accounts for most of the 32% token reduction — screenshots are typically 40–100KB of base64 each.

### Tier-2: LLM summarization

```typescript
compactWithSummary(adapter: ModelAdapter, currentState: TaskState | null)
```

Triggered proactively when `tokenUtilization() > compactionThreshold`. Uses `adapter.summarize()` (a cheap Haiku-class call for Anthropic) to write a concise natural-language summary of what happened, then replaces the entire wire history with a single `{ role: "summary", content: "..." }` entry.

The main model resumes from the summary as if it has always known that history. Agent state is re-injected every step from `StateStore`, so it is never lost in compaction.

---

## Memory: StateStore

An in-session memory mechanism that survives history compaction.

### StateStore

A structured `TaskState` object, written via the `writeState` action.

```typescript
// Any JSON-serializable object
type TaskState = Record<string, unknown>;
```

Only the model can write state. It is re-injected as a JSON blob in the system prompt each step:

```
Task state: {"min_price":"£3.49","min_title":"Sharp Objects"}
```

`StateStore` holds only the latest value (not a history of writes). It is serialized in `SerializedHistory.agentState`.

---

## ActionRouter

`ActionRouter` is the single place where:
1. Coordinates are denormalized from 0–1000 to pixels.
2. CUAActions are dispatched to the appropriate `BrowserTab` method.
3. Post-action sleep delays are applied.
4. Special actions (`writeState`, `terminate`, `delegate`, `screenshot`) are handled without touching the browser.
5. Errors from `BrowserTab` are caught and returned as `ActionExecution` objects (never thrown).

```typescript
execute(action: CUAAction, tab: BrowserTab, state: StateStore): Promise<ActionExecution>
```

`ActionExecution` carries:
- `ok: boolean` — whether the action succeeded
- `error?: string` — error message (fed back to model as `is_error` tool result)
- `terminated?: boolean` — set by `terminate` action
- `isDelegateRequest?: boolean` — set by `delegate` action
- `isScreenshotRequest?: boolean` — set by `screenshot` action

`RouterTiming` overrides the default post-action delays:

```typescript
{
  afterClick: 200,       // ms to wait after click/doubleClick/drag/hover
  afterType: 500,        // ms after type
  afterScroll: 300,      // ms after scroll
  afterNavigation: 1000, // ms after goto (passed to tab.waitForLoad)
}
```

---

## ModelAdapter interface

```typescript
interface ModelAdapter {
  readonly modelId: string;
  readonly provider: string;
  readonly patchSize?: number;           // Grid size for viewport alignment
  readonly maxImageDimension?: number;   // Max image edge length
  readonly supportsThinking?: boolean;
  readonly nativeComputerUse: boolean;   // Uses provider's computer-use tool
  readonly contextWindowTokens: number;  // For compaction threshold calculation

  stream(context: StepContext): AsyncIterable<CUAAction>;  // Primary
  step(context: StepContext): Promise<ModelResponse>;       // Single-shot

  estimateTokens(context: StepContext): number;
  summarize(wireHistory: WireMessage[], currentState: TaskState | null): Promise<string>;
}
```

The loop uses `stream()` exclusively. `step()` is used by the planner and by `CustomAdapter` (which delegates `stream()` to `step()` internally).

### AnthropicAdapter

- `nativeComputerUse: true`
- `contextWindowTokens: 200_000`
- `patchSize: 28`, `maxImageDimension: 1344` (used by `ViewportManager`)
- Selects `computer_20251124` for Claude 4.x models, `computer_20250124` for older.
- Streaming: parses `content_block_delta` events, yields each `CUAAction` when its `content_block_stop` arrives.
- Thinking: accumulates `thinking_delta` events; exposed in `ModelResponse.thinking`.
- Summarization: uses `claude-haiku-4-5-20251001` (cheap, fast).
- Maintains `_lastStreamResponse` so `PerceptionLoop` can call `appendResponse()` after the stream.

### GoogleAdapter

- Uses `@google/genai` with the `computerUse` tool.
- `contextWindowTokens: 1_000_000` (Gemini 1M context)
- Coordinates from Google are in 0–1000 space natively; ActionDecoder passes them through.

### OpenAIAdapter

- Uses the `openai` SDK's Responses API (`client.responses.create`).
- `nativeComputerUse: true`
- Normalizes OpenAI computer-tool coordinates to 0–1000 in `ActionDecoder`.

### CustomAdapter

- Falls back to standard chat completions for any unknown model string.
- `nativeComputerUse: false` — the action schema is presented as a JSON function call instead of a native computer-use tool.
- `stream()` delegates to `step()` and yields actions from the response.

### Adding a new adapter

1. Implement `ModelAdapter` in `src/model/your-adapter.ts`.
2. Register it in `agent.ts`'s `createAdapter()` function.
3. Export it from `src/index.ts`.

---

## Browser layer

### BrowserTab interface

```typescript
interface BrowserTab {
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;
  click(x: number, y: number, options?: ClickOptions): Promise<ActionOutcome>;
  doubleClick(x: number, y: number): Promise<ActionOutcome>;
  hover / drag / scroll / type / keyPress / goto / waitForLoad
  url(): string;
  viewport(): ViewportSize;
  setViewport(size: ViewportSize): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
  close(): Promise<void>;
}
```

All coordinate parameters are in **pixels** (already denormalized by `ActionRouter`). All methods return `ActionOutcome` — `{ ok: boolean; error?: string }` — never throw.

### CDPTab

`CDPTab` (in `src/browser/cdptab.ts`) is the production implementation, backed by a raw CDP WebSocket connection (`CdpConnection` in `src/browser/cdp.ts`). It:

- Captures screenshots via `Page.captureScreenshot` (PNG or JPEG via `sharp`).
- Applies a cursor overlay (colored dot at the last click position) using `sharp` compositing.
- Dispatches mouse/keyboard events via `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`.
- Handles navigation via `Page.navigate` + `Page.loadEventFired` wait.

### ViewportManager

`ViewportManager` aligns the browser viewport to the model's optimal patch size:

```typescript
await vm.alignToModel(adapter.patchSize, adapter.maxImageDimension);
```

For Anthropic models (`patchSize: 28`, `maxImageDimension: 1344`), this snaps the viewport to the nearest multiple of 28 in each dimension, capped at 1344px. This minimizes rounding error in the model's coordinate outputs.

---

## Safety layer

### SessionPolicy

`SessionPolicy` is a synchronous filter checked before every action execution. It is configured via `AgentOptions.policy`:

```typescript
interface SessionPolicyOptions {
  allowedDomains?: string[];   // glob: "*.myco.com"
  blockedDomains?: string[];
  allowedActions?: CUAAction["type"][];
}
```

Domain matching supports `*.domain.com` wildcards. An exact match or a suffix match of the form `sub.domain.com` will pass the `*.domain.com` pattern.

A blocked action is converted to a `{ ok: false, error: reason, is_error: true }` tool result and fed back to the model. The loop continues; the model can choose a different action.

### PreActionHook

Runs before `SessionPolicy`. Can be async. Returns:
- `{ decision: "allow" }` — proceed
- `{ decision: "deny", reason: string }` — block with reason

Use cases: rate limiting, audit logging, custom allow/deny rules that depend on external state.

### CompletionGate

Called when the model emits a `terminate` action. The gate receives the current screenshot and URL and returns `{ passed: boolean; reason?: string }`.

If the gate fails, the termination is rejected and the loop continues — the error reason is fed back to the model so it can try to reach the actual completion condition.

Built-in gates:
- `UrlMatchesGate(pattern: RegExp)` — passes if the current URL matches the pattern.
- `CustomGate(fn, failureReason)` — passes if `fn(screenshot, url)` resolves to `true`.

---

## ChildLoop (delegation)

The `delegate` action allows the model to hand off a sub-task to a fresh loop that runs on the same browser tab with the same adapter. This is useful for "bookkeeping" sub-tasks (e.g., "scroll through all results and collect every price") without polluting the parent history.

```
Parent loop:
  model emits: { type: "delegate", instruction: "Collect all product names from the listing page", maxSteps: 15 }
  → ActionRouter returns isDelegateRequest: true
  → PerceptionLoop spins up ChildLoop.run(instruction, { tab, adapter }, { maxSteps: 15 })
  → ChildLoop runs its own PerceptionLoop on the same tab
  → ChildLoop terminates
  → Parent loop continues
```

---

## Planner

When `AgentOptions.plannerModel` is set, `Agent.run()` executes a planning pass before the main loop:

1. Takes a screenshot of the current page.
2. Calls `adapter.step()` with a "you are a task planner" system prompt.
3. Extracts the thinking text (Anthropic) or falls back to a canned plan.
4. Prepends the plan to the session system prompt for this run.

The planner can use a different, cheaper model than the main agent. The plan is ephemeral — it is not persisted in session history.

---

## Observability

### LoopMonitor

```typescript
interface LoopMonitor {
  stepStarted(step: number, context: StepContext): void;
  stepCompleted(step: number, response: ModelResponse): void;
  actionExecuted(step: number, action: CUAAction, outcome: ActionExecution): void;
  actionBlocked(step: number, action: CUAAction, reason: string): void;
  terminationRejected(step: number, reason: string): void;
  compactionTriggered(step: number, tokensBefore: number, tokensAfter: number): void;
  terminated(result: LoopResult): void;
  error(err: Error): void;
}
```

Implementations:
- `ConsoleMonitor` — logs to stdout (default at `verbose: 1` or `2`).
- `NoopMonitor` — all methods are no-ops (used at `verbose: 0`).
- `StreamingMonitor` — buffers events into an async queue for `agent.stream()`.

Implement `LoopMonitor` to integrate with your own telemetry (OpenTelemetry, Datadog, etc.):

```typescript
const agent = new Agent({
  ...,
  monitor: {
    stepStarted(step, ctx) { otelSpan.addEvent("step_start", { step, url: ctx.url }); },
    terminated(result) { otelSpan.end(); },
    // ... other methods
  },
});
```

### StreamingMonitor

`StreamingMonitor` is an internal `LoopMonitor` implementation that translates monitor events into `CUAEvent` objects and buffers them in an async queue. `agent.stream()` wraps the monitor queue in an `AsyncIterableIterator`, running the actual loop in the background.

The queue is unbounded — if the consumer is slow, events accumulate in memory. For production use, make sure to consume events promptly.

---

## Public API layers

### Agent (facade)

`Agent` is the recommended entry point for most callers. It manages:

- **Lazy connection**: the browser and model adapter are not initialized until the first `run()` call.
- **Parallel initialization**: `createAdapter()`, `connectBrowser()`, `buildMonitor()`, and `createAdapter()` (compaction) all run concurrently via `Promise.all`.
- **Viewport alignment**: calls `ViewportManager.alignToModel()` after connection.
- **Planner**: optional pre-loop planning pass.
- **Session resumption**: `Agent.resume(snapshot, options)` stashes serialized history for `_connect()` to restore.
- **`using` / `Symbol.asyncDispose`**: supports the TC39 `using` declaration for automatic cleanup.

```typescript
{
  await using agent = new Agent({ ... });
  await agent.run({ instruction: "..." });
}  // agent.close() called automatically
```

### Session

`Session` is a lower-level API for callers that want to own the browser and adapter themselves. It assembles `HistoryManager`, `StateStore`, `SessionPolicy`, and `PerceptionLoop` from options.

```typescript
import { CUASession, CDPTab, CdpConnection, AnthropicAdapter } from "@omlabs/lumen";

const conn = await CdpConnection.connect("ws://localhost:9222/...");
const tab = new CDPTab(conn.mainSession());
const adapter = new AnthropicAdapter("claude-sonnet-4-6", apiKey);

const session = new CUASession({ tab, adapter, maxSteps: 20 });
await session.init();

const result = await session.run({ instruction: "..." });
const snapshot = session.serialize();

conn.close();
```

---

## Error model

Lumen has a deliberate two-tier error model:

**Action errors — returned, never thrown**

Any error that occurs during action execution (a click on a stale element, a navigation timeout, a policy violation) is returned as `ActionExecution.ok = false` and injected as an `is_error: true` tool result into the model's context. The loop continues; the model has the opportunity to self-correct.

**Fatal errors — thrown as `CUAError`**

Only `BROWSER_DISCONNECTED` (the CDP socket closed unexpectedly) propagates out of the loop as a thrown `CUAError`. Other `CUAErrorCode` values are defined for future use:

```typescript
type CUAErrorCode =
  | "BROWSER_DISCONNECTED"
  | "MODEL_API_ERROR"
  | "SESSION_TIMEOUT"
  | "MAX_RETRIES_EXCEEDED"
  | "POLICY_VIOLATION"
  | "CHILD_LOOP_FAILED";
```

---

## Module graph

```
src/index.ts          ← public surface
  src/agent.ts        ← Agent facade
    src/session.ts    ← Session
      src/loop/perception.ts      ← PerceptionLoop
        src/loop/history.ts       ← HistoryManager
        src/loop/router.ts        ← ActionRouter
        src/loop/state.ts         ← StateStore
        src/loop/policy.ts        ← SessionPolicy
        src/loop/gate.ts          ← CompletionGate
        src/loop/monitor.ts       ← LoopMonitor
        src/loop/child.ts         ← ChildLoop
      src/model/adapter.ts        ← ModelAdapter interface + coord helpers
        src/model/anthropic.ts    ← AnthropicAdapter
        src/model/google.ts       ← GoogleAdapter
        src/model/openai.ts       ← OpenAIAdapter
        src/model/custom.ts       ← CustomAdapter
        src/model/decoder.ts      ← ActionDecoder
      src/browser/tab.ts          ← BrowserTab interface
        src/browser/cdptab.ts     ← CDPTab
        src/browser/cdp.ts        ← CdpConnection
        src/browser/capture.ts    ← ScreenCapture
        src/browser/frame.ts      ← FrameRouter
        src/browser/viewport.ts   ← ViewportManager
        src/browser/launch/
          local.ts                ← launchChrome
          browserbase.ts          ← connectBrowserbase
    src/loop/planner.ts           ← runPlanner
    src/loop/streaming-monitor.ts ← StreamingMonitor
  src/errors.ts       ← CUAError
  src/types.ts        ← all shared types
```

All cross-module imports use the `.js` extension (ESM requirement). Circular dependencies are avoided; the dependency direction is always top-down.
