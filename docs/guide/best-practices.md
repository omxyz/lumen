# Best Practices

## Cost optimization

### The problem: token costs spiral on long tasks

A 30-step task with screenshots in every message can easily consume 200K+ tokens. Without intervention, context grows linearly until it hits the model's limit.

### The solution: tune compaction and model selection

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  compactionThreshold: 0.6,                              // trigger early (default: 0.8)
  compactionModel: "anthropic/claude-haiku-4-5-20251001", // cheap model for summarization
  keepRecentScreenshots: 1,                               // keep only the latest screenshot
});
```

This keeps token usage flat even on 50+ step tasks. The agent summarizes old context with Haiku (cheap) while the main loop runs on Sonnet (capable).

**Pick the right model for the job:**
- **Sonnet** — best cost/performance for most tasks
- **Opus** — reserve for complex multi-site research where reasoning matters
- **Haiku** — compaction and verification only, not as the main agent

**Set realistic `maxSteps`.** Every step = one model call + one screenshot. Start with 15 for simple tasks, increase only when needed.

## Speed optimization

### The problem: the agent wastes steps navigating

Two steps spent typing a URL into the address bar and pressing Enter is two steps of latency and cost you didn't need.

### The solution: pre-navigate and tune timing

```typescript
// Save 1-2 steps by starting on the right page
await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Find the cheapest flight from JFK to LAX next Friday.",
  startUrl: "https://www.google.com/travel/flights",
});
```

For fast single-page apps, reduce the conservative default delays:

```typescript
timing: {
  afterClick: 300,      // default: 500
  afterType: 200,       // default: 300
  afterNavigation: 1000 // default: 2000
}
```

Run headless in production — no rendering overhead:

```typescript
browser: { type: "local", headless: true }
```

## Prompting

### The problem: vague instructions produce vague results

"Find me a keyboard" gives the agent no criteria. It doesn't know which site, what price range, or when to stop.

### The solution: be specific, use systemPrompt, extract structured data

**Be specific in instructions:**
```typescript
instruction: "Go to Amazon and find the cheapest mechanical keyboard under $50 with Cherry MX switches"
// NOT: "find me a keyboard"
```

**Use `systemPrompt` for persistent context** that the agent needs every step:
```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  systemPrompt: "You are logged in as test@example.com. Always use metric units. Prefer English language results.",
});
```

**Use `writeState` for structured extraction.** Tell the agent what data to collect — it persists JSON that survives compaction:

```typescript
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Go to HN and collect the top 5 story titles and URLs into state, then terminate.",
});

console.log(result.agentState);
// { stories: [{ title: "Show HN: ...", url: "https://..." }, ...] }
```

**Use `delegate` for multi-site tasks.** When context from site A isn't needed on site B, delegate to a fresh child loop:

```
"Search for flights on Google Flights, then delegate to Kayak to compare prices."
```

The child loop gets its own clean context — no leftover screenshots from the previous site polluting the model's attention.

## Debugging

### The problem: the agent did something wrong and you don't know why

A 20-step run failed. Which step went wrong? What did the model see? What was it thinking?

### The solution: verbose logging + semantic history

**Start with `verbose: 2`** for full console output:
```typescript
{ verbose: 2 }
```

**Use targeted log surfaces** when you know where to look:
```bash
LUMEN_LOG=debug npm start          # everything
LUMEN_LOG_ACTIONS=1 npm start      # what actions were dispatched
LUMEN_LOG_CDP=1 npm start          # raw CDP wire traffic
LUMEN_LOG_LOOP=1 npm start         # perception loop decisions
LUMEN_LOG_HISTORY=1 npm start      # compaction triggers and summaries
LUMEN_LOG_ADAPTER=1 npm start      # model request/response payloads
```

**Inspect `result.history`** — every run returns `SemanticStep[]` with the screenshot, thinking, actions, and outcomes for each step. This is the single best debugging tool:

```typescript
const result = await agent.run({ instruction: "..." });

for (const step of result.history) {
  console.log(`Step ${step.stepIndex}: ${step.url}`);
  console.log(`  Thinking: ${step.thinking}`);
  for (const { action, outcome } of step.actions) {
    console.log(`  ${action.type} → ${outcome.ok ? "ok" : outcome.error}`);
  }
}
```

**Use streaming for real-time visibility** — watch the agent work live:

```typescript
for await (const event of agent.stream({ instruction: "..." })) {
  if (event.type === "action") console.log(`Step ${event.step}: ${event.action.type}`);
  if (event.type === "termination_rejected") console.log(`Verifier rejected: ${event.reason}`);
  if (event.type === "done") console.log(event.result.result);
}
```

## Deploying

### The problem: it works locally but not in production

Local development uses headed Chrome with a visible window. Production needs headless mode, Docker containers, or cloud browsers — different constraints entirely.

### The solution: match the browser option to your environment

**Docker / CI** — install Chrome, launch headless, connect via CDP:

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y chromium
ENV CHROME_PATH=/usr/bin/chromium
```

```typescript
// In your app — Chrome is already running in the container
browser: { type: "local", headless: true }

// Or connect to an existing Chrome instance
browser: { type: "cdp", url: "ws://localhost:9222/devtools/browser/..." }
```

**Cloud (no Chrome at all)** — use Browserbase:

```typescript
browser: {
  type: "browserbase",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
}
```

**Long-running workflows** — serialize state to survive process restarts:

```typescript
// Save before shutdown
const snapshot = await agent.serialize();
fs.writeFileSync("session.json", JSON.stringify(snapshot));

// Restore after restart — picks up exactly where it left off
const data = JSON.parse(fs.readFileSync("session.json", "utf8"));
const agent2 = Agent.resume(data, {
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
});
```
