# Lumen vs Alternatives

A technical comparison of Lumen against other browser agent frameworks. All frameworks were analyzed from source code in this repository.

## At a Glance

| | **Lumen** | **Stagehand** | **browser-use** | **Skyvern** | **Magnitude** |
|---|---|---|---|---|---|
| Language | TypeScript | TypeScript | Python | Python | TypeScript |
| Approach | Vision-only | Hybrid (DOM + Vision + A11y) | Hybrid (DOM-first + Vision) | Vision + Playwright | Vision-only |
| Browser | CDP (raw WebSocket) | CDP + Playwright/Puppeteer | CDP (`cdp-use`) | Playwright | CDP |
| LLM Providers | Anthropic, Google, OpenAI, Custom | 15+ via `@ai-sdk/*` | 10+ (OpenAI, Anthropic, Google, Groq, Ollama...) | OpenAI, Anthropic, Google, Bedrock | Anthropic, Google |
| Context Mgmt | Dual history + 2-tier compaction | Agent cache + conversation replay | Message compaction (summarization) | Workflow-level | Screenshot compression |
| Stall Detection | 3-layer repeat detector + escalating nudges | Cache-based self-healing | Rolling window (20 actions) + page stagnation hash | Workflow retries | None documented |
| Session Resume | Full serialize/deserialize (wire + semantic + state) | Conversation messages + cache replay | Browser profile + storage state | Workflow persistence | None documented |
| Safety | Policy + PreActionHook + Verifier gates | None built-in | Domain whitelist watchdog | Auth + domain control | None documented |
| Codebase Size | ~5K LOC | ~17K LOC (published) | ~68K LOC | ~50K+ LOC | ~3K LOC (core) |
| Key Dependency | `sharp`, `ws`, provider SDKs | `@ai-sdk/*`, `pino`, `zod` | `cdp-use`, `bubus`, `pydantic`, `Pillow` | `playwright`, `pydantic` | Provider SDKs |

---

## Page Understanding

The most fundamental architectural difference between these frameworks is how they understand web pages.

### Lumen: Vision-Only

Lumen sends only screenshots to the model. No DOM parsing, no accessibility tree, no selectors.

**Advantages:**
- Simplest implementation — no brittle DOM extraction logic
- Works identically across all page types (SPAs, canvas, iframes, shadow DOM)
- No risk of stale DOM snapshots
- Model sees exactly what a human would see

**Tradeoffs:**
- Requires strong vision models (Claude Sonnet 4+, Gemini 2.0+)
- Cannot leverage structural hints (element indices, ARIA labels) for disambiguation
- Higher per-step token cost from screenshot encoding (~40-100KB base64 each)

### Stagehand: Hybrid (DOM + Vision + Accessibility)

Stagehand supports three modes: DOM-only, hybrid (vision + DOM), and CUA (computer-use). The DOM mode builds an accessibility tree via the browser's ARIA API, giving the model structured element information alongside optional screenshots.

**Advantages:**
- Works with cheaper, non-vision models in DOM mode
- Accessibility tree provides semantic structure that helps with ambiguous elements
- Self-healing cache: if a selector breaks, re-discovers the element and replays
- `act()` / `extract()` / `observe()` API is intuitive for common tasks

**Tradeoffs:**
- DOM extraction adds complexity and latency
- Accessibility tree can miss dynamically-generated or heavily-obfuscated content
- Three separate code paths (DOM / hybrid / CUA) increase maintenance surface
- Cannot switch modes mid-execution

### browser-use: Hybrid (DOM-first + Vision fallback)

browser-use parses the DOM into indexed interactive elements (`[1] <button>Click me</button>`), with optional screenshots for vision models.

**Advantages:**
- DOM indices give the model precise element targeting
- Paint-order filtering removes occluded elements
- Vision is optional — can run with text-only models
- Fine-tuned `ChatBrowserUse` model optimized for the DOM format (3-5x speedup claimed)

**Tradeoffs:**
- DOM indices shift when page content changes (stale index problem)
- DOM serialization is expensive on large pages
- Python-only ecosystem

### Skyvern: Vision + Playwright

Skyvern uses Playwright for browser control with AI-powered commands (`page.act()`, `page.extract()`, `page.validate()`).

**Advantages:**
- Cross-browser support (Chrome, Firefox, WebKit) via Playwright
- Built-in workflow engine with loops, conditionals, and integrations
- Authentication support (Bitwarden, 2FA/TOTP)
- No-code workflow builder UI

**Tradeoffs:**
- Playwright dependency is heavier than raw CDP
- Tightly coupled to cloud service for advanced features

---

## History & Context Management

Long-running tasks (20+ steps) inevitably exhaust the model's context window. How each framework handles this determines how well it scales.

### Lumen: Dual History + 2-Tier Compaction

Lumen maintains two parallel histories:

1. **Wire history** — fed to the model. Compressed aggressively via:
   - **Tier-1**: Screenshot base64 nulled out (keeps last N frames, default 2)
   - **Tier-2**: At 80% context utilization, LLM summarizes the entire history into a single block
2. **Semantic history** — never compressed. Full screenshots, actions, outcomes, tokens, timing. Used for debugging and audit.

**TaskState** (`writeState` action) persists structured JSON that survives compaction — re-injected every step.

Token savings are quadratic in task length: short tasks see ~5% reduction, long tasks (20+ steps) routinely exceed 40%.

### Stagehand: Cache + Conversation Replay

Stagehand stores `AgentReplayStep[]` sequences that can replay without LLM calls on subsequent runs. For ongoing sessions, conversation messages (`ModelMessage[]`) carry the full conversation forward.

No automatic context compression — relies on the underlying model's context window (Gemini's 1M tokens helps).

### browser-use: Message Compaction

Triggered when history exceeds ~40K chars. Uses a cheaper LLM to summarize old steps into memory blocks, keeping the last 6 items verbatim. Configurable trigger thresholds.

Closest to Lumen's approach, but:
- Single-tier (no separate screenshot compression)
- No immutable audit trail (compacted history is the only history)
- Agent state tracked via `memory` field in the agent state machine, not a separate persistent store

### Skyvern: Workflow-Level

Skyvern manages state at the workflow level rather than the individual agent step level. Each task in a workflow runs semi-independently.

---

## Stall & Loop Detection

A critical reliability feature: what happens when the model gets stuck repeating the same action?

### Lumen: 3-Layer RepeatDetector

Three detection layers with escalating nudges:

| Layer | What it detects | Mechanism |
|---|---|---|
| **Action-level** | Same click/scroll repeated | SHA-256 hash of normalized action (64px coordinate bucketing) in rolling 20-action window |
| **Category-level** | Scroll/noop patterns interleaving | Classifies actions as productive/passive/noop; triggers when non-productive category dominates |
| **URL-level** | Stuck on same page too long | Tracks steps per URL (normalized to origin+pathname to ignore tracking params) |

Nudges are injected into the system prompt and escalate:
- Level 5: "Try something different"
- Level 8: "WARNING: Save progress, try keyboard navigation"
- Level 12: "CRITICAL STRATEGY RESET: Change approach NOW"

Nudges are sticky — they persist until the model takes a productive action (for action nudges) or navigates away (for URL nudges).

### Stagehand: Cache-Based Self-Healing

If a cached action sequence fails (e.g., selector changed), Stagehand re-invokes the AI to discover the new selector. Not a loop detector per se, but prevents one class of stuck behavior.

No explicit mechanism for detecting repeated model-generated actions in non-cached execution.

### browser-use: Rolling Window Detection

Similar to Lumen's action-level detection: SHA-256 hashes in a rolling window (default 20 actions) with page stagnation tracking (URL + element count + text hash). Nudges at 5, 8, 12 repetitions.

Also includes a `DefaultActionWatchdog` that automatically scrolls before retrying a failed action.

### Skyvern: Workflow Retries

Task-level retries with configurable retry counts. No step-level stall detection within a task.

---

## Action Execution Model

### Lumen: Streaming Mid-Stream Execution

Actions are executed as soon as each tool call block completes in the model's response stream. This reduces latency compared to waiting for the full response.

Buffered outcomes are replayed into wire history after the assistant turn is committed, maintaining correct message format. Post-action delays are configurable (click: 200ms, type: 500ms, scroll: 300ms, navigation: 1000ms).

**Form state extraction**: After form-related actions, Lumen evaluates a CDP script to extract visible input values and feeds them back to the model as a nudge. This helps the model verify that form inputs were actually set correctly.

### Stagehand: Tool-Calling Loop

Standard tool-calling pattern via the `ai` SDK's `generateText()`. 17 tools available, including DOM-specific ones (`act`, `fillForm`, `extract`).

Two execution styles:
- High-level: `stagehand.act("click the login button")` — LLM figures out the selector
- Deterministic: `stagehand.act({ selector: "#btn", method: "click" })` — no LLM needed

### browser-use: Registry-Based

Actions are registered in a tool registry with event emission. 18 core actions including file operations (`upload_file`, `save_as_pdf`) and tab management (`switch_tab`, `close_tab`).

14 watchdog services coordinate via an event bus for error handling, CAPTCHA detection, crash recovery, etc.

### Skyvern: Playwright Actions

Wraps Playwright's action methods with AI-powered element targeting. Supports standard Playwright actions plus AI-specific ones (`act`, `extract`, `validate`).

---

## Safety & Policy

### Lumen

Three layers of safety, composable:

1. **SessionPolicy** — declarative allow/blocklist for domains (glob patterns) and action types
2. **PreActionHook** — async callback before every action, can deny with reason
3. **Verifier gates** — `UrlMatchesGate`, `CustomGate`, `ModelVerifier` verify task completion before accepting `terminate`

Blocked actions are fed back to the model as errors — the loop continues.

### Stagehand

No built-in safety layer. Domain restrictions and action filtering must be implemented in application code.

### browser-use

`SecurityWatchdog` enforces a domain whitelist. Sensitive data detection with regex-based redaction.

### Skyvern

Authentication support (Bitwarden, TOTP). Domain control via workflow configuration.

---

## Multi-Provider Support

| Provider | Lumen | Stagehand | browser-use | Skyvern |
|---|---|---|---|---|
| Anthropic (Claude) | Native CUA | Via `@ai-sdk` | `ChatAnthropic` | Direct |
| Google (Gemini) | Native CUA | Via `@ai-sdk` | `ChatGoogle` | Direct |
| OpenAI | Native CUA | Via `@ai-sdk` | `ChatOpenAI` | Direct |
| Groq | Via Custom | Via `@ai-sdk` | `ChatGroq` | No |
| Ollama | Via Custom | Via `@ai-sdk` | `ChatOllama` | Via OpenRouter |
| Custom/OpenAI-compat | `CustomAdapter` | Via `@ai-sdk` | Multiple | Via OpenRouter |
| Azure | Via Custom | Via `@ai-sdk` | Yes | Direct |
| AWS Bedrock | No | Via `@ai-sdk` | No | Direct |
| **Total** | **4 native + custom** | **15+** | **10+** | **8+** |

Lumen focuses on deep integration with 4 providers (native computer-use protocol for each) plus a custom fallback. Stagehand and browser-use cast a wider net with more provider adapters.

---

## Browser Integration

| | Lumen | Stagehand | browser-use | Skyvern |
|---|---|---|---|---|
| Protocol | Raw CDP WebSocket | CDP + Playwright/Puppeteer | CDP (`cdp-use`) | Playwright |
| Local Chrome | `chrome-launcher` | `chrome-launcher` / Patchright | `chrome-launcher` | Playwright chromium |
| Cloud Browser | Browserbase | Browserbase | Browser Use Cloud | Cloud offering |
| Cross-browser | Chrome only | Chrome (+ Firefox/WebKit via Playwright) | Chrome only | Chrome, Firefox, WebKit |
| Viewport Alignment | Auto-align to model patch size | No | No | No |
| Stealth/Anti-detect | No | No | Cloud mode only | Cloud mode |

Lumen's viewport alignment is unique: it snaps the viewport to the model's optimal patch size (e.g., multiples of 28px for Anthropic) to minimize rounding error in coordinate outputs.

---

## Observability

### Lumen

- **LumenLogger**: 6 surface-specific debug channels (`LUMEN_LOG_CDP`, `LUMEN_LOG_ACTIONS`, `LUMEN_LOG_BROWSER`, `LUMEN_LOG_HISTORY`, `LUMEN_LOG_ADAPTER`, `LUMEN_LOG_LOOP`)
- **LoopMonitor**: Event callbacks for step/action/compaction lifecycle
- **StreamingMonitor**: Typed `StreamEvent` async iterable for real-time UIs
- **Semantic history**: Immutable audit trail with full screenshots, always available regardless of compaction

### Stagehand

- `pino` structured logging
- `stagehandMetrics` token tracking
- Event emitter for screenshots during execution

### browser-use

- `rich` terminal formatting
- Watchdog event bus (14+ event types)
- PostHog telemetry (opt-in)
- HAR recording for network debugging

### Skyvern

- Livestreaming browser viewport to local machine
- Workflow execution logs
- Video/screen recording

---

## Session Resumption

| | Lumen | Stagehand | browser-use | Skyvern |
|---|---|---|---|---|
| Serialize to JSON | Full roundtrip (wire + semantic + state + model ID) | Partial (conversation messages) | No | Workflow state |
| Cross-process resume | `Agent.resume(snapshot, opts)` | Via `resumeSessionId` | Browser profile reuse | Workflow continuation |
| What survives | History, agent state, model context | Cache entries, Browserbase session | Cookies, localStorage | Workflow variables |
| What doesn't | Browser state (must reconnect) | In-memory state | In-memory agent state | Browser state |

Lumen's serialization is the most complete — it captures both the compressed wire history (what the model sees) and the full semantic history (what you can audit), plus any structured state written by the model.

---

## API Design

### Lumen: Facade + Session

```typescript
// High-level (recommended)
const result = await Agent.run({ model: "anthropic/claude-sonnet-4-6", browser: { type: "local" }, instruction: "..." });

// Multi-run
const agent = new Agent({ model: "...", browser: { type: "local" } });
await agent.run({ instruction: "Step 1" });
await agent.run({ instruction: "Step 2" });

// Streaming
for await (const event of agent.stream({ instruction: "..." })) { ... }

// Low-level
const session = new Session({ tab, adapter, maxSteps: 20 });
const result = await session.run({ instruction: "..." });
```

### Stagehand: Method-per-action

```typescript
const stagehand = new Stagehand(options);
await stagehand.init();
await stagehand.act("click the login button");
const data = await stagehand.extract("get the product name", schema);
const elements = await stagehand.observe("find all links");
```

### browser-use: Task-based

```python
agent = Agent(task="Find the weather", llm=ChatAnthropic(...), browser=browser)
result = await agent.run(max_steps=500)
```

### Skyvern: Command-based

```python
await page.act("Click the login button")
data = await page.extract("Get product name", schema={...})
is_done = await page.validate("Check if logged in")
```

---

## Benchmark Framework

Lumen includes a multi-framework benchmark harness at `evals/benchmark/` that runs the same 12 tasks across Lumen, Stagehand, and browser-use on live websites. Metrics tracked:

- **Success rate** (primary) — task pass/fail judged by the model
- **Average steps** — action efficiency
- **Average tokens** — LLM cost
- **Average duration** — wall-clock time

Winning criteria for Lumen:
- Success rate >= each other framework
- Steps <= Stagehand * 1.2 (browser-use excluded — different action granularity)
- Tokens <= each other * 1.05 (5% tolerance)
- Time <= each other * 1.15 (15% tolerance for startup variance)

Lumen also includes a WebVoyager evaluation (`evals/webvoyager/`) matching Stagehand's evaluation methodology exactly: Gemini 2.5 Flash judge, same prompt, 3 trials per task, 50 max steps.

---

## When to Use What

| Use case | Recommended | Why |
|---|---|---|
| **Multi-step workflows (20+ steps)** | **Lumen** | 2-tier compaction + `writeState` checkpointing keep context efficient for long tasks |
| **Quick DOM scraping / extraction** | **Stagehand** | `extract(instruction, schema)` API is purpose-built; DOM mode is fast and cheap |
| **Enterprise with many integrations** | **browser-use** | 14 watchdogs, MCP support, fine-tuned model, extensive provider support |
| **No-code / workflow builder** | **Skyvern** | Visual workflow editor, authentication support, cloud infrastructure |
| **Safety-critical automation** | **Lumen** | Policy + hooks + gates provide layered defense; full audit trail |
| **Non-vision models (GPT-3.5, Llama)** | **Stagehand** or **browser-use** | DOM/a11y modes work without vision capabilities |
| **Multi-provider comparison** | **Lumen** | Native adapters for Anthropic/Google/OpenAI with unified Action format |
| **Python ecosystem** | **browser-use** or **Skyvern** | Lumen and Stagehand are TypeScript-only |
| **Maximum reliability** | **Lumen** | Repeat detection, form state extraction, completion gates, and retry backoff cover common failure modes |
| **Cross-browser testing** | **Skyvern** | Playwright enables Firefox and WebKit alongside Chrome |

---

## Architecture Tradeoffs Summary

| Decision | Lumen's choice | Alternative approach | Tradeoff |
|---|---|---|---|
| Page understanding | Vision-only | DOM + Vision hybrid | Simpler, universal, but needs strong vision models and costs more tokens per step |
| Coordinate space | Pixel coords (decoded per provider) | Normalized 0-1000 everywhere | Zero conversion overhead in the hot path, but requires per-provider decode logic |
| History | Dual (wire + semantic) | Single compacted history | 2x memory for screenshots, but full audit trail always available |
| Compaction | Proactive at 80% utilization | Reactive at limit | Extra LLM call cost, but avoids context pressure surprises |
| Action execution | Streaming mid-stream | Batch after full response | More complex buffer management, but lower latency |
| State persistence | `writeState` action (last-write-wins) | Agent memory field | Simple semantics, but no versioning or branching |
| Browser | Raw CDP | Playwright | Lighter weight, but Chrome-only |
| Safety | 3-layer (policy + hook + gate) | None / application-level | Built-in overhead, but composable defense-in-depth |
