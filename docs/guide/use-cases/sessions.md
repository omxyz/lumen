# Session Management

### Serialize & resume

Save state across process restarts:

```typescript
// Save
const snapshot = await agent.serialize();
writeFileSync("session.json", JSON.stringify(snapshot));

// Restore
const data = JSON.parse(readFileSync("session.json", "utf8"));
const agent2 = Agent.resume(data, {
  model: snapshot.modelId,
  browser: { type: "local" },
});
```

> Note: Resumption restores wire history and agent state, not browser state (cookies, page content).

### Browser checkpointing

Save browser state every N steps. Backtracks on deep stalls (level 8+):

```typescript
{ checkpointInterval: 5 }
```

### Pre-seeded state

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  initialState: { accountId: "acc_1234", plan: "Pro" },
});
```
