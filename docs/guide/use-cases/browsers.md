# Browser Connections

### Local Chrome

```typescript
browser: { type: "local", headless: true, port: 9222 }
```

### Existing CDP endpoint

Chrome already running (Docker, CI):

```typescript
// google-chrome --remote-debugging-port=9222 --headless=new
browser: { type: "cdp", url: "ws://localhost:9222/devtools/browser/..." }
```

### Browserbase (cloud)

No local Chrome needed:

```typescript
browser: {
  type: "browserbase",
  apiKey: process.env.BROWSERBASE_API_KEY!,
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
}
```
