# Quickstart

Install Lumen and run your first browser agent in under a minute.

## 1. Install

```bash
npm install @omxyz/lumen
```

Requires Node.js >= 20.19 and Chrome/Chromium installed locally.

## 2. Set your API key

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## 3. Run

```typescript
import { Agent } from "@omxyz/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Go to news.ycombinator.com and tell me the title of the top story.",
});

console.log(result.result);
```

Save as `agent.ts` and run with `npx tsx agent.ts`. The agent launches Chrome, takes screenshots, reasons about what it sees, and returns the answer.

## Next steps

- [Getting Started](/guide/getting-started) — multi-run sessions, streaming, browser options
- [Basic Usage](/guide/use-cases/basic) — one-shot tasks, pre-navigation, streaming events
- [Model Configuration](/guide/use-cases/models) — provider selection, local models, extended thinking
- [Best Practices](/guide/best-practices) — tips for reliable agents
