# Basic Usage

### One-shot task

```typescript
import { Agent } from "@omxyz/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local", headless: true },
  instruction: "Go to news.ycombinator.com and tell me the title of the top story.",
  maxSteps: 10,
});

console.log(result.result);
```

### Multi-run session

Reuse one browser across tasks. History accumulates.

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
});

await agent.run({ instruction: "Navigate to github.com" });
await agent.run({ instruction: "Search for the 'react' repository." });
await agent.close();
```

### Streaming events

Watch the agent work in real-time:

```typescript
for await (const event of agent.stream({ instruction: "Find the current Bitcoin price." })) {
  if (event.type === "step_start") console.log(`Step ${event.step}/${event.maxSteps}`);
  if (event.type === "action") console.log(`  ${event.action.type}`);
  if (event.type === "done") console.log(event.result.result);
}
```

### Pre-navigate with startUrl

Skip 1-2 steps by starting on the right page:

```typescript
await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Find the cheapest flight from JFK to LAX next Friday.",
  startUrl: "https://www.google.com/travel/flights",
});
```
