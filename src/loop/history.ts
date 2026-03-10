import type { ModelAdapter, ModelResponse } from "../model/adapter";
import type {
  ActionExecution,
  Action,
  SemanticStep,
  SerializedHistory,
  TaskState,
  TokenUsage,
  WireMessage,
} from "../types";

export class HistoryManager {
  private wire: WireMessage[] = [];
  private semantic: SemanticStep[] = [];
  private totalInputTokens = 0;
  private lastResponse: ModelResponse | null = null;
  private foldedSummaries: string[] = [];

  /** Tracks (action, toolCallId) pairs awaiting their tool_result. */
  private pendingToolCalls: Array<{ action: Action; toolCallId: string }> = [];

  constructor(private readonly contextWindowTokens: number) {}

  // ─── Wire history ───────────────────────────────────────────────────────────

  wireHistory(): WireMessage[] {
    return [...this.wire];
  }

  appendActionOutcome(action: Action, outcome: ActionExecution): void {
    // Find the tool call ID for this action so tool_results correlate with tool_use blocks.
    const pending = this.pendingToolCalls.find((p) => p.action === action);
    const toolCallId = pending?.toolCallId ?? `toolu_${action.type}_${Date.now()}`;
    if (pending) {
      this.pendingToolCalls = this.pendingToolCalls.filter((p) => p !== pending);
    }

    this.wire.push({
      role: "tool_result",
      tool_call_id: toolCallId,
      action: action.type,
      ok: outcome.ok,
      ...(outcome.error ? { error: outcome.error, is_error: true } : {}),
    });
  }

  appendResponse(response: ModelResponse): void {
    this.lastResponse = response;
    this.totalInputTokens += response.usage.inputTokens;

    // Register tool call IDs for correlation with subsequent tool_results.
    if (response.toolCallIds) {
      for (let i = 0; i < response.actions.length; i++) {
        const id = response.toolCallIds[i];
        if (id) {
          this.pendingToolCalls.push({ action: response.actions[i]!, toolCallId: id });
        }
      }
    }

    this.wire.push({
      role: "assistant",
      actions: response.actions,
      tool_call_ids: response.toolCallIds,
      thinking: response.thinking,
    });
  }

  getLastResponse(): ModelResponse | null {
    return this.lastResponse;
  }

  // ─── Semantic history (never compressed) ───────────────────────────────────

  semanticHistory(): SemanticStep[] {
    return [...this.semantic];
  }

  appendSemanticStep(step: SemanticStep): void {
    this.semantic.push(step);
  }

  // ─── Token tracking ─────────────────────────────────────────────────────────

  getTotalInputTokens(): number {
    return this.totalInputTokens;
  }

  /** 0.0–1.0 ratio of used tokens to context window size. */
  tokenUtilization(): number {
    return Math.min(this.totalInputTokens / this.contextWindowTokens, 1.0);
  }

  /** Store the step-start screenshot in wire history so buildMessages() can include it. */
  appendScreenshot(base64: string, stepIndex: number): void {
    this.wire.push({ role: "screenshot", base64, stepIndex, compressed: false });
  }

  // ─── Fold (agent-controlled context compression) ───────────────────────────

  /** Store a completed sub-goal summary. Persists across compaction. */
  addFold(summary: string): void {
    this.foldedSummaries.push(summary);
    // Aggressively compress old screenshots when folding
    this.compressScreenshots(1);
  }

  /** Get all folded summaries for injection into system prompt. */
  getFoldedContext(): string | undefined {
    if (this.foldedSummaries.length === 0) return undefined;
    return "COMPLETED SUB-GOALS:\n" + this.foldedSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n");
  }

  // ─── Compression ────────────────────────────────────────────────────────────

  /** Tier 1: Replace screenshot image data older than keepRecent steps with a text placeholder. */
  compressScreenshots(keepRecent = 2): void {
    // Collect indices of all screenshot entries in order
    const screenshotIndices: number[] = [];
    for (let i = 0; i < this.wire.length; i++) {
      if (this.wire[i]?.role === "screenshot") screenshotIndices.push(i);
    }
    // Compress all but the most recent keepRecent entries
    const compressUpTo = screenshotIndices.length - keepRecent;
    for (let k = 0; k < compressUpTo; k++) {
      const idx = screenshotIndices[k]!;
      const msg = this.wire[idx]!;
      this.wire[idx] = { ...msg, base64: null, compressed: true };
    }
  }

  /** Tier 2: Use a cheap model to write a <summary> block replacing compressed history.
   *  Triggered proactively at 80% token utilization, not when forced by limit. */
  async compactWithSummary(
    adapter: ModelAdapter,
    agentState: TaskState | null,
  ): Promise<{ tokensBefore: number; tokensAfter: number }> {
    const tokensBefore = this.totalInputTokens;

    const summary = await adapter.summarize(this.wire, agentState);

    // Replace entire wire history with the summary anchor + reset token counter
    this.wire = [
      {
        role: "summary",
        content: summary,
        compactedAt: Date.now(),
      },
    ];
    this.totalInputTokens = Math.round(tokensBefore * 0.15); // rough estimate post-compaction

    return { tokensBefore, tokensAfter: this.totalInputTokens };
  }

  // ─── Serialization ──────────────────────────────────────────────────────────

  toJSON(agentState: Record<string, unknown> | null): SerializedHistory {
    return {
      wireHistory: this.wire,
      semanticSteps: this.semantic,
      agentState,
      foldedSummaries: this.foldedSummaries.length > 0 ? this.foldedSummaries : undefined,
    };
  }

  static fromJSON(
    data: SerializedHistory,
    contextWindowTokens: number,
  ): { history: HistoryManager; agentState: TaskState | null } {
    const history = new HistoryManager(contextWindowTokens);
    history.wire = data.wireHistory;
    history.semantic = data.semanticSteps;
    if ((data as { foldedSummaries?: string[] }).foldedSummaries) {
      history.foldedSummaries = (data as { foldedSummaries: string[] }).foldedSummaries;
    }
    return { history, agentState: data.agentState };
  }

  // ─── Aggregate usage ────────────────────────────────────────────────────────

  aggregateTokenUsage(): TokenUsage {
    return this.semantic.reduce(
      (acc, step) => ({
        inputTokens: acc.inputTokens + step.tokenUsage.inputTokens,
        outputTokens: acc.outputTokens + step.tokenUsage.outputTokens,
        cacheReadTokens: (acc.cacheReadTokens ?? 0) + (step.tokenUsage.cacheReadTokens ?? 0),
        cacheWriteTokens: (acc.cacheWriteTokens ?? 0) + (step.tokenUsage.cacheWriteTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
  }
}
