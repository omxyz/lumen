# Stealth & Anti-Detection

Some websites detect automated browsers and block or degrade the experience. Here's how to handle that with Lumen.

## Browserbase (recommended)

The easiest path — Browserbase handles stealth, proxies, and CAPTCHAs out of the box:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: {
    type: "browserbase",
    apiKey: process.env.BROWSERBASE_API_KEY!,
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
  },
});
```

No fingerprint leaks, residential proxies, and automatic CAPTCHA solving. No local Chrome needed.

## Local: persistent profiles

Use `userDataDir` to persist cookies, localStorage, and login sessions across runs. This avoids triggering "new device" checks:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: {
    type: "local",
    userDataDir: "./chrome-profile",
  },
});
```

## CDP: pre-configured Chrome

Connect to a Chrome instance you've already configured with extensions, profiles, or stealth patches:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: {
    type: "cdp",
    url: "ws://localhost:9222/devtools/browser/...",
  },
});
```

This is useful for:
- Docker containers with stealth Chrome builds
- CI environments with pre-warmed browser sessions
- Chrome launched with custom flags (`--disable-blink-features=AutomationControlled`)

## Tips

- **Navigation wait time**: Lumen waits 2000ms after navigation for async content to load. Complex sites with heavy JS may need the agent to scroll or wait before reading results.
- **Cookie banners**: Add rules to [SiteKB](/guide/use-cases/site-knowledge) (e.g., `"Dismiss cookie banner before interacting"`).
- **Rate limiting**: The model adapter layer has built-in [retry with backoff](/guide/use-cases/error-handling) for API rate limits, but site-level rate limiting requires slower step pacing or proxies.
