# Model Configuration

### Provider selection

```typescript
model: "anthropic/claude-sonnet-4-6"     // recommended
model: "anthropic/claude-opus-4-6"       // most capable
model: "google/gemini-2.5-pro"
model: "openai/computer-use-preview"
```

### Local / custom model

Any unrecognized prefix uses `CustomAdapter` (OpenAI-compatible):

```typescript
{ model: "llama3.2-vision", baseURL: "http://localhost:11434/v1", apiKey: "ollama" }
```

### Extended thinking

```typescript
{ model: "anthropic/claude-opus-4-6", thinkingBudget: 10_000 }
```

### Planner-assisted execution

A cheap model plans before the main loop runs:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  plannerModel: "anthropic/claude-haiku-4-5",
});
```
