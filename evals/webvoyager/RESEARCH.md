# Academic Research: Agentic Web Browsing (for Lumen)

## Top Techniques to Incorporate (Prioritized)

### Tier 1: High Impact, Low Effort

**1. Reflexion-style retry** (NeurIPS 2023, [2303.11366](https://arxiv.org/abs/2303.11366))
- After failed task, generate verbal self-reflection explaining what went wrong
- Inject reflection on retry instead of just raw judge feedback
- Lumen already has retry logic — enhance the `previousFeedback` mechanism

**2. Agent Workflow Memory / AWM** (ICML 2025, [2409.07429](https://arxiv.org/abs/2409.07429))
- Extract reusable multi-step routines from successful runs
- Store as named workflows with triggers (e.g. "book flight" → steps)
- Inject matched workflow as suggested plan in system prompt
- 24.6% improvement on Mind2Web, 51.1% on WebArena

**3. OpenCUA three-level reasoning** (COLM 2025, [2508.09123](https://arxiv.org/abs/2508.09123))
- OBSERVATION → REFLECTION → ACTION decomposition
- Lumen already partially does this; formalize it in prompts

### Tier 2: High Impact, Medium Effort

**4. Best-of-N action sampling** (from Agent Q, [2408.07199](https://arxiv.org/abs/2408.07199))
- Generate 3 candidate actions per step, score with lightweight critic
- Pick highest-scored action. Doubles API cost but improves accuracy
- Agent Q: 76.57% relative improvement with MCTS + self-critique

**5. AgentFold proactive context folding** (Alibaba 2025, [2510.24699](https://arxiv.org/abs/2510.24699))
- Agent-controlled compression: new `fold_context` tool
- Compress completed sub-tasks into summaries; keep current sub-task detailed
- 92% context reduction vs ReAct at 100 turns

**6. Value-based progress evaluation** (DigiRL concept, [2406.11896](https://arxiv.org/abs/2406.11896))
- Replace pattern-matching nudges with VLM-based "is agent making progress?" check
- Denser signal than binary stuck detection

### Tier 3: High Impact, High Effort

**7. Tree search with browser snapshots** (CMU ICLR 2025, jykoh.com)
- Save CDP state at decision points, explore branches, backtrack on failure
- 39.7% relative improvement on VisualWebArena
- CDP supports `Page.captureSnapshot()` for state save/restore

**8. Hierarchical planner-executor** (Agent-E, [2407.13032](https://arxiv.org/html/2407.13032v1))
- Separate high-level planning from low-level browser interaction
- Planner decomposes task into sub-goals; executor handles one sub-goal at a time

**9. Hybrid vision+DOM grounding** (SeeAct, ICML 2024, [2401.01614](https://arxiv.org/abs/2401.01614))
- Supplement screenshots with accessibility tree metadata for precise targeting
- Two-stage: "what to do" (vision) → "where to do it" (DOM grounding)
- Key finding: pure vision grounding is the main bottleneck

## Key Papers

| Paper | Venue | Key Idea | Impact |
|-------|-------|----------|--------|
| WebVoyager | ACL 2024 | Screenshot + set-of-mark benchmark | Foundation |
| SeeAct | ICML 2024 | Grounding is the bottleneck | Hybrid DOM+vision |
| Agent Q | ICLR 2025 | MCTS + self-critique | +76.57% |
| Tree Search for LM Agents | ICLR 2025 | Best-first search with snapshots | +39.7% |
| Reflexion | NeurIPS 2023 | Verbal self-reflection on retry | Low-effort win |
| AWM | ICML 2025 | Reusable workflow memory | +51.1% WebArena |
| DigiRL | NeurIPS 2024 | VLM-based progress evaluator | Dense signal |
| AgentFold | 2025 | Proactive context folding | 92% ctx reduction |
| OpenCUA | COLM 2025 | 3-level reasoning CoT | Structured thinking |
| WebRL | ICLR 2025 | Self-evolving curriculum RL | Training |
| Agent-E | 2024 | Hierarchical planner-navigator | +20% SOTA |
| Plan-and-Act | 2025 | Explicit plan/execute separation | Dynamic replanning |

## Benchmarks to Consider

- **WebArena** (812 tasks, self-hosted, reproducible)
- **VisualWebArena** (910 visual tasks)
- **BrowseComp** (OpenAI, 1266 long-horizon problems)
- **Online-Mind2Web** (300 live-website tasks)
