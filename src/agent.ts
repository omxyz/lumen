import type { ModelAdapter } from "./model/adapter.js";
import type { BrowserTab } from "./browser/tab.js";
import type { CompletionGate } from "./loop/gate.js";
import type { LoopMonitor } from "./loop/monitor.js";
import type { RouterTiming } from "./loop/router.js";
import type { SessionPolicyOptions } from "./loop/policy.js";
import { CUASession } from "./session.js";
import type {
  AgentEvent,
  AgentOptions,
  AgentResult,
  BrowserOptions,
  RunOptions,
  SemanticStep,
  SerializedAgent,
} from "./types.js";

// Lazy imports for browser/model to avoid loading unused deps
async function createAdapter(
  model: string,
  apiKey?: string,
  baseURL?: string,
  thinkingBudget = 0,
): Promise<ModelAdapter> {
  if (model.startsWith("anthropic/")) {
    const { AnthropicAdapter } = await import("./model/anthropic.js");
    return new AnthropicAdapter(model.slice("anthropic/".length), apiKey, thinkingBudget);
  }
  if (model.startsWith("google/")) {
    const { GoogleAdapter } = await import("./model/google.js");
    return new GoogleAdapter(model.slice("google/".length), apiKey);
  }
  if (model.startsWith("openai/")) {
    const { OpenAIAdapter } = await import("./model/openai.js");
    return new OpenAIAdapter(model.slice("openai/".length), apiKey);
  }
  // Stagehand-compatible model inference
  const stagehandModels: Record<string, () => Promise<ModelAdapter>> = {
    "claude-opus-4-6": async () => { const { AnthropicAdapter } = await import("./model/anthropic.js"); return new AnthropicAdapter("claude-opus-4-6", apiKey, thinkingBudget); },
    "claude-sonnet-4-6": async () => { const { AnthropicAdapter } = await import("./model/anthropic.js"); return new AnthropicAdapter("claude-sonnet-4-6", apiKey, thinkingBudget); },
    "claude-opus-4-5": async () => { const { AnthropicAdapter } = await import("./model/anthropic.js"); return new AnthropicAdapter("claude-opus-4-5", apiKey, thinkingBudget); },
    "claude-sonnet-4-5": async () => { const { AnthropicAdapter } = await import("./model/anthropic.js"); return new AnthropicAdapter("claude-sonnet-4-5", apiKey, thinkingBudget); },
    "claude-3-7-sonnet-20250219": async () => { const { AnthropicAdapter } = await import("./model/anthropic.js"); return new AnthropicAdapter("claude-3-7-sonnet-20250219", apiKey, thinkingBudget); },
    "gemini-2.0-flash": async () => { const { GoogleAdapter } = await import("./model/google.js"); return new GoogleAdapter("gemini-2.0-flash", apiKey); },
    "gemini-2.5-pro": async () => { const { GoogleAdapter } = await import("./model/google.js"); return new GoogleAdapter("gemini-2.5-pro", apiKey); },
    "computer-use-preview": async () => { const { OpenAIAdapter } = await import("./model/openai.js"); return new OpenAIAdapter("computer-use-preview", apiKey); },
  };
  if (stagehandModels[model]) return stagehandModels[model]!();
  // Fallback: CustomAdapter with OpenAI-compatible chat completions
  const { CustomAdapter } = await import("./model/custom.js");
  return new CustomAdapter(model, { baseURL, apiKey });
}

async function connectBrowser(opts: BrowserOptions): Promise<{ tab: BrowserTab; cleanup: () => Promise<void> }> {
  const { CdpConnection } = await import("./browser/cdp.js");
  const { CDPTab } = await import("./browser/cdptab.js");

  if (opts.type === "local") {
    const { launchChrome } = await import("./browser/launch/local.js");
    const { wsUrl, kill } = await launchChrome({
      port: opts.port,
      headless: opts.headless,
      userDataDir: opts.userDataDir,
    });
    const conn = await CdpConnection.connect(wsUrl);
    const tab = new CDPTab(conn.mainSession());
    return { tab, cleanup: async () => { conn.close(); kill(); } };
  }

  if (opts.type === "cdp") {
    const conn = await CdpConnection.connect(opts.url);
    const tab = new CDPTab(conn.mainSession());
    return { tab, cleanup: async () => { conn.close(); } };
  }

  if (opts.type === "browserbase") {
    const { connectBrowserbase } = await import("./browser/launch/browserbase.js");
    const { wsUrl } = await connectBrowserbase(opts);
    const conn = await CdpConnection.connect(wsUrl);
    const tab = new CDPTab(conn.mainSession());
    return { tab, cleanup: async () => { conn.close(); } };
  }

  throw new Error(`Unknown browser type: ${(opts as { type: string }).type}`);
}

/** Build a LoopMonitor that respects verbose level and optional logger callback. */
async function buildMonitor(opts: AgentOptions): Promise<import("./loop/monitor.js").LoopMonitor> {
  // If a custom monitor is provided, use it directly
  if (opts.monitor) return opts.monitor;

  const { ConsoleMonitor, NoopMonitor } = await import("./loop/monitor.js");
  const verbose = opts.verbose ?? 1;
  if (verbose === 0) return new NoopMonitor();

  const base = new ConsoleMonitor();

  // If a logger callback is provided, wrap the base monitor to also emit structured log lines
  if (opts.logger) {
    const { logger, verbose: v } = opts;
    return {
      stepStarted(step, context) {
        if ((v ?? 1) >= 1) {
          base.stepStarted(step, context);
          logger({ level: "info", message: `step_start step=${step + 1}/${context.maxSteps} url=${context.url}`, timestamp: Date.now() });
        }
      },
      stepCompleted(step, response) {
        if ((v ?? 1) >= 1) {
          base.stepCompleted(step, response);
          logger({ level: "info", message: `step_complete step=${step + 1} actions=${response.actions.length} input_tokens=${response.usage.inputTokens}`, timestamp: Date.now() });
        }
      },
      actionExecuted(step, action, outcome) {
        if ((v ?? 1) >= 2) {
          base.actionExecuted(step, action, outcome);
        }
        if (!outcome.ok) {
          logger({ level: "warn", message: `action_error step=${step + 1} type=${action.type} error=${outcome.error}`, timestamp: Date.now() });
        }
      },
      actionBlocked(step, action, reason) {
        base.actionBlocked(step, action, reason);
        logger({ level: "warn", message: `action_blocked step=${step + 1} type=${action.type} reason=${reason}`, timestamp: Date.now() });
      },
      terminationRejected(step, reason) {
        base.terminationRejected(step, reason);
        logger({ level: "warn", message: `termination_rejected step=${step + 1} reason=${reason}`, timestamp: Date.now() });
      },
      compactionTriggered(step, tokensBefore, tokensAfter) {
        base.compactionTriggered(step, tokensBefore, tokensAfter);
        logger({ level: "info", message: `compaction step=${step + 1} tokens_before=${tokensBefore} tokens_after=${tokensAfter}`, timestamp: Date.now() });
      },
      terminated(result) {
        base.terminated(result);
        logger({ level: "info", message: `terminated status=${result.status} steps=${result.steps}`, timestamp: Date.now() });
      },
      error(err) {
        base.error(err);
        logger({ level: "error", message: `error ${err.message}`, timestamp: Date.now() });
      },
    };
  }

  return base;
}

export class Agent {
  private readonly options: AgentOptions;
  private _tab: BrowserTab | null = null;
  private _adapter: ModelAdapter | null = null;
  private _cleanup: (() => Promise<void>) | null = null;
  private _session: CUASession | null = null;
  private _pendingHistory: SerializedAgent | null = null;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  get tab(): BrowserTab {
    if (!this._tab) throw new Error("Agent not connected. Call run() first.");
    return this._tab;
  }

  private async _connect(): Promise<void> {
    if (this._tab) return;

    const [adapter, { tab, cleanup }, monitor, compactionAdapter] = await Promise.all([
      createAdapter(this.options.model, this.options.apiKey, this.options.baseURL, this.options.thinkingBudget),
      connectBrowser(this.options.browser),
      buildMonitor(this.options),
      this.options.compactionModel
        ? createAdapter(this.options.compactionModel, this.options.apiKey, this.options.baseURL)
        : Promise.resolve(undefined),
    ]);

    this._adapter = adapter;
    this._tab = tab;
    this._cleanup = cleanup;

    // Align viewport to model's patch size if requested
    if (this.options.autoAlignViewport !== false) {
      const { ViewportManager } = await import("./browser/viewport.js");
      const vm = new ViewportManager(tab);
      await vm.alignToModel(adapter.patchSize, adapter.maxImageDimension);
    }

    // Determine initial history from pending (Agent.resume) or AgentOptions.initialHistory
    const initialHistory = this._pendingHistory ?? this.options.initialHistory;

    this._session = new CUASession({
      tab,
      adapter,
      systemPrompt: this.options.systemPrompt,
      maxSteps: this.options.maxSteps,
      compactionThreshold: this.options.compactionThreshold,
      keepRecentScreenshots: this.options.keepRecentScreenshots,
      cursorOverlay: this.options.cursorOverlay,
      timing: this.options.timing,
      policy: this.options.policy,
      preActionHook: this.options.preActionHook,
      completionGate: this.options.completionGate,
      monitor,
      compactionAdapter,
      initialHistory,
      initialFacts: this.options.initialFacts,
      initialState: this.options.initialState,
    });
    this._pendingHistory = null;
    await this._session.init();
  }

  async run(options: RunOptions): Promise<AgentResult> {
    await this._connect();

    // Optional planner pass — generates a step plan and prepends to the session system prompt
    if (this.options.plannerModel) {
      const screenshot = await this._tab!.screenshot();
      const { runPlanner } = await import("./loop/planner.js");
      const plan = await runPlanner(options.instruction, screenshot, this._adapter!);
      // Re-create the session with the plan-enhanced system prompt for this run
      const plannerSystemPrompt = `${plan}\n\n${this.options.systemPrompt ?? ""}`.trim();
      const monitor = await buildMonitor(this.options);
      const sessionWithPlan = new CUASession({
        tab: this._tab!,
        adapter: this._adapter!,
        systemPrompt: plannerSystemPrompt,
        maxSteps: this.options.maxSteps,
        compactionThreshold: this.options.compactionThreshold,
        keepRecentScreenshots: this.options.keepRecentScreenshots,
        cursorOverlay: this.options.cursorOverlay,
        timing: this.options.timing,
        policy: this.options.policy,
        preActionHook: this.options.preActionHook,
        completionGate: this.options.completionGate,
        monitor,
      });
      await sessionWithPlan.init();
      return sessionWithPlan.run(options);
    }

    return this._session!.run({ ...options });
  }

  async *stream(options: RunOptions): AsyncIterable<AgentEvent> {
    const { StreamingMonitor } = await import("./loop/streaming-monitor.js");
    const streamingMonitor = new StreamingMonitor();

    // Override options to use the streaming monitor
    const streamingOptions: AgentOptions = {
      ...this.options,
      monitor: streamingMonitor,
    };

    // Create a separate agent instance with the streaming monitor that uses the same browser
    // (We need to start the run in the background while consuming events)
    await this._connect();

    // Re-create session with streaming monitor if already connected
    // We patch the session's monitor by creating the loop with the streaming monitor
    const { CUASession: CUASess } = await import("./session.js");
    const [compactionAdapter, monitor] = await Promise.all([
      this.options.compactionModel
        ? createAdapter(this.options.compactionModel, this.options.apiKey, this.options.baseURL)
        : Promise.resolve(undefined),
      Promise.resolve(streamingMonitor as import("./loop/monitor.js").LoopMonitor),
    ]);

    const session = new CUASess({
      tab: this._tab!,
      adapter: this._adapter!,
      systemPrompt: this.options.systemPrompt,
      maxSteps: this.options.maxSteps,
      compactionThreshold: this.options.compactionThreshold,
      keepRecentScreenshots: this.options.keepRecentScreenshots,
      cursorOverlay: this.options.cursorOverlay,
      timing: this.options.timing,
      policy: this.options.policy,
      preActionHook: this.options.preActionHook,
      completionGate: this.options.completionGate,
      monitor,
      compactionAdapter,
    });
    await session.init();

    // Run in the background while we consume events
    const runPromise = session.run(options).then((result) => {
      streamingMonitor.complete(result);
      return result;
    }).catch((err: Error) => {
      // Signal done with a failure if something throws
      streamingMonitor.complete({
        status: "failure",
        result: err.message,
        steps: 0,
        history: [],
        finalState: null,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      });
      throw err;
    });

    // Yield all events as they arrive
    for await (const event of streamingMonitor.events()) {
      yield event;
    }

    // Ensure the run promise has settled (it should have since we got the done event)
    await runPromise;
  }

  history(): SemanticStep[] {
    if (!this._session) return [];
    return this._session.serialize().semanticSteps;
  }

  async serialize(): Promise<SerializedAgent> {
    if (!this._session) throw new Error("No session to serialize.");
    return {
      ...this._session.serialize(),
      modelId: this.options.model,
    };
  }

  static resume(data: SerializedAgent, options: AgentOptions): Agent {
    const agent = new Agent(options);
    // Stash serialized history so _connect() can restore it
    agent._pendingHistory = data;
    return agent;
  }

  async close(): Promise<void> {
    if (this._cleanup) {
      await this._cleanup();
      this._cleanup = null;
      this._tab = null;
      this._adapter = null;
      this._session = null;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Convenience: create agent, run, close */
  static async run(options: AgentOptions & RunOptions): Promise<AgentResult> {
    const agent = new Agent(options);
    try {
      return await agent.run({ instruction: options.instruction, maxSteps: options.maxSteps });
    } finally {
      await agent.close();
    }
  }
}
