import type { ModelAdapter } from "./model/adapter.js";
import type { BrowserTab } from "./browser/tab.js";
import type { CompletionGate } from "./loop/gate.js";
import type { LoopMonitor } from "./loop/monitor.js";
import type { RouterTiming } from "./loop/router.js";
import type { SessionPolicyOptions } from "./loop/policy.js";
import { SessionPolicy } from "./loop/policy.js";
import { FactStore } from "./loop/facts.js";
import { StateStore } from "./loop/state.js";
import { HistoryManager } from "./loop/history.js";
import { PerceptionLoop } from "./loop/perception.js";
import type {
  CUAResult,
  PreActionHook,
  RunOptions,
  SerializedHistory,
  TaskState,
} from "./types.js";
import { CUAError } from "./errors.js";

export interface CUASessionOptions {
  /** Browser connection — bring your own tab (CDPTab, BrowserbaseTab, etc.) */
  tab: BrowserTab;

  /** Model adapter — AnthropicAdapter, GoogleAdapter, OpenAIAdapter, or CustomAdapter */
  adapter: ModelAdapter;

  /** Session-scoped system prompt */
  systemPrompt?: string;

  /** Maximum steps per run() call. Default: 30 */
  maxSteps?: number;

  /** 0.0–1.0. Trigger LLM summarization compaction at this utilization. Default: 0.8 */
  compactionThreshold?: number;

  /** Number of recent screenshots to keep in wire history. Default: 2. */
  keepRecentScreenshots?: number;

  /** Composite cursor dot at last click position in screenshots. Default: true. */
  cursorOverlay?: boolean;

  /** Post-action timing overrides */
  timing?: RouterTiming;

  /** Allowlist filter for model-emitted actions. Not OS-level isolation. */
  policy?: SessionPolicyOptions;

  /** Optional hook called before every action. Return deny to block with reason. */
  preActionHook?: PreActionHook;

  /** Verify terminate before accepting the exit. */
  completionGate?: CompletionGate;

  /** Observability hook called at each step. */
  monitor?: LoopMonitor;

  /** Optional adapter used for compaction summarization (defaults to main adapter). */
  compactionAdapter?: ModelAdapter;

  /** Resume from a serialized session. */
  initialHistory?: SerializedHistory;
  initialFacts?: string[];
  initialState?: TaskState;
}

export class CUASession {
  readonly tab: BrowserTab;

  private readonly adapter: ModelAdapter;
  private readonly opts: CUASessionOptions;
  private history: HistoryManager;
  private facts: FactStore;
  private state: StateStore;
  private initialized = false;

  constructor(opts: CUASessionOptions) {
    this.tab = opts.tab;
    this.adapter = opts.adapter;
    this.opts = opts;
    this.history = new HistoryManager(opts.adapter.contextWindowTokens);
    this.facts = new FactStore();
    this.state = new StateStore();

    if (opts.initialFacts) {
      this.facts.load(opts.initialFacts);
    }
    if (opts.initialState) {
      this.state.load(opts.initialState);
    }
    if (opts.initialHistory) {
      const { history, facts, taskState } = HistoryManager.fromJSON(
        opts.initialHistory,
        opts.adapter.contextWindowTokens,
      );
      this.history = history;
      this.facts.load(facts);
      this.state.load(taskState);
    }
  }

  async init(): Promise<void> {
    this.initialized = true;
  }

  async run(options: RunOptions): Promise<CUAResult> {
    if (!this.initialized) {
      throw new CUAError("INIT_REQUIRED", "Call session.init() before session.run()");
    }

    const policy = this.opts.policy ? new SessionPolicy(this.opts.policy) : undefined;

    const loop = new PerceptionLoop({
      tab: this.tab,
      adapter: this.adapter,
      history: this.history,
      facts: this.facts,
      state: this.state,
      policy,
      gate: this.opts.completionGate,
      monitor: this.opts.monitor,
      timing: this.opts.timing,
      preActionHook: this.opts.preActionHook,
      keepRecentScreenshots: this.opts.keepRecentScreenshots,
      cursorOverlay: this.opts.cursorOverlay,
      compactionAdapter: this.opts.compactionAdapter,
    });

    // Prepend the per-run instruction to the session-level system prompt
    const systemPrompt = [
      options.instruction ? `Task: ${options.instruction}` : "",
      this.opts.systemPrompt ?? "",
    ].filter(Boolean).join("\n\n") || undefined;

    const loopResult = await loop.run({
      maxSteps: options.maxSteps ?? this.opts.maxSteps ?? 30,
      systemPrompt,
      compactionThreshold: this.opts.compactionThreshold,
    });

    return {
      ...loopResult,
      tokenUsage: this.history.aggregateTokenUsage(),
    };
  }

  serialize(): SerializedHistory {
    return this.history.toJSON(this.facts.all(), this.state.current());
  }

  static resume(data: SerializedHistory, opts: Omit<CUASessionOptions, "initialHistory">): CUASession {
    return new CUASession({ ...opts, initialHistory: data });
  }

  async close(): Promise<void> {
    await this.tab.close();
  }
}
