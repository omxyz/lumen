# Action Caching

ActionCache stores model decisions so repeated tasks on the same page skip the API call entirely.

## How it works

Each cached entry is keyed by:
- **Action type** (click, type, goto, etc.)
- **Current URL**
- **Instruction hash** (SHA-256 of the task instruction)

For coordinate-based actions (click, doubleClick, hover, scroll, drag), the cache also stores a **screenshot hash**. On cache hit, the screenshot is compared to validate that the page layout hasn't shifted — if similarity drops below 92%, the cache entry is skipped and a fresh API call is made.

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
  a1b2c3d4e5f6g7h8.json   # sha256(actionType:url:instructionHash)[:16]
  ...
```

## When to use it

Caching is most useful for:
- **Repeated evaluations** — running the same dataset multiple times during development
- **Stable workflows** — tasks on pages that rarely change layout
- **Development iteration** — avoid burning tokens while debugging agent behavior

## Limitations

- Screenshot validation uses exact hash comparison (not perceptual hashing), so minor rendering differences invalidate coordinate-action caches
- Cache entries have no TTL — clear the directory manually when stale
- Only caches individual action decisions, not full task runs
