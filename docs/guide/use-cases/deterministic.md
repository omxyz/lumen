# Deterministic Automation

Run browser tasks without calling the model — replay cached actions from a previous successful run. When a cached action fails (page changed, element moved), Lumen self-heals by falling back to the model and updating the cache automatically.

## How it works

1. **First run** — the model decides each action normally; successful actions are cached
2. **Subsequent runs** — cached actions replay instantly (zero tokens), skipping the model entirely
3. **Self-healing** — if a cached action fails, the model takes over for that step and the cache is updated

This gives you deterministic, fast automation on stable pages and graceful degradation on dynamic ones.

## Enable it

Pass `cacheDir` to opt in:

```typescript
import { Agent } from "lumen";

const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  cacheDir: ".lumen-cache",
});

// First run: model decides actions, cache populates
await agent.run("Search for 'headless browsers' on Google");

// Second run: replays from cache, zero API calls
await agent.run("Search for 'headless browsers' on Google");
```

## Self-healing in action

Consider a login page where a button moved after a redesign:

```
Run 1 (cache empty):
  Step 1: model → click(200, 300) on "Sign In"  ✓  → cached
  Step 2: model → type("user@example.com")       ✓  → cached

Run 2 (cache populated, page unchanged):
  Step 1: cache HIT → click(200, 300)             ✓  → replayed
  Step 2: cache HIT → type("user@example.com")    ✓  → replayed

Run 3 (button moved to 400, 350 after redesign):
  Step 1: cache HIT → click(200, 300)             ✗  → FAILED
          self-heal → model → click(400, 350)      ✓  → cache updated
  Step 2: cache HIT → type("user@example.com")    ✓  → replayed
```

No manual intervention needed — the cache self-corrects on failure.

## Cache key design

Each cache entry is keyed by `SHA-256(url + instructionHash)`. This intentionally excludes:

- **Screenshot hash** — dynamic content (videos, ads, timestamps) would cause 100% miss rates
- **Action type** — unknown before lookup

The trade-off: same URL + same instruction but different visual state (e.g., a modal open vs closed) may return a stale action. Self-healing handles this at the cost of one extra action attempt.

## Viewport awareness

Cache entries record viewport dimensions. On replay, if the viewport differs from the cached value, a warning is logged but execution still proceeds. This helps you spot layout-sensitive failures without blocking automation.

## When to use deterministic mode

| Scenario | Benefit |
|----------|---------|
| CI/CD pipelines | Stable, repeatable runs with zero token cost |
| Regression testing | Same actions every time on unchanged pages |
| Cost optimization | Eliminate model calls for known workflows |
| Development iteration | Fast reruns while debugging agent logic |

## Limitations

- Coordinate-based actions (click, drag) depend on pixel positions — layout changes may produce incorrect coordinates until self-healing kicks in
- Cache entries have no TTL — clear the directory when workflows change significantly
- Caches individual actions, not full task sequences
- Same URL with different visual state requires one self-healing round to correct

See [Action Caching](/guide/use-cases/caching) for configuration details.
