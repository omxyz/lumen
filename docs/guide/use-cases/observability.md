# Observability

### Custom monitor

```typescript
import type { LoopMonitor } from "@omxyz/lumen";

class OtelMonitor implements LoopMonitor {
  stepStarted(step, ctx) { tracer.addEvent("step", { step, url: ctx.url }); }
  stepCompleted(step, res) { tracer.addEvent("done", { step, tokens: res.usage.inputTokens }); }
  actionExecuted(step, action, outcome) { if (!outcome.ok) tracer.addEvent("error", { step }); }
  terminated(result) { span.end(); }
  error(err) { span.recordException(err); }
  // ... other hooks: actionBlocked, terminationRejected, compactionTriggered
}

const agent = new Agent({ ..., monitor: new OtelMonitor(), verbose: 0 });
```

### Structured logger

```typescript
logger: (line) => process.stdout.write(JSON.stringify(line) + "\n")
```

### Debug log surfaces

```bash
LUMEN_LOG=debug npm start          # everything
LUMEN_LOG_ACTIONS=1 npm start      # action dispatch
LUMEN_LOG_CDP=1 npm start          # CDP wire traffic
LUMEN_LOG_LOOP=1 npm start         # perception loop
```
