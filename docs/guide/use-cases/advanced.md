# Advanced

### Bring your own adapter

Implement `ModelAdapter` for unsupported models:

```typescript
import type { ModelAdapter, StepContext, ModelResponse } from "@omxyz/lumen";

class MyAdapter implements ModelAdapter {
  readonly modelId = "my-model";
  readonly provider = "custom";
  readonly nativeComputerUse = false;
  readonly contextWindowTokens = 128_000;

  async step(context: StepContext): Promise<ModelResponse> {
    const res = await myApi.call({ image: context.screenshot.data.toString("base64") });
    return { actions: [{ type: "click", x: 500, y: 300 }], usage: { inputTokens: 1000, outputTokens: 50 }, rawResponse: res };
  }

  async *stream(ctx: StepContext) { for (const a of (await this.step(ctx)).actions) yield a; }
  estimateTokens(ctx: StepContext) { return ctx.wireHistory.length * 200; }
  async summarize(history, state) { return `${history.length} messages`; }
}
```

### Fold action (context compression)

The model can explicitly compress completed sub-tasks:

```typescript
systemPrompt: "When you finish a sub-task, call fold with a summary to free context."
```

### Low-level Session API

Bring your own tab and adapter:

```typescript
import { Session, CDPTab, CdpConnection, AnthropicAdapter } from "@omxyz/lumen";

const conn = await CdpConnection.connect("ws://localhost:9222/...");
const tab = new CDPTab(conn.mainSession());
const session = new Session({ tab, adapter: new AnthropicAdapter("claude-sonnet-4-6"), maxSteps: 20 });

const result = await session.run({ instruction: "Click the login button." });
conn.close();
```
