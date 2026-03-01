# @omlabs/lumen

Vision-first Computer Use Agent (CUA) engine for Node.js. Give it a task in plain English; it drives a real browser using screenshots and model-emitted actions to get it done.

Lumen is a clean, production-grade redesign of the CUA path in Stagehand V3 — same vision-loop idea, engineered from scratch with principled history compression, a unified coordinate model, and a composable adapter interface for Anthropic, Google, OpenAI, and any OpenAI-compatible provider.

## Table of Contents

- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Browser Options](#browser-options)
- [Model Selection](#model-selection)
- [AgentOptions Reference](#agentoptions-reference)
- [Streaming Events](#streaming-events)
- [Session Resumption](#session-resumption)
- [Policy & Safety](#policy--safety)
- [Testing](#testing)
- [Evals](#evals)
- [Scripts](#scripts)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

---

## Key Features

- **Vision-only loop** — screenshot → model → action(s) → screenshot. No DOM scraping, no selectors.
- **Multi-provider** — Anthropic (Claude), Google (Gemini), OpenAI (`computer-use-preview`), and any OpenAI-compatible chat endpoint.
- **Principled history compression** — tier-1 screenshot compression (keeps the last N frames) + tier-2 LLM summarization at 80% context utilization. Achieves 32% fewer tokens than Stagehand V3 in benchmarks.
- **Unified coordinate model** — all model-space coords are normalized 0–1000. Denormalization to pixels happens exactly once, in `ActionRouter`, so adapters never touch raw pixel values.
- **Persistent within-session memory** — the `writeState` action persists structured JSON that survives history compaction via `StateStore`.
- **Streaming events** — `agent.stream()` yields a typed `CUAEvent` async iterable for real-time UI.
- **Session resumption** — serialize to JSON, restore later with `Agent.resume()`.
- **Safety hooks** — `SessionPolicy` (domain allowlist/blocklist, action-type filter) and a `PreActionHook` for imperative deny logic.
- **Completion gates** — plug in a `CompletionGate` to verify the task is actually done before the loop exits.
- **Child loop delegation** — the model can delegate a sub-task to a fresh loop via the `delegate` action.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.7+ (ESM-only) |
| Runtime | Node.js ≥ 20.19 |
| Browser | Chrome/Chromium via CDP WebSocket |
| Browser launch | `chrome-launcher` (local) or Browserbase (cloud) |
| Image processing | `sharp` (JPEG compression, cursor overlay) |
| Models | `@anthropic-ai/sdk`, `@google/genai`, `openai` |
| Tests | Vitest |
| Build | `tsc` → `dist/` |

---

## Prerequisites

- **Node.js** ≥ 20.19.0 or ≥ 22.12.0
- **Chrome or Chromium** installed locally (for `browser: { type: "local" }`)
- An API key for at least one of: Anthropic, Google AI, or OpenAI

---

## Installation

```bash
npm install @omlabs/lumen
# or
pnpm add @omlabs/lumen
```

---

## Quick Start

```typescript
import { Agent } from "@omlabs/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local", headless: true },
  instruction: "Go to news.ycombinator.com and tell me the title of the top story.",
  maxSteps: 10,
});

console.log(result.status);  // "success" | "failure" | "maxSteps"
console.log(result.result);  // natural-language answer from the model
console.log(`Used ${result.tokenUsage.inputTokens} input tokens in ${result.steps} steps`);
```

`Agent.run()` is a convenience wrapper that creates the agent, runs once, and closes the browser. For multi-run sessions use the class directly:

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
});

// First task
const r1 = await agent.run({ instruction: "Navigate to github.com" });

// Second task — same browser session, history preserved
const r2 = await agent.run({ instruction: "Search for the 'react' repository." });

await agent.close();
```

---

## Browser Options

### Local Chrome (default for development)

Launches a Chrome process via `chrome-launcher`. Requires Chrome/Chromium to be installed.

```typescript
browser: {
  type: "local",
  headless: true,         // default: true
  port: 9222,             // CDP port, default: 9222
  userDataDir: "/tmp/lumen-profile",  // optional profile directory
}
```

### Existing CDP endpoint

Connect to an already-running Chrome instance (useful when you own the browser lifecycle).

```typescript
browser: {
  type: "cdp",
  url: "ws://localhost:9222/devtools/browser/...",
}
```

Obtain the WebSocket URL from `http://localhost:<port>/json/version`.

### Browserbase (cloud)

Remote browser hosted by [Browserbase](https://browserbase.com). No local Chrome needed; works in serverless environments.

```typescript
browser: {
  type: "browserbase",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  // sessionId: "existing-session-id",  // optional: resume a session
}
```

---

## Model Selection

Pass the model as `"provider/model-id"` or use the short Stagehand-compatible names.

### Anthropic

```typescript
model: "anthropic/claude-opus-4-6"    // most capable
model: "anthropic/claude-sonnet-4-6"  // balanced (recommended)
model: "anthropic/claude-3-7-sonnet-20250219"
```

Anthropic models use the native `computer_20251124` tool (Claude 4.x) or `computer_20250124` (older models). Extended thinking is supported:

```typescript
{ model: "anthropic/claude-opus-4-6", thinkingBudget: 8000 }
```

### Google

```typescript
model: "google/gemini-2.5-pro"
model: "google/gemini-2.0-flash"
```

### OpenAI

```typescript
model: "openai/computer-use-preview"
```

### Custom / OpenAI-compatible

Any model not matching the above prefixes falls through to `CustomAdapter`, which speaks OpenAI-compatible chat completions:

```typescript
{
  model: "my-local-model",
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",
}
```

---

## AgentOptions Reference

```typescript
interface AgentOptions {
  // Required
  model: string;                     // "anthropic/claude-sonnet-4-6" etc.
  browser: BrowserOptions;

  // Auth
  apiKey?: string;                   // Falls back to env var (ANTHROPIC_API_KEY etc.)
  baseURL?: string;                  // For CustomAdapter

  // Task control
  maxSteps?: number;                 // Default: 30
  systemPrompt?: string;             // Prepended to every request
  plannerModel?: string;             // If set, runs a planning pass before the loop

  // Anthropic extended thinking
  thinkingBudget?: number;           // Token budget. Default: 0 (disabled)

  // History & compression
  compactionThreshold?: number;      // 0–1. Compact at this token utilization. Default: 0.8
  compactionModel?: string;          // Override model for summarization. Default: main model
  keepRecentScreenshots?: number;    // Screenshots to keep in wire history. Default: 2

  // Viewport
  autoAlignViewport?: boolean;       // Snap viewport to model patch size. Default: true
  cursorOverlay?: boolean;           // Draw cursor dot at last click. Default: true

  // Observability
  verbose?: 0 | 1 | 2;              // 0=silent, 1=step-level, 2=action-level. Default: 1
  logger?: (line: LogLine) => void;  // Structured log callback
  monitor?: LoopMonitor;             // Custom monitor (overrides verbose)

  // Safety
  policy?: SessionPolicyOptions;
  preActionHook?: PreActionHook;
  completionGate?: CompletionGate;

  // Timing overrides (milliseconds)
  timing?: {
    afterClick?: number;       // Default: 200
    afterType?: number;        // Default: 500
    afterScroll?: number;      // Default: 300
    afterNavigation?: number;  // Default: 1000
  };

  // Session resumption
  initialHistory?: SerializedHistory;
  initialState?: TaskState;
}
```

---

## Streaming Events

`agent.stream()` returns an async iterable of `CUAEvent` objects, useful for building real-time UIs or progress indicators.

```typescript
const agent = new Agent({ model: "anthropic/claude-sonnet-4-6", browser: { type: "local" } });

for await (const event of agent.stream({ instruction: "Find the current Bitcoin price." })) {
  switch (event.type) {
    case "step_start":
      console.log(`Step ${event.step}/${event.maxSteps} — ${event.url}`);
      break;
    case "screenshot":
      // event.imageBase64 — render in UI
      break;
    case "thinking":
      console.log("Thinking:", event.text);
      break;
    case "action":
      console.log("Executing:", event.action.type);
      break;
    case "action_result":
      if (!event.ok) console.warn("Action failed:", event.error);
      break;
    case "compaction":
      console.log(`Compacted: ${event.tokensBefore} → ${event.tokensAfter} tokens`);
      break;
    case "done":
      console.log("Done:", event.result.status, event.result.result);
      break;
  }
}

await agent.close();
```

### Full event reference

| Event type | Key fields |
|---|---|
| `step_start` | `step`, `maxSteps`, `url` |
| `screenshot` | `step`, `imageBase64` |
| `thinking` | `step`, `text` |
| `action` | `step`, `action: CUAAction` |
| `action_result` | `step`, `action`, `ok`, `error?` |
| `action_blocked` | `step`, `action`, `reason` |
| `state_written` | `step`, `data: TaskState` |
| `compaction` | `step`, `tokensBefore`, `tokensAfter` |
| `termination_rejected` | `step`, `reason` |
| `done` | `result: AgentResult` |

---

## Session Resumption

Serialize the agent state to JSON after a run, then restore it later in a new process.

```typescript
// Run 1 — save state
const agent = new Agent({ model: "anthropic/claude-sonnet-4-6", browser: { type: "local" } });
await agent.run({ instruction: "Log in to the app." });
const snapshot = await agent.serialize();
await agent.close();

// Persist snapshot however you like
fs.writeFileSync("session.json", JSON.stringify(snapshot));

// Run 2 — restore in a new process
const snapshot = JSON.parse(fs.readFileSync("session.json", "utf8"));
const agent2 = Agent.resume(snapshot, {
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
});
await agent2.run({ instruction: "Now fill out the profile form." });
await agent2.close();
```

The serialized payload contains:
- `wireHistory` — compressed model-facing message history
- `semanticSteps` — full human-readable step records (never compressed)
- `agentState` — last `writeState` state
- `modelId` — model used in the original session

---

## Policy & Safety

### SessionPolicy — declarative allowlist/blocklist

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  policy: {
    allowedDomains: ["*.mycompany.com", "api.stripe.com"],
    blockedDomains: ["facebook.com", "twitter.com"],
    allowedActions: ["click", "type", "scroll", "goto", "terminate"],
  },
});
```

`allowedDomains` / `blockedDomains` support glob-style `*.domain.com` patterns. Note: this is a policy layer, not OS-level network isolation. Page-initiated redirects and embedded resources are not intercepted.

### PreActionHook — imperative deny logic

Called before every action, before the policy check. Return `{ decision: "deny", reason: "..." }` to block.

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  preActionHook: async (action) => {
    if (action.type === "goto" && action.url.includes("checkout")) {
      return { decision: "deny", reason: "checkout navigation not permitted in this context" };
    }
    return { decision: "allow" };
  },
});
```

### CompletionGate — verify the task is actually done

By default, the loop exits as soon as the model emits `terminate`. A `CompletionGate` lets you add your own verification:

```typescript
import { Agent, UrlMatchesGate, CustomGate } from "@omlabs/lumen";

// Built-in: verify the current URL matches a pattern
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  completionGate: new UrlMatchesGate(/\/confirmation\?order=\d+/),
});

// Custom: inspect the screenshot
const gate = new CustomGate(
  async (screenshot, url) => {
    // your verification logic
    return url.includes("/success");
  },
  "Expected to land on success page",
);
```

If the gate fails, the termination is rejected and fed back to the model as an error, giving it a chance to recover.

---

## Testing

```bash
# Run the full test suite (73 tests, ~0.5s)
npm test

# Watch mode
npm run test:watch

# Type checking (includes tests/)
npm run typecheck
```

### Test structure

```
tests/
├── unit/
│   ├── facts.test.ts          # FactStore
│   ├── state.test.ts          # StateStore
│   ├── policy.test.ts         # SessionPolicy domain matching
│   ├── gate.test.ts           # CompletionGate
│   ├── normalize.test.ts      # Coordinate helpers
│   ├── decoder.test.ts        # ActionDecoder
│   ├── history.test.ts        # HistoryManager compression
│   ├── history-toolids.test.ts# Tool call ID correlation
│   ├── router.test.ts         # ActionRouter
│   └── streaming-monitor.test.ts
├── integration/
│   ├── mock-tab.ts            # In-memory BrowserTab implementation
│   ├── mock-adapter.ts        # In-memory ModelAdapter implementation
│   ├── loop.test.ts           # Full PerceptionLoop integration
│   ├── child.test.ts          # ChildLoop delegation
│   ├── gate.test.ts           # CompletionGate integration
│   ├── policy-integration.test.ts
│   ├── preaction-hook.test.ts
│   ├── writestate.test.ts
│   ├── options.test.ts
│   ├── compaction.test.ts
│   └── live-challenges.test.ts
└── evals/
    ├── runner.ts              # Eval harness
    ├── scoring.ts             # Scoring utilities
    ├── compare.ts             # Lumen vs Stagehand token comparison
    └── tasks/
        ├── hacker_news.eval.ts
        ├── all_recipes.eval.ts
        ├── amazon_shoes.eval.ts
        └── google_flights.eval.ts
```

---

## Evals

Evals measure real-task performance against live websites with actual model calls. They require API keys.

```bash
# All 4 tasks, both adapters (Lumen + Stagehand baseline)
ANTHROPIC_API_KEY=sk-... npm run eval

# Single task
npm run eval:quick         # wikipedia_shannon only

# Lumen adapter only (skip Stagehand comparison)
npm run eval:lumen
```

Eval results (claude-sonnet-4-6, March 2026):

| Task | Steps | Token reduction |
|---|---|---|
| wikipedia_shannon | 4 | 5.6% |
| github_react_version | 3 | ~0% |
| hacker_news_top | 1 | 0% |
| allrecipes_wellington | 14 | 39.7% |
| **Aggregate** | — | **32.1%** |

The token savings are quadratic in task length: long tasks (20+ steps) routinely exceed 40%.

---

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the full test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | Type-check everything including tests |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm run test:live` | Run `run-test.ts` against a real browser (requires API key) |
| `npm run eval` | Run all evals against live websites |
| `npm run eval:quick` | Run the fast single-task eval |
| `npm run eval:lumen` | Eval Lumen adapter only (no Stagehand baseline) |

---

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for an in-depth breakdown of every layer.

See [docs/HAPPY_PATH.md](docs/HAPPY_PATH.md) for annotated walkthroughs of common usage patterns.

---

## Troubleshooting

### Chrome fails to launch

```
Error: Chrome process exited
```

1. Verify Chrome is installed: `google-chrome --version` or `chromium --version`
2. On Linux CI, add `--no-sandbox`: use `browser: { type: "cdp", url: "..." }` and launch Chrome with `--no-sandbox --disable-setuid-sandbox` yourself.
3. Try a non-default port if 9222 is occupied: `browser: { type: "local", port: 9333 }`.

### API key not found

Each provider reads a default env var when `apiKey` is omitted:

| Provider | Env var |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Google | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |

### Loop hits `maxSteps` without finishing

Increase `maxSteps` for complex tasks. Consider adding a `systemPrompt` that focuses the model on efficient execution. For debugging, set `verbose: 2` to see every action.

### `BROWSER_DISCONNECTED` error

The CDP connection dropped (browser crashed or was closed externally). This is the only error type that throws out of the loop — all other action errors are fed back to the model. Restart the agent.

### Types not resolving

This package is ESM-only with `"type": "module"`. Ensure your `tsconfig.json` has `"moduleResolution": "bundler"` or `"node16"/"nodenext"`, and that you import with the `.js` extension in TypeScript source files.

---

## License

MIT
