# @omxyz/lumen

[![npm version](https://img.shields.io/npm/v/@omxyz/lumen)](https://www.npmjs.com/package/@omxyz/lumen)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A vision-first browser agent with self-healing deterministic replay.

## WebVoyager Benchmark (preliminary)

Subset of 25 tasks from [WebVoyager](https://github.com/MinorJerry/WebVoyager), stratified across 15 sites. Scored by LLM-as-judge (Gemini 2.5 Flash), 3 trials per task. Lumen runs with SiteKB (domain-specific navigation tips) and ModelVerifier (termination gate) enabled.

| Metric | Lumen | browser-use | Stagehand |
|--------|-------|-------------|-----------|
| **Success Rate** | **25/25 (100%)** | **25/25 (100%)** | 19/25 (76%) |
| **Avg Steps (all)** | 14.4 | 8.8 | 23.1 |
| **Avg Steps (passed)** | 14.4 | 8.8 | 15.7 |
| **Avg Time (all)** | **77.8s** | 109.8s | 207.8s |
| **Avg Time (passed)** | **77.8s** | 136.0s | 136.0s |
| **Avg Tokens** | 104K | N/A | 200K |

All frameworks use Claude Sonnet 4.6 as the agent model.

```typescript
import { Agent } from "@omxyz/lumen";

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
npm install @omxyz/lumen
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
import { Agent, UrlMatchesGate, ModelVerifier, AnthropicAdapter } from "@omxyz/lumen";

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

Run [WebVoyager](https://github.com/MinorJerry/WebVoyager) evals yourself:

```bash
npm run eval              # 25 tasks, lumen (default)
npm run eval -- 5         # 5 tasks
npm run eval -- 25 stagehand    # compare with stagehand
npm run eval -- 25 browser-use  # compare with browser-use
```

## Testing

```bash
npm test              # 140 tests, ~3.5s
npm run test:watch
npm run typecheck
```

## Architecture

The core is a **perception loop** — screenshot, think, act, repeat — running over CDP:

```
                    ┌──────────────────────────────────────┐
                    │           PerceptionLoop              │
                    │                                      │
 ┌────────┐   ┌────┴─────┐   ┌───────────┐   ┌─────────┐ │
 │ Chrome ├──▶│Screenshot├──▶│  History   ├──▶│  Build  │ │
 │ (CDP)  │   └──────────┘   │  Manager   │   │ Context │ │
 │        │                  │            │   │         │ │
 │        │                  │ tier-1:    │   │ + state │ │
 │        │                  │  compress  │   │ + KB    │ │
 │        │                  │ tier-2:    │   │ + nudge │ │
 │        │                  │  summarize │   └────┬────┘ │
 │        │                  └────────────┘        │      │
 │        │                                        ▼      │
 │        │   ┌──────────┐   ┌────────────────────────┐   │
 │        │   │  Action   │   │    Model Adapter       │   │
 │        │◀──┤  Router   │◀──┤  (stream actions)      │   │
 │        │   │          │   │                        │   │
 │        │   │ click    │   │  Anthropic / Google /  │   │
 │        │   │ type     │   │  OpenAI / Custom       │   │
 │        │   │ scroll   │   └────────────────────────┘   │
 │        │   │ goto     │                                │
 │        │   └────┬─────┘                                │
 │        │        │                                      │
 │        │        ▼                                      │
 │        │   ┌──────────────────┐                        │
 │        │   │  Post-Action     │                        │
 │        │   │                  │                        │
 │        │   │ ActionVerifier   │◀─ heuristic checks     │
 │        │   │ RepeatDetector   │◀─ 3-layer stuck detect │
 │        │   │ Checkpoint       │◀─ save for backtrack   │
 │        │   └────────┬─────────┘                        │
 │        │            │                                  │
 │        │            ▼                                  │
 │        │   ┌──────────────────┐                        │
 │        │   │  task_complete?  │                        │
 │        │   │                  │     ┌──────────┐       │
 │        │   │  yes ──────────────▶│ Verifier │       │
 │        │   │                  │     │  (gate)  │       │
 │        │   │                  │     └────┬─────┘       │
 │        │   └──────────────────┘          │             │
 └────────┘                          pass ──▶ done        │
                                     fail ──▶ continue    │
                    └──────────────────────────────────────┘
```

**Step by step:**

1. **Screenshot** — capture the browser viewport via CDP
2. **History** — append to wire history; if context exceeds threshold, compress (tier-1: drop old screenshots, tier-2: LLM summarization)
3. **Context** — assemble system prompt with persistent state, site-specific tips (SiteKB), stuck nudges, and workflow hints
4. **Model** — stream actions from the model (supports Anthropic, Google, OpenAI, or any OpenAI-compatible endpoint)
5. **Execute** — ActionRouter dispatches each action to Chrome via CDP (click, type, scroll, goto, etc.)
6. **Verify action** — ActionVerifier runs heuristic post-checks (did the click land? is an input focused after type?)
7. **Detect loops** — RepeatDetector checks 3 layers: exact action repeats, category dominance, URL stall. Escalating nudges guide the model out
8. **Checkpoint** — periodically save browser state; backtrack on deep stalls (level 8+)
9. **Termination gate** — when the model calls `task_complete`, the Verifier (ModelVerifier or custom) checks the screenshot to confirm. Rejected? Loop continues. Passed? Return result.

See [docs/architecture/overview.md](docs/architecture/overview.md) for the full breakdown.

See [docs/guide/happy-path.md](docs/guide/happy-path.md) for annotated usage walkthroughs.

See [docs/architecture/comparison.md](docs/architecture/comparison.md) for a technical comparison with other browser agent frameworks.

## Troubleshooting

**Chrome fails to launch** — verify Chrome is installed (`google-chrome --version`). On Linux CI, launch Chrome with `--no-sandbox` yourself and use `browser: { type: "cdp", url: "ws://..." }`.

**API key not found** — falls back to env vars: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENAI_API_KEY`.

**Loop hits maxSteps** — increase `maxSteps`, add a focused `systemPrompt`, or use `verbose: 2` to debug.

**BROWSER_DISCONNECTED** — the CDP socket closed unexpectedly. This is the only error that throws; all action errors are fed back to the model.

**ESM import errors** — this package is ESM-only. Use `"moduleResolution": "bundler"` or `"nodenext"` in `tsconfig.json`.

## References

Research papers and projects that influenced Lumen's design.

| Paper | Impact on Lumen |
|-------|-----------------|
| **Surfer 2** — WebVoyager SOTA (97.1%) | `StateStore` + `Verifier` + `plannerModel` — persistent context, completion gate, orchestrator planning |
| **Magnitude** — WebVoyager (93.9%) | `ActionCache` + prompt caching + tier-1 screenshot compression |
| **CATTS** — Confidence-Aware Test-Time Scaling (2026) | `ConfidenceGate` — multi-sample on hard steps, skip extra compute on easy ones |
| **BacktrackAgent** — Error Detection + Backtracking (EMNLP 2025) | `ActionVerifier` — heuristic post-action checks |
| **Tree Search with Browser Snapshots** (ICLR 2025, CMU) | `CheckpointManager` — save CDP state, backtrack on deep stalls |
| **ColorBrowserAgent** — Adaptive Knowledge Base (2026) | `SiteKB` — domain-specific navigation rules |
| **Agent Workflow Memory** (ICML 2025) [arXiv 2409.07429](https://arxiv.org/abs/2409.07429) | `WorkflowMemory` — reusable routines from successful runs |
| **AgentFold** — Proactive Context Folding (Alibaba 2025) [arXiv 2510.24699](https://arxiv.org/abs/2510.24699) | `fold` action — agent-controlled context compression |
| **OpenCUA** — Three-Level Reasoning (COLM 2025) [arXiv 2508.09123](https://arxiv.org/abs/2508.09123) | Structured reasoning prompts — THINK FIRST, CHECKPOINT PROGRESS |
| **TTI** — Test-Time Interaction Scaling (NeurIPS 2025) | Action-biased prompts — favor exploration over long reasoning |
| **Reflexion** (NeurIPS 2023) [arXiv 2303.11366](https://arxiv.org/abs/2303.11366) | Retry with judge feedback — structured reflection on retry attempts |
| **Agent Q** — Best-of-N Sampling (ICLR 2025) [arXiv 2408.07199](https://arxiv.org/abs/2408.07199) | Confidence gate design — scoring vs agreement voting tradeoffs |
| **SeeAct** — Vision+DOM Grounding (ICML 2024) [arXiv 2401.01614](https://arxiv.org/abs/2401.01614) | Validated vision-first design — pure vision grounding as main bottleneck |
| **Agent-E** — Hierarchical Planner-Executor (2024) [arXiv 2407.13032](https://arxiv.org/abs/2407.13032) | `delegate` action — hand off sub-tasks to a child loop |
| **DigiRL** — VLM-Based Progress Evaluation (NeurIPS 2024) [arXiv 2406.11896](https://arxiv.org/abs/2406.11896) | `RepeatDetector` design — progress evaluation beyond pattern matching |

See [docs/reference/references.md](docs/reference/references.md) for full details on each reference.

## License

MIT
