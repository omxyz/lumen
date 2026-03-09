import type { ModelAdapter } from "./model/adapter.js";
import type { BrowserTab } from "./browser/tab.js";
import type { Verifier } from "./loop/verifier.js";
import type { LoopMonitor } from "./loop/monitor.js";
import type { RouterTiming } from "./loop/router.js";
import type { SessionPolicyOptions } from "./loop/policy.js";
import { Session } from "./session.js";
import { LumenLogger } from "./logger.js";
import type {
  AgentOptions,
  RunResult,
  StreamEvent,
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

/** Resolve a page-level CDP session from a browser-level connection.
 *  Browser-level sessions (/devtools/browser/) don't support Page.* or Emulation.* —
 *  we must attach to the first page target to get a usable session. */
async function resolvePageSession(conn: import("./browser/cdp.js").CdpConnection, log: LumenLogger) {
  interface TargetInfo { targetId: string; type: string; url: string }
  try {
    const { targetInfos } = await conn.mainSession().send<{ targetInfos: TargetInfo[] }>("Target.getTargets", {});
    const pageTarget = targetInfos.find((t) => t.type === "page");
    if (pageTarget) {
      log.browser(`attaching to page target: ${pageTarget.targetId} (${pageTarget.url})`);
      return await conn.newSession(pageTarget.targetId);
    }
  } catch {
    // Already a page-level connection — mainSession is usable directly
  }
  return conn.mainSession();
}

type BrowserConnectResult = {
  tab: BrowserTab;
  cleanup: () => Promise<void>;
  conn?: import("./browser/cdp.js").CdpConnection;
};

async function connectBrowser(
  opts: BrowserOptions,
  log: LumenLogger,
): Promise<BrowserConnectResult> {
  const { CdpConnection } = await import("./browser/cdp.js");
  const { CDPTab } = await import("./browser/cdptab.js");

  if (opts.type === "local") {
    const { launchChrome } = await import("./browser/launch/local.js");
    log.browser(`launching local Chrome${opts.headless !== false ? " (headless)" : " (headed)"}`);
    const { wsUrl, kill } = await launchChrome({
      port: opts.port,
      headless: opts.headless,
      userDataDir: opts.userDataDir,
    });
    log.browser(`Chrome launched, connecting CDP: ${wsUrl}`);
    const conn = await CdpConnection.connect(wsUrl, log);
    const session = await resolvePageSession(conn, log);
    const tab = new CDPTab(session, log);
    return { tab, cleanup: async () => { conn.close(); kill(); }, conn };
  }

  if (opts.type === "cdp") {
    log.browser(`connecting to CDP endpoint: ${opts.url}`);
    const conn = await CdpConnection.connect(opts.url, log);
    const session = await resolvePageSession(conn, log);
    const tab = new CDPTab(session, log);
    return { tab, cleanup: async () => { conn.close(); }, conn };
  }

  if (opts.type === "browserbase") {
    log.browser(`connecting to Browserbase (project=${opts.projectId}${opts.sessionId ? ` session=${opts.sessionId}` : ""})`);
    const { connectBrowserbase } = await import("./browser/launch/browserbase.js");
    const { wsUrl, sessionId } = await connectBrowserbase(opts);
    log.browser(`Browserbase session ready (id=${sessionId}), connecting CDP`);
    const conn = await CdpConnection.connect(wsUrl, log);
    const session = await resolvePageSession(conn, log);
    const tab = new CDPTab(session, log);
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
  private _conn: import("./browser/cdp.js").CdpConnection | null = null;
  private _session: Session | null = null;
  private _pendingHistory: SerializedAgent | null = null;
  private _log: LumenLogger | null = null;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  get tab(): BrowserTab {
    if (!this._tab) throw new Error("Agent not connected. Call run() first.");
    return this._tab;
  }

  private async _connect(): Promise<void> {
    if (this._tab) return;

    // Create the logger first — it is threaded into every layer below
    const log = new LumenLogger(this.options.verbose ?? 1, this.options.logger);
    this._log = log;

    log.info(`[lumen] connecting — model=${this.options.model} browser=${this.options.browser.type}`);

    const [adapter, browserResult, monitor, compactionAdapter] = await Promise.all([
      createAdapter(this.options.model, this.options.apiKey, this.options.baseURL, this.options.thinkingBudget),
      connectBrowser(this.options.browser, log),
      buildMonitor(this.options),
      this.options.compactionModel
        ? createAdapter(this.options.compactionModel, this.options.apiKey, this.options.baseURL)
        : Promise.resolve(undefined),
    ]);

    const { tab, cleanup, conn } = browserResult;

    log.adapter(
      `adapter ready | provider=${adapter.provider} model=${adapter.modelId} contextWindow=${adapter.contextWindowTokens}`,
      { provider: adapter.provider, modelId: adapter.modelId, contextWindow: adapter.contextWindowTokens },
    );

    this._adapter = adapter;
    this._tab = tab;
    this._cleanup = cleanup;
    this._conn = conn ?? null;

    // Align viewport to model's patch size if requested
    if (this.options.autoAlignViewport !== false) {
      try {
        const { ViewportManager } = await import("./browser/viewport.js");
        const vm = new ViewportManager(tab);
        const aligned = await vm.alignToModel(adapter.patchSize, adapter.maxImageDimension);
        log.browser(
          `viewport aligned: ${aligned.width}x${aligned.height} (patchSize=${adapter.patchSize ?? "n/a"})`,
          { width: aligned.width, height: aligned.height, patchSize: adapter.patchSize },
        );
      } catch (e) {
        log.warn(`[lumen] viewport alignment skipped (CDP not supported): ${(e as Error).message}`);
      }
    }

    // Determine initial history from pending (Agent.resume) or AgentOptions.initialHistory
    const initialHistory = this._pendingHistory ?? this.options.initialHistory;

    // Initialize v2 features
    let confidenceGate: import("./loop/confidence-gate.js").ConfidenceGate | undefined;
    if (this.options.confidenceGate) {
      const { ConfidenceGate } = await import("./loop/confidence-gate.js");
      confidenceGate = new ConfidenceGate({ adapter });
    }

    let actionVerifier: import("./loop/action-verifier.js").ActionVerifier | undefined;
    if (this.options.actionVerifier) {
      const { ActionVerifier } = await import("./loop/action-verifier.js");
      actionVerifier = new ActionVerifier();
    }

    let checkpointManager: import("./loop/checkpoint.js").CheckpointManager | undefined;
    if (this.options.checkpointInterval !== undefined) {
      const { CheckpointManager } = await import("./loop/checkpoint.js");
      checkpointManager = new CheckpointManager({ interval: this.options.checkpointInterval });
    }

    let siteKB: import("./memory/site-kb.js").SiteKB | undefined;
    if (this.options.siteKB) {
      const { SiteKB } = await import("./memory/site-kb.js");
      if (typeof this.options.siteKB === "string") {
        siteKB = SiteKB.fromFile(this.options.siteKB);
      } else {
        siteKB = new SiteKB(this.options.siteKB);
      }
    }

    let workflowMemory: import("./memory/workflow.js").WorkflowMemory | undefined;
    if (this.options.workflowMemory) {
      const { WorkflowMemory } = await import("./memory/workflow.js");
      workflowMemory = WorkflowMemory.fromFile(this.options.workflowMemory);
    }

    this._session = new Session({
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
      verifier: this.options.verifier,
      monitor,
      compactionAdapter,
      initialHistory,
      initialState: this.options.initialState,
      log,
      confidenceGate,
      actionVerifier,
      checkpointManager,
      siteKB,
      workflowMemory,
    });
    this._pendingHistory = null;

    log.info(`[lumen] connected and ready`);
  }

  async run(options: RunOptions): Promise<RunResult> {
    await this._connect();

    this._log?.info(
      `[lumen] run: "${options.instruction?.slice(0, 80)}${(options.instruction?.length ?? 0) > 80 ? "..." : ""}"`,
      { instructionLen: options.instruction?.length ?? 0, maxSteps: options.maxSteps },
    );

    // Optional planner pass — generates a step plan and prepends to the session system prompt
    if (this.options.plannerModel) {
      const screenshot = await this._tab!.screenshot();
      const { runPlanner } = await import("./loop/planner.js");
      // Bug fix #1: actually use the plannerModel to create a separate adapter
      const plannerAdapter = await createAdapter(
        this.options.plannerModel,
        this.options.apiKey,
        this.options.baseURL,
      );
      const plan = await runPlanner(options.instruction, screenshot, plannerAdapter);
      // Re-create the session with the plan-enhanced system prompt for this run
      const plannerSystemPrompt = `${plan}\n\n${this.options.systemPrompt ?? ""}`.trim();
      const [monitor, compactionAdapter] = await Promise.all([
        buildMonitor(this.options),
        this.options.compactionModel
          ? createAdapter(this.options.compactionModel, this.options.apiKey, this.options.baseURL)
          : Promise.resolve(undefined),
      ]);
      // Bug fix #2: inherit all session config from the original session
      const sessionWithPlan = new Session({
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
        verifier: this.options.verifier,
        compactionAdapter,
        initialHistory: this._pendingHistory ?? this.options.initialHistory,
        initialState: this.options.initialState,
        monitor,
        log: this._log ?? undefined,
      });
      return sessionWithPlan.run(options);
    }

    if (options.startUrl) {
      this._log?.browser(`pre-navigating to startUrl: ${options.startUrl}`);
      try {
        await this._tab!.goto(options.startUrl);
      } catch (e) {
        this._log?.warn(`[lumen] startUrl pre-navigation failed (${options.startUrl}): ${e}. Attempting CDP reconnect.`);
        // The browsing context may have been replaced (COOP or redirect). Try to
        // reconnect the CDPTab to the new page target without rebuilding the session.
        if (this._conn) {
          try {
            await new Promise((r) => setTimeout(r, 150)); // let Chrome settle
            const newPageSession = await resolvePageSession(this._conn, this._log!);
            const { CDPTab } = await import("./browser/cdptab.js");
            if (this._tab instanceof CDPTab) {
              await this._tab.reconnect(newPageSession);
              this._log?.browser(`[lumen] CDPTab reconnected to new page target (url=${this._tab.url()})`);
              // Retry navigation on the fresh session
              try {
                await this._tab.goto(options.startUrl);
              } catch {
                this._log?.warn(`[lumen] retry navigation after reconnect failed. Model will navigate.`);
              }
            }
          } catch (reconnectErr) {
            this._log?.warn(`[lumen] CDP reconnect failed: ${reconnectErr}. Model will navigate.`);
          }
        }
      }
    }

    return this._session!.run({ ...options });
  }

  async *stream(options: RunOptions): AsyncIterable<StreamEvent> {
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
    const { Session: CUASess } = await import("./session.js");
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
      verifier: this.options.verifier,
      monitor,
      compactionAdapter,
      log: this._log ?? undefined,
    });

    if (options.startUrl) {
      this._log?.browser(`pre-navigating to startUrl: ${options.startUrl}`);
      try {
        await this._tab!.goto(options.startUrl);
      } catch (e) {
        this._log?.warn(`[lumen] startUrl pre-navigation failed (${options.startUrl}): ${e}. Model will navigate.`);
      }
    }

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
        agentState: null,
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
  static async run(options: AgentOptions & RunOptions): Promise<RunResult> {
    const agent = new Agent(options);
    try {
      return await agent.run({ instruction: options.instruction, maxSteps: options.maxSteps, startUrl: options.startUrl });
    } finally {
      await agent.close();
    }
  }
}
