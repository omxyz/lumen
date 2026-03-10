# Getting Started

## The problem

Browser automation is stuck between two bad options:

1. **Selector-based tools** (Playwright, Puppeteer) — fast and precise, but scripts break every time the UI changes. You're maintaining selectors, not building features.
2. **Pure AI agents** — flexible, but they hallucinate actions, get stuck in loops, and blow through token budgets on long tasks.

## The solution

Lumen is a vision-first browser agent. Give it a task in plain English; it sees the screen and acts like a human would. No selectors to break. No infinite loops — three layers of stuck detection keep it on track.

```typescript
import { Agent } from "@omxyz/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Go to news.ycombinator.com and tell me the title of the top story.",
});

console.log(result.result);
```

That's it. Five lines. The agent launches Chrome, takes screenshots, reasons about what it sees, clicks and types, and returns the answer.

## Benchmark

How does it compare? Subset of 25 tasks from [WebVoyager](https://github.com/MinorJerry/WebVoyager), stratified across 15 sites. Scored by LLM-as-judge (Gemini 2.5 Flash), 3 trials per task.

| Metric | Lumen | browser-use | Stagehand |
|--------|-------|-------------|-----------|
| **Success Rate** | **25/25 (100%)** | **25/25 (100%)** | 19/25 (76%) |
| **Avg Steps (all)** | 14.4 | 8.8 | 23.1 |
| **Avg Time (all)** | **77.8s** | 109.8s | 207.8s |
| **Avg Tokens** | 104K | N/A | 200K |

All frameworks use Claude Sonnet 4.6 as the agent model.

## Install

```bash
npm install @omxyz/lumen
```

Requires Node.js >= 20.19 and Chrome/Chromium for local browser mode.

## Your first agent

### One task, one result

The simplest pattern — create an agent, run a task, get the answer:

```typescript
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local", headless: true },
  instruction: "Find the price of the top result for 'mechanical keyboard' on Amazon.",
  maxSteps: 15,
});

console.log(result.result);      // "The top result is $49.99"
console.log(result.agentState);  // structured data if the agent used writeState
```

### Multiple tasks, one browser

Need to chain tasks in the same browser session? Create the agent once, run multiple times:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
});

await agent.run({ instruction: "Navigate to github.com" });
await agent.run({ instruction: "Search for the 'react' repository." });
await agent.close();
```

### Watch it work in real-time

The streaming API yields typed events as the agent works — build live dashboards, progress bars, or debugging UIs:

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

### Skip the navigation

Every model step costs time and tokens. If you know where the task starts, pre-navigate to save 1-2 steps:

```typescript
await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Find the cheapest flight from JFK to LAX next Friday.",
  startUrl: "https://www.google.com/travel/flights",
});
```

## Models

The `model` string is `"provider/model-id"`. Lumen picks the right adapter automatically:

```typescript
model: "anthropic/claude-sonnet-4-6"     // recommended — best cost/performance
model: "anthropic/claude-opus-4-6"       // most capable — complex multi-site tasks
model: "google/gemini-2.5-pro"
model: "openai/computer-use-preview"
```

**Want to use a local model?** Any unrecognized prefix falls through to `CustomAdapter` (OpenAI-compatible chat completions):

```typescript
{ model: "llama3.2-vision", baseURL: "http://localhost:11434/v1", apiKey: "ollama" }
```

**Need the model to think harder?** Enable extended thinking (Anthropic only):

```typescript
{ model: "anthropic/claude-opus-4-6", thinkingBudget: 8000 }
```

## Browser options

**Local Chrome** — launches and manages Chrome for you:
```typescript
browser: { type: "local", headless: true, port: 9222 }
```

**Existing CDP endpoint** — Chrome is already running (Docker, CI):
```typescript
browser: { type: "cdp", url: "ws://localhost:9222/devtools/browser/..." }
```

**Browserbase** — cloud browser, no local Chrome needed:
```typescript
browser: {
  type: "browserbase",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
}
```

## Safety

### The problem: agents going rogue

An unrestricted agent could navigate anywhere and do anything. Lumen gives you three layers of control.

### Layer 1: Domain & action policy

Declarative rules — the agent can't even attempt blocked actions:

```typescript
policy: {
  allowedDomains: ["*.mycompany.com"],
  blockedDomains: ["facebook.com"],
  allowedActions: ["click", "type", "scroll", "goto", "terminate"],
}
```

### Layer 2: Pre-action hook

Imperative logic — inspect every action before it executes:

```typescript
preActionHook: async (action) => {
  if (action.type === "goto" && action.url.includes("checkout")) {
    return { decision: "deny", reason: "checkout not permitted" };
  }
  return { decision: "allow" };
}
```

### Layer 3: Completion verifier

Don't trust the agent's "I'm done" — verify it:

```typescript
import { UrlMatchesGate, ModelVerifier, AnthropicAdapter } from "@omxyz/lumen";

// Simple: URL must match a pattern
verifier: new UrlMatchesGate(/\/confirmation\?order=\d+/)

// Thorough: a separate model checks the screenshot
verifier: new ModelVerifier(
  new AnthropicAdapter("claude-haiku-4-5-20251001"),
  "Complete the checkout flow",
)
```

## Session resumption

**The problem:** long workflows crash, and you lose everything.

**The solution:** serialize mid-session, restore later:

```typescript
// Save
const snapshot = await agent.serialize();
fs.writeFileSync("session.json", JSON.stringify(snapshot));

// Restore — picks up exactly where it left off
const data = JSON.parse(fs.readFileSync("session.json", "utf8"));
const agent2 = Agent.resume(data, { model: "anthropic/claude-sonnet-4-6", browser: { type: "local" } });
```

## Testing

```bash
npm test              # 140 tests, ~3.5s
npm run test:watch
npm run typecheck
```

## Troubleshooting

**Chrome fails to launch** — verify Chrome is installed (`google-chrome --version`). On Linux CI, launch Chrome with `--no-sandbox` yourself and use `browser: { type: "cdp", url: "ws://..." }`.

**API key not found** — falls back to env vars: `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` / `GEMINI_API_KEY`, `OPENAI_API_KEY`.

**Loop hits maxSteps** — increase `maxSteps`, add a focused `systemPrompt`, or use `verbose: 2` to debug.

**BROWSER_DISCONNECTED** — the CDP socket closed unexpectedly. This is the only error that throws; all action errors are fed back to the model.

**ESM import errors** — this package is ESM-only. Use `"moduleResolution": "bundler"` or `"nodenext"` in `tsconfig.json`.
