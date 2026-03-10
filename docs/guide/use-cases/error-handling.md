# Error Handling & Retries

Lumen handles errors at three levels: API retries, action error recovery, and evaluation retries.

## API retries

Model API calls (Anthropic, Google, OpenAI) automatically retry on transient errors with exponential backoff:

- **Retryable status codes:** 429 (rate limit), 500, 503, 529 (overloaded)
- **Strategy:** up to 3 attempts, backoff of 1s → 2s → 4s
- **Non-retryable errors** (auth failures, invalid requests) throw immediately

This is handled by `withRetry()` in the adapter layer — no configuration needed.

## Action errors

When a browser action fails (click misses, navigation blocked, element not found), the error is **not thrown**. Instead, it's fed back to the model as context in the next step. The agent sees what went wrong and can self-correct:

```
Action "click" failed: Element not found at coordinates (450, 320)
```

This means your code never needs try/catch around `agent.run()` for action-level failures — the agent handles them internally.

## Fatal errors

The only error that throws and terminates the agent loop:

- **`BROWSER_DISCONNECTED`** — the CDP WebSocket closed unexpectedly (browser crashed, container killed, etc.)

All other errors are recoverable within the agent loop.

## Action verification hints

With `actionVerifier: true`, failed heuristic checks produce hints fed back to the model:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  actionVerifier: true,
});
```

Example hints:
- *"Type action may have failed — no input element was focused. Try clicking the input field first."*
- *"Navigation may have failed — expected github.com but got google.com."*

See [Verifying Completion](/guide/use-cases/verification) for details.

## Evaluation retries

The eval framework has its own retry mechanism with judge feedback injection. Failed tasks are retried up to 3 times, with the judge's reasoning from the previous attempt injected into the next instruction. See [Running Evaluations](/guide/use-cases/evaluations) for details.
