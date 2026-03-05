import type { ModelAdapter } from "./model/adapter.js";
import type { BrowserTab } from "./browser/tab.js";
import type { Verifier } from "./loop/gate.js";
import type { LoopMonitor } from "./loop/monitor.js";
import type { RouterTiming } from "./loop/router.js";
import type { SessionPolicyOptions } from "./loop/policy.js";
import { SessionPolicy } from "./loop/policy.js";
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
import { LumenLogger } from "./logger.js";

export interface SessionOptions {
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
  completionGate?: Verifier;

  /** Observability hook called at each step. */
  monitor?: LoopMonitor;

  /** Optional adapter used for compaction summarization (defaults to main adapter). */
  compactionAdapter?: ModelAdapter;

  /** Resume from a serialized session. */
  initialHistory?: SerializedHistory;
  initialState?: TaskState;

  /** Granular debug logger — threaded into PerceptionLoop, ActionRouter, and HistoryManager. */
  log?: LumenLogger;

  /** Enable action caching. Pass a directory path to enable. */
  cacheDir?: string;
}

export class Session {
  readonly tab: BrowserTab;

  private readonly adapter: ModelAdapter;
  private readonly opts: SessionOptions;
  private history: HistoryManager;
  private state: StateStore;
  private readonly log: LumenLogger;

  constructor(opts: SessionOptions) {
    this.tab = opts.tab;
    this.adapter = opts.adapter;
    this.opts = opts;
    this.log = opts.log ?? LumenLogger.NOOP;
    this.history = new HistoryManager(opts.adapter.contextWindowTokens);
    this.state = new StateStore();

    if (opts.initialState) {
      this.state.load(opts.initialState);
    }
    if (opts.initialHistory) {
      const { history, agentState } = HistoryManager.fromJSON(
        opts.initialHistory,
        opts.adapter.contextWindowTokens,
      );
      this.history = history;
      this.state.load(agentState);
      this.log.loop(
        `session resumed: wire=${history.wireHistory().length}msgs hasState=${agentState !== null}`,
        { wireLen: history.wireHistory().length, hasState: agentState !== null },
      );
    }
  }

  async run(options: RunOptions): Promise<CUAResult> {
    const maxSteps = options.maxSteps ?? this.opts.maxSteps ?? 30;
    this.log.loop(
      `session.run: instruction="${options.instruction?.slice(0, 80)}" maxSteps=${maxSteps}`,
      { maxSteps, instructionLen: options.instruction?.length ?? 0 },
    );

    const policy = this.opts.policy ? new SessionPolicy(this.opts.policy) : undefined;

    const loop = new PerceptionLoop({
      tab: this.tab,
      adapter: this.adapter,
      history: this.history,
      state: this.state,
      policy,
      gate: this.opts.completionGate,
      monitor: this.opts.monitor,
      timing: this.opts.timing,
      preActionHook: this.opts.preActionHook,
      keepRecentScreenshots: this.opts.keepRecentScreenshots,
      cursorOverlay: this.opts.cursorOverlay,
      compactionAdapter: this.opts.compactionAdapter,
      log: this.log,
      cacheDir: this.opts.cacheDir,
    });

    // Prepend the per-run instruction to the session-level system prompt
    const systemPrompt = [
      options.instruction ? `Task: ${options.instruction}` : "",
      this.opts.systemPrompt ?? "",
    ].filter(Boolean).join("\n\n") || undefined;

    // Compute instruction hash for action cache key
    const instructionHash = this.opts.cacheDir && options.instruction
      ? (await import("crypto")).createHash("sha256").update(options.instruction).digest("hex").slice(0, 16)
      : undefined;

    const loopResult = await loop.run({
      maxSteps,
      systemPrompt,
      compactionThreshold: this.opts.compactionThreshold,
      instructionHash,
    });

    this.log.loop(
      `session.run done: status=${loopResult.status} steps=${loopResult.steps}`,
      { status: loopResult.status, steps: loopResult.steps },
    );

    return {
      ...loopResult,
      tokenUsage: this.history.aggregateTokenUsage(),
    };
  }

  serialize(): SerializedHistory {
    return this.history.toJSON(this.state.current());
  }

  static resume(data: SerializedHistory, opts: Omit<SessionOptions, "initialHistory">): Session {
    return new Session({ ...opts, initialHistory: data });
  }

  async close(): Promise<void> {
    await this.tab.close();
  }
}
