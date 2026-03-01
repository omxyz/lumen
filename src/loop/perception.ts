import type { BrowserTab } from "../browser/tab.js";
import type { ModelAdapter, ModelResponse, StepContext } from "../model/adapter.js";
import type { ActionExecution, CUAAction, LoopOptions, LoopResult, PreActionHook, SemanticStep, TokenUsage } from "../types.js";
import type { CompletionGate } from "./gate.js";
import type { LoopMonitor } from "./monitor.js";
import { ConsoleMonitor } from "./monitor.js";
import { StateStore } from "./state.js";
import { HistoryManager } from "./history.js";
import { ActionRouter, type RouterTiming } from "./router.js";
import type { SessionPolicy } from "./policy.js";
import { LumenLogger } from "../logger.js";

const CUA_TOOLS: CUAAction["type"][] = [
  "click", "doubleClick", "drag", "scroll",
  "type", "keyPress", "wait", "goto",
  "writeState", "screenshot", "terminate",
  "hover", "delegate",
];

export interface PerceptionLoopOptions {
  tab: BrowserTab;
  adapter: ModelAdapter;
  history: HistoryManager;
  state: StateStore;
  policy?: SessionPolicy;
  gate?: CompletionGate;
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
}

export class PerceptionLoop {
  private readonly tab: BrowserTab;
  private readonly adapter: ModelAdapter;
  private readonly history: HistoryManager;
  private readonly state: StateStore;
  private readonly policy?: SessionPolicy;
  private readonly gate?: CompletionGate;
  private readonly monitor: LoopMonitor;
  private readonly router: ActionRouter;
  private readonly preActionHook?: PreActionHook;
  private readonly keepRecentScreenshots: number;
  private readonly cursorOverlay: boolean;
  private readonly compactionAdapter: ModelAdapter;
  private readonly log: LumenLogger;

  constructor(opts: PerceptionLoopOptions) {
    this.tab = opts.tab;
    this.adapter = opts.adapter;
    this.history = opts.history;
    this.state = opts.state;
    this.policy = opts.policy;
    this.gate = opts.gate;
    this.monitor = opts.monitor ?? new ConsoleMonitor();
    this.preActionHook = opts.preActionHook;
    this.keepRecentScreenshots = opts.keepRecentScreenshots ?? 2;
    this.cursorOverlay = opts.cursorOverlay ?? true;
    this.compactionAdapter = opts.compactionAdapter ?? opts.adapter;
    this.log = opts.log ?? LumenLogger.NOOP;
    this.router = new ActionRouter(opts.timing, this.log);
  }

  async run(options: LoopOptions): Promise<LoopResult> {
    const threshold = options.compactionThreshold ?? 0.8;

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

      // 2. Screenshot (with cursor overlay at last click position if enabled)
      const screenshot = await this.tab.screenshot({ cursorOverlay: this.cursorOverlay });

      // 2b. Store screenshot in wire history so the model sees its full visual navigation trail.
      //     This is the "after" state of the previous step's actions (or the initial page for step 0).
      this.history.appendScreenshot(screenshot.data.toString("base64"), step);

      // 3. Build step context — state re-injected every step regardless of compaction
      const context: StepContext = {
        screenshot,
        wireHistory: this.history.wireHistory(),
        agentState: this.state.current(),
        stepIndex: step,
        maxSteps: options.maxSteps,
        url: this.tab.url(),
        systemPrompt: options.systemPrompt,
      };

      this.monitor.stepStarted(step, context);

      const stepStart = Date.now();
      const stepActions: SemanticStep["actions"] = [];
      let stepUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      let thinking: string | undefined;

      // 4. Stream model actions and execute mid-stream.
      //    Wire ordering is maintained by buffering outcomes during the stream and
      //    replaying them AFTER recording the assistant turn:
      //    [screenshot → assistant → tool_result...] ← correct Anthropic format
      const bufferedOutcomes: Array<{ action: CUAAction; wireOutcome: { ok: boolean; error?: string } }> = [];
      let terminated = false;
      let terminationResult: LoopResult | null = null;

      this.log.adapter(
        `step ${step + 1}: stream start | model=${this.adapter.modelId} histMsgs=${context.wireHistory.length}`,
        { step: step + 1, model: this.adapter.modelId, histMsgs: context.wireHistory.length },
      );
      const modelT0 = Date.now();

      for await (const action of this.adapter.stream(context)) {
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

        // 5d. Termination check
        if (outcome.terminated) {
          if (this.gate) {
            const currentScreenshot = await this.tab.screenshot();
            const gateResult = await this.gate.verify(currentScreenshot, this.tab.url());
            if (!gateResult.passed) {
              const reason = gateResult.reason ?? "completion condition not met";
              this.log.loop(`step ${step + 1}: termination rejected by gate: ${reason}`);
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
          const noopAction: CUAAction = { type: "screenshot" };
          const noopId = `toolu_noop_${Date.now()}`;
          streamResponse.actions.push(noopAction);
          if (!streamResponse.toolCallIds) streamResponse.toolCallIds = [];
          streamResponse.toolCallIds.push(noopId);
          bufferedOutcomes.push({ action: noopAction, wireOutcome: { ok: true } });
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

    const result: LoopResult = {
      status: "maxSteps",
      result: "Maximum steps reached without completion",
      steps: options.maxSteps,
      history: this.history.semanticHistory(),
      agentState: this.state.current(),
    };
    this.monitor.terminated(result);
    return result;
  }
}

// suppress unused import warning — CUA_TOOLS used as documentation
void CUA_TOOLS;
