import type { ScreenshotResult } from "../types.js";

export interface GateResult {
  passed: boolean;
  reason?: string;
}

/** Verifies that a terminate action actually corresponds to task completion.
 *  A failed gate is fed back as an is_error tool result — the loop continues. */
export interface CompletionGate {
  verify(screenshot: ScreenshotResult, url: string): Promise<GateResult>;
}

/** Passes if the current URL matches the given pattern. */
export class UrlMatchesGate implements CompletionGate {
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
export class CustomGate implements CompletionGate {
  constructor(
    private readonly fn: (screenshot: ScreenshotResult, url: string) => Promise<boolean>,
    private readonly failureReason = "completion condition not met",
  ) {}

  async verify(screenshot: ScreenshotResult, url: string): Promise<GateResult> {
    const passed = await this.fn(screenshot, url);
    return passed ? { passed: true } : { passed: false, reason: this.failureReason };
  }
}
