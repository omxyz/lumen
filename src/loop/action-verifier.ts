import type { BrowserTab } from "../browser/tab.js";
import type { Action, ActionOutcome } from "../types.js";

export interface ActionVerification {
  success: boolean;
  hint?: string;
}

/**
 * BacktrackAgent-inspired post-action verifier.
 * Runs heuristic checks after each action to detect failures early.
 * No API calls — purely based on CDP state inspection.
 */
export class ActionVerifier {
  /**
   * Verify that an action succeeded by inspecting browser state.
   */
  async verify(
    action: Action,
    outcome: ActionOutcome,
    tab: BrowserTab,
    prevUrl: string,
  ): Promise<ActionVerification> {
    // Already failed — outcome.error is set by CDP layer
    if (!outcome.ok) {
      return { success: false, hint: `Action "${action.type}" failed: ${outcome.error}` };
    }

    switch (action.type) {
      case "click":
      case "doubleClick":
        return this.verifyClick(action, outcome, tab, prevUrl);
      case "type":
        return this.verifyType(tab);
      case "goto":
        return this.verifyGoto(action, tab);
      default:
        return { success: true };
    }
  }

  private async verifyClick(
    action: Action & { type: "click" | "doubleClick" },
    outcome: ActionOutcome,
    tab: BrowserTab,
    prevUrl: string,
  ): Promise<ActionVerification> {
    // If clickTarget indicates a non-interactive element, warn
    if (outcome.clickTarget) {
      const target = outcome.clickTarget.toLowerCase();
      // These are fine targets
      if (target.includes("input") || target.includes("button") || target.includes("link") ||
          target.includes("select") || target.includes("a ") || target.includes("checkbox") ||
          target.includes("radio") || target.includes("textarea")) {
        return { success: true };
      }
    }

    // Check if URL changed (navigation happened — click worked)
    const currentUrl = tab.url();
    if (currentUrl !== prevUrl) {
      return { success: true };
    }

    // No URL change and target info suggests non-interactive — soft warning
    // Don't flag as failure since many valid clicks don't change URL (dropdowns, tabs, etc.)
    return { success: true };
  }

  private async verifyType(tab: BrowserTab): Promise<ActionVerification> {
    try {
      const focusInfo = await tab.evaluate<string>(`
        (() => {
          const el = document.activeElement;
          if (!el) return 'none';
          const tag = el.tagName.toLowerCase();
          if (tag === 'input' || tag === 'textarea' || el.contentEditable === 'true') {
            return 'input:' + (el.value || el.textContent || '').slice(0, 30);
          }
          return 'other:' + tag;
        })()
      `);

      if (focusInfo === 'none' || focusInfo.startsWith('other:')) {
        return {
          success: false,
          hint: "Type action may have failed — no input element was focused. Try clicking the input field first.",
        };
      }
      return { success: true };
    } catch {
      // CDP eval can fail on some pages
      return { success: true };
    }
  }

  private async verifyGoto(
    action: Action & { type: "goto" },
    tab: BrowserTab,
  ): Promise<ActionVerification> {
    const currentUrl = tab.url();
    // Check if navigation actually happened (fuzzy — some URLs normalize differently)
    try {
      const targetHost = new URL(action.url).hostname;
      const currentHost = new URL(currentUrl).hostname;
      if (targetHost !== currentHost && !currentUrl.includes(targetHost)) {
        return {
          success: false,
          hint: `Navigation may have failed — expected ${targetHost} but got ${currentHost}. Page may have blocked the redirect.`,
        };
      }
    } catch {
      // URL parsing can fail for malformed URLs
    }
    return { success: true };
  }
}
