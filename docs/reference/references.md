# References

Research papers and projects that influenced Lumen's design and implementation.

## Projects

| Project | Impact on Lumen |
|---------|-----------------|
| **Stagehand** — [github.com/browserbase/stagehand](https://github.com/browserbase/stagehand) | CUA mode reference — Playwright-based browser agent with observe/act/extract API. ActCache with DOM fingerprinting inspired Lumen's self-healing deterministic replay |
| **browser-use** — [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use) | Python browser agent — vision + DOM hybrid, multi-tab support, agent chain architecture |
| **Claude Code** — [claude.com/claude-code](https://claude.com/claude-code) | Agentic loop design — tool-use pattern, streaming actions, context compaction strategy |
| **Ralph Loop** — [oh-my-claudecode](https://github.com/nicobailon/oh-my-claudecode) | Self-referential execution loop — iterate until verified complete, with architect verification gate |

## Papers

| Paper | Impact on Lumen |
|-------|-----------------|
| **CATTS** — Confidence-Aware Test-Time Scaling (2026) | `ConfidenceGate` — multi-sample on hard steps, skip extra compute on easy ones |
| **BacktrackAgent** — Error Detection + Backtracking (EMNLP 2025) | `ActionVerifier` — heuristic post-action checks (click target, input focus, goto host) |
| **Tree Search with Browser Snapshots** (ICLR 2025, CMU) | `CheckpointManager` — save CDP state every N steps, backtrack on level 8+ stuck |
| **ColorBrowserAgent** — Adaptive Knowledge Base (2026) | `SiteKB` — domain-specific navigation rules injected into prompts |
| **Agent Workflow Memory** (ICML 2025) [arXiv 2409.07429](https://arxiv.org/abs/2409.07429) | `WorkflowMemory` — reusable multi-step routines from successful runs |
| **AgentFold** — Proactive Context Folding (Alibaba 2025) [arXiv 2510.24699](https://arxiv.org/abs/2510.24699) | `fold` action — agent-controlled context compression for completed sub-tasks |
| **OpenCUA** — Three-Level Reasoning (COLM 2025) [arXiv 2508.09123](https://arxiv.org/abs/2508.09123) | Structured reasoning prompts — THINK FIRST, CHECKPOINT PROGRESS every 3-5 steps |
| **TTI** — Test-Time Interaction Scaling (NeurIPS 2025) | Action-biased prompts — "ACT DECISIVELY", favor exploration over long reasoning chains |
| **Reflexion** — Verbal Self-Reflection (NeurIPS 2023) [arXiv 2303.11366](https://arxiv.org/abs/2303.11366) | Retry with judge feedback — structured reflection injected on retry attempts |
| **FormFactory** — Form-Filling Benchmark (2025) | Form-specific prompt rules — fill one field at a time, verify after each, use URL params as fallback |
| **Agent Q** — Best-of-N Sampling (ICLR 2025) [arXiv 2408.07199](https://arxiv.org/abs/2408.07199) | Informed confidence gate design — scoring vs agreement voting tradeoffs |
| **SeeAct** — Hybrid Vision+DOM Grounding (ICML 2024) [arXiv 2401.01614](https://arxiv.org/abs/2401.01614) | Validated vision-first design — pure vision grounding identified as main bottleneck |
| **BrowserAgent** — Human-Inspired Browsing (TMLR 2025) | `writeState` persistent memory — explicit cross-page information retention |
| **DigiRL** — VLM-Based Progress Evaluation (NeurIPS 2024) [arXiv 2406.11896](https://arxiv.org/abs/2406.11896) | Informed `RepeatDetector` design — progress evaluation beyond pattern matching |
| **WAC** — World-Model-Augmented Action Correction (2026) | Informed `ModelVerifier` — predict expected outcome, compare with actual |
| **Agent-E** — Hierarchical Planner-Executor (2024) [arXiv 2407.13032](https://arxiv.org/abs/2407.13032) | `delegate` action — hand off sub-tasks to a child loop |
| **Illusion of Progress** (2025) | Eval methodology — test across diverse sites, not just benchmark-specific tuning |
