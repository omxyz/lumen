import type { BrowserTab } from "../browser/tab";
import type { ModelAdapter, ModelResponse, StepContext } from "../model/adapter";
import type { ActionExecution, Action, LoopOptions, LoopResult, PreActionHook, SemanticStep, TokenUsage } from "../types";
import type { Verifier } from "./verifier";
import type { LoopMonitor } from "./monitor";
import { ConsoleMonitor } from "./monitor";
import { StateStore } from "./state";
import { HistoryManager } from "./history";
import { ActionRouter, type RouterTiming } from "./router";
import type { SessionPolicy } from "./policy";
import { LumenLogger } from "../logger";
import { RepeatDetector, nudgeMessage } from "./repeat-detector";
import { ActionCache, screenshotHash, viewportMismatch } from "./action-cache";
import type { ConfidenceGate } from "./confidence-gate";
import type { ActionVerifier } from "./action-verifier";
import type { CheckpointManager } from "./checkpoint";
import type { SiteKB } from "../memory/site-kb";
import type { WorkflowMemory } from "../memory/workflow";

const CUA_TOOLS: Action["type"][] = [
  "click", "doubleClick", "drag", "scroll",
  "type", "keyPress", "wait", "goto",
  "writeState", "screenshot", "terminate",
  "hover", "delegate", "fold",
];

export interface PerceptionLoopOptions {
  tab: BrowserTab;
  adapter: ModelAdapter;
  history: HistoryManager;
  state: StateStore;
  policy?: SessionPolicy;
  verifier?: Verifier;
  monitor?: LoopMonitor;
  timing?: RouterTiming;
  /** Optional hook called before every action. Return deny to block with reason. */
  preActionHook?: PreActionHook;
  /** Number of recent screenshots to keep in wire history. Default: 2. */
  keepRecentScreenshots?: number;
  /** Composite cursor dot at last click position in screenshots. Default: true. */
  cursorOverlay?: boolean;
  /** Optional adapter used for compaction summarization (defaults to main adapter). */
  compactionAdapter?: ModelAdapter;
  /** Granular debug logger. */
  log?: LumenLogger;
  /** Enable action caching. Pass a directory path to enable, or omit to disable. */
  cacheDir?: string;
  /** CATTS-inspired confidence gate: multi-sample on hard steps. */
  confidenceGate?: ConfidenceGate;
  /** BacktrackAgent-inspired post-action verifier. */
  actionVerifier?: ActionVerifier;
  /** Browser state checkpointing for backtracking on stuck detection. */
  checkpointManager?: CheckpointManager;
  /** Site-specific knowledge base for domain-matched prompt tips. */
  siteKB?: SiteKB;
  /** AWM-inspired workflow memory for injecting past success patterns. */
  workflowMemory?: WorkflowMemory;
}

export class PerceptionLoop {
  private readonly tab: BrowserTab;
  private readonly adapter: ModelAdapter;
  private readonly history: HistoryManager;
  private readonly state: StateStore;
  private readonly policy?: SessionPolicy;
  private readonly verifier?: Verifier;
  private readonly monitor: LoopMonitor;
  private readonly router: ActionRouter;
  private readonly preActionHook?: PreActionHook;
  private readonly keepRecentScreenshots: number;
  private readonly cursorOverlay: boolean;
  private readonly compactionAdapter: ModelAdapter;
  private readonly log: LumenLogger;
  private readonly repeatDetector = new RepeatDetector();
  private readonly actionCache: ActionCache | null;
  private readonly confidenceGate?: ConfidenceGate;
  private readonly actionVerifier?: ActionVerifier;
  private readonly checkpointManager?: CheckpointManager;
  private readonly siteKB?: SiteKB;
  private readonly workflowMemory?: WorkflowMemory;

  constructor(opts: PerceptionLoopOptions) {
    this.tab = opts.tab;
    this.adapter = opts.adapter;
    this.history = opts.history;
    this.state = opts.state;
    this.policy = opts.policy;
    this.verifier = opts.verifier;
    this.monitor = opts.monitor ?? new ConsoleMonitor();
    this.preActionHook = opts.preActionHook;
    this.keepRecentScreenshots = opts.keepRecentScreenshots ?? 2;
    this.cursorOverlay = opts.cursorOverlay ?? true;
    this.compactionAdapter = opts.compactionAdapter ?? opts.adapter;
    this.log = opts.log ?? LumenLogger.NOOP;
    this.router = new ActionRouter(opts.timing, this.log);
    this.actionCache = opts.cacheDir ? new ActionCache(opts.cacheDir) : null;
    this.confidenceGate = opts.confidenceGate;
    this.actionVerifier = opts.actionVerifier;
    this.checkpointManager = opts.checkpointManager;
    this.siteKB = opts.siteKB;
    this.workflowMemory = opts.workflowMemory;
  }

  /**
   * Attempt to serve a step from cache.
   * Returns cached action + outcome on hit, or null to fall through to model.
   * Self-healing: if cached action fails execution, returns null so model can take over.
   */
  private async tryCache(
    step: number,
    url: string,
    instructionHash: string,
    screenshot: { data: Buffer; width: number; height: number },
    tab: BrowserTab,
  ): Promise<{ action: Action; outcome: ActionExecution } | null> {
    if (!this.actionCache) return null;

    try {
      const key = this.actionCache.stepKey(url, instructionHash);
      const cached = await this.actionCache.get(key);
      if (!cached) return null;

      this.log.loop(`step ${step + 1}: cache HIT — replaying ${cached.type} action`);

      // Viewport mismatch warning (informational only)
      const viewport = { width: screenshot.width, height: screenshot.height };
      if (viewportMismatch(cached, viewport)) {
        this.log.loop(
          `step ${step + 1}: viewport mismatch — cached ${cached.viewport?.width}x${cached.viewport?.height}, current ${viewport.width}x${viewport.height}`,
        );
      }

      // Reconstruct Action from cached args
      const action = cached.args as unknown as Action;

      // Execute via router — this is where self-healing kicks in
      const outcome = await this.router.execute(action, tab, this.state);

      if (!outcome.ok) {
        // Self-healing: cached action failed, fall through to model
        this.log.loop(`step ${step + 1}: cached action FAILED (${outcome.error}) — self-healing via model`);
        return null;
      }

      // Success — inject synthetic wire history (noop pattern from line 490)
      const toolCallId = `toolu_cache_${Date.now()}`;
      const syntheticResponse: ModelResponse = {
        actions: [action],
        toolCallIds: [toolCallId],
        thinking: undefined,
        usage: { inputTokens: 0, outputTokens: 0 },
        rawResponse: null,
      };
      this.history.appendResponse(syntheticResponse);
      this.history.appendActionOutcome(action, outcome);

      return { action, outcome };
    } catch (err) {
      // Fail-open: any cache error → silently fall through to model
      this.log.loop(`step ${step + 1}: cache error — ${err}`);
      return null;
    }
  }

  async run(options: LoopOptions): Promise<LoopResult> {
    const threshold = options.compactionThreshold ?? 0.8;
    let pendingNudge: string | undefined;
    let nudgeSource: "action" | "url" | undefined; // Track nudge origin for clearing logic
    let lastNormalizedUrl = ""; // Track URL for clearing URL nudges
    let lastOutcomeFailed = false; // Track for confidence gate
    let hasBacktracked = false; // Prevent repeated backtracking

    for (let step = 0; step < options.maxSteps; step++) {
      // ── Step start ──────────────────────────────────────────────────────────
      if (this.log.loopEnabled) {
        const util = this.history.tokenUtilization();
        const totalTokens = this.history.getTotalInputTokens();
        const ctxTokens = this.adapter.contextWindowTokens;
        const wireLen = this.history.wireHistory().length;
        this.log.loop(
          `step ${step + 1}/${options.maxSteps} start | url=${this.tab.url()} wire=${wireLen}msgs util=${(util * 100).toFixed(1)}% (${totalTokens}/${ctxTokens})`,
          { step: step + 1, url: this.tab.url(), wireLen, util, totalTokens, ctxTokens },
        );
      }

      // 1. Proactive compaction before context pressure hits
      if (this.history.tokenUtilization() > threshold) {
        const util = this.history.tokenUtilization();
        this.log.history(
          `step ${step + 1}: tier-2 compaction triggered (util=${(util * 100).toFixed(1)}% > threshold=${(threshold * 100).toFixed(0)}%)`,
        );

        const { tokensBefore, tokensAfter } = await this.history.compactWithSummary(
          this.compactionAdapter,
          this.state.current(),
        );
        this.monitor.compactionTriggered(step, tokensBefore, tokensAfter);

        this.log.history(
          `step ${step + 1}: tier-2 done | ${tokensBefore} → ${tokensAfter} tokens (~${(100 - (tokensAfter / tokensBefore) * 100).toFixed(0)}% reduction)`,
          { tokensBefore, tokensAfter },
        );

        this.history.compressScreenshots(this.keepRecentScreenshots);
        this.log.history(
          `step ${step + 1}: tier-1 compress (post-compaction) | keepRecent=${this.keepRecentScreenshots}`,
        );
      }

      // 1b. URL stall detection — too many steps on the same URL
      //     Also clear URL nudges when the page actually changes (SPA fix).
      const currentNormalized = normalizeUrlForStall(this.tab.url());
      if (nudgeSource === "url" && currentNormalized !== lastNormalizedUrl) {
        // Agent navigated away — clear the URL nudge and reset backtrack flag
        pendingNudge = undefined;
        nudgeSource = undefined;
        hasBacktracked = false;
      }
      lastNormalizedUrl = currentNormalized;

      // Always call recordUrl so the stall counter keeps incrementing (for escalation 5→8→12).
      const urlStall = this.repeatDetector.recordUrl(this.tab.url());
      if (urlStall !== null) {
        this.log.loop(`step ${step + 1}: URL stall detected at level ${urlStall} (url=${this.tab.url()})`);

        // Backtrack on level 8+ if checkpoint manager is available and we haven't already backtracked
        if (urlStall >= 8 && this.checkpointManager && !hasBacktracked) {
          const checkpoint = await this.checkpointManager.restore(this.tab);
          if (checkpoint) {
            hasBacktracked = true;
            if (checkpoint.agentState) this.state.write(checkpoint.agentState);
            pendingNudge = `BACKTRACKED to step ${checkpoint.step}. Your previous approach was stuck. Try a COMPLETELY different strategy — different elements, different navigation path, or URL parameters.`;
            nudgeSource = "url";
            this.log.loop(`step ${step + 1}: backtracked to checkpoint at step ${checkpoint.step}`);
          } else {
            pendingNudge = nudgeMessage(urlStall, "url");
            nudgeSource = "url";
          }
        } else {
          pendingNudge = nudgeMessage(urlStall, "url");
          nudgeSource = "url";
        }
      }

      // Checkpoint: save browser state periodically
      if (this.checkpointManager && step % this.checkpointManager.interval === 0) {
        await this.checkpointManager.save(step, this.tab.url(), this.state.current(), this.tab);
      }

      // 2. Screenshot (with cursor overlay at last click position if enabled)
      const screenshot = await this.tab.screenshot({ cursorOverlay: this.cursorOverlay });
      const currentScreenshotHash = this.actionCache ? screenshotHash(screenshot.data) : undefined;

      // 2b. Store screenshot in wire history so the model sees its full visual navigation trail.
      //     This is the "after" state of the previous step's actions (or the initial page for step 0).
      this.history.appendScreenshot(screenshot.data.toString("base64"), step);

      // 3. Build step context — state re-injected every step regardless of compaction
      //    Layer additional context: site KB, workflow hints, fold summaries, nudges.
      const promptParts: string[] = [];

      // Inject folded sub-goal summaries (persist across compaction)
      const foldedContext = this.history.getFoldedContext();
      if (foldedContext) promptParts.push(foldedContext);

      // Inject site-specific tips if URL matches
      if (this.siteKB) {
        const siteTips = this.siteKB.formatForPrompt(this.tab.url());
        if (siteTips) promptParts.push(siteTips);
      }

      // Inject workflow hint on first step only
      if (step === 0 && this.workflowMemory && options.systemPrompt) {
        const workflow = this.workflowMemory.match(options.systemPrompt, this.tab.url());
        if (workflow) promptParts.push(this.workflowMemory.toPromptHint(workflow));
      }

      // Nudges are STICKY — persist until productive action clears them
      if (pendingNudge) promptParts.push(pendingNudge);

      // Base system prompt last
      if (options.systemPrompt) promptParts.push(options.systemPrompt);

      const stepSystemPrompt = promptParts.length > 0 ? promptParts.join("\n\n") : undefined;

      const context: StepContext = {
        screenshot,
        wireHistory: this.history.wireHistory(),
        agentState: this.state.current(),
        stepIndex: step,
        maxSteps: options.maxSteps,
        url: this.tab.url(),
        systemPrompt: stepSystemPrompt,
      };

      this.monitor.stepStarted(step, context);

      // ── Cache-hit fast path ──────────────────────────────────────────────────
      if (options.instructionHash) {
        const cacheResult = await this.tryCache(step, this.tab.url(), options.instructionHash, screenshot, this.tab);
        if (cacheResult) {
          const { action, outcome } = cacheResult;

          // Record in repeat detector (prevents stuck loops from cached repeats)
          const repeatLevel = this.repeatDetector.record(action);
          if (repeatLevel !== null) {
            pendingNudge = nudgeMessage(repeatLevel);
            nudgeSource = "action";
          }

          // Handle termination
          if (outcome.terminated) {
            const result: LoopResult = {
              status: outcome.status!,
              result: outcome.result!,
              steps: step + 1,
              history: [],
              agentState: this.state.current(),
            };
            this.history.appendSemanticStep({
              stepIndex: step,
              url: this.tab.url(),
              screenshotBase64: screenshot.data.toString("base64"),
              thinking: undefined,
              actions: [{ action, outcome: { ok: outcome.ok, error: outcome.error } }],
              agentState: this.state.current(),
              tokenUsage: { inputTokens: 0, outputTokens: 0 },
              durationMs: 0,
            });
            result.history = this.history.semanticHistory();
            this.monitor.stepCompleted(step, { actions: [action], usage: { inputTokens: 0, outputTokens: 0 }, rawResponse: null } as ModelResponse);
            this.monitor.terminated(result);
            return result;
          }

          // Record in semantic history
          this.history.appendSemanticStep({
            stepIndex: step,
            url: this.tab.url(),
            screenshotBase64: screenshot.data.toString("base64"),
            thinking: undefined,
            actions: [{ action, outcome: { ok: outcome.ok, error: outcome.error } }],
            agentState: this.state.current(),
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
          });

          // Emit monitor callbacks (streaming parity)
          this.monitor.actionExecuted(step, action, outcome);
          this.monitor.stepCompleted(step, { actions: [action], usage: { inputTokens: 0, outputTokens: 0 }, rawResponse: null } as ModelResponse);

          // Tier-1 screenshot compression
          this.history.compressScreenshots(this.keepRecentScreenshots);
          continue; // skip model call, next step
        }
      }
      // ── End cache-hit fast path ──────────────────────────────────────────────

      const stepStart = Date.now();
      const stepActions: SemanticStep["actions"] = [];
      let stepUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let thinking: string | undefined;

      // 4. Stream model actions and execute mid-stream.
      //    Wire ordering is maintained by buffering outcomes during the stream and
      //    replaying them AFTER recording the assistant turn:
      //    [screenshot → assistant → tool_result...] ← correct Anthropic format
      const bufferedOutcomes: Array<{ action: Action; wireOutcome: { ok: boolean; error?: string } }> = [];
      let terminated = false;
      let terminationResult: LoopResult | null = null;

      this.log.adapter(
        `step ${step + 1}: stream start | model=${this.adapter.modelId} histMsgs=${context.wireHistory.length}`,
        { step: step + 1, model: this.adapter.modelId, histMsgs: context.wireHistory.length },
      );
      const modelT0 = Date.now();

      // Confidence gate: on hard steps, use multi-sampling instead of streaming
      const useConfidenceGate = this.confidenceGate?.isHardStep(pendingNudge, lastOutcomeFailed);
      const actionSource: AsyncIterable<Action> = useConfidenceGate && this.confidenceGate
        ? (async function* (gate, ctx) {
            const response = await gate.decide(ctx, true);
            // Cache the response for PerceptionLoop
            const adapterAny = gate as unknown as { _lastGateResponse?: ModelResponse };
            adapterAny._lastGateResponse = response;
            for (const a of response.actions) yield a;
          })(this.confidenceGate, context)
        : this.adapter.stream(context);

      // Save URL before actions for verifier comparison
      const preActionUrl = this.tab.url();

      for await (const action of actionSource) {
        if (terminated) {
          // Drain remaining stream actions without executing (e.g. if model emits multiple actions after terminate)
          continue;
        }

        // 5a. Pre-action hook check (runs before policy)
        if (this.preActionHook) {
          const hookDecision = await this.preActionHook(action);
          if (hookDecision.decision === "deny") {
            this.log.loop(`step ${step + 1}: action "${action.type}" denied by preActionHook: ${hookDecision.reason}`);
            const wireOutcome = { ok: false, error: hookDecision.reason };
            bufferedOutcomes.push({ action, wireOutcome });
            this.monitor.actionBlocked(step, action, hookDecision.reason);
            stepActions.push({ action, outcome: wireOutcome });
            continue;
          }
        }

        // 5b. Policy check
        if (this.policy) {
          const policyResult = this.policy.check(action);
          if (!policyResult.allowed) {
            this.log.loop(`step ${step + 1}: action "${action.type}" blocked by policy: ${policyResult.reason}`);
            const wireOutcome = { ok: false, error: policyResult.reason };
            bufferedOutcomes.push({ action, wireOutcome });
            this.monitor.actionBlocked(step, action, policyResult.reason!);
            stepActions.push({ action, outcome: wireOutcome });
            continue;
          }
        }

        // 5c. Execute
        const outcome = await this.router.execute(action, this.tab, this.state);

        // 5c-fold. Handle fold action — store summary in history
        if (action.type === "fold") {
          this.history.addFold(action.summary);
          this.log.loop(`step ${step + 1}: fold — "${action.summary.slice(0, 60)}"`);
          bufferedOutcomes.push({ action, wireOutcome: { ok: true } });
          stepActions.push({ action, outcome: { ok: true } });
          continue;
        }

        // 5c-verify. Post-action verification (BacktrackAgent-inspired)
        if (this.actionVerifier && !outcome.terminated && !outcome.isDelegateRequest) {
          const verification = await this.actionVerifier.verify(
            action, { ok: outcome.ok, error: outcome.error, clickTarget: (outcome as { clickTarget?: string }).clickTarget }, this.tab, preActionUrl,
          );
          if (!verification.success && verification.hint) {
            if (pendingNudge) {
              pendingNudge = `${pendingNudge}\n\n${verification.hint}`;
            } else {
              pendingNudge = verification.hint;
              nudgeSource = "action";
            }
            lastOutcomeFailed = true;
          }
        }

        // 5d. Termination check
        if (outcome.terminated) {
          if (this.verifier) {
            const currentScreenshot = await this.tab.screenshot();
            const verifyResult = await this.verifier.verify(currentScreenshot, this.tab.url());
            if (!verifyResult.passed) {
              const reason = verifyResult.reason ?? "completion condition not met";
              this.log.loop(`step ${step + 1}: termination rejected by verifier: ${reason}`);
              const wireOutcome = { ok: false, error: `terminate rejected: ${reason}` };
              bufferedOutcomes.push({ action, wireOutcome });
              this.monitor.terminationRejected(step, reason);
              stepActions.push({ action, outcome: wireOutcome });
              continue;
            }
          }
          // Accepted — drain remaining stream without executing
          terminated = true;
          bufferedOutcomes.push({ action, wireOutcome: { ok: true } });
          terminationResult = {
            status: outcome.status!,
            result: outcome.result!,
            steps: step + 1,
            history: [], // filled in after wire history is updated below
            agentState: this.state.current(),
          };
          this.log.loop(
            `step ${step + 1}: termination accepted | status=${outcome.status} result="${outcome.result?.slice(0, 80)}"`,
          );
          continue;
        }

        // 5d-delegate. Child loop delegation
        if (outcome.isDelegateRequest) {
          this.log.loop(`step ${step + 1}: spawning child loop — "${outcome.delegateInstruction?.slice(0, 60)}" maxSteps=${outcome.delegateMaxSteps ?? 20}`);
          const { ChildLoop } = await import("./child.js");
          const childResult = await ChildLoop.run(
            outcome.delegateInstruction!,
            { tab: this.tab, adapter: this.adapter },
            { maxSteps: outcome.delegateMaxSteps ?? 20 },
          );
          this.log.loop(
            `step ${step + 1}: child loop done | status=${childResult.status} steps=${childResult.steps}`,
          );
          const wireOutcome = {
            ok: childResult.status === "success",
            error: childResult.status !== "success" ? childResult.result : undefined,
          };
          bufferedOutcomes.push({ action, wireOutcome });
          this.monitor.actionExecuted(step, action, outcome);
          stepActions.push({ action, outcome: { ok: childResult.status === "success" } });
          continue;
        }

        // 5e. Normal action
        this.monitor.actionExecuted(step, action, outcome);
        stepActions.push({ action, outcome: { ok: outcome.ok, error: outcome.error } });
        bufferedOutcomes.push({ action, wireOutcome: { ok: outcome.ok, error: outcome.error } });
        lastOutcomeFailed = !outcome.ok;

        // 5e-clear. Clear nudge based on its source:
        //   - Action nudges: clear on any productive action (click, goto, writeState, etc.)
        //   - URL nudges: only clear when the URL actually changes (checked at step start above).
        //     On SPAs, clicks don't mean the agent left the page, so clicks must NOT clear URL nudges.
        //     Only goto/writeState/terminate indicate real progress on a stalled page.
        if (pendingNudge && nudgeSource === "action" && isProductiveAction(action)) {
          pendingNudge = undefined;
          nudgeSource = undefined;
        } else if (pendingNudge && nudgeSource === "url" && isUrlEscapeAction(action)) {
          pendingNudge = undefined;
          nudgeSource = undefined;
        }

        // 5f. Repeat detection — record after execution, stash nudge for next step
        const repeatLevel = this.repeatDetector.record(action);
        if (repeatLevel !== null) {
          this.log.loop(`step ${step + 1}: repeat detected at level ${repeatLevel}`);
          pendingNudge = nudgeMessage(repeatLevel);
          nudgeSource = "action";
        }

        // 5g. Action cache — store successful actions for replay on future runs
        if (this.actionCache && outcome.ok && options.instructionHash) {
          const key = this.actionCache.stepKey(this.tab.url(), options.instructionHash);
          const viewport = { width: screenshot.width, height: screenshot.height };
          this.actionCache.set(key, action, this.tab.url(), options.instructionHash, currentScreenshotHash, viewport).catch(() => {
            // Cache write failures are non-fatal
          });
        }
      }

      // 5h. Form state extraction — after form-related actions, extract input values via CDP
      //      and inject as a nudge for the next step. This gives the model explicit text feedback
      //      about what values are actually set in form fields (dates, filters, text inputs).
      //      Always inject — even when a repeat/stall nudge is pending (especially then, since
      //      the agent needs to know WHY it's stuck: "your form fields are still empty").
      const hadFormAction = bufferedOutcomes.some(({ action: a }) =>
        a.type === "click" || a.type === "doubleClick" || a.type === "type",
      );
      if (hadFormAction && !terminated) {
        try {
          const formState = await this.tab.evaluate<string>(`
            (() => {
              const fields = [];
              const empties = [];
              const inputs = document.querySelectorAll('input:not([type="hidden"]), select, textarea');
              for (const el of inputs) {
                if (!el.offsetParent && el.tagName !== 'INPUT') continue;
                const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
                if (!label) continue;
                const val = el.tagName === 'SELECT' ? el.options[el.selectedIndex]?.text : el.value;
                if (val) {
                  fields.push(label.slice(0, 30) + ': ' + val.slice(0, 50));
                } else {
                  empties.push(label.slice(0, 30));
                }
              }
              let result = '';
              if (fields.length > 0) result += 'FILLED: ' + fields.slice(0, 8).join(' | ');
              if (empties.length > 0) result += (result ? '\\n' : '') + 'EMPTY: ' + empties.slice(0, 6).join(', ');
              return result;
            })()
          `);
          if (formState && formState.length > 5) {
            const formNudge = `FORM STATE: ${formState}\nVerify these values match your intent. If a field is EMPTY or wrong, your previous action may not have worked — try clicking the field first, then typing.`;
            if (pendingNudge) {
              // Append form state to existing nudge — agent needs both signals
              pendingNudge = `${pendingNudge}\n\n${formNudge}`;
            } else {
              pendingNudge = formNudge;
              nudgeSource = "action"; // Clear on next productive action
            }
          }
        } catch {
          // CDP evaluation can fail on some pages (cross-origin, crashed context)
        }
      }

      // 6. After stream: record assistant turn FIRST (correct wire order), then tool results.
      //    adapter.getLastStreamResponse() returns the full ModelResponse (with token usage and
      //    toolCallIds) that was cached internally by the adapter during streaming.
      const adapterAny = this.adapter as { getLastStreamResponse?: () => ModelResponse | null };
      const streamResponse = adapterAny.getLastStreamResponse?.() ?? null;
      if (streamResponse) {
        const modelMs = Date.now() - modelT0;
        this.log.adapter(
          `step ${step + 1}: stream done | actions=${streamResponse.actions.length} in=${streamResponse.usage.inputTokens} out=${streamResponse.usage.outputTokens} (${modelMs}ms)`,
          {
            step: step + 1,
            actions: streamResponse.actions.length,
            inputTokens: streamResponse.usage.inputTokens,
            outputTokens: streamResponse.usage.outputTokens,
            cacheReadTokens: streamResponse.usage.cacheReadTokens,
            durationMs: modelMs,
          },
        );

        // If the model returned no tool_use blocks (text-only response), inject a screenshot
        // action so the loop continues and the model can observe the current page state.
        // We must also inject a synthetic toolCallId so the tool_result ID matches the
        // tool_use ID in the assistant turn — Anthropic rejects mismatched IDs.
        if (streamResponse.actions.length === 0) {
          this.log.loop(`step ${step + 1}: model returned no actions — injecting noop screenshot`);
          const noopAction: Action = { type: "screenshot" };
          const noopId = `toolu_noop_${Date.now()}`;
          streamResponse.actions.push(noopAction);
          if (!streamResponse.toolCallIds) streamResponse.toolCallIds = [];
          streamResponse.toolCallIds.push(noopId);
          bufferedOutcomes.push({ action: noopAction, wireOutcome: { ok: true } });

          // Record noop in repeat detector — noops were previously invisible
          const noopRepeat = this.repeatDetector.record(noopAction);
          if (noopRepeat !== null) {
            this.log.loop(`step ${step + 1}: noop repeat detected at level ${noopRepeat}`);
            pendingNudge = nudgeMessage(noopRepeat);
            nudgeSource = "action";
          }
        }
        this.history.appendResponse(streamResponse);
        stepUsage = streamResponse.usage;
        thinking = streamResponse.thinking;
        this.monitor.stepCompleted(step, streamResponse);
      }

      // Replay buffered action outcomes into wire history (tool_results)
      for (const { action, wireOutcome } of bufferedOutcomes) {
        this.history.appendActionOutcome(action, wireOutcome as ActionExecution);
      }

      // Record this step in semantic history (including the termination step, so
      // aggregateTokenUsage() accounts for ALL steps' token costs).
      this.history.appendSemanticStep({
        stepIndex: step,
        url: this.tab.url(),
        screenshotBase64: screenshot.data.toString("base64"),
        thinking,
        actions: stepActions,
        agentState: this.state.current(),
        tokenUsage: stepUsage,
        durationMs: Date.now() - stepStart,
      });

      // Return termination result with up-to-date semantic history
      if (terminationResult) {
        terminationResult.history = this.history.semanticHistory();

        // Extract workflow from successful runs for future reuse
        if (terminationResult.status === "success" && this.workflowMemory && options.systemPrompt) {
          try {
            const { WorkflowMemory: WM } = await import("../memory/workflow.js");
            const workflow = WM.extract(options.systemPrompt, terminationResult.history);
            if (workflow) this.workflowMemory.add(workflow);
          } catch {
            // Workflow extraction is non-critical
          }
        }

        this.monitor.terminated(terminationResult);
        return terminationResult;
      }

      // Tier-1 screenshot compression (always runs after each non-terminal step)
      this.history.compressScreenshots(this.keepRecentScreenshots);
      if (this.log.historyEnabled) {
        const wireLen = this.history.wireHistory().length;
        this.log.history(
          `step ${step + 1}: tier-1 compress | keepRecent=${this.keepRecentScreenshots} wire=${wireLen}msgs total`,
          { step: step + 1, wireLen, keepRecentScreenshots: this.keepRecentScreenshots },
        );
      }
    }

    // Extract best answer from agentState if available (model may have saved progress via update_state)
    let maxStepsResult = "Maximum steps reached without completion";
    const finalState = this.state.current();
    if (finalState && Object.keys(finalState).length > 0) {
      maxStepsResult = Object.entries(finalState)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("; ");
    }

    const result: LoopResult = {
      status: "maxSteps",
      result: maxStepsResult,
      steps: options.maxSteps,
      history: this.history.semanticHistory(),
      agentState: finalState,
    };
    this.monitor.terminated(result);
    return result;
  }
}

// suppress unused import warning — CUA_TOOLS used as documentation
void CUA_TOOLS;

/** Returns true for actions that indicate the agent is making progress, not stalling. */
function isProductiveAction(action: Action): boolean {
  switch (action.type) {
    case "click":
    case "doubleClick":
    case "goto":
    case "writeState":
    case "terminate":
    case "type":
    case "delegate":
    case "fold":
      return true;
    default:
      return false;
  }
}

/** Returns true for actions that can clear a URL stall nudge.
 *  On SPAs, clicks don't navigate away. And goto to the same page is just a reload.
 *  Only writeState (agent saved progress) or terminate (agent completed) indicate
 *  the agent actually responded to the nudge. Goto to a DIFFERENT page is handled
 *  by the URL change check at step start, not here. */
function isUrlEscapeAction(action: Action): boolean {
  switch (action.type) {
    case "writeState":
    case "terminate":
      return true;
    default:
      return false;
  }
}

/** Normalize URL to origin+pathname for stall comparison (mirrors RepeatDetector). */
function normalizeUrlForStall(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}
