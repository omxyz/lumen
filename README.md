# @omlabs/lumen

Vision-first browser agent for Node.js. Give it a task in plain English; it drives a real browser using screenshots and model-emitted actions to get it done.

```typescript
import { Agent } from "@omlabs/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Go to news.ycombinator.com and tell me the title of the top story.",
});

console.log(result.result);
```

## Features

- **Vision-only loop** — screenshot → model → action(s) → screenshot. No DOM scraping, no selectors.
- **Multi-provider** — Anthropic, Google, OpenAI, and any OpenAI-compatible endpoint.
- **History compression** — tier-1 screenshot compression + tier-2 LLM summarization at 80% context utilization.
- **Unified coordinates** — `ActionDecoder` normalizes all provider formats to viewport pixels at decode time.
- **Persistent memory** — `writeState` persists structured JSON that survives history compaction.
- **Streaming** — `agent.stream()` yields typed `StreamEvent` objects for real-time UI.
- **Session resumption** — serialize to JSON, restore later with `Agent.resume()`.
- **Safety** — `SessionPolicy` (domain allowlist/blocklist), `PreActionHook` (imperative deny), `Verifier` (completion gate).
- **Repeat detection** — three-layer stuck detection with escalating nudges.
- **Action caching** — on-disk cache for replaying known-good actions.
- **Child delegation** — the model can hand off sub-tasks to a fresh loop via `delegate`.

## Install

```bash
npm install @omlabs/lumen
```

Requires Node.js ≥ 20.19 and Chrome/Chromium for local browser mode.

## Usage

### One-shot

```typescript
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local", headless: true },
  instruction: "Find the price of the top result for 'mechanical keyboard' on Amazon.",
  maxSteps: 15,
});
```

### Multi-run session

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
});

await agent.run({ instruction: "Navigate to github.com" });
await agent.run({ instruction: "Search for the 'react' repository." });
await agent.close();
```

### Streaming

```typescript
for await (const event of agent.stream({ instruction: "Find the current Bitcoin price." })) {
  switch (event.type) {
    case "step_start":
      console.log(`Step ${event.step}/${event.maxSteps} — ${event.url}`);
      break;
    case "action":
      console.log(`  ${event.action.type}`);
      break;
    case "done":
      console.log(event.result.result);
      break;
  }
}
```

### Pre-navigate with startUrl

Save 1-2 model steps by going to the target page before the first screenshot:

```typescript
await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Find the cheapest flight from JFK to LAX next Friday.",
  startUrl: "https://www.google.com/travel/flights",
});
```

## Models

Pass `"provider/model-id"`:

```typescript
model: "anthropic/claude-sonnet-4-6"     // recommended
model: "anthropic/claude-opus-4-6"       // most capable
model: "google/gemini-2.5-pro"
model: "openai/computer-use-preview"
```

Any unrecognized prefix falls through to `CustomAdapter` (OpenAI-compatible chat completions):

```typescript
{ model: "llama3.2-vision", baseURL: "http://localhost:11434/v1", apiKey: "ollama" }
```

Extended thinking (Anthropic):

```typescript
{ model: "anthropic/claude-opus-4-6", thinkingBudget: 8000 }
```

## Browser Options

```typescript
// Local Chrome (default)
browser: { type: "local", headless: true, port: 9222 }

// Existing CDP endpoint
browser: { type: "cdp", url: "ws://localhost:9222/devtools/browser/..." }

// Browserbase (cloud — no local Chrome needed)
browser: {
  type: "browserbase",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
}
```

## Safety

### SessionPolicy

```typescript
policy: {
  allowedDomains: ["*.mycompany.com"],
  blockedDomains: ["facebook.com"],
  allowedActions: ["click", "type", "scroll", "goto", "terminate"],
}
```

### PreActionHook

```typescript
preActionHook: async (action) => {
  if (action.type === "goto" && action.url.includes("checkout")) {
    return { decision: "deny", reason: "checkout not permitted" };
  }
  return { decision: "allow" };
}
```

### Verifier

Verify the task is actually done before accepting `terminate`:

```typescript
import { Agent, UrlMatchesGate, ModelVerifier, AnthropicAdapter } from "@omlabs/lumen";

// URL pattern match
verifier: new UrlMatchesGate(/\/confirmation\?order=\d+/)

// Model-based verification
verifier: new ModelVerifier(
  new AnthropicAdapter("claude-haiku-4-5-20251001"),
  "Complete the checkout flow",
)
```

## Session Resumption

```typescript
// Save
const snapshot = await agent.serialize();
fs.writeFileSync("session.json", JSON.stringify(snapshot));

// Restore
const data = JSON.parse(fs.readFileSync("session.json", "utf8"));
const agent2 = Agent.resume(data, { model: "anthropic/claude-sonnet-4-6", browser: { type: "local" } });
```

## Options

```typescript
interface AgentOptions {
  model: string;
  browser: BrowserOptions;
  apiKey?: string;
  baseURL?: string;
  maxSteps?: number;                 // default: 30
  systemPrompt?: string;
  plannerModel?: string;             // cheap model for pre-loop planning
  thinkingBudget?: number;           // Anthropic extended thinking. default: 0
  compactionThreshold?: number;      // 0–1. default: 0.8
  compactionModel?: string;
  keepRecentScreenshots?: number;    // default: 2
  autoAlignViewport?: boolean;       // default: true
  cursorOverlay?: boolean;           // default: true
  verbose?: 0 | 1 | 2;              // default: 1
  logger?: (line: LogLine) => void;
  monitor?: LoopMonitor;
  policy?: SessionPolicyOptions;
  preActionHook?: PreActionHook;
  verifier?: Verifier;
  timing?: { afterClick?: number; afterType?: number; afterScroll?: number; afterNavigation?: number };
  cacheDir?: string;                 // action cache directory
  initialHistory?: SerializedHistory;
  initialState?: TaskState;
}
```

## Event Reference

| Event | Key fields |
|---|---|
| `step_start` | `step`, `maxSteps`, `url` |
| `screenshot` | `step`, `imageBase64` |
| `thinking` | `step`, `text` |
| `action` | `step`, `action: Action` |
| `action_result` | `step`, `ok`, `error?` |
| `action_blocked` | `step`, `reason` |
| `state_written` | `step`, `data: TaskState` |
| `compaction` | `step`, `tokensBefore`, `tokensAfter` |
| `termination_rejected` | `step`, `reason` |
| `done` | `result: RunResult` |

## Debug Logging

```bash
LUMEN_LOG=debug npm start              # all surfaces
LUMEN_LOG_ACTIONS=1 npm start          # just action dispatch
LUMEN_LOG_CDP=1 npm start              # CDP wire traffic
LUMEN_LOG_LOOP=1 npm start             # perception loop internals
```

Surfaces: `LUMEN_LOG_CDP`, `LUMEN_LOG_ACTIONS`, `LUMEN_LOG_BROWSER`, `LUMEN_LOG_HISTORY`, `LUMEN_LOG_ADAPTER`, `LUMEN_LOG_LOOP`.

## Eval

Abbreviated [WebVoyager](https://github.com/MinorJerry/WebVoyager) benchmark (25 tasks, `claude-sonnet-4-6`):

| Metric | Score |
|---|---|
| **Pass rate** | **96.0% (24/25)** |
| Avg steps per task | 12.3 |
| Avg tokens per task | 84K |
| Avg time per task | 86.9s |
| Token reduction (vs baseline) | 32.1% |

Per-task breakdown:

| Task | Steps | Token reduction |
|---|---|---|
| wikipedia_shannon | 4 | 5.6% |
| github_react_version | 3 | ~0% |
| hacker_news_top | 1 | 0% |
| allrecipes_wellington | 14 | 39.7% |

Token savings scale with task length — long tasks (20+ steps) routinely exceed 40% reduction.

Run evals yourself:

```bash
ANTHROPIC_API_KEY=sk-... npx tsx evals/webvoyager/run.ts
```

## Testing

```bash
npm test              # 140 tests, ~3.5s
npm run test:watch
npm run typecheck
```

## Architecture

```
Agent → Session → PerceptionLoop
  ├── HistoryManager (wire + semantic, 2-tier compression)
  ├── ActionRouter (pixel dispatch + timing)
  ├── ModelAdapter (stream/step/summarize)
  ├── StateStore (writeState memory)
  ├── RepeatDetector (3-layer stuck detection)
  ├── Verifier (completion verification)
  └── ActionCache (on-disk replay)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full breakdown.

See [docs/HAPPY_PATH.md](docs/HAPPY_PATH.md) for annotated usage walkthroughs.

See [docs/COMPARISON.md](docs/COMPARISON.md) for a technical comparison with other browser agent frameworks.

## Troubleshooting

**Chrome fails to launch** — verify Chrome is installed (`google-chrome --version`). On Linux CI, launch Chrome with `--no-sandbox` yourself and use `browser: { type: "cdp", url: "ws://..." }`.

**API key not found** — falls back to env vars: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENAI_API_KEY`.

**Loop hits maxSteps** — increase `maxSteps`, add a focused `systemPrompt`, or use `verbose: 2` to debug.

**BROWSER_DISCONNECTED** — the CDP socket closed unexpectedly. This is the only error that throws; all action errors are fed back to the model.

**ESM import errors** — this package is ESM-only. Use `"moduleResolution": "bundler"` or `"nodenext"` in `tsconfig.json`.

## License

MIT
