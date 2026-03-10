# API Reference

All public exports from `@omxyz/lumen`.

## Agent

**The problem:** you want to automate a browser task without writing selectors or managing browser lifecycle.

**The solution:** `Agent` handles everything — browser connection, model selection, history, and cleanup.

```typescript
import { Agent } from "@omxyz/lumen";

// One line: create agent, run task, get answer, close browser
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Find the top story on Hacker News.",
});

console.log(result.result);      // "Show HN: ..."
console.log(result.agentState);  // structured data if writeState was used
```

Need to chain multiple tasks in one browser session?

```typescript
const agent = new Agent({ model: "anthropic/claude-sonnet-4-6", browser: { type: "local" } });
await agent.run({ instruction: "Navigate to github.com" });
await agent.run({ instruction: "Search for 'react'" });
await agent.close();
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `new Agent(options: AgentOptions)` | Create an agent. Does not connect until the first `run()`. |
| `run` | `run(options: RunOptions): Promise<RunResult>` | Execute a task. Connects to the browser on first call. |
| `stream` | `stream(options: RunOptions): AsyncIterable<StreamEvent>` | Like `run()`, but yields typed events in real-time. |
| `serialize` | `serialize(): Promise<SerializedAgent>` | Snapshot the agent's wire history and state for later resumption. |
| `resume` | `static resume(data: SerializedAgent, options: AgentOptions): Agent` | Restore an agent from a serialized snapshot. |
| `close` | `close(): Promise<void>` | Disconnect the browser and release resources. |
| `run` (static) | `static run(options: AgentOptions & RunOptions): Promise<RunResult>` | Convenience: create agent, run one task, close. |

### RunOptions

```typescript
interface RunOptions {
  instruction: string;   // the task in plain English
  maxSteps?: number;     // override per-run (defaults to AgentOptions.maxSteps)
  startUrl?: string;     // pre-navigate before first screenshot — saves 1-2 steps
}
```

### RunResult

```typescript
interface RunResult {
  status: "success" | "failure" | "maxSteps";
  result: string;              // the agent's final answer
  steps: number;               // total steps taken
  history: SemanticStep[];     // full step-by-step trace with screenshots
  agentState: TaskState | null; // structured state from writeState
  tokenUsage: TokenUsage;
}
```

---

## Session

**The problem:** you already have a browser tab and model adapter — you just need the perception loop.

**The solution:** `Session` is the lower-level API. Bring your own tab and adapter, get full control.

```typescript
import { Session, CDPTab, CdpConnection, AnthropicAdapter } from "@omxyz/lumen";

const conn = await CdpConnection.connect("ws://localhost:9222/...");
const tab = new CDPTab(conn.mainSession());
const adapter = new AnthropicAdapter("claude-sonnet-4-6");

const session = new Session({ tab, adapter, maxSteps: 20 });
const result = await session.run({ instruction: "Find the price of Bitcoin." });
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `constructor` | `new Session(options: SessionOptions)` | Create a session with an existing tab and adapter. |
| `run` | `run(options: RunOptions): Promise<RunResult>` | Execute a task using the provided tab/adapter. |
| `serialize` | `serialize(): SerializedHistory` | Snapshot wire history and state. |

---

## Model Adapters

**The problem:** different model providers use different APIs, coordinate formats, and tool schemas.

**The solution:** adapters normalize everything. The `Agent` class picks one automatically from the `model` string prefix — or you can instantiate directly.

```typescript
import { AnthropicAdapter, GoogleAdapter, OpenAIAdapter, CustomAdapter } from "@omxyz/lumen";

// Automatic selection via Agent:
{ model: "anthropic/claude-sonnet-4-6" }  // → AnthropicAdapter
{ model: "google/gemini-2.5-pro" }        // → GoogleAdapter
{ model: "openai/computer-use-preview" }  // → OpenAIAdapter
{ model: "llama3.2-vision", baseURL: "http://localhost:11434/v1" }  // → CustomAdapter (fallback)

// Manual construction for Session:
const adapter = new AnthropicAdapter("claude-sonnet-4-6", process.env.ANTHROPIC_API_KEY);
```

| Adapter | Provider | Model prefix | Example |
|---------|----------|--------------|---------|
| `AnthropicAdapter` | Anthropic | `anthropic/` | `"anthropic/claude-sonnet-4-6"` |
| `GoogleAdapter` | Google | `google/` | `"google/gemini-2.5-pro"` |
| `OpenAIAdapter` | OpenAI | `openai/` | `"openai/computer-use-preview"` |
| `CustomAdapter` | Any OpenAI-compatible | *(fallback)* | `{ model: "llama3.2-vision", baseURL: "..." }` |

---

## Verifiers

**The problem:** the agent says "I'm done" but hasn't actually completed the task. It found a search results page, not the actual answer.

**The solution:** verifiers act as completion gates — they check the screenshot/URL before accepting a `terminate` action. If verification fails, the loop continues.

```typescript
import { UrlMatchesGate, ModelVerifier, CustomGate, AnthropicAdapter } from "@omxyz/lumen";

// Simple: URL must match a pattern
const gate = new UrlMatchesGate(/\/confirmation\?order=\d+/);

// Thorough: a cheap model inspects the screenshot
const gate = new ModelVerifier(
  new AnthropicAdapter("claude-haiku-4-5-20251001"),
  "Complete the checkout flow",
);

// Custom: your own logic
const gate = new CustomGate(async (screenshot, url) => {
  return url.includes("/success") ? { pass: true } : { pass: false, reason: "Not on success page" };
});
```

| Class | Description |
|-------|-------------|
| `UrlMatchesGate` | Pass if the current URL matches a regex pattern. |
| `CustomGate` | Pass if a user-provided async function returns true. |
| `ModelVerifier` | Pass if a cheap model confirms the task is done by inspecting the screenshot. |

---

## v2 Features

**The problem:** basic screenshot-and-act works for simple tasks, but complex sites need smarter strategies — backtracking when stuck, domain-specific tips, learning from past runs.

**The solution:** optional v2 modules, each enabled with a single flag in `AgentOptions`.

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },

  // Multi-sample on uncertain steps — picks the most consistent action
  confidenceGate: true,

  // Verify clicks landed, inputs received focus
  actionVerifier: true,

  // Save browser state every 5 steps — backtrack on deep stalls
  checkpointInterval: 5,

  // Domain-specific tips: "on booking.com, use the calendar widget"
  siteKB: "./site-kb.json",

  // Inject patterns from past successful runs
  workflowMemory: "./workflows.json",
});
```

| Class | Option | Description |
|-------|--------|-------------|
| `ConfidenceGate` | `confidenceGate: true` | Multi-sample on hard steps. Samples multiple model responses and picks the most consistent action. Inspired by [CATTS](https://arxiv.org/abs/2503.00069). |
| `ActionVerifier` | `actionVerifier: true` | Heuristic post-action checks via CDP — verifies clicks landed correctly, inputs received focus after typing. |
| `CheckpointManager` | `checkpointInterval: 5` | Periodically saves browser state for backtracking. When the repeat detector hits level 8+ (deep stall), the agent rolls back to the last checkpoint. |
| `SiteKB` | `siteKB: "path.json"` | Domain-specific navigation tips injected into model context. See `default-site-kb.json` for examples. |
| `WorkflowMemory` | `workflowMemory: "path.json"` | Reusable workflow patterns extracted from past successful runs. Matching workflows are injected as hints. |

---

## Loop Primitives

**The problem:** you want to build a custom agent loop with different logic, but reuse Lumen's battle-tested components.

**The solution:** all internal components are exported. Compose them however you want.

```typescript
import {
  PerceptionLoop, HistoryManager, ActionRouter,
  StateStore, RepeatDetector, ActionCache,
} from "@omxyz/lumen";
```

| Class | Description |
|-------|-------------|
| `PerceptionLoop` | The core screenshot → model → action loop. |
| `HistoryManager` | Wire history with tier-1 (screenshot drop) and tier-2 (LLM summarization) compaction. |
| `ActionRouter` | Dispatches `Action` objects to the browser via CDP. |
| `StateStore` | Persistent structured state (`writeState` data) that survives compaction. |
| `RepeatDetector` | Three-layer stuck detection: exact action repeats, category dominance, URL stall. |
| `ActionCache` | On-disk cache for replaying known-good action sequences. |
| `ChildLoop` | Fresh sub-loop for `delegate` actions with isolated context. |
| `SessionPolicy` | Declarative action filter (domain allowlist/blocklist, action type filter). |
| `runPlanner` | Pre-loop planning pass using a cheap model. |

---

## Browser

**The problem:** you need to connect to Chrome in different environments — local, Docker, cloud.

**The solution:** Lumen exports the browser primitives so you can connect however you need.

```typescript
import { CDPTab, CdpConnection, launchChrome, connectBrowserbase } from "@omxyz/lumen";

// Launch locally
const { wsUrl, kill } = await launchChrome({ headless: true });
const conn = await CdpConnection.connect(wsUrl);
const tab = new CDPTab(conn.mainSession());

// Or connect to Browserbase cloud
const { wsUrl } = await connectBrowserbase({
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
});
```

| Export | Description |
|--------|-------------|
| `CDPTab` | Default `BrowserTab` implementation over Chrome DevTools Protocol. Handles click, type, scroll, goto, screenshot. |
| `CdpConnection` | WebSocket connection to a Chrome CDP endpoint. Manages sessions and message routing. |
| `ViewportManager` | Resizes and aligns the browser viewport to the model's preferred dimensions. |
| `launchChrome` | Launch a local Chrome instance and return its CDP WebSocket URL. |
| `connectBrowserbase` | Connect to a Browserbase cloud session and return its CDP WebSocket URL. |

---

## Monitors

**The problem:** you need visibility into what the agent is doing — for debugging, analytics, or building a UI.

**The solution:** monitors are hooks called at each loop step. Use the built-in ones or implement your own `LoopMonitor`.

```typescript
import { ConsoleMonitor, NoopMonitor, StreamingMonitor } from "@omxyz/lumen";

// Default at verbose >= 1: prints step progress to stdout
const monitor = new ConsoleMonitor();

// Silent mode
const monitor = new NoopMonitor();

// For agent.stream() — buffers StreamEvent objects
const monitor = new StreamingMonitor();
```

| Class | Description |
|-------|-------------|
| `ConsoleMonitor` | Prints step progress, actions, and results to stdout. Used by default at `verbose >= 1`. |
| `NoopMonitor` | Does nothing. Used at `verbose: 0`. |
| `StreamingMonitor` | Buffers `StreamEvent` objects for the `agent.stream()` API. |

---

## Types

Key type exports for TypeScript consumers:

```typescript
import type {
  Action,           // union of all action types (click, type, scroll, goto, ...)
  StreamEvent,      // union of all streaming event types
  RunResult,        // result of agent.run()
  RunOptions,       // options for agent.run()
  TaskState,        // Record<string, unknown> — writeState data
  SemanticStep,     // human-readable step trace with screenshots
  SerializedHistory,// serializable history snapshot
  TokenUsage,       // { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
  LogLine,          // structured log entry
  PreActionHook,    // imperative deny hook
  PreActionDecision,// { decision: "allow" } | { decision: "deny", reason: string }
  BrowserOptions,   // local | cdp | browserbase
  AgentOptions,     // full agent configuration
} from "@omxyz/lumen";
```
