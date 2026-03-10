# API Options

## AgentOptions

```typescript
interface AgentOptions {
  // ── Core ────────────────────────────────────────────────────────────
  model: string;                     // "provider/model-id", e.g. "anthropic/claude-sonnet-4-6"
  browser: BrowserOptions;
  apiKey?: string;                   // falls back to env: ANTHROPIC_API_KEY, GOOGLE_API_KEY, etc.
  baseURL?: string;                  // for CustomAdapter (OpenAI-compatible endpoints)
  maxSteps?: number;                 // default: 30
  systemPrompt?: string;             // prepended to the model context every step
  plannerModel?: string;             // cheap model for pre-loop planning pass

  // ── Model Tuning ────────────────────────────────────────────────────
  thinkingBudget?: number;           // Anthropic extended thinking token budget. default: 0 (disabled)
  compactionThreshold?: number;      // 0–1. Trigger LLM summarization at this context utilization. default: 0.8
  compactionModel?: string;          // override model used for compaction (defaults to main model)
  keepRecentScreenshots?: number;    // screenshots kept in wire history after compaction. default: 2

  // ── v2 Features ─────────────────────────────────────────────────────
  confidenceGate?: boolean;          // CATTS-inspired multi-sample on hard steps
  actionVerifier?: boolean;          // heuristic post-action checks via CDP (click target, focus)
  checkpointInterval?: number;       // browser state checkpoint every N steps for backtracking. default: 5
  siteKB?: string | SiteRule[];      // path to site KB JSON, or inline rules array
  workflowMemory?: string;           // path to workflow memory JSON for reusable patterns

  // ── Display & Debug ─────────────────────────────────────────────────
  autoAlignViewport?: boolean;       // resize viewport to model's preferred size. default: true
  cursorOverlay?: boolean;           // composite a cursor dot at last click position. default: true
  verbose?: 0 | 1 | 2;              // 0=silent, 1=minimal, 2=full. default: 1
  logger?: (line: LogLine) => void;  // structured log callback, called alongside ConsoleMonitor

  // ── Safety & Hooks ──────────────────────────────────────────────────
  monitor?: LoopMonitor;             // observability hook called at each step
  policy?: SessionPolicyOptions;     // domain allowlist/blocklist, action filter
  preActionHook?: PreActionHook;     // imperative deny hook fired before every action
  verifier?: Verifier;               // completion gate — verify terminate before accepting

  // ── Timing ──────────────────────────────────────────────────────────
  timing?: { afterClick?: number; afterType?: number; afterScroll?: number; afterNavigation?: number };

  // ── Persistence ─────────────────────────────────────────────────────
  cacheDir?: string;                 // action cache directory for replaying known-good actions
  initialHistory?: SerializedHistory;// resume with pre-loaded history (prefer Agent.resume())
  initialState?: TaskState;          // resume with pre-loaded structured state
}
```

### v2 Feature Details

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `confidenceGate` | `boolean` | `false` | When enabled, the agent samples multiple model responses on steps where confidence is low (inspired by the [CATTS](https://arxiv.org/abs/2503.00069) paper). Picks the most consistent action. |
| `actionVerifier` | `boolean` | `false` | Runs CDP-based heuristic checks after each action — e.g., verifying a click landed on the expected element, or that an input received focus after typing. |
| `checkpointInterval` | `number` | `5` | Saves a browser state snapshot every N steps. When the repeat detector reaches level 8+ (deep stall), the agent backtracks to the last checkpoint. |
| `siteKB` | `string \| SiteRule[]` | — | Domain-specific navigation tips injected into the model context. Pass a path to a JSON file or an inline array of `{ domain, rules }` objects. See `default-site-kb.json` for examples. |
| `workflowMemory` | `string` | — | Path to a JSON file of reusable workflows extracted from past successful runs. Matching workflows are injected as hints into the model context. |

## BrowserOptions

```typescript
type BrowserOptions =
  | { type: "local"; port?: number; headless?: boolean; userDataDir?: string }
  | { type: "cdp"; url: string }
  | { type: "browserbase"; apiKey: string; projectId: string; sessionId?: string };
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

## Action Types

```typescript
type Action =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle" }
  | { type: "doubleClick"; x: number; y: number }
  | { type: "drag"; startX: number; startY: number; endX: number; endY: number }
  | { type: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount: number }
  | { type: "type"; text: string }
  | { type: "keyPress"; keys: string[] }
  | { type: "wait"; ms: number }
  | { type: "goto"; url: string }
  | { type: "writeState"; data: TaskState }
  | { type: "screenshot" }
  | { type: "terminate"; status: "success" | "failure"; result: string }
  | { type: "hover"; x: number; y: number }
  | { type: "delegate"; instruction: string; maxSteps?: number }
  | { type: "fold"; summary: string };
```

## Debug Logging

```bash
LUMEN_LOG=debug npm start              # all surfaces
LUMEN_LOG_ACTIONS=1 npm start          # just action dispatch
LUMEN_LOG_CDP=1 npm start              # CDP wire traffic
LUMEN_LOG_LOOP=1 npm start             # perception loop internals
```

Surfaces: `LUMEN_LOG_CDP`, `LUMEN_LOG_ACTIONS`, `LUMEN_LOG_BROWSER`, `LUMEN_LOG_HISTORY`, `LUMEN_LOG_ADAPTER`, `LUMEN_LOG_LOOP`.

## Eval

Run [WebVoyager](https://github.com/MinorJerry/WebVoyager) evals:

```bash
npm run eval              # 25 tasks (default)
npm run eval -- 5         # 5 tasks
npm run eval -- 25 stagehand    # compare with stagehand
npm run eval -- 25 browser-use  # compare with browser-use
```
