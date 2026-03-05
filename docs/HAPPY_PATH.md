# Happy Path Walkthroughs

Annotated examples for the most common Lumen usage patterns. Each section is self-contained.

## Contents

1. [One-shot task](#1-one-shot-task)
2. [Multi-step session](#2-multi-step-session)
3. [Streaming progress events](#3-streaming-progress-events)
4. [Structured data extraction](#4-structured-data-extraction)
5. [Using memory across steps](#5-using-memory-across-steps)
6. [Session resumption across processes](#6-session-resumption-across-processes)
7. [Domain-restricted agent](#7-domain-restricted-agent)
8. [Pre-action hook for audit logging](#8-pre-action-hook-for-audit-logging)
9. [Custom completion gate](#9-custom-completion-gate)
10. [Bring your own browser (CDP)](#10-bring-your-own-browser-cdp)
11. [Browserbase (cloud)](#11-browserbase-cloud)
12. [Custom / local model](#12-custom--local-model)
13. [Extended thinking (Anthropic)](#13-extended-thinking-anthropic)
14. [Planner-assisted execution](#14-planner-assisted-execution)
15. [Custom monitor / observability](#15-custom-monitor--observability)
16. [Bring your own adapter (advanced)](#16-bring-your-own-adapter-advanced)
17. [Pre-navigating with startUrl](#17-pre-navigating-with-starturl)
18. [Debug logging](#18-debug-logging)

---

## 1. One-shot task

The simplest possible usage. `Agent.run()` creates the agent, runs once, closes the browser.

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
console.log(result.result);  // "The top story is: ..."
```

`result.history` contains the full step-by-step record if you want to inspect what happened:

```typescript
for (const step of result.history) {
  console.log(`Step ${step.stepIndex + 1} @ ${step.url}`);
  console.log(`  ${step.actions.length} actions, ${step.tokenUsage.inputTokens} tokens, ${step.durationMs}ms`);
}
```

---

## 2. Multi-step session

Create the agent once and call `run()` multiple times. The browser stays open and history accumulates across runs.

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  verbose: 1,  // Log step-level progress
});

// Task 1: Navigate somewhere
await agent.run({
  instruction: "Go to github.com and sign in with username 'demouser' and password 'hunter2'.",
});

// Task 2: Same session, browser is already logged in
const result = await agent.run({
  instruction: "Open the notifications panel and tell me how many unread notifications I have.",
});

console.log(result.result);

// Always close the browser when done
await agent.close();
```

Using the TC39 `using` keyword (Node 22+, TypeScript 5.2+) for automatic cleanup:

```typescript
{
  await using agent = new Agent({ model: "anthropic/claude-sonnet-4-6", browser: { type: "local" } });
  await agent.run({ instruction: "..." });
}  // agent.close() called automatically, even if an error is thrown
```

---

## 3. Streaming progress events

`agent.stream()` returns a typed async iterable. Useful for rendering a live UI or writing a progress logger.

```typescript
import { Agent, type CUAEvent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  verbose: 0,  // Suppress built-in logging; we'll log ourselves
});

for await (const event of agent.stream({
  instruction: "Search Amazon for 'mechanical keyboard' and tell me the price of the first result.",
  maxSteps: 20,
})) {
  switch (event.type) {
    case "step_start":
      process.stdout.write(`\n[Step ${event.step}/${event.maxSteps}] ${event.url}\n`);
      break;

    case "thinking":
      process.stdout.write(`  Thinking: ${event.text.slice(0, 80)}...\n`);
      break;

    case "action":
      process.stdout.write(`  → ${event.action.type}`);
      if ("x" in event.action) process.stdout.write(` (${event.action.x}, ${event.action.y})`);
      if ("text" in event.action) process.stdout.write(` "${(event.action as { text: string }).text}"`);
      process.stdout.write("\n");
      break;

    case "action_result":
      if (!event.ok) process.stdout.write(`    ERROR: ${event.error}\n`);
      break;

    case "action_blocked":
      process.stdout.write(`  ✗ blocked: ${event.reason}\n`);
      break;

    case "compaction":
      process.stdout.write(`  [compaction] ${event.tokensBefore} → ${event.tokensAfter} tokens\n`);
      break;

    case "done":
      process.stdout.write(`\nDone: ${event.result.status}\n${event.result.result}\n`);
      break;
  }
}

await agent.close();
```

---

## 4. Structured data extraction

Use a custom `systemPrompt` to instruct the model to store extracted data using the `writeState` action. The state is returned in `result.agentState`.

```typescript
import { Agent } from "@omlabs/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local", headless: true },
  instruction: "Go to the Wikipedia page for 'Claude Shannon' and extract his birth date, death date, and the first three works listed in his bibliography.",
  maxSteps: 15,
  systemPrompt: "When you have extracted the requested information, call writeState with the data as a flat JSON object, then call terminate.",
});

console.log(result.status);  // "success"
console.log(result.agentState);
// {
//   birthDate: "April 30, 1916",
//   deathDate: "February 24, 2001",
//   bibliography: ["A Mathematical Theory of Communication", ...]
// }
```

---

## 5. Using memory across steps

The model can call `writeState` to store data that survives history compaction. The state is re-injected into the system prompt every step and returned in `result.agentState`.

```typescript
import { Agent } from "@omlabs/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  instruction: `
    Go to the Hacker News front page. Scroll through all visible stories. Use writeState to track each story that has more than 100 points: call writeState with {stories: [...]} after each scroll, appending to the array. When done, call terminate with how many you found.
  `,
  maxSteps: 25,
});

// The accumulated stories are available directly on the result
console.log(result.agentState);
// { stories: [{ title: "...", points: 342 }, ...] }
```

You can pre-seed state at agent construction time:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  initialState: { accountId: "acc_1234", plan: "Pro" },
});
```

---

## 6. Session resumption across processes

Serialize the agent's full state after one run, then restore it in a separate Node process.

```typescript
// process-a.ts — run first
import { Agent } from "@omlabs/lumen";
import { writeFileSync } from "fs";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
});

await agent.run({ instruction: "Log in to the web app at http://localhost:3000 with admin@example.com / password123." });

const snapshot = await agent.serialize();
writeFileSync("session.json", JSON.stringify(snapshot, null, 2));

await agent.close();
console.log("Session saved.");
```

```typescript
// process-b.ts — run later
import { Agent } from "@omlabs/lumen";
import { readFileSync } from "fs";

const snapshot = JSON.parse(readFileSync("session.json", "utf8"));

// Agent.resume() restores wire history and agent state
const agent = Agent.resume(snapshot, {
  model: snapshot.modelId,  // use the same model
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
});

const result = await agent.run({
  instruction: "Now navigate to the Settings page and change the timezone to 'America/New_York'.",
});

console.log(result.result);
await agent.close();
```

> Note: The resumed session does not restore the browser's actual state (cookies, page content). You need to bring a browser that's already in the right state, or re-navigate to the right starting point.

---

## 7. Domain-restricted agent

Allow only specific domains to prevent the model from wandering outside the intended scope.

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  policy: {
    // Only these domains are reachable via the goto action
    allowedDomains: ["*.mycompany.com", "accounts.google.com"],

    // Explicitly block specific domains even if not in allowedDomains
    blockedDomains: ["facebook.com", "twitter.com", "x.com"],

    // Optional: restrict which action types the model may emit
    allowedActions: ["click", "doubleClick", "type", "scroll", "goto", "keyPress", "screenshot", "terminate", "writeState"],
  },
});

await agent.run({
  instruction: "Navigate to app.mycompany.com/reports and download the Q4 summary.",
});

await agent.close();
```

If the model tries to navigate to a blocked domain, the attempt is rejected and fed back as an error — the model can recover by choosing a different action.

---

## 8. Pre-action hook for audit logging

Intercept every action before execution. Return `deny` to block, `allow` to pass.

```typescript
import { Agent, type CUAAction } from "@omlabs/lumen";
import { appendFileSync } from "fs";

const actionLog: Array<{ ts: number; action: CUAAction }> = [];

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },

  preActionHook: async (action) => {
    // Audit every action
    actionLog.push({ ts: Date.now(), action });
    appendFileSync("audit.log", JSON.stringify({ ts: Date.now(), action }) + "\n");

    // Block any attempt to submit a form (type: "keyPress" with Enter while focused)
    if (action.type === "keyPress" && action.keys.includes("Return")) {
      return {
        decision: "deny",
        reason: "Form submission is not permitted in this context.",
      };
    }

    // Allow everything else
    return { decision: "allow" };
  },
});

await agent.run({ instruction: "Fill out the contact form but do not submit it." });

console.log(`Executed ${actionLog.length} actions.`);
await agent.close();
```

---

## 9. Custom completion gate

Prevent the loop from exiting until you have independently verified the task is done.

```typescript
import { Agent, UrlMatchesGate, CustomGate } from "@omlabs/lumen";

// Gate 1: URL must match a pattern
const agent1 = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  completionGate: new UrlMatchesGate(/\/order\/\d+\/confirmation/),
});

await agent1.run({
  instruction: "Add the first item in the cart to checkout and complete the purchase with card 4111 1111 1111 1111.",
  maxSteps: 30,
});

await agent1.close();

// Gate 2: Custom async predicate
const agent2 = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  completionGate: new CustomGate(
    async (screenshot, url) => {
      // Your own verification — could call an external API, check a DB, etc.
      return url.includes("/success") && url.includes("?ref=");
    },
    "Expected to land on success page with ref parameter",
  ),
});

await agent2.run({ instruction: "Complete the registration flow." });
await agent2.close();
```

---

## 10. Bring your own browser (CDP)

If you manage Chrome yourself (e.g., in a Docker container or a test suite that reuses a browser process), connect directly via the CDP WebSocket URL.

```typescript
import { Agent } from "@omlabs/lumen";

// Chrome must already be running:
//   google-chrome --remote-debugging-port=9222 --headless=new
//
// Get the WebSocket URL:
//   curl http://localhost:9222/json/version | jq .webSocketDebuggerUrl

const wsUrl = "ws://localhost:9222/devtools/browser/XXXXX";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "cdp", url: wsUrl },
});

await agent.run({ instruction: "..." });
await agent.close();  // closes the CDP connection but does NOT kill Chrome
```

For lower-level control, use `Session` directly with manually constructed adapters and tabs:

```typescript
import { Session, CDPTab, CdpConnection, AnthropicAdapter } from "@omlabs/lumen";

const conn = await CdpConnection.connect(wsUrl);
const tab = new CDPTab(conn.mainSession());
const adapter = new AnthropicAdapter("claude-sonnet-4-6", process.env.ANTHROPIC_API_KEY);

const session = new Session({ tab, adapter, maxSteps: 20 });

const result = await session.run({ instruction: "Click the login button." });
const snapshot = session.serialize();

conn.close();
```

---

## 11. Browserbase (cloud)

Run the browser in Browserbase's cloud infrastructure — no local Chrome required.

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: {
    type: "browserbase",
    apiKey: process.env.BROWSERBASE_API_KEY!,
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
  },
});

await agent.run({ instruction: "Extract the stock price of AAPL from finance.yahoo.com." });
await agent.close();
```

To resume an existing Browserbase session (e.g., to preserve cookies across invocations):

```typescript
browser: {
  type: "browserbase",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  sessionId: "bb_session_XXXXXXXX",  // existing session ID
}
```

---

## 12. Custom / local model

Any model string that does not match `anthropic/`, `google/`, or `openai/` falls back to `CustomAdapter`, which speaks OpenAI-compatible chat completions.

```typescript
import { Agent } from "@omlabs/lumen";

// Ollama example (local Llama)
const agent = new Agent({
  model: "llama3.2-vision",
  baseURL: "http://localhost:11434/v1",
  apiKey: "ollama",  // Ollama ignores the key but the SDK requires one
  browser: { type: "local" },
});

await agent.run({ instruction: "..." });
await agent.close();
```

```typescript
// LiteLLM proxy
const agent = new Agent({
  model: "gpt-4o",
  baseURL: "http://localhost:4000/v1",
  apiKey: process.env.LITELLM_API_KEY,
  browser: { type: "local" },
});
```

Note: `CustomAdapter` does not use a native computer-use tool — it presents the action schema as a JSON function call. Vision capability depends on the model.

---

## 13. Extended thinking (Anthropic)

Enable Anthropic's extended thinking to get more thorough reasoning for complex tasks.

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-opus-4-6",  // Opus or Sonnet 4.x
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  thinkingBudget: 10_000,  // Token budget for thinking. 0 = disabled (default).
  verbose: 2,              // Print thinking text to stdout
});

const result = await agent.run({
  instruction: "Analyze the Google Flights search results for JFK to LAX next Friday and identify the best value flight considering price, duration, and stops.",
  maxSteps: 20,
});

// Thinking text is also available in history
for (const step of result.history) {
  if (step.thinking) {
    console.log(`Step ${step.stepIndex + 1} thinking:\n${step.thinking}\n`);
  }
}

await agent.close();
```

---

## 14. Planner-assisted execution

The planner runs once before the main loop, taking a screenshot of the current page and producing a step-by-step plan that is prepended to the system prompt. Useful for long, multi-phase tasks.

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  // Use a separate (potentially cheaper) model for the planning step
  plannerModel: "anthropic/claude-haiku-4-5",
});

await agent.run({
  instruction: "On the Airbnb homepage, search for accommodations in Lisbon for 2 adults for 5 nights starting April 10, 2026. Find the listing with the highest rating and at least 50 reviews.",
  maxSteps: 30,
});

await agent.close();
```

---

## 15. Custom monitor / observability

Replace or extend the built-in `ConsoleMonitor` to integrate with your observability stack.

```typescript
import { Agent, type LoopMonitor } from "@omlabs/lumen";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("lumen-agent");

class OtelMonitor implements LoopMonitor {
  private span = tracer.startSpan("agent.run");

  stepStarted(step: number, context: { url: string; maxSteps: number }) {
    this.span.addEvent("step_start", { step, url: context.url });
  }

  stepCompleted(step: number, response: { usage: { inputTokens: number } }) {
    this.span.addEvent("step_complete", { step, input_tokens: response.usage.inputTokens });
  }

  actionExecuted(step: number, action: { type: string }, outcome: { ok: boolean; error?: string }) {
    if (!outcome.ok) {
      this.span.addEvent("action_error", { step, type: action.type, error: outcome.error ?? "" });
    }
  }

  actionBlocked(step: number, action: { type: string }, reason: string) {
    this.span.addEvent("action_blocked", { step, type: action.type, reason });
  }

  terminationRejected(step: number, reason: string) {
    this.span.addEvent("termination_rejected", { step, reason });
  }

  compactionTriggered(step: number, tokensBefore: number, tokensAfter: number) {
    this.span.addEvent("compaction", { step, tokens_before: tokensBefore, tokens_after: tokensAfter });
  }

  terminated(result: { status: string; steps: number }) {
    this.span.setAttribute("status", result.status);
    this.span.setAttribute("steps", result.steps);
    if (result.status !== "success") {
      this.span.setStatus({ code: SpanStatusCode.ERROR });
    }
    this.span.end();
  }

  error(err: Error) {
    this.span.recordException(err);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    this.span.end();
  }
}

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local" },
  monitor: new OtelMonitor(),  // completely replaces ConsoleMonitor
  verbose: 0,                  // prevents double logging
});

await agent.run({ instruction: "..." });
await agent.close();
```

Or use the built-in `logger` callback for structured JSON logging without replacing the monitor:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  logger: (line) => {
    process.stdout.write(JSON.stringify(line) + "\n");
  },
});
```

Each `LogLine` has `{ level, message, data?, timestamp }`.

---

## 16. Bring your own adapter (advanced)

Implement `ModelAdapter` to integrate any model that is not natively supported.

```typescript
import type { ModelAdapter, StepContext, ModelResponse } from "@omlabs/lumen";
import type { CUAAction, WireMessage, TaskState } from "@omlabs/lumen";

class MyCustomAdapter implements ModelAdapter {
  readonly modelId = "my-model";
  readonly provider = "my-provider";
  readonly nativeComputerUse = false;
  readonly contextWindowTokens = 128_000;

  async step(context: StepContext): Promise<ModelResponse> {
    // Call your model API here
    // context.screenshot.data is a Buffer of PNG/JPEG bytes
    // context.wireHistory is the compressed message history
    // context.agentState is the last written state

    const response = await myApi.call({
      image: context.screenshot.data.toString("base64"),
      prompt: context.systemPrompt,
      // ...
    });

    // Return actions in 0–1000 normalized coordinate space
    return {
      actions: [{ type: "click", x: 500, y: 300 }],
      usage: { inputTokens: 1000, outputTokens: 50 },
      rawResponse: response,
    };
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    // If your model doesn't support streaming, delegate to step():
    const response = await this.step(context);
    for (const action of response.actions) {
      yield action;
    }
  }

  estimateTokens(context: StepContext): number {
    return context.wireHistory.length * 200 + 1500;
  }

  async summarize(wireHistory: WireMessage[], currentState: TaskState | null): Promise<string> {
    // Called during compaction — produce a concise summary of the session history
    return `Session: ${wireHistory.length} messages. State: ${JSON.stringify(currentState)}`;
  }
}

// Use with Session directly
import { Session, CDPTab, CdpConnection } from "@omlabs/lumen";

const conn = await CdpConnection.connect("ws://...");
const tab = new CDPTab(conn.mainSession());
const adapter = new MyCustomAdapter();

const session = new Session({ tab, adapter });
await session.run({ instruction: "..." });
conn.close();
```

---

## 17. Pre-navigating with startUrl

Skip 1-2 model steps by navigating to the starting URL before the first model call.

```typescript
import { Agent } from "@omlabs/lumen";

const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  browser: { type: "local", headless: true },
  instruction: "Find the price of the cheapest flight from JFK to LAX next Friday.",
  startUrl: "https://www.google.com/travel/flights",
  maxSteps: 15,
});

console.log(result.result);
```

The model sees the target page on its very first screenshot instead of starting from a blank tab.

---

## 18. Debug logging

Lumen's `LumenLogger` provides per-surface debug logging controlled by environment variables.

```bash
# Enable all debug surfaces at once
LUMEN_LOG=debug npm run start

# Enable only specific surfaces
LUMEN_LOG_CDP=1 npm run start       # CDP WebSocket wire traffic
LUMEN_LOG_ACTIONS=1 npm run start   # ActionRouter dispatch + timing
LUMEN_LOG_BROWSER=1 npm run start   # CDPTab navigation/input/screenshot
LUMEN_LOG_HISTORY=1 npm run start   # HistoryManager compaction state
LUMEN_LOG_ADAPTER=1 npm run start   # Model adapter call timing + tokens
LUMEN_LOG_LOOP=1 npm run start      # PerceptionLoop step internals

# Combine surfaces
LUMEN_LOG_ACTIONS=1 LUMEN_LOG_LOOP=1 npm run start
```

Or configure programmatically with `verbose: 2` to enable all surfaces:

```typescript
import { Agent } from "@omlabs/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  verbose: 2,  // Enables all debug surfaces
  logger: (line) => {
    // Structured callback receives EVERY log line regardless of console verbosity
    myTelemetry.log(line);
  },
});
```

The `LumenLogger` is threaded through all layers -- PerceptionLoop, ActionRouter, HistoryManager, CDPTab, and model adapters -- so you can trace a single action from model output through coordinate decoding to CDP dispatch.
