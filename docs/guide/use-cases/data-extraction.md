# Data Extraction

### Structured extraction with writeState

Tell the agent what data to collect — it persists JSON that survives compaction:

```typescript
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local", headless: true },
  instruction: "Go to Wikipedia's page for Claude Shannon. Extract birth date, death date, and first 3 bibliography entries into state.",
  systemPrompt: "Call writeState with extracted data as JSON, then terminate.",
});

console.log(result.agentState);
// { birthDate: "April 30, 1916", deathDate: "February 24, 2001", bibliography: [...] }
```

### Accumulating state across steps

The model can call `writeState` repeatedly — state persists across compaction:

```typescript
const result = await Agent.run({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  instruction: "Scroll through HN. Use writeState to collect stories with 100+ points. Terminate when done.",
  maxSteps: 25,
});

console.log(result.agentState); // { stories: [{ title: "...", points: 342 }, ...] }
```
