# Action Caching

ActionCache stores model decisions so repeated tasks on the same page skip the API call entirely — zero tokens consumed on cache hits.

## How it works

Each cached entry is keyed by **URL + instruction hash** only:

```
key = SHA-256(url + ":" + instructionHash)[:16]
```

The cache deliberately omits action type and screenshot hash from the key:
- **No action type** — you don't know the action before looking it up (chicken-and-egg)
- **No screenshot hash** — dynamic content (videos, ads, timestamps) would cause 100% miss rates

Instead of validating cache entries upfront, Lumen uses **self-healing**: execute the cached action, and if it fails, fall back to the model and overwrite the stale entry.

## Self-healing

When a cached action doesn't match the current page state:

1. Cache hit — replay the cached action
2. Action fails (element missing, wrong state, etc.)
3. Fall back to the model — make a fresh API call
4. Model produces the correct action
5. Cache updated — stale entry overwritten automatically

This means at most one wasted action attempt per stale cache entry, after which the cache self-corrects. No manual invalidation needed.

## Viewport tracking

Cache entries record the viewport dimensions at write time. On cache hit, if the current viewport differs from the cached one, a warning is logged — but execution still proceeds. This is informational only; viewport mismatches don't invalidate the cache.

## Enable caching

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  cacheDir: ".lumen-cache",
});
```

Cache entries are stored as JSON files in the specified directory:

```
.lumen-cache/
  a1b2c3d4e5f6g7h8.json   # sha256(url:instructionHash)[:16]
  ...
```

Omitting `cacheDir` disables caching entirely — zero overhead.

## When to use it

Caching is most useful for:
- **Repeated evaluations** — running the same dataset multiple times during development
- **Stable workflows** — tasks on pages that rarely change layout
- **Development iteration** — avoid burning tokens while debugging agent behavior

## Limitations

- Same URL + same instruction but different visual state (e.g., modal open vs closed) may return a stale action — self-healing handles this at the cost of one extra action attempt
- Coordinate-based actions (click, drag) depend on pixel positions — viewport or layout changes may produce incorrect coordinates until self-healing kicks in
- Cache entries have no TTL — clear the directory manually when stale
- Only caches individual action decisions, not full task sequences
