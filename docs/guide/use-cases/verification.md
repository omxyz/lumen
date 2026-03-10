# Verifying Completion

Agents say "I'm done" when they *think* they're done — but they're often wrong. A verifier checks the actual browser state before accepting a terminate action. If verification fails, the rejection is fed back as an error and the agent keeps going.

## UrlMatchesGate

The simplest verifier — checks that the current URL matches a regex:

```typescript
import { UrlMatchesGate } from "@omxyz/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Complete the checkout flow",
  verifier: new UrlMatchesGate(/\/order\/\d+\/confirmation/),
});
```

The agent can only terminate when the URL contains `/order/123/confirmation`. Otherwise it gets: `URL "..." does not match expected pattern`.

## ModelVerifier

A separate model inspects the screenshot to judge completion. Uses a cheap model (Haiku) so verification cost is minimal:

```typescript
import { ModelVerifier, AnthropicAdapter } from "@omxyz/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Complete the checkout flow",
  verifier: new ModelVerifier(
    new AnthropicAdapter("claude-haiku-4-5-20251001"),
    "Complete the checkout flow",
  ),
});
```

The verifier asks: *"Has the task been fully completed?"* and expects YES or NO. After `maxAttempts` (default: 2) rejections, it hard-passes to prevent infinite gate loops.

```typescript
// Custom max attempts
new ModelVerifier(adapter, "Complete the checkout flow", 3)
```

## CustomGate

Full control — write any async predicate over the screenshot and URL:

```typescript
import { CustomGate } from "@omxyz/lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Submit the contact form",
  verifier: new CustomGate(
    async (screenshot, url) => url.includes("/success"),
    "Must reach the success page",  // optional failure message
  ),
});
```

## Action verification

Separate from completion verification, `ActionVerifier` runs heuristic checks after *every* action using CDP state inspection. No API calls — zero cost:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  actionVerifier: true,
});
```

What it checks:

| Action | Verification |
|--------|-------------|
| `click` / `doubleClick` | Did the click target an interactive element? Did the URL change? |
| `type` | Is an input element currently focused? |
| `goto` | Does the current hostname match the target? |

Failed checks produce hints fed back to the model (e.g., *"Type action may have failed — no input element was focused. Try clicking the input field first."*). The agent can self-correct on the next step.
