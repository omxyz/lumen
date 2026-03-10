# Navigating Tricky Sites

Some websites have quirks — date pickers that don't respond to clicks, cookie banners that block interaction, or search results that load asynchronously. SiteKB lets you teach the agent site-specific tricks so it doesn't waste steps figuring them out.

## How it works

SiteKB injects domain-matched rules into the agent's system prompt before each step. When the current URL matches a domain pattern, the corresponding rules appear as `SITE-SPECIFIC TIPS` in the prompt.

## Loading rules from a file

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  siteKB: "./site-kb.json",
});
```

The JSON file is an array of `{ domain, rules }` objects:

```json
[
  {
    "domain": "google.com/travel",
    "rules": [
      "Google Flights date picker is unreliable. Construct the URL directly with date params.",
      "Results load asynchronously — wait 2s after search before reading results"
    ]
  },
  {
    "domain": "*.booking.com",
    "rules": [
      "Dismiss cookie banner before interacting with the page",
      "URL tracking params change frequently — ignore query string differences"
    ]
  }
]
```

## Inline rules

Pass rules directly in the agent options:

```typescript
const agent = new Agent({
  model: "anthropic/claude-sonnet-4-6",
  browser: { type: "local" },
  siteKB: [
    { domain: "*.mycompany.com", rules: ["Search bar is top-right", "Use sidebar nav"] },
    { domain: "internal.tools.com", rules: ["Login uses SSO — click 'Sign in with Google'"] },
  ],
});
```

## Domain matching

Patterns match against the full `hostname + pathname`:

| Pattern | Matches |
|---------|---------|
| `google.com/travel` | `www.google.com/travel/flights`, `www.google.com/travel/hotels` |
| `*.booking.com` | `www.booking.com`, `secure.booking.com` |
| `github.com` | `github.com/any/path` |

Wildcard prefix (`*.`) matches any subdomain. All other patterns use substring matching against `hostname + pathname`.

## Default knowledge base

Lumen ships with a default knowledge base at `src/memory/default-site-kb.json` covering common sites like Google Flights, Booking.com, Amazon, GitHub, ESPN, and others. These rules were learned from evaluation runs and encode workarounds for known site quirks.

To use the defaults:

```typescript
siteKB: "./src/memory/default-site-kb.json"
```

## Building your own knowledge base

The `SiteKB` class supports programmatic rule management:

```typescript
import { SiteKB } from "@omxyz/lumen";

const kb = SiteKB.fromFile("./site-kb.json");
kb.addRule("newsite.com", "Click 'Accept All' on the cookie popup first");
kb.save("./site-kb.json");
```

A good workflow: run evaluations, note where the agent struggles, and add targeted rules. Knowledge compounds over time — each rule prevents wasted steps on future runs.
