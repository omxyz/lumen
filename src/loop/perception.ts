import type { BrowserTab } from "../browser/tab.js";
import type { ModelAdapter, ModelResponse, StepContext } from "../model/adapter.js";
import type { ActionExecution, CUAAction, LoopOptions, LoopResult, PreActionHook, SemanticStep, TokenUsage } from "../types.js";
import type { CompletionGate } from "./gate.js";
import type { LoopMonitor } from "./monitor.js";
import { ConsoleMonitor } from "./monitor.js";
import { FactStore } from "./facts.js";
import { StateStore } from "./state.js";
import { HistoryManager } from "./history.js";
import { ActionRouter, type RouterTiming } from "./router.js";
import type { SessionPolicy } from "./policy.js";

const CUA_TOOLS: CUAAction["type"][] = [
  "click", "doubleClick", "drag", "scroll",
  "type", "keyPress", "wait", "goto",
  "memorize", "writeState", "screenshot", "terminate",
  "hover", "delegate",
];

export interface PerceptionLoopOptions {
  tab: BrowserTab;
  adapter: ModelAdapter;
  history: HistoryManager;
  facts: FactStore;
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
}

export class PerceptionLoop {
  private readonly tab: BrowserTab;
  private readonly adapter: ModelAdapter;
  private readonly history: HistoryManager;
  private readonly facts: FactStore;
  private readonly state: StateStore;
  private readonly policy?: SessionPolicy;
  private readonly gate?: CompletionGate;
  private readonly monitor: LoopMonitor;
  private readonly router: ActionRouter;
  private readonly preActionHook?: PreActionHook;
  private readonly keepRecentScreenshots: number;
  private readonly cursorOverlay: boolean;
  private readonly compactionAdapter: ModelAdapter;

  constructor(opts: PerceptionLoopOptions) {
    this.tab = opts.tab;
    this.adapter = opts.adapter;
    this.history = opts.history;
    this.facts = opts.facts;
    this.state = opts.state;
    this.policy = opts.policy;
    this.gate = opts.gate;
    this.monitor = opts.monitor ?? new ConsoleMonitor();
    this.router = new ActionRouter(opts.timing);
    this.preActionHook = opts.preActionHook;
    this.keepRecentScreenshots = opts.keepRecentScreenshots ?? 2;
    this.cursorOverlay = opts.cursorOverlay ?? true;
    this.compactionAdapter = opts.compactionAdapter ?? opts.adapter;
  }

  async run(options: LoopOptions): Promise<LoopResult> {
    const threshold = options.compactionThreshold ?? 0.8;

    for (let step = 0; step < options.maxSteps; step++) {
      // 1. Proactive compaction before context pressure hits
      if (this.history.tokenUtilization() > threshold) {
        const { tokensBefore, tokensAfter } = await this.history.compactWithSummary(
          this.compactionAdapter,
          this.state.current(),
        );
        this.monitor.compactionTriggered(step, tokensBefore, tokensAfter);
        this.history.compressScreenshots(this.keepRecentScreenshots);
      }

      // 2. Screenshot (with cursor overlay at last click position if enabled)
      const screenshot = await this.tab.screenshot({ cursorOverlay: this.cursorOverlay });

      // 2b. Store screenshot in wire history so the model sees its full visual navigation trail.
      //     This is the "after" state of the previous step's actions (or the initial page for step 0).
      this.history.appendScreenshot(screenshot.data.toString("base64"), step);

      // 3. Build step context — state + facts re-injected every step regardless of compaction
      const context: StepContext = {
        screenshot,
        wireHistory: this.history.wireHistory(),
        factStore: this.facts.all(),
        taskState: this.state.current(),
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

      for await (const action of this.adapter.stream(context)) {
        if (terminated) {
          // Drain remaining stream actions without executing (e.g. if model emits multiple actions after terminate)
          continue;
        }

        // 5a. Pre-action hook check (runs before policy)
        if (this.preActionHook) {
          const hookDecision = await this.preActionHook(action);
          if (hookDecision.decision === "deny") {
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
            const wireOutcome = { ok: false, error: policyResult.reason };
            bufferedOutcomes.push({ action, wireOutcome });
            this.monitor.actionBlocked(step, action, policyResult.reason!);
            stepActions.push({ action, outcome: wireOutcome });
            continue;
          }
        }

        // 5c. Execute
        const outcome = await this.router.execute(action, this.tab, this.facts, this.state);

        // 5d. Termination check
        if (outcome.terminated) {
          if (this.gate) {
            const currentScreenshot = await this.tab.screenshot();
            const gateResult = await this.gate.verify(currentScreenshot, this.tab.url());
            if (!gateResult.passed) {
              const reason = gateResult.reason ?? "completion condition not met";
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
            finalState: this.state.current(),
          };
          continue;
        }

        // 5d-delegate. Child loop delegation
        if (outcome.isDelegateRequest) {
          const { ChildLoop } = await import("./child.js");
          const childResult = await ChildLoop.run(
            outcome.delegateInstruction!,
            { tab: this.tab, adapter: this.adapter, parentFacts: this.facts.all() },
            { maxSteps: outcome.delegateMaxSteps ?? 20 },
          );
          for (const fact of childResult.factsDiscovered) {
            this.facts.memorize(fact);
          }
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
        // If the model returned no tool_use blocks (text-only response), inject a screenshot
        // action so the loop continues and the model can observe the current page state.
        // We must also inject a synthetic toolCallId so the tool_result ID matches the
        // tool_use ID in the assistant turn — Anthropic rejects mismatched IDs.
        if (streamResponse.actions.length === 0) {
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

      // Return termination result with up-to-date semantic history
      if (terminationResult) {
        terminationResult.history = this.history.semanticHistory();
        this.monitor.terminated(terminationResult);
        return terminationResult;
      }

      this.history.appendSemanticStep({
        stepIndex: step,
        url: this.tab.url(),
        screenshotBase64: screenshot.data.toString("base64"),
        thinking,
        actions: stepActions,
        taskStateAfter: this.state.current(),
        tokenUsage: stepUsage,
        durationMs: Date.now() - stepStart,
      });

      // 6. Compress screenshots after each step (tier 1 compression always runs)
      this.history.compressScreenshots(this.keepRecentScreenshots);
    }

    const result: LoopResult = {
      status: "maxSteps",
      result: "Maximum steps reached without completion",
      steps: options.maxSteps,
      history: this.history.semanticHistory(),
      finalState: this.state.current(),
    };
    this.monitor.terminated(result);
    return result;
  }
}
