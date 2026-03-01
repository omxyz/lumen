# Stagehand CUA Redesign PRD
## Vision-First Computer Use Agent Architecture

**Status:** Draft
**Scope:** CUA (Computer Use Agent) path only — vision-based models with screenshot→action loop
**Based on:** Stagehand V3 analysis + browser-use + trycua/cua + Claude Code architecture research

---

## 1. Problem Statement

Stagehand V3 contains a capable CUA engine, but it is buried inside an architecture designed primarily for DOM-snapshot + LLM pipelines. The CUA path (`v3CuaAgentHandler.ts`, `AgentClient.ts`, and the three provider implementations) was added as a mode alongside DOM/hybrid rather than designed as the first-class target.

The result:

1. **The loop is scattered.** Screenshot capture, history management, coordinate normalization, error handling, and the termination check live in different files with no unifying abstraction.
2. **History grows without bound.** Screenshots pile up in the message history. Anthropic's client compresses only because it hits token limits; Google's doesn't compress at all. There is no principled strategy.
3. **Coordinate handling is inconsistent.** Google normalizes to 0–1000 and scales; Anthropic uses viewport pixels directly; Microsoft's FARA port uses a third system. No shared coordinate contract.
4. **Errors throw instead of recover.** A misclick or a stale element throws out of the agent loop instead of being fed back to the model as context for self-correction.
5. **Completion is inferred.** The loop ends when the model stops calling tools. This is fragile — some models produce a final text response AND a tool call in the same turn.
6. **No within-session memory.** The model has no structured way to store facts it discovers mid-session. Everything lives in the linear message history, which gets compressed away.
7. **No inter-action timing.** After a click, the page may still be animating. After typing, focus events may not have fired. There is no principled delay strategy between actions.
8. **No structured state artifact.** Navigation progress lives in freeform conversation text, which history compression aggressively discards. There is no load-bearing state object that survives compaction.
9. **Termination has no verification.** When the model emits "done," the loop exits immediately. There is no mechanism for the host application to assert the task actually completed (e.g., "success modal must be visible").

This PRD defines what Stagehand's CUA path looks like redesigned as the primary use case — not a mode added to a DOM framework, but a clean vision-first architecture that treats the screenshot as the ground truth and the model as the reasoning engine.

---

## 2. Design Principles

### 2.1 Screenshot is ground truth
The model sees what the user sees. The DOM is not consulted during the action loop. XPath selectors, accessibility trees, and element IDs are not part of the CUA path. The only input to the model is a screenshot (plus optional metadata injected as text).

### 2.2 The loop is the architecture
Everything is organized around one loop: screenshot → model → action(s) → screenshot. There is no separate "handler" for each action type. The loop is a single, inspectable, testable unit.

### 2.3 Errors are context, not exceptions
Recoverable action errors (click missed, element not interactable, scroll out of bounds) are injected back into the model's history as tool results with `isError: true`. The model reasons about the failure and retries or pivots. Only unrecoverable errors (browser crash, session timeout) propagate as exceptions.

### 2.4 Coordinates are normalized at the boundary
All coordinate-based actions use a 0–1000 normalized space internally. The model always speaks in 0–1000. The browser layer always speaks in pixels. Normalization/denormalization happens exactly once at the action-execution boundary.

### 2.5 History has a structure, not just a length
Message history has two parallel representations: a semantic trace (human-readable step log, never compressed) and a wire trace (what the model actually sees, actively compressed). Screenshots older than the 2 most recent are replaced with the text `"[screenshot]"`. The semantic trace is never sent to the model.

### 2.6 Termination is explicit
The model emits a `terminate` action with `{ status: "success" | "failure", result: string }`. The loop does not infer completion. If `maxSteps` is reached without a `terminate`, the loop exits with `status: "maxSteps"`.

### 2.7 Memory is a first-class action
The model can call `memorize(fact: string)` to persist a fact within the session. Facts are prepended to each step's context. This is the only structured within-session memory. History compression does not affect the fact store.

### 2.8 The browser layer is zero-framework
The browser interaction layer uses CDP directly. No Playwright, no Puppeteer, no Patchright. Users connect via WebSocket URL (Browserbase, local Chrome, any CDP endpoint).

**Why not Playwright?** Playwright's high-level API assumes you have a selector — `page.click("button.submit")` auto-waits for element visibility, stability, and actionability before dispatching input. CUA never has a selector; it has coordinates from a screenshot. Playwright's waiting and actionability machinery becomes unpredictable noise on a coordinate-only path. Additionally, Playwright intercepts navigation events, injects helpers into pages, and manages frame lifecycles in ways that conflict with a loop that treats the screenshot as the sole ground truth. Raw CDP is transparent: every event dispatched is exactly what the model requested, with timing the loop controls.

### 2.9 Structured state survives compression
Freeform conversation text is aggressively summarized during compaction. Structured state is not. The model writes task progress as an explicit `writeState` action that produces a JSON artifact. This artifact is re-injected at the start of every step and treated as protected context during compaction — equivalent to Claude Code's TodoWrite task list, which persists across compression boundaries.

### 2.10 Compaction uses the model, not just truncation
When token utilization crosses a threshold (~80%), the loop triggers a proactive compaction pass: a cheap model summarizes the last N steps into a `<summary>` block that replaces the compressed history. Screenshot images are dropped (kept only for the 2 most recent steps); text state is summarized intelligently rather than truncated. Compaction happens before forced context-window pressure, not because of it.

### 2.11 Termination is verified, not just declared
The model's `terminate` action is a request to exit, not a command. If a `CompletionGate` is configured, the loop verifies the termination condition (e.g., screenshots the page and checks it against a predicate) before accepting the exit. A failed gate becomes a tool result: "terminate rejected — success confirmation not found." The model retries.

### 2.12 Tool descriptions are behavioral contracts
Tool schemas are not just parameter lists. Each tool's description is a behavioral specification: when to use it, when NOT to use it, common failure modes, and what to do after calling it. This is where agent behavior is shaped — not in the system prompt, not in code.

### 2.13 Sessions have policies, not per-action confirmations
Allowed domains and action categories are declared at session init as a `SessionPolicy`. The loop operates freely within those rules. `PreActionHook` intercepts are available for logging and audit, but the primary scope-limiting mechanism is the policy filter, not per-action prompts. Per-action confirmation breaks autonomous flow on tasks with 10+ steps.

### 2.14 Actions execute mid-stream
The loop starts executing a tool call as soon as its input block is complete — it does not wait for `message_stop`. When the model emits multiple actions in one turn, execution of action #1 begins while action #2 is still streaming. This eliminates one round-trip of latency on compound operations (click a field, then type into it).

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    PUBLIC API                           │
│       Agent       │    AgentResult │    AgentEvent      │
│  SessionPolicy    │  PreActionHook │  CompletionGate    │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  PERCEPTION LOOP                        │
│   PerceptionLoop  │  HistoryManager  │  FactStore       │
│   StateStore      │  ActionRouter    │  LoopMonitor     │
│   CompletionGate  │  ChildLoop       │  TokenTracker    │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  MODEL ADAPTER                          │
│  ModelAdapter  │  AnthropicAdapter  │  GoogleAdapter    │
│  CoordinateNormalizer  │  ActionDecoder                 │
└─────────────────────────┬───────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────┐
│                  BROWSER LAYER                          │
│  BrowserTab  │  ViewportManager  │  ScreenCapture       │
│  CDPSession  │  FrameRouter      │                      │
└─────────────────────────┬───────────────────────────────┘
                          │
                  CDP WebSocket
```

---

## 4. Browser Layer

### 4.0 Session wiring

`BrowserTab` wraps a raw CDP session. The session comes from either a local Chrome launch or a Browserbase cloud browser — the interface is identical either way.

```
// Browserbase
const { ws } = await Browserbase.sessions.create(params);  // → CDP WebSocket URL
const conn   = await CdpConnection.connect(ws);
const tab    = new BrowserTab(conn.mainSession());

// Local Chrome
const { ws } = await launchChrome();                        // → CDP WebSocket URL
const conn   = await CdpConnection.connect(ws);
const tab    = new BrowserTab(conn.mainSession());
```

No Playwright in either path. Browserbase's session lifecycle (create, resume, release) stays in the Browserbase SDK; `BrowserTab` only sees the WebSocket URL.

### 4.1 `BrowserTab`

The only browser abstraction exposed to the loop. Eight methods, each mapping 1:1 to a single CDP domain command. Convenience sequences (click = moved+pressed+released, drag = pressed+n×moved+released) are composed directly in `ActionRouter` on top of these primitives — not here.

```typescript
interface BrowserTab {
  // Page.captureScreenshot
  screenshot(options?: { format?: "png" | "jpeg"; quality?: number }): Promise<ScreenshotResult>;

  // Input.dispatchMouseEvent — type maps directly to CDP's type discriminant
  dispatchMouseEvent(
    type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel",
    x: number,
    y: number,
    options?: {
      button?: "left" | "right" | "middle";
      clickCount?: number;
      deltaX?: number;   // mouseWheel only — CSS pixels
      deltaY?: number;   // mouseWheel only — CSS pixels
    }
  ): Promise<void>;

  // Input.insertText — bulk text input, bypasses key events
  insertText(text: string): Promise<void>;

  // Input.dispatchKeyEvent
  dispatchKeyEvent(type: "keyDown" | "keyUp", key: string): Promise<void>;

  // Page.navigate + lifecycle event subscription
  navigate(url: string, waitUntil?: "load" | "domcontentloaded" | "networkidle"): Promise<void>;

  // Current URL from target info
  url(): string;

  // Emulation.setDeviceMetricsOverride + setVisibleSize
  setViewport(width: number, height: number): Promise<void>;
  viewport(): { width: number; height: number };

  // Raw CDP session — OOPIF routing, Runtime.evaluate, anything else
  cdpSession(): CDPSessionLike;
}

interface ScreenshotResult {
  data: Buffer;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
}
```

**What moved to `ActionRouter`:**

| Model action | Primitive sequence |
|---|---|
| `click(x,y,button)` | `mouseMoved` → `mousePressed` → `mouseReleased` |
| `doubleClick(x,y)` | same, `clickCount=2` |
| `drag(from,to,steps)` | `mousePressed` → n×`mouseMoved` → `mouseReleased` |
| `scroll(x,y,dir,amt)` | `mouseMoved` → `mouseWheel(deltaX,deltaY)` |
| `hover(x,y)` | `mouseMoved` |
| `type(text)` | `insertText` |
| `keyPress(keys[])` | `keyDown` + `keyUp` per key |
| `wait(ms)` | `setTimeout` — not a browser operation |

**OOPIF / frame routing.** `BrowserTab` operates on a single CDP session (the main frame). For clicks inside out-of-process iframes, `ActionRouter` calls `FrameRouter.sessionForPoint(x, y)` to get the child frame's `CDPSessionLike`, then calls `dispatchMouseEvent` on that session directly — bypassing `BrowserTab` entirely for sub-frame input.

### 4.2 `ScreenCapture`

Handles screenshot capture, JPEG compression for large viewports, and cursor overlay injection.

```typescript
interface ScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;        // 0–100, for JPEG
  cursorOverlay?: boolean; // Default: true — injects cursor dot at last known position
  fullPage?: boolean;      // Default: false — CUA always uses viewport
}
```

**Cursor overlay:** A 12px red dot is composited onto the screenshot at the model's last clicked coordinate. This is the single most effective technique for helping models track where they are on the page. Implemented by drawing on the raw PNG buffer before encoding, not via DOM injection.

### 4.3 `ViewportManager`

Handles the `smart_resize` problem: some models (especially pixel-level vision models) require image dimensions divisible by their patch size.

```typescript
interface ViewportManager {
  // Set viewport to match model's preferred dimensions
  alignToModel(adapter: ModelAdapter): Promise<ViewportSize>;

  // After model changes, restore original
  restoreOriginal(): Promise<void>;

  // Current dimensions
  current(): ViewportSize;
}
```

**smart_resize algorithm:**
1. Get model's `patchSize` (from adapter metadata, e.g., 28px for Qwen2-VL, 56px for some Gemini variants)
2. Round viewport width and height up to nearest multiple of `patchSize`
3. Cap at model's max resolution (from adapter metadata)
4. Apply via `Emulation.setDeviceMetricsOverride`

This ensures pixel coordinates from the model map 1:1 to the viewport grid. Without this, models that think in terms of patches produce coordinates that drift from the true element center.

### 4.4 `FrameRouter`

CUA clicks land on viewport coordinates. Most of the time this is fine. But for OOPIFs (out-of-process iframes — common on complex web apps), clicks at coordinates inside the iframe frame need to be dispatched to the iframe's CDP session, not the main frame's.

```typescript
interface FrameRouter {
  // Given viewport coordinates, return which CDP session owns that point
  sessionForPoint(x: number, y: number): Promise<{ session: CDPSession; localX: number; localY: number }>;
}
```

This is transparent to the loop. `ActionRouter` calls `FrameRouter` before dispatching input events. The coordinates it gets back are in the iframe's local coordinate system.

---

## 5. Model Adapter Layer

### 5.1 `ModelAdapter` interface

The single interface all model providers implement. Adapters handle wire format differences, tool calling conventions, and provider-specific quirks.

```typescript
interface ModelAdapter {
  readonly modelId: string;
  readonly provider: "anthropic" | "google" | "openai" | "custom";

  // Model capabilities (used by ViewportManager, PerceptionLoop)
  readonly patchSize?: number;             // For smart_resize
  readonly maxImageDimension?: number;     // Hard cap per image
  readonly supportsThinking?: boolean;
  readonly nativeComputerUse: boolean;     // Has first-class computer-use tool support

  // The core call — returns an async stream of actions as they complete (mid-stream execution)
  stream(context: StepContext): AsyncIterable<CUAAction>;

  // Single-shot variant (waits for all actions before returning)
  step(context: StepContext): Promise<ModelResponse>;

  // Estimate token count for a context (used by HistoryManager.tokenUtilization())
  estimateTokens(context: StepContext): number;
}

interface StepContext {
  // What the model receives this turn
  screenshot: ScreenshotResult;
  wireHistory: WireMessage[];              // Compressed model-native history
  factStore: string[];                     // Current facts (prepended as system context)
  taskState: TaskState | null;             // Current writeState artifact (always re-injected)
  stepIndex: number;
  maxSteps: number;
  url: string;                             // Current page URL (prepended as context)
  systemPrompt?: string;
  tools: CUATool[];
}

interface ModelResponse {
  actions: CUAAction[];                    // Decoded, normalized actions
  thinking?: string;                       // Extended thinking text (Anthropic)
  usage: TokenUsage;
  rawResponse: unknown;                    // Provider-native response object
}

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### 5.2 `CUAAction` — the normalized action type

All model adapters decode their provider-specific tool calls into a single `CUAAction` union. The `ActionRouter` only speaks `CUAAction`.

```typescript
type CUAAction =
  | { type: "click";       x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "doubleClick"; x: number; y: number }
  | { type: "hover";       x: number; y: number }
  | { type: "drag";        startX: number; startY: number; endX: number; endY: number }
  | { type: "scroll";      x: number; y: number; direction: "up" | "down" | "left" | "right"; amount: number }
  | { type: "type";        text: string }
  | { type: "keyPress";    keys: string[] }
  | { type: "wait";        ms: number }
  | { type: "goto";        url: string }
  | { type: "memorize";    fact: string }
  | { type: "writeState";  state: TaskState }
  | { type: "screenshot" }
  | { type: "delegate";    instruction: string; maxSteps?: number }  // Spawn a child loop for a sub-task
  | { type: "terminate";   status: "success" | "failure"; result: string }

// The structured task state artifact written by writeState and re-injected every step
interface TaskState {
  currentUrl: string;
  completedSteps: string[];          // Past steps in plain English
  nextStep: string;                  // What the model plans to do next
  blockers: string[];                // Known obstacles
  data: Record<string, unknown>;     // Arbitrary structured data the model wants to retain
}
```

**All coordinates in `CUAAction` are in the 0–1000 normalized space.** Denormalization to pixels happens in `ActionRouter` just before dispatch.

### 5.3 Coordinate normalization

One function, one direction, one place.

```typescript
// Model-space (0–1000) → viewport pixels
function denormalize(coord: number, dimension: number): number {
  return Math.round((coord / 1000) * dimension);
}

// Viewport pixels → model-space (0–1000)
function normalize(pixel: number, dimension: number): number {
  return Math.round((pixel / dimension) * 1000);
}

// Clamp normalized coordinates before storing in history
function clampNormalized(coord: number): number {
  return Math.max(0, Math.min(1000, coord));
}
```

**Why 0–1000?** This is the coordinate space Google's CUA models natively speak. Using it everywhere means Google adapters are pass-through; Anthropic adapters that speak in pixels normalize incoming coordinates before returning `CUAAction`; OpenAI adapters do the same. The browser layer never sees model-space coordinates.

### 5.4 `AnthropicAdapter`

Handles the Anthropic computer-use tool (`computer_20250124`).

```typescript
class AnthropicAdapter implements ModelAdapter {
  readonly provider = "anthropic";
  readonly nativeComputerUse = true;
  readonly supportsThinking = true;

  async step(context: StepContext): Promise<ModelResponse> {
    // Build Anthropic messages from compressed wire history
    // Inject current screenshot as the latest user message
    // Include URL and step counter as text prefix
    // Call Anthropic API with computer_20250124 tool
    // Decode tool_use blocks → CUAAction[]
    // Normalize pixel coordinates → 0–1000
  }
}
```

**Thinking budget.** When `supportsThinking` is `true` and `thinkingBudget` is configured, the adapter adds the thinking block to the API call. Thinking text is returned in `ModelResponse.thinking` and stored in the semantic trace (not the wire trace — models don't re-read their own thinking after compression).

**History format.** Anthropic requires alternating `user`/`assistant` messages. The adapter enforces this during wire history construction. Tool results are `user` messages. Tool calls are `assistant` messages with `tool_use` blocks.

### 5.5 `GoogleAdapter`

Handles Gemini's native computer-use tool.

```typescript
class GoogleAdapter implements ModelAdapter {
  readonly provider = "google";
  readonly nativeComputerUse = true;
  readonly patchSize = 56;               // Gemini vision patch grid

  async step(context: StepContext): Promise<ModelResponse> {
    // Build Gemini Content[] from compressed wire history
    // Google uses 0–1000 natively — coordinates pass through without conversion
    // Inject URL per step in system instruction update
    // Handle exponential backoff on 429/503
    // Decode functionCall parts → CUAAction[]
  }
}
```

**Exponential backoff.** Google's API rate-limits aggressively. The adapter implements backoff internally with jitter: `delay = min(initialDelay * 2^attempt + jitter, maxDelay)`. This is not surfaced to the loop — from the loop's perspective, `step()` just takes longer.

### 5.6 `OpenAIAdapter`

Handles OpenAI's computer-use tool (operator API).

```typescript
class OpenAIAdapter implements ModelAdapter {
  readonly provider = "openai";
  readonly nativeComputerUse = true;

  async step(context: StepContext): Promise<ModelResponse> {
    // Use OpenAI Responses API with computer_use_preview tool
    // Coordinate space: pixels relative to screenshot dimensions
    // Normalize incoming pixel coordinates → 0–1000
  }
}
```

### 5.7 `CustomAdapter`

For models without native computer-use, provides a tool-calling wrapper that presents CUA actions as explicit function definitions.

```typescript
class CustomAdapter implements ModelAdapter {
  readonly nativeComputerUse = false;

  // Tools are presented as explicit function definitions:
  // click(x: int, y: int, button?: string)
  // type(text: string)
  // keyPress(keys: string[])
  // scroll(x: int, y: int, direction: string, amount: int)
  // goto(url: string)
  // memorize(fact: string)
  // terminate(status: string, result: string)
  //
  // All coordinate params documented as 0–1000 in the tool description
}
```

### 5.8 `ActionDecoder`

Stateless utility that converts provider-specific tool call formats to `CUAAction[]`. Each adapter delegates here.

```typescript
interface ActionDecoder {
  fromAnthropic(toolUse: AnthropicToolUse, viewport: ViewportSize): CUAAction;
  fromGoogle(functionCall: GoogleFunctionCall): CUAAction;
  fromOpenAI(toolCall: OpenAIToolCall, viewport: ViewportSize): CUAAction;
  fromGeneric(toolCall: { name: string; input: Record<string, unknown> }): CUAAction;
}
```

Coordinate normalization lives here — `fromAnthropic` and `fromOpenAI` call `normalize()` because these providers speak pixels; `fromGoogle` and `fromGeneric` pass through because they already speak 0–1000.

---

## 6. Perception Loop

### 6.1 `PerceptionLoop`

The execution engine. One class, one method, one loop.

```typescript
class PerceptionLoop {
  constructor(
    private tab: BrowserTab,
    private adapter: ModelAdapter,
    private history: HistoryManager,
    private facts: FactStore,
    private state: StateStore,
    private router: ActionRouter,
    private monitor: LoopMonitor,
    private policy: SessionPolicy,
    private gate?: CompletionGate,
  ) {}

  async run(options: LoopOptions): Promise<LoopResult> {
    for (let step = 0; step < options.maxSteps; step++) {
      // 1. Proactive compaction — trigger BEFORE hitting context limit, not because of it
      if (this.history.tokenUtilization() > (options.compactionThreshold ?? 0.8)) {
        await this.history.compactWithSummary(this.adapter, this.state.current());
      }

      // 2. Capture screenshot (with cursor overlay at last click position)
      const screenshot = await this.tab.screenshot({ cursorOverlay: true });

      // 3. Build step context — inject state artifact + facts at every step
      const context: StepContext = {
        screenshot,
        wireHistory: this.history.wireHistory(),
        factStore: this.facts.all(),
        taskState: this.state.current(),    // Re-injected every step regardless of compression
        stepIndex: step,
        maxSteps: options.maxSteps,
        url: this.tab.url(),
        systemPrompt: options.systemPrompt,
        tools: CUA_TOOLS,
      };

      // 4. Call model (streaming — actions are delivered as they complete, not after message_stop)
      this.monitor.stepStarted(step, context);
      const stream = this.adapter.stream(context);

      // 5. Execute actions mid-stream: each action runs as soon as its input block is complete
      //    (does not wait for subsequent actions in the same turn to finish streaming)
      for await (const action of stream) {
        // 5a. Policy check — block if action violates session policy rules
        const policyResult = this.policy.check(action);
        if (!policyResult.allowed) {
          this.history.appendActionOutcome(action, { ok: false, error: policyResult.reason });
          this.monitor.actionBlocked(step, action, policyResult.reason!);
          continue;
        }

        // 5b. Execute
        const outcome = await this.router.execute(action, this.facts, this.state);
        this.monitor.actionExecuted(step, action, outcome);

        // 5c. Check for delegate request — spawn a child loop for the sub-task
        if (outcome.isDelegateRequest) {
          const childResult = await ChildLoop.run(
            outcome.delegateInstruction!,
            { tab: this.tab, adapter: this.adapter, facts: this.facts },
            { maxSteps: outcome.delegateMaxSteps ?? 20 },
          );
          // Surface any facts the child discovered back to the parent store
          for (const fact of childResult.factsDiscovered) {
            this.facts.memorize(fact);
          }
          // Feed child result back as a tool result so the parent model sees what happened
          this.history.appendActionOutcome(action, {
            ok: childResult.status === "success",
            error: childResult.status !== "success" ? childResult.result : undefined,
          });
          this.monitor.actionExecuted(step, action, outcome);
          continue;
        }

        // 5d. Check for termination request
        if (outcome.terminated) {
          // Verify via CompletionGate if one is configured
          if (this.gate) {
            const gateResult = await this.gate.verify(await this.tab.screenshot(), action as any);
            if (!gateResult.passed) {
              // Termination rejected — feed failure back as tool result, loop continues
              this.history.appendActionOutcome(action, {
                ok: false,
                error: `terminate rejected: ${gateResult.reason}`,
              });
              this.monitor.terminationRejected(step, gateResult.reason!);
              continue;
            }
          }
          return {
            status: outcome.status!,
            result: outcome.result!,
            steps: step + 1,
            history: this.history.semantic(),
            finalState: this.state.current(),
          };
        }

        // 5e. Append outcome to wire history (errors as is_error tool results)
        this.history.appendActionOutcome(action, outcome);
      }

      this.monitor.stepCompleted(step, this.history.lastResponse());
    }

    return {
      status: "maxSteps",
      result: "Maximum steps reached without completion",
      steps: options.maxSteps,
      history: this.history.semantic(),
      finalState: this.state.current(),
    };
  }
}

interface LoopOptions {
  maxSteps: number;
  systemPrompt?: string;
  compactionThreshold?: number;  // 0.0–1.0, default 0.8 (trigger compaction at 80% token fill)
}

interface LoopResult {
  status: "success" | "failure" | "maxSteps";
  result: string;
  steps: number;
  history: SemanticStep[];     // Human-readable trace
  finalState: TaskState | null; // Last writeState artifact, if any
}
```

### 6.2 `HistoryManager`

Manages the dual-history system. Wire history is what the model sees (compressed). Semantic history is what humans see (never compressed).

```typescript
class HistoryManager {
  // Wire history: model-native format, actively compressed
  wireHistory(): WireMessage[];

  // Semantic history: human-readable, never compressed
  semantic(): SemanticStep[];

  // Append action outcome into wire history (called after each action in mid-stream execution)
  appendActionOutcome(action: CUAAction, outcome: ActionOutcome): void;

  // Append the completed model response (called after the stream closes)
  appendResponse(response: ModelResponse): void;
  lastResponse(): ModelResponse | null;

  // Token tracking — based on actual usage from last adapter call
  totalInputTokens(): number;
  contextWindowSize(): number;    // From adapter metadata
  tokenUtilization(): number;     // 0.0–1.0, ratio of totalInputTokens to contextWindowSize

  // Compaction strategies
  // 1. Screenshot compression: keeps N recent screenshots, replaces older with "[screenshot]"
  compressScreenshots(keepRecentScreenshots?: number): void;

  // 2. LLM summarization: model writes a <summary> block replacing compressed history
  //    currentState is embedded in the summary prompt so facts survive the compression pass
  compactWithSummary(adapter: ModelAdapter, currentState: TaskState | null): Promise<void>;

  // Serialize for storage/resumption (includes FactStore and StateStore data)
  toJSON(): SerializedHistory;
  static fromJSON(data: SerializedHistory): HistoryManager;
}

interface SemanticStep {
  stepIndex: number;
  url: string;
  screenshotBase64: string;   // Always kept in semantic trace — never compressed
  thinking?: string;
  actions: {
    action: CUAAction;
    outcome: { ok: boolean; error?: string };
  }[];
  taskStateAfter: TaskState | null;  // writeState artifact at end of step, if emitted
  tokenUsage: TokenUsage;
  durationMs: number;
}
```

**Two-tier compression strategy:**

**Tier 1 — Screenshot compression** (applied after every step automatically):
- Keep the 2 most recent screenshots in wire history; replace older with `"[screenshot]"`
- Tool results containing screenshots follow the same rule
- Text content (action descriptions, tool results, thinking) is untouched
- This alone handles ~70% of token growth for typical sessions

**Tier 2 — LLM summarization** (triggered proactively at 80% token utilization):
- The loop calls `compactWithSummary()` before the next step, not after hitting the limit
- The compaction model (cheap, fast — Haiku-class) receives the full wire history and current `TaskState`
- It writes a `<summary>` block: current URL, completed steps, key facts, next planned steps, any data already extracted
- The summary replaces all wire history before the compaction boundary; only the summary + last 2 steps remain
- The `TaskState` artifact and `FactStore` are **not** compressed — they are re-injected from their own stores regardless of what the summary says
- The semantic history is never touched

**Why proactive at 80%?** Compacting at 95% (forced) leaves no room for the summary generation itself to consume tokens. 80% gives a comfortable buffer and lets the summarization model produce a thorough summary rather than racing against the limit.

**Why the model writes its own summary?** The model understands which tool results matter and which are noise. A naive truncation drops arbitrary content; a model-written summary preserves what the model would want to remember. This is the same insight behind Claude Code's `<summary>` compaction mechanism.

**Serializable history.** `toJSON()` / `fromJSON()` enable session resumption. A session can be paused, serialized to disk, and resumed later by a different process. The `FactStore` and `StateStore` are included in the serialization.

### 6.3 `FactStore`

Persistent within-session memory. The model writes to it via the `memorize` action; the loop reads from it on every step.

```typescript
class FactStore {
  memorize(fact: string): void;
  forget(fact: string): void;      // Exact string match
  all(): string[];                  // Ordered by insertion time
  toContextString(): string;        // Formatted for system prompt injection
}
```

**Injection format:**
```
Memory:
- The login button is in the top-right corner
- The user's email is user@example.com
- The form requires a phone number before the submit button activates
```

This is prepended to the system context (not the message history) at each step. Facts persist for the entire session unless explicitly forgotten.

**Why not just rely on history?** History gets compressed. Facts don't. For critical information discovered mid-session (a login credential, an important element location, a required field value), the fact store ensures the model retains it regardless of how many steps have passed.

### 6.4 `StateStore`

The structured task progress artifact. Unlike `FactStore` (unordered key facts), `StateStore` holds a single current `TaskState` JSON object that the model overwrites with each `writeState` action.

```typescript
class StateStore {
  // Read current state
  current(): TaskState | null;

  // Model calls writeState → ActionRouter calls this
  write(state: TaskState): void;

  // Formatted for injection into StepContext
  toContextString(): string;
}
```

**Injection format (prepended as system context every step):**
```
Current Task State:
  URL: https://example.com/checkout/payment
  Completed: ["logged in", "added items to cart", "entered shipping address"]
  Next: Enter payment details
  Blockers: []
  Data: { "orderTotal": "$47.99", "deliveryDate": "March 3" }
```

**Why a separate store from FactStore?** `FactStore` is append-only (individual facts accumulate). `StateStore` is last-write-wins (the model replaces the entire state). They solve different problems: facts accumulate as the model discovers things; state tracks where the model is in the task flow. Both survive compaction for the same reason — they are re-injected from their own stores, never from history.

**The compaction connection.** When `compactWithSummary()` runs, it passes `currentState` to the summarization prompt. The summary model is instructed: "Include this task state in your summary so progress is not lost." The resulting `<summary>` block embeds the state verbatim. After compaction, `StateStore` is reset and re-populated from the embedded state in the summary, ensuring continuity.

### 6.5 `ActionRouter`

Translates `CUAAction` objects into browser operations. Responsibilities: denormalize 0–1000 coordinates → pixels, resolve OOPIF sessions via `FrameRouter`, call `BrowserTab` primitives directly, apply post-action waits, and capture errors without throwing. Drag is the only action complex enough to warrant a private helper.

```typescript
class ActionRouter {
  constructor(
    private tab: BrowserTab,
    private frameRouter: FrameRouter,
    private policy: SessionPolicy,
  ) {}

  async execute(
    action: CUAAction,
    facts: FactStore,
    state: StateStore,
  ): Promise<ActionExecution> {
    const vp = this.tab.viewport();

    switch (action.type) {

      case "click": {
        const x = denormalize(action.x, vp.width);
        const y = denormalize(action.y, vp.height);
        this.lastClickPosition = { x, y };
        try {
          const { session, localX, localY } = await this.frameRouter.sessionForPoint(x, y);
          const s = session ?? this.tab.cdpSession();
          await s.send("Input.dispatchMouseEvent", { type: "mouseMoved",   x: localX, y: localY });
          await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: localX, y: localY, button: action.button ?? "left", clickCount: 1 });
          await sleep(50);
          await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: localX, y: localY, button: action.button ?? "left", clickCount: 1 });
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        await this.postActionWait(200);
        return { ok: true };
      }

      case "doubleClick": {
        const x = denormalize(action.x, vp.width);
        const y = denormalize(action.y, vp.height);
        this.lastClickPosition = { x, y };
        try {
          await this.tab.dispatchMouseEvent("mouseMoved",   x, y);
          await this.tab.dispatchMouseEvent("mousePressed", x, y, { button: "left", clickCount: 2 });
          await sleep(50);
          await this.tab.dispatchMouseEvent("mouseReleased", x, y, { button: "left", clickCount: 2 });
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        await this.postActionWait(200);
        return { ok: true };
      }

      case "drag": {
        const from = { x: denormalize(action.startX, vp.width), y: denormalize(action.startY, vp.height) };
        const to   = { x: denormalize(action.endX,   vp.width), y: denormalize(action.endY,   vp.height) };
        try {
          await this.executeDrag(from, to);
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        await this.postActionWait(300);
        return { ok: true };
      }

      case "scroll": {
        const x = denormalize(action.x, vp.width);
        const y = denormalize(action.y, vp.height);
        const PX = 100; // pixels per scroll unit
        const deltaX = (action.direction === "right" ? 1 : action.direction === "left" ? -1 : 0) * action.amount * PX;
        const deltaY = (action.direction === "down"  ? 1 : action.direction === "up"   ? -1 : 0) * action.amount * PX;
        try {
          await this.tab.dispatchMouseEvent("mouseMoved",  x, y);
          await this.tab.dispatchMouseEvent("mouseWheel",  x, y, { deltaX, deltaY });
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        await this.postActionWait(300);
        return { ok: true };
      }

      case "type": {
        // No coordinates. Adapters receiving compound actions (e.g. Google's type_text_at)
        // must emit a click action first — coordinates on type are silently dropped here.
        try {
          await this.tab.insertText(action.text);
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        await this.postActionWait(500); // autocomplete, validation, focus events
        return { ok: true };
      }

      case "keyPress": {
        try {
          for (const key of action.keys) {
            await this.tab.dispatchKeyEvent("keyDown", key);
            await sleep(30);
            await this.tab.dispatchKeyEvent("keyUp", key);
          }
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        await this.postActionWait(200);
        return { ok: true };
      }

      case "goto": {
        try {
          await this.tab.navigate(action.url, "networkidle");
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        return { ok: true };
      }

      case "hover": {
        const x = denormalize(action.x, vp.width);
        const y = denormalize(action.y, vp.height);
        try {
          await this.tab.dispatchMouseEvent("mouseMoved", x, y);
        } catch (err) {
          return { ok: false, error: String(err) };
        }
        return { ok: true };
      }

      case "memorize":   { facts.memorize(action.fact);  return { ok: true }; }
      case "writeState": { state.write(action.state);     return { ok: true }; }
      case "screenshot": { return { ok: true, isScreenshotRequest: true }; }
      case "delegate":   { return { ok: true, isDelegateRequest: true, delegateInstruction: action.instruction, delegateMaxSteps: action.maxSteps }; }
      case "terminate":  { return { ok: true, terminated: true, status: action.status, result: action.result }; }
      case "wait":       { await sleep(action.ms); return { ok: true }; }
    }
  }

  // Drag is the only action with non-trivial internal logic (path interpolation).
  private async executeDrag(from: Point, to: Point, steps = 10): Promise<void> {
    await this.tab.dispatchMouseEvent("mousePressed", from.x, from.y, { button: "left" });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.tab.dispatchMouseEvent("mouseMoved", x, y);
      await sleep(20);
    }
    await this.tab.dispatchMouseEvent("mouseReleased", to.x, to.y, { button: "left" });
  }

  private lastClickPosition: Point | null = null;
  lastClick(): Point | null { return this.lastClickPosition; }

  private async postActionWait(ms: number): Promise<void> { await sleep(ms); }
}

interface ActionExecution {
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
```

**Two layers, not three.** `ActionRouter` calls `BrowserTab` primitives directly. Every action case is self-contained — you read what CDP calls it makes without jumping to another class. The only exception is drag, which has a private helper because path interpolation is real logic, not a trivial sequence.

**OOPIF.** Click uses `FrameRouter.sessionForPoint()` to get the correct CDP session and dispatches directly on it. All other actions go through `tab.dispatchMouseEvent()` on the main session.

**Post-action waits are typed, not uniform.** Click: 200ms. Type: 500ms (autocomplete, validation). Scroll/drag: 300ms. These are defaults; `AgentOptions.timing` can override them.

**Error-as-context.** Every case wraps in `try/catch` and returns `{ ok: false, error }` — never throws. `PerceptionLoop` injects the error as a tool result so the model can reason about the failure.

### 6.6 `ChildLoop`

A scoped `PerceptionLoop` instance spawned by the parent model via a `delegate` action. Runs a self-contained sub-task with isolated history, then returns its result to the parent as a tool result.

```typescript
class ChildLoop {
  static async run(
    instruction: string,
    parent: { tab: BrowserTab; adapter: ModelAdapter; facts: FactStore },
    options: ChildLoopOptions,
  ): Promise<ChildLoopResult> {
    // Isolated history — parent's wire context is not polluted by child's steps
    const history = new HistoryManager();
    const state   = new StateStore();
    // Facts: child gets a read-only snapshot of parent facts at spawn time,
    // plus its own writeable store for new discoveries
    const facts   = new FactStore({ inherited: parent.facts.all() });

    const router  = new ActionRouter(parent.tab, new FrameRouter(parent.tab), SessionPolicy.permissive());
    const loop    = new PerceptionLoop(
      parent.tab, parent.adapter, history, facts, state, router,
      new LoopMonitor(), SessionPolicy.permissive(),
    );

    const result = await loop.run({
      maxSteps: options.maxSteps,
      systemPrompt: `Sub-task: ${instruction}\n\nComplete this task and call terminate when done.`,
    });

    return {
      status: result.status,
      result: result.result,
      factsDiscovered: facts.ownFacts(),  // Only facts the child wrote, not inherited ones
      steps: result.steps,
    };
  }
}

interface ChildLoopOptions {
  maxSteps: number;  // Default: 20
}

interface ChildLoopResult {
  status: "success" | "failure" | "maxSteps";
  result: string;             // Returned to parent as tool result content
  factsDiscovered: string[];  // New facts child wants to surface to parent's FactStore
  steps: number;
}
```

**History isolation.** The child gets a fresh `HistoryManager`. The parent never sees the child's intermediate screenshots or tool calls — only the final `result` string fed back as a single tool result. This keeps the parent's context window clean.

**Fact inheritance.** The child sees parent facts at spawn time (read-only snapshot). New facts the child writes go into `facts.ownFacts()` and are merged back into the parent's `FactStore` after the child completes. Facts flow down at spawn, discoveries flow up at completion.

**Same tab, sequential.** The child runs on the same `BrowserTab` as the parent. There is no parallelism — the parent is suspended while the child runs. The child leaves the browser in whatever state it ends in; the parent's next screenshot reflects that state.

**Example use cases:**

1. **Authentication sub-task.** Main task: "Book a flight on Expedia." At step 3, model hits a login wall and emits `delegate("Log into my Expedia account with email user@example.com and password from memorized facts", maxSteps: 15)`. Child handles the full login flow (email field, password, 2FA, confirm). Parent resumes with an authenticated session and sees "Child completed: Logged in successfully."

2. **Sub-form isolation.** Main task: "Submit a visa application." A multi-page sub-form for employment history appears. Model emits `delegate("Fill out the employment history sub-form with the data in my task state", maxSteps: 25)`. Child fills all 5 pages, clicks submit, and returns "Employment history submitted, returned to main application."

3. **Side-tab research.** Main task: "Compare hotel prices and book the cheapest." Model opens a new tab, navigates to Hotels.com, then realizes the comparison needs independent browsing. Emits `delegate("Find the cheapest hotel near SFO airport for March 15-18 on Hotels.com and return the price and hotel name")`. Child returns "Grand Hyatt SFO — $189/night." Parent uses that fact when filling the booking form.

4. **Verification after action.** Main task: "Place an order and confirm it." After clicking "Place Order," model emits `delegate("Wait for the confirmation email in Gmail and return the order number", maxSteps: 10)`. Child switches to the Gmail tab, waits, reads the email, memorizes the order number, and returns it. Parent stores it via `memorize`.

**What `delegate` is NOT.** It is not parallelism (child is sequential). It is not a new browser session (same tab, same cookies). It is not indefinitely recursive (each child level gets a capped `maxSteps`). It is scoped autonomy with a clean return contract.

### 6.7 `CompletionGate`

Optional verification step that runs when the model emits `terminate`. A failed gate reinjects the failure as a tool result, keeping the loop alive.

```typescript
interface CompletionGate {
  verify(
    screenshot: ScreenshotResult,
    action: { type: "terminate"; status: string; result: string },
  ): Promise<{ passed: boolean; reason?: string }>;
}

// Built-in gates
class ScreenshotContainsTextGate implements CompletionGate {
  constructor(private expectedText: string) {}
  // Passes if OCR of screenshot contains expectedText
}

class UrlMatchesGate implements CompletionGate {
  constructor(private pattern: RegExp) {}
  // Passes if current URL matches pattern
}

class CustomGate implements CompletionGate {
  constructor(private fn: (screenshot: ScreenshotResult) => Promise<boolean>) {}
}
```

**Usage:** Task "Book a flight" has gate `new UrlMatchesGate(/confirmation/)`. If the model emits `terminate` on the search results page by mistake, the gate fails. The model receives: `"terminate rejected: URL does not match /confirmation/"` and continues.

**The stop_hook analogy.** Claude Code's Stop hooks prevent the agent from exiting until a completion condition is met. `CompletionGate` is the CUA equivalent — the host application declares what "done" looks like, and the model must achieve it before the loop accepts the exit.

### 6.8 `SessionPolicy`

An allowlist filter declared at session init. The `PerceptionLoop` checks every action against the policy before dispatching. This is **not** OS-level isolation — it is a guard in application code that intercepts actions the model explicitly emits and returns an error tool result if they violate declared rules. Real process/network isolation lives at the infrastructure layer (Browserbase session isolation, Docker, etc.).

```typescript
interface SessionPolicy {
  check(action: CUAAction): SessionPolicyResult;
}

interface SessionPolicyResult {
  allowed: boolean;
  reason?: string;   // Present when allowed === false; fed back as is_error tool result
}

interface SessionPolicyOptions {
  allowedDomains?: string[];    // Glob patterns. e.g. ["*.mycompany.com", "api.stripe.com"]
  blockedDomains?: string[];    // Explicit block list
  allowedActions?: CUAAction["type"][];  // e.g. exclude "goto" to prevent any navigation
}
```

**Key behavior:** `goto` actions where the URL's domain does not match `allowedDomains` return `{ allowed: false, reason: "navigation to external domain blocked" }`. This becomes an `is_error: true` tool result; the model sees why it was blocked and can pivot. No per-action user prompt needed.

**Limitation:** The policy only intercepts actions the model explicitly emits. A page-initiated redirect after a `click` bypasses it — the browser follows it transparently. For hard network-level restrictions, use infrastructure isolation.

### 6.9 `LoopMonitor`

Observability hook. Called at each step start/end and on terminal events. Used for logging, tracing, and streaming.

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

### 6.10 `PreActionHook`

Optional intercept for observability, audit logging, and application-level enforcement. Fires before every action. Complements `SessionPolicy` — `SessionPolicy` is declarative (defined at init, checked automatically); `PreActionHook` is imperative (custom logic, runs every action).

```typescript
interface PreActionHook {
  (action: CUAAction, tab: BrowserTab): Promise<PreActionDecision>;
}

type PreActionDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string }
  | { decision: "pause"; message: string };  // Surfaces to caller; resumes on acknowledge
```

**Typical uses:**
- Audit log: allow every action, log to external system
- Payment guard: pause before any `click` at coordinates near "Submit Payment"
- Rate limit: deny actions faster than N/second
- Debug: pause and show the user what's about to happen


---

## 7. Context Injection

Every step, before calling the model, the loop prepends structured context to the screenshot message. This is the mechanism behind several patterns:

### 7.1 Step counter injection

```
Step 3 of 20
```

Prepended as a text block before the screenshot. Models use this to calibrate urgency — if they're on step 18 of 20, they should focus on completing the task rather than exploring.

### 7.2 URL injection

```
Current URL: https://example.com/checkout/payment
```

Prepended every step. Models lose track of their location when screenshots look similar across pages. Explicit URL grounding reduces navigation errors by roughly 30% in benchmarks (trycua/cua observation).

### 7.3 Task state injection

```
Current Task State:
  URL: https://example.com/checkout/payment
  Completed: ["logged in", "added items to cart", "entered shipping address"]
  Next: Enter payment details
  Blockers: []
  Data: { "orderTotal": "$47.99" }
```

Prepended to the system prompt every step from `StateStore`. Unlike facts (which accumulate), state is the model's current structured view of progress. It is always current — even after compaction — because it comes from `StateStore`, not from history.

### 7.4 Fact store injection

```
Memory:
- Cart has 2 items
- User selected "Express Shipping"
```

Prepended to the system prompt (not the user message) so it doesn't inflate the conversation turn count.

### 7.5 Error context injection

When the previous action returned an error:

```
The previous action failed: click at (450, 320) — element not interactable
```

This is a structured tool result in the wire history (`is_error: true`), not a separate injection. The model reads it as part of the conversation and reasons about the failure directly.

**Full injection order (per step, what the model sees):**

```
[System prompt]
[Task state — from StateStore, always current]
[Fact store contents — from FactStore, always current]
---
[Wire history: <summary> anchor (if compacted) + recent steps]
---
User: Step N of maxSteps
       Current URL: https://...
       [screenshot image]
```

**What survives compaction:** Everything in the system prompt block (task state, facts, system prompt itself) is re-injected fresh from its respective store every step — it is never part of the compressed history. The `<summary>` anchor in wire history carries prose continuity. Together these three layers ensure the model always has: current page context (screenshot), where it is in the task (state), what it knows (facts), and what happened before (summary + recent steps).

---

## 8. Public API

### 8.1 `Agent`

The only entry point. Browser connection is lazy — established on the first `run()` call. `close()` is optional: use `await using` for automatic scoped cleanup, or `Agent.run()` for one-shot tasks.

```typescript
class Agent {
  constructor(options: AgentOptions);

  // Run the perception loop. Connects to the browser on first call.
  run(options: RunOptions): Promise<AgentResult>;

  // Same as run but yields events as they happen.
  stream(options: RunOptions): AsyncIterable<AgentEvent>;

  // Access history after run.
  history(): SemanticStep[];

  // Direct browser access — navigate before run(), inspect after.
  tab: BrowserTab;

  // Pause and resume across processes.
  serialize(): Promise<SerializedAgent>;
  static resume(data: SerializedAgent, options: AgentOptions): Agent;

  // Explicit cleanup — optional if using `await using` or Agent.run().
  close(): Promise<void>;

  // AsyncDispose — called automatically by `await using`.
  [Symbol.asyncDispose](): Promise<void>;

  // One-shot static helper — creates agent, runs, closes.
  static run(options: AgentOptions & RunOptions): Promise<AgentResult>;
}
```

### 8.2 `AgentOptions`

```typescript
interface AgentOptions {
  // Browser connection
  browser:
    | { type: "browserbase"; apiKey: string; projectId: string; sessionId?: string }
    | { type: "cdp"; url: string }
    | { type: "local"; executablePath?: string; port?: number; userDataDir?: string };

  // Model
  model:
    | "anthropic/claude-opus-4-20250514"
    | "anthropic/claude-sonnet-4-20250514"
    | "anthropic/claude-sonnet-4-5-20250929"
    | "google/gemini-2.5-computer-use-preview-10-2025"
    | "google/gemini-2.0-flash"
    | "openai/computer-use-preview"
    | (string & {});
  apiKey?: string;
  baseURL?: string;

  // Optional planning model (single call before the action loop)
  plannerModel?: string;
  plannerApiKey?: string;

  // System prompt
  systemPrompt?: string;

  // Execution defaults (can be overridden per run)
  maxSteps?: number;           // Default: 30
  thinkingBudget?: number;     // Anthropic extended thinking tokens (default: 0)

  // Post-action timing overrides
  timing?: {
    afterClick?: number;       // Default: 200ms
    afterType?: number;        // Default: 500ms
    afterScroll?: number;      // Default: 300ms
    afterNavigation?: number;  // Default: 1000ms
  };

  // History compression
  keepRecentScreenshots?: number;  // Default: 2
  compactionThreshold?: number;    // Default: 0.8
  compactionModel?: string;        // Default: cheapest available (Haiku-class)

  // Cursor overlay on screenshots
  cursorOverlay?: boolean;         // Default: true

  // Viewport alignment to model patch size
  autoAlignViewport?: boolean;     // Default: true

  // Action allowlist filter (not OS isolation — application-level guard)
  policy?: SessionPolicyOptions;

  // Pre-action hook for audit logging, selective pausing, rate limiting
  preActionHook?: PreActionHook;

  // Completion gate — verifies task actually completed before accepting terminate
  completionGate?: CompletionGate;

  // Observability
  monitor?: LoopMonitor;
  logger?: (line: LogLine) => void;
  verbose?: 0 | 1 | 2;

  // Resumption — pre-load history, facts, and state from a previous run
  initialHistory?: SerializedHistory;
  initialFacts?: string[];
  initialState?: TaskState;
}
```

### 8.3 `RunOptions`

```typescript
interface RunOptions {
  instruction: string;
  maxSteps?: number;  // Overrides AgentOptions.maxSteps for this run
}
```

### 8.4 `AgentResult`

```typescript
interface AgentResult {
  status: "success" | "failure" | "maxSteps";
  result: string;               // Model's final message or reason for failure
  steps: number;
  history: SemanticStep[];      // Full human-readable trace
  finalState: TaskState | null; // Last writeState artifact emitted during the run
  tokenUsage: TokenUsage;       // Aggregate across all steps
}
```

### 8.5 Streaming API

```typescript
type AgentEvent =
  | { type: "step_start";          step: number; maxSteps: number; url: string }
  | { type: "screenshot";          step: number; imageBase64: string }
  | { type: "thinking";            step: number; text: string }
  | { type: "action";              step: number; action: CUAAction }
  | { type: "action_result";       step: number; action: CUAAction; ok: boolean; error?: string }
  | { type: "action_blocked";      step: number; action: CUAAction; reason: string }
  | { type: "memorized";           step: number; fact: string }
  | { type: "state_written";       step: number; state: TaskState }
  | { type: "compaction";          step: number; tokensBefore: number; tokensAfter: number }
  | { type: "termination_rejected"; step: number; reason: string }
  | { type: "done";                result: AgentResult };
```

### 8.6 Usage examples

**One-shot — no lifecycle to manage:**
```typescript
const result = await Agent.run({
  browser: { type: "local" },
  model: "anthropic/claude-sonnet-4-5-20250929",
  apiKey: process.env.ANTHROPIC_API_KEY,
  instruction: "Find and click the 'Get Started' button, then fill in the email with user@example.com",
  maxSteps: 10,
});
console.log(result.status, result.result);
```

**Scoped — automatic cleanup via `await using`:**
```typescript
await using agent = new Agent({
  browser: { type: "browserbase", apiKey: "...", projectId: "..." },
  model: "anthropic/claude-sonnet-4-5-20250929",
});

await agent.tab.navigate("https://example.com");
const result = await agent.run({ instruction: "Book a flight from SFO to JFK", maxSteps: 30 });
console.log(result.result);
// agent.close() called automatically here
```

**Multi-run — reuse browser across tasks:**
```typescript
await using agent = new Agent({ browser: { type: "local" }, model: "..." });

await agent.run({ instruction: "Log in with user@example.com" });
await agent.run({ instruction: "Export the Q4 report as PDF" });
await agent.run({ instruction: "Send it to finance@example.com" });
```

**Streaming:**
```typescript
await using agent = new Agent({ browser: { type: "local" }, model: "..." });

for await (const event of agent.stream({ instruction: "Book a flight from SFO to JFK" })) {
  if (event.type === "screenshot")          showPreview(event.imageBase64);
  if (event.type === "action")              console.log("→", event.action.type);
  if (event.type === "done")               console.log("Result:", event.result.result);
}
```

**With policy + completion gate:**
```typescript
const agent = new Agent({
  browser: { type: "local" },
  model: "anthropic/claude-sonnet-4-5-20250929",
  policy: { allowedDomains: ["*.mycompany.com", "stripe.com"] },
  completionGate: new UrlMatchesGate(/\/order-confirmation/),
});
const result = await agent.run({ instruction: "Place the order" });
await agent.close();
```

**With pre-action hook:**
```typescript
const agent = new Agent({
  browser: { type: "local" },
  model: "google/gemini-2.5-computer-use-preview-10-2025",
  preActionHook: async (action, tab) => {
    auditLog.append({ action, url: tab.url(), timestamp: Date.now() });
    return { decision: "allow" };
  },
});
```

**Resumption:**
```typescript
// Pause mid-task
const agent = new Agent({ ... });
const result = await agent.run({ instruction: "Apply for the permit" });
const serialized = await agent.serialize();
await agent.close();

// Resume later — full history, facts, and task state restored
const resumed = Agent.resume(serialized, { browser: { type: "local" }, model: "..." });
const final = await resumed.run({ instruction: "Continue where we left off" });
```

---

## 9. Optional Planner Model

Before the action loop, an optional planner model produces a structured plan. This plan is injected into the system prompt and reduces the number of steps needed for complex tasks.

```typescript
interface PlannerResult {
  plan: string[];              // Ordered list of high-level steps
  estimatedSteps: number;
}

async function runPlanner(
  instruction: string,
  screenshot: ScreenshotResult,
  model: ModelAdapter,
): Promise<PlannerResult> {
  // Single call to a cheap/fast model
  // Returns ["1. Navigate to login page", "2. Fill in credentials", ...]
  // This plan is then injected into the action loop's system prompt
}
```

**Why a separate model?** The planner can be a smaller, faster model (e.g., Haiku) that does one call. The action loop then uses a more capable model (e.g., Sonnet) for execution. This reduces total cost while improving navigation on complex tasks.

**Injection:** The plan is prepended to the system prompt:

```
Your plan:
1. Navigate to the checkout page
2. Enter shipping address
3. Select Express Shipping
4. Enter payment details
5. Click Place Order

Execute this plan step by step.
```

---

## 10. Error Handling Contract

### 10.1 Two error categories

**Recoverable — returned as `ActionOutcome`, fed back to model:**
- Click coordinates not interactable
- Type target not focused
- Scroll position already at limit
- `goto` redirect (handled transparently, not an error)
- Model output does not include `terminate` before maxSteps

**Unrecoverable — thrown as exceptions, propagate to caller:**
- Browser session disconnected
- CDP command timeout
- Model API request failed after retries
- `init()` not called before `run()`

### 10.2 Typed exceptions

```typescript
class CUAError extends Error {
  readonly code: CUAErrorCode;
  readonly step?: number;
}

type CUAErrorCode =
  | "BROWSER_DISCONNECTED"
  | "MODEL_API_ERROR"
  | "SESSION_TIMEOUT"
  | "INIT_REQUIRED"
  | "MAX_RETRIES_EXCEEDED";
```

### 10.3 Model API retry policy

```typescript
interface RetryPolicy {
  maxRetries: number;           // Default: 3
  initialDelayMs: number;       // Default: 1000ms
  maxDelayMs: number;           // Default: 30000ms
  backoffMultiplier: number;    // Default: 2
  jitterMs: number;             // Default: 500ms — prevents thundering herd
  retryOnStatusCodes: number[]; // Default: [429, 500, 502, 503, 504]
}
```

Retry logic lives in each `ModelAdapter`. From the `PerceptionLoop`'s perspective, `adapter.step()` either resolves or throws `CUAError("MODEL_API_ERROR")` after retries are exhausted.

---

## 11. Package Structure

```
lumen/
├── src/
│   ├── browser/
│   │   ├── tab.ts             # BrowserTab interface + CDPTab implementation
│   │   ├── capture.ts         # ScreenCapture (screenshot + cursor overlay)
│   │   ├── viewport.ts        # ViewportManager (smart_resize)
│   │   ├── frame.ts           # FrameRouter (OOPIF coordinate routing)
│   │   └── launch/
│   │       ├── local.ts       # chrome-launcher integration
│   │       └── browserbase.ts # Browserbase SDK integration
│   │
│   ├── model/
│   │   ├── adapter.ts         # ModelAdapter interface + types
│   │   ├── decoder.ts         # ActionDecoder (provider → CUAAction)
│   │   ├── normalize.ts       # Coordinate normalization utilities
│   │   ├── anthropic.ts       # AnthropicAdapter
│   │   ├── google.ts          # GoogleAdapter
│   │   ├── openai.ts          # OpenAIAdapter
│   │   └── custom.ts          # CustomAdapter (tool-calling wrapper)
│   │
│   ├── loop/
│   │   ├── perception.ts      # PerceptionLoop (main loop + mid-stream execution)
│   │   ├── history.ts         # HistoryManager (dual history, screenshot compression, LLM compaction)
│   │   ├── facts.ts           # FactStore (append-only, compression-resistant)
│   │   ├── state.ts           # StateStore (last-write-wins TaskState artifact)
│   │   ├── router.ts          # ActionRouter (CUAAction → browser ops, timing)
│   │   ├── gate.ts            # CompletionGate interface + built-in gates
│   │   ├── policy.ts           # SessionPolicy (domain/action boundary enforcement)
│   │   ├── child.ts           # ChildLoop (isolated sub-session for multi-tab)
│   │   ├── monitor.ts         # LoopMonitor interface + implementations
│   │   └── planner.ts         # Optional planner model (cheap pre-loop call)
│   │
│   ├── agent.ts               # Agent (public entry point)
│   ├── types.ts               # All public types (CUAAction, AgentResult, TaskState, etc.)
│   └── errors.ts              # CUAError, CUAErrorCode
│
├── package.json               # No Playwright / Puppeteer dependency
└── tsconfig.json
```

---

## 12. Key Design Decisions and Rationale

| Decision | Rationale |
|---|---|
| 0–1000 normalized coordinates | Matches Google's native space; models are stable in abstract coordinate space vs pixel space which shifts with viewport size; one normalization point |
| Keep 2 screenshots in wire history | Gives model state + delta; 3+ rarely helps; dramatic token reduction (avg 1 screenshot ≈ 800 tokens at medium quality) |
| LLM summarization at 80% threshold | Proactive compaction before forced limit gives the model room to write a thorough summary; summarizer understands which tool results matter vs noise (Claude Code pattern) |
| `writeState` structured artifact | Structured JSON survives compaction where freeform text doesn't; re-injected from its own store every step regardless of compression; equivalent to Claude Code's TodoWrite checklist |
| `terminate` action required + CompletionGate | Inferred completion is fragile; gate lets the host assert "done" means the confirmation page is actually visible (Claude Code stop_hook pattern) |
| `memorize` + `FactStore` | Facts survive compression; model writes incrementally as it discovers things; separated from `StateStore` because facts are append-only, state is last-write-wins |
| `StateStore` separate from `FactStore` | State tracks "where in the task" (replaced each step by model); facts track "what I learned" (accumulated); different update patterns, different injection semantics |
| Errors as `is_error: true` tool results | 30–40% of CUA actions fail on first attempt; throwing kills the session; `is_error: true` is the Anthropic API standard and Claude Code's pattern for feeding error context back |
| `SessionPolicy` over per-action confirmation | Claude Code measured 84% prompt reduction with boundary-first model; per-action prompts break autonomy at step 15 of a 30-step flow; policy is a filter not a sandbox — page-initiated redirects bypass it |
| `PreActionHook` for observability | Audit logging, rate limiting, and selective pause without breaking autonomous flow; imperative complement to the declarative `SessionPolicy` |
| ChildLoop for multi-tab isolation | Full child conversation never enters parent history; only result summary does; prevents multi-tab sessions exploding parent context (Claude Code sub-agent pattern) |
| Mid-stream action execution | Start executing action #1 while action #2 is still streaming; eliminates one round-trip of latency on compound operations (Claude Code pattern) |
| Cursor overlay at last click | Single highest-leverage technique for model spatial orientation; costs ~1KB of buffer compositing |
| Planner model optional, cheap | Significantly reduces step count on complex tasks; Haiku-class for planning, Sonnet-class for execution; optional because many simple tasks don't need it |
| smart_resize before loop start | Patch-aligned coordinates drift without it; fix it once at init rather than compensating per-action |
| Post-action timing per action type | Uniform sleeps waste time; typed delays match actual browser behavior (animations, focus events, lazy loads) |
| Serializable history including StateStore + FactStore | Full session serialization enables resumption, debugging, and handoff without re-running the model |
| No DOM access in the hot path | Eliminates complexity; the model sees what the user sees; DOM access would add 100–300ms per step |
| Tool descriptions as behavioral contracts | Model behavior shaped via rich tool descriptions (not just parameter schemas); Claude Code's Bash tool is 1,558 tokens of behavioral specification |

---

## 13. Patterns Adopted from Prior Art

### From browser-use
- **Error-as-context**: browser-use injects errors as conversation history rather than throwing. Adopted directly in `ActionRouter` (`is_error: true` tool results).
- **Step counter injection**: browser-use prepends `Step N/M` to help models calibrate urgency. Adopted.
- **`include_in_memory` flag**: browser-use lets models mark facts for retention. Adopted as the `memorize` action + `FactStore`.
- **Serializable history**: browser-use's `AgentHistoryList` supports serialization. Adopted in `HistoryManager.toJSON()` (also includes `StateStore` + `FactStore`).
- **Optional planner model**: browser-use's `planner_llm` pattern. Adopted — cheap model for planning, capable model for execution.

### From trycua/cua
- **0–1000 normalized coordinate space**: trycua's core coordinate abstraction. Adopted as the universal model-space coordinate system; normalization happens at `ActionDecoder`, denormalization at `ActionRouter`, nowhere else.
- **Screenshot compression**: keep 2 most recent screenshots. Adopted in `HistoryManager.compressScreenshots()`.
- **Dual history**: semantic trace (never compressed) + wire trace (actively compressed). Adopted.
- **URL per step injection**: trycua prepends the current URL every step. Adopted.
- **Explicit `terminate` action**: trycua requires explicit termination. Adopted + extended with `CompletionGate` verification.
- **`pause_and_memorize_fact`**: trycua's within-session memory. Adopted as the `memorize` action + `FactStore`.
- **smart_resize**: trycua's patch-aligned viewport adjustment. Adopted in `ViewportManager`.
- **Inter-action delays typed by action**: trycua uses 500ms after type, 200ms after click. Adopted in `ActionRouter`.
- **Cursor overlay**: trycua composes a cursor dot onto screenshots. Adopted in `ScreenCapture`.

### From Claude Code
- **LLM summarization at threshold**: Claude Code compacts at 95% with a model-written `<summary>` block. Adopted as `compactWithSummary()`, triggered proactively at 80%.
- **Structured artifact survives compaction**: Claude Code's TodoWrite checklist persists across compression because it's a named artifact, not freeform text. Adopted as `StateStore` + `writeState` action — re-injected from its own store every step.
- **`is_error: true` on tool results**: Claude Code's standard for feeding error context back. Adopted as the wire format for all recoverable action failures.
- **Stop hook as completion gate**: Claude Code's Stop hooks prevent exit until a condition is met. Adopted as `CompletionGate` — host application asserts what "done" looks like before the loop accepts `terminate`.
- **Sub-agent context isolation**: Claude Code's Task tool gives each sub-agent a fresh context; only the summary result enters the parent. Adopted as `ChildLoop` — full child conversation never enters parent history.
- **Mid-stream tool execution**: Claude Code starts tool execution at `content_block_stop`, not `message_stop`. Adopted — `adapter.stream()` yields actions as they complete; `PerceptionLoop` executes each immediately.
- **Policy over per-action confirmation**: Claude Code measured 84% prompt reduction with boundary-first model. Adopted as `SessionPolicy` — an allowlist filter (not OS-level isolation) with `allowedDomains`/`allowedActions` declared at session init. Page-initiated redirects are not intercepted.
- **Tool descriptions as behavioral contracts**: Claude Code's Bash tool is 1,558 tokens of behavioral specification, not just a parameter schema. Adopted — each CUA tool description includes when to use it, failure modes, and what to do after calling it.

---

## 14. What This Explicitly Excludes

| Excluded | Reason |
|---|---|
| `act()` / `extract()` / `observe()` methods | These are DOM-snapshot pipelines, not CUA; separate concern |
| Accessibility tree / DOM snapshot capture | CUA doesn't need the DOM; adding it complicates the hot path |
| XPath-based element selection | The model selects via coordinates, not XPath |
| Playwright / Puppeteer / Patchright | Zero runtime dependency; users connect via CDP URL |
| Per-call model override | In CUA, the model is the session; changing it mid-session breaks history format |
| `selfHeal` retry on stale selectors | There are no selectors; "self-healing" is the model seeing the error and retrying |
| `ActCache` / `AgentCache` | Caching is at the session level via `serialize()`; no instruction-hash-based cache |
| Auto-wait / actionability checks | The loop always takes a screenshot before calling the model; the model has current state |
| Hybrid mode | This PRD is CUA-only; DOM/hybrid belongs in a separate module |

---

## 15. Success Metrics

| Metric | Target |
|---|---|
| Task success rate on standard CUA benchmarks | ≥ V3 baseline |
| Steps to complete (efficiency) | ≤ V3 baseline (planner + typed timing + state injection helps) |
| Average tokens per step (30-step session) | 40% reduction vs V3 (screenshot compression + LLM summarization) |
| Token utilization at which compaction triggers | 80% (proactive — never forced by limit) |
| Loop core lines of code | < 600 lines (PerceptionLoop + HistoryManager + ActionRouter + StateStore) |
| Model adapter lines of code | < 200 lines per adapter |
| Hard framework dependencies | 0 (no Playwright, no Puppeteer) |
| Time from `init()` to first step | < 500ms |
| Sessions resumable from serialization | 100% (history + facts + state all serialized) |
| Coordinate error rate (click misses due to normalization) | < 2% |
| False termination rate (model says done, CompletionGate rejects) | Measurable + logged via `LoopMonitor.terminationRejected()` |
| Actions blocked by `SessionPolicy` per session (typical) | < 1 (expected near-zero for correctly configured sessions) |

