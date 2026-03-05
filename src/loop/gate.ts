import type { ScreenshotResult } from "../types.js";
import type { ModelAdapter } from "../model/adapter.js";

export interface GateResult {
  passed: boolean;
  reason?: string;
}

/** Verifies that a terminate action actually corresponds to task completion.
 *  A failed gate is fed back as an is_error tool result — the loop continues. */
export interface Verifier {
  verify(screenshot: ScreenshotResult, url: string): Promise<GateResult>;
}

/** @deprecated Use Verifier instead */
export type CompletionGate = Verifier;

/** Passes if the current URL matches the given pattern. */
export class UrlMatchesGate implements Verifier {
  constructor(private readonly pattern: RegExp) {}

  async verify(_screenshot: ScreenshotResult, url: string): Promise<GateResult> {
    if (this.pattern.test(url)) {
      return { passed: true };
    }
    return {
      passed: false,
      reason: `URL "${url}" does not match expected pattern ${this.pattern}`,
    };
  }
}

/** Passes based on a custom async predicate over the screenshot and current URL. */
export class CustomGate implements Verifier {
  constructor(
    private readonly fn: (screenshot: ScreenshotResult, url: string) => Promise<boolean>,
    private readonly failureReason = "completion condition not met",
  ) {}

  async verify(screenshot: ScreenshotResult, url: string): Promise<GateResult> {
    const passed = await this.fn(screenshot, url);
    return passed ? { passed: true } : { passed: false, reason: this.failureReason };
  }
}

/** Uses the model to verify task completion from a screenshot.
 *  Hard-passes after maxAttempts to prevent infinite gate loops. */
export class ModelVerifier implements Verifier {
  private attempts = 0;
  private readonly maxAttempts: number;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly task: string,
    maxAttempts = 2,
  ) {
    this.maxAttempts = maxAttempts;
  }

  async verify(screenshot: ScreenshotResult, url: string): Promise<GateResult> {
    if (this.attempts >= this.maxAttempts) {
      return { passed: true };
    }
    this.attempts++;

    // Provide the screenshot as a wire message so buildMessages() produces
    // at least one user message — Anthropic requires messages to be non-empty.
    const wireHistory = [
      {
        role: "screenshot" as const,
        base64: screenshot.data.toString("base64"),
        stepIndex: 0,
        compressed: false,
      },
    ];

    const response = await this.adapter.step({
      screenshot,
      wireHistory,
      agentState: null,
      stepIndex: 0,
      maxSteps: 1,
      url,
      systemPrompt: [
        "You are a task completion verifier.",
        `Task: ${this.task}`,
        "Look at the current screenshot. Has the task been fully completed?",
        "Respond with exactly: YES or NO, followed by one sentence explaining why.",
      ].join("\n"),
    });

    const text = response.thinking ?? response.actions.map(a => JSON.stringify(a)).join(" ");
    const passed = /^yes\b/i.test(text.trim());
    return passed
      ? { passed: true }
      : { passed: false, reason: text.trim().slice(0, 200) };
  }
}
