import type { CUAAction, CUAEvent, CUAResult, LoopResult } from "../types.js";
import type { LoopMonitor } from "./monitor.js";
import type { ModelResponse, StepContext } from "../model/adapter.js";
import type { ActionExecution } from "../types.js";

/**
 * A LoopMonitor that enqueues CUAEvent objects onto an internal queue.
 * Used by Agent.stream() to convert the synchronous monitor callbacks into
 * an async iterable of events.
 *
 * The consumer calls next() in a loop; when the loop terminates, it calls done().
 * After done() is called, any remaining events in the queue are flushed and then
 * the async generator terminates.
 */
export class StreamingMonitor implements LoopMonitor {
  private readonly queue: CUAEvent[] = [];
  private resolver: (() => void) | null = null;
  private finished = false;
  private finalResult: CUAResult | null = null;

  /** Await this to get the next event batch (resolves when queue is non-empty or done). */
  private _notify(): void {
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r();
    }
  }

  private enqueue(event: CUAEvent): void {
    this.queue.push(event);
    this._notify();
  }

  /** Called by the Agent after run() completes to signal end of stream. */
  complete(result: CUAResult): void {
    this.finalResult = result;
    this.finished = true;
    this.enqueue({ type: "done", result });
    this._notify();
  }

  // ─── LoopMonitor implementation ─────────────────────────────────────────────

  stepStarted(step: number, context: StepContext): void {
    this.enqueue({
      type: "step_start",
      step,
      maxSteps: context.maxSteps,
      url: context.url,
    });
    this.enqueue({
      type: "screenshot",
      step,
      imageBase64: context.screenshot.data.toString("base64"),
    });
  }

  stepCompleted(step: number, response: ModelResponse): void {
    if (response.thinking) {
      this.enqueue({ type: "thinking", step, text: response.thinking });
    }
  }

  actionExecuted(step: number, action: CUAAction, outcome: ActionExecution): void {
    this.enqueue({ type: "action", step, action });
    this.enqueue({ type: "action_result", step, action, ok: outcome.ok, error: outcome.error });

    if (action.type === "memorize") {
      this.enqueue({ type: "memorized", step, fact: action.fact });
    }
    if (action.type === "writeState") {
      this.enqueue({ type: "state_written", step, state: action.state });
    }
  }

  actionBlocked(step: number, action: CUAAction, reason: string): void {
    this.enqueue({ type: "action_blocked", step, action, reason });
  }

  terminationRejected(step: number, reason: string): void {
    this.enqueue({ type: "termination_rejected", step, reason });
  }

  compactionTriggered(step: number, tokensBefore: number, tokensAfter: number): void {
    this.enqueue({ type: "compaction", step, tokensBefore, tokensAfter });
  }

  terminated(_result: LoopResult): void {
    // done event is emitted by complete(), not here
  }

  error(_err: Error): void {
    // errors propagate as exceptions; no event needed
  }

  // ─── Async generator ─────────────────────────────────────────────────────────

  /** Consume all events as an async iterable. Terminates after a "done" event. */
  async *events(): AsyncIterable<CUAEvent> {
    while (true) {
      // Drain the queue
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        if (event.type === "done") return;
      }

      if (this.finished) return;

      // Wait for next notification
      await new Promise<void>((resolve) => {
        this.resolver = resolve;
        // If something was enqueued while we were setting up the resolver, notify immediately
        if (this.queue.length > 0 || this.finished) {
          const r = this.resolver;
          this.resolver = null;
          r();
        }
      });
    }
  }
}
