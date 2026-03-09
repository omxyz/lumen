# References: Agentic Web Browsing Research (2024-2026)

Academic papers and techniques relevant to Lumen's architecture. Organized by applicability.

---

## Tier 1: High Impact, Low Effort

### CATTS — Confidence-Aware Test-Time Scaling
- **Date**: February 2026
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Use vote-derived uncertainty to allocate compute only when decisions are contentious. Sample N candidate actions per step, measure agreement. If unanimous, act immediately. If split, allocate more compute (re-sample, reflect, critique).
- **Results**: +9.1% over ReAct baseline, 2.3x fewer tokens on average.
- **Lumen relevance**: Highest ROI change. On easy steps (clear next action), skip extra reasoning and save tokens. On hard steps (after nudge, failed form interaction), sample multiple candidates and pick the best. Can be implemented as a wrapper around the model adapter's `step()` method.

### Reflexion — Verbal Self-Reflection on Retry
- **Date**: NeurIPS 2023
- **Link**: [arXiv 2303.11366](https://arxiv.org/abs/2303.11366)
- **Key idea**: After a failed task attempt, generate a verbal self-reflection explaining what went wrong. Inject the reflection (not raw judge feedback) on the next retry attempt.
- **Results**: Significant improvements across reasoning, coding, and decision-making benchmarks.
- **Lumen relevance**: Lumen already has retry logic with `previousFeedback`. Enhance it by generating structured reflections ("I failed because I clicked the wrong date picker — next time, use URL parameters for dates on this site").

### OpenCUA — Three-Level Reasoning
- **Date**: COLM 2025
- **Link**: [arXiv 2508.09123](https://arxiv.org/abs/2508.09123)
- **Key idea**: Decompose each step into OBSERVATION → REFLECTION → ACTION. Observation describes what's on screen, reflection reasons about what to do, action executes.
- **Lumen relevance**: Lumen partially does this via "THINK FIRST" prompts. Could formalize into explicit structured output fields.

### ColorBrowserAgent — Adaptive Knowledge Base
- **Date**: January 2026
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Maintains an adaptive knowledge base of 52 rules injected into prompts (site-specific tips, UI patterns). Uses knowledge-aligned progressive summarization: completed sub-goals compressed to one line, active sub-goal keeps full detail. Belief state tracks sub-goal completion to prevent decision drift.
- **Results**: 71.2% on WebArena.
- **Lumen relevance**: Two applicable ideas: (1) After successful eval runs, extract "what worked" as site-specific rules (e.g., "Google Flights: use URL params for dates"). Inject matching rules on future runs. Compounds over time. (2) Replace fixed compaction window with sub-goal-aware summarization that preserves active context.

---

## Tier 2: High Impact, Medium Effort

### WAC — World-Model-Augmented Action Correction
- **Date**: February 2026
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Before executing an action, a world model predicts what the screenshot *should* look like afterward. After executing, a judge compares predicted vs actual. Mismatch triggers corrective feedback injected into the next step.
- **Results**: +1.8% on VisualWebArena.
- **Lumen relevance**: Use a cheap model (Flash/Haiku) as world model. Adds 1 LLM call per step but catches wrong clicks/navigations immediately instead of waiting for stuck detection. Could be applied selectively (only after form interactions or navigation).

### BacktrackAgent — Error Detection + Backtracking
- **Date**: May 2025, EMNLP
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Three components: Verifier (did the action succeed?), Judger (is current state recoverable or do we need to go back?), Reflector (what went wrong and what to try differently). If unrecoverable, backtrack to last known-good state.
- **Results**: +7.6% task success rate on Mobile3M/Auto-UI benchmarks.
- **Lumen relevance**: Our stuck detection is reactive (waits for repetition patterns). BacktrackAgent is proactive — catches mistakes 1 step after they happen. Could integrate a verifier into perception.ts post-action phase. CDP supports state checkpointing via `Page.captureSnapshot()`.

### Agent Workflow Memory (AWM)
- **Date**: ICML 2025
- **Link**: [arXiv 2409.07429](https://arxiv.org/abs/2409.07429)
- **Key idea**: Extract reusable multi-step routines from successful runs. Store as named workflows with triggers (e.g., "book flight" → steps 1-7). On new tasks, match and inject the workflow as a suggested plan in the system prompt.
- **Results**: +24.6% on Mind2Web, +51.1% on WebArena.
- **Lumen relevance**: After eval runs, mine successful trajectories for reusable patterns. Store in a workflow library. Inject matched workflows into prompts for similar future tasks.

### Best-of-N Action Sampling (Agent Q)
- **Date**: ICLR 2025
- **Link**: [arXiv 2408.07199](https://arxiv.org/abs/2408.07199)
- **Key idea**: Generate N candidate actions per step, score each with a lightweight critic model, pick the highest-scored action. Combined with MCTS for multi-step lookahead.
- **Results**: +76.57% relative improvement with MCTS + self-critique.
- **Lumen relevance**: Full MCTS is expensive, but best-of-3 sampling with a cheap critic (Flash) is practical. Related to CATTS but with explicit scoring rather than agreement voting.

### AgentFold — Proactive Context Folding
- **Date**: Alibaba, 2025
- **Link**: [arXiv 2510.24699](https://arxiv.org/abs/2510.24699)
- **Key idea**: Agent-controlled compression via a new `fold_context` tool. The agent decides when to compress completed sub-tasks into summaries while keeping the current sub-task detailed.
- **Results**: 92% context reduction vs ReAct at 100 turns.
- **Lumen relevance**: Our compaction is triggered by token thresholds. AgentFold gives the agent explicit control — it calls `fold_context` when it finishes a sub-task. Could add this as a new tool alongside `update_state`.

### TTI / Thinking vs Doing — Test-Time Interaction Scaling
- **Date**: September 2025, NeurIPS
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Scaling test-time *interaction* (more steps, more exploration) beats scaling test-time *thinking* (longer CoT). Uses curriculum-based online RL to train agents that explore more effectively.
- **Results**: SOTA on WebVoyager and WebArena with Gemma 3 12B.
- **Lumen relevance**: Validates our maxSteps=50 approach. Suggests biasing toward action over long reasoning chains. Consider: shorten CoT prompts, increase maxSteps, encourage trying things rather than deliberating. Cheaper per step, more total attempts.

---

## Tier 3: High Impact, High Effort

### Tree Search with Browser Snapshots
- **Date**: CMU, ICLR 2025
- **Link**: [jykoh.com](https://jykoh.com)
- **Key idea**: Save CDP browser state at decision points, explore multiple action branches, backtrack on failure. Best-first search prioritizes promising branches.
- **Results**: +39.7% relative improvement on VisualWebArena.
- **Lumen relevance**: CDP supports `Page.captureSnapshot()` for state save/restore. Could save checkpoints every 5 steps and restore on stuck detection instead of just nudging.

### Hierarchical Planner-Executor (Agent-E)
- **Date**: 2024
- **Link**: [arXiv 2407.13032](https://arxiv.org/html/2407.13032v1)
- **Key idea**: Separate high-level planning from low-level browser interaction. Planner decomposes task into sub-goals; executor handles one sub-goal at a time with its own action loop.
- **Results**: +20% over prior SOTA.
- **Lumen relevance**: Would require significant architectural changes. Currently Lumen uses a single loop. A planner layer could help with complex multi-step tasks (e.g., "compare flights across 3 airlines").

### WALT — Website As Reusable Tools
- **Date**: October 2025, Salesforce
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Automatically reverse-engineers website UI into callable tools via a demonstrate-generate-validate loop. Observe interactions → generate tool code (e.g., `search_flights(from, to, date)`) → validate the tool works.
- **Results**: 52.9% VisualWebArena, 50.1% WebArena.
- **Lumen relevance**: Could auto-generate site-specific tools from successful eval runs. Ambitious but would massively speed up repeat visits. Generated tools bypass vision grounding entirely.

### Hybrid Vision+DOM Grounding (SeeAct)
- **Date**: ICML 2024
- **Link**: [arXiv 2401.01614](https://arxiv.org/abs/2401.01614)
- **Key idea**: Two-stage grounding: "what to do" (vision-based reasoning) → "where to do it" (DOM-based element selection). Supplements screenshots with accessibility tree metadata.
- **Results**: Pure vision grounding identified as the main accuracy bottleneck.
- **Lumen relevance**: Lumen is vision-first. Adding accessibility tree metadata as supplementary context could improve element targeting accuracy, especially for small or overlapping elements.

---

## Tier 4: Insights and Benchmarks

### FormFactory — Form-Filling Benchmark
- **Date**: June 2025
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Benchmark specifically for web form filling. Tests complex multi-field forms with interdependent fields, date pickers, dropdowns, autocomplete.
- **Results**: No model exceeds 5% accuracy on the hardest forms.
- **Lumen relevance**: Confirms forms are the single hardest bottleneck. Validates our form-specific prompt rules (fill one field at a time, verify after each, fall back to URL params). Suggests a specialized "form mode" could help.

### GroundCUA — Grounding Dataset from Human Demos
- **Date**: November 2025
- **Link**: [arXiv (forthcoming)]
- **Key idea**: 56K screenshots with 3.56M grounding annotations collected from human browsing demonstrations. GroundNext models trained on this data achieve SOTA with <1/10 the training data of alternatives.
- **Lumen relevance**: Could be used to fine-tune a grounding model if we ever train custom models. The annotation methodology (recording human demos) could also inform our workflow memory extraction.

### OpAgent — Online RL for Web Agents
- **Date**: February 2026
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Four-component pipeline: Planner (decompose task), Grounder (map to UI elements), Reflector (analyze failures), Summarizer (compress history). Trained with online RL using hybrid reward (task completion + step-level progress).
- **Results**: 71.6% on WebArena.
- **Lumen relevance**: The four-component decomposition is clean but requires training. The hybrid reward concept (dense step-level signal + sparse task completion) could inform our stuck detection.

### BrowserAgent — Human-Inspired Browsing
- **Date**: October 2025, TMLR
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Mimics human browsing patterns: targeted scrolling (not blind Page_Down), explicit memory mechanism for cross-page information. Two-stage training: SFT on demonstrations, then RFT (Reinforcement Fine-Tuning) with only 5.3K samples.
- **Results**: Competitive with much larger models.
- **Lumen relevance**: Our scrolling is already efficient (Page_Down). The explicit memory mechanism aligns with our `update_state` tool. Shows that small fine-tuned models can compete — relevant if we ever distill from large model traces.

### WMA — Web Agents with World Models
- **Date**: ICLR 2025
- **Link**: [arXiv (forthcoming)]
- **Key idea**: World model uses transition-focused observation abstraction — predicts state *differences* in natural language rather than full state. Used for policy verification: "if I click X, will the page change to show Y?"
- **Results**: Improvements on WebArena tasks.
- **Lumen relevance**: The transition-focused abstraction is more practical than full state prediction (WAC). Could be integrated as a lightweight verification step: "describe what changed" after each action.

### DigiRL — VLM-Based Progress Evaluation
- **Date**: NeurIPS 2024
- **Link**: [arXiv 2406.11896](https://arxiv.org/abs/2406.11896)
- **Key idea**: Replace pattern-matching progress checks with a VLM-based evaluator that answers "is the agent making progress toward the goal?" Provides denser signal than binary stuck detection.
- **Results**: Significant improvements in training efficiency.
- **Lumen relevance**: Could replace or supplement our repeat-detector with a VLM-based progress check every N steps. More nuanced than action-hash matching.

### Illusion of Progress — Critical Analysis of Web Agent Evaluation
- **Date**: 2025
- **Link**: [arXiv (forthcoming)]
- **Key idea**: Many reported gains in web agent papers come from eval-specific tricks (prompt tuning to specific benchmarks, cherry-picked task subsets) rather than generalizable improvements. Calls for standardized evaluation protocols.
- **Lumen relevance**: Reminds us to test improvements across diverse tasks, not just optimize for WebVoyager. Our 30-task diverse sample is a good start but should expand to WebArena/VisualWebArena for validation.

---

## Recommended Implementation Priority for Lumen

| Priority | Technique | Source | Effort | Expected Impact |
|----------|-----------|--------|--------|-----------------|
| 1 | Confidence-aware action voting | CATTS | Low | +5-10%, saves tokens |
| 2 | Post-action verification | BacktrackAgent, WAC | Low | Catches errors early |
| 3 | Progressive sub-goal summarization | ColorBrowserAgent | Medium | Better compaction |
| 4 | Site-specific knowledge base | ColorBrowserAgent, AWM | Medium | Compounds over time |
| 5 | Structured self-reflection on retry | Reflexion | Low | Better retry quality |
| 6 | Interaction scaling (more steps, less thinking) | TTI | Low | More attempts per task |
| 7 | Browser state checkpointing | Tree Search, BacktrackAgent | High | Real backtracking |
| 8 | Website-as-tools generation | WALT | High | Skip vision grounding |
