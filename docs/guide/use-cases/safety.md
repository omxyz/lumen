# Safety & Control

### Domain restriction

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  policy: {
    allowedDomains: ["*.mycompany.com", "accounts.google.com"],
    blockedDomains: ["facebook.com", "twitter.com"],
  },
});
```

### Pre-action hook (audit / deny)

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  preActionHook: async (action) => {
    appendFileSync("audit.log", JSON.stringify({ ts: Date.now(), action }) + "\n");
    if (action.type === "keyPress" && action.keys.includes("Return")) {
      return { decision: "deny", reason: "Form submission blocked" };
    }
    return { decision: "allow" };
  },
});
```

