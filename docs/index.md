---
layout: home
hero:
  name: Lumen
  text: Vision-first browser agent
  tagline: "Selectors break. AI agents loop forever. Lumen is the middle ground."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /architecture/overview
features:
  - title: Vision-only loop
    details: Screenshot → model → action → repeat. No DOM, no selectors.
  - title: Multi-provider
    details: Anthropic, Google, OpenAI, or any OpenAI-compatible endpoint.
  - title: History compression
    details: Screenshot drop + LLM summarization. Stays in budget on long tasks.
  - title: Streaming
    details: agent.stream() yields typed StreamEvent objects for real-time UI.
  - title: Safety
    details: Domain policies, action hooks, and completion verification gates.
  - title: Session resumption
    details: Serialize to JSON, restore with Agent.resume().
---
