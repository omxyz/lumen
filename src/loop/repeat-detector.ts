import { createHash } from "crypto";
import type { Action } from "../types";

/**
 * Detects when the agent is stuck repeating actions or stalling on one page.
 *
 * Three detection layers:
 *   1. Action-level: same normalized action hash repeated N times in a rolling window
 *   2. Category-level: same action *category* (scroll-like, noop-like) dominates the window
 *   3. URL-level: too many steps spent on the same URL without meaningful progress
 */
export class RepeatDetector {
  private readonly window: string[] = [];
  private readonly categoryWindow: string[] = [];
  private readonly windowSize = 20;
  private readonly thresholds = [5, 8, 12] as const;

  // URL stall tracking
  private currentUrl = "";
  private stepsOnUrl = 0;
  private readonly urlStallThreshold: number;

  constructor(urlStallThreshold = 10) {
    this.urlStallThreshold = urlStallThreshold;
  }

  /** Records an action. Returns the threshold level hit (5, 8, or 12), or null. */
  record(action: Action): number | null {
    const hash = createHash("sha256").update(this.normalize(action)).digest("hex");
    const category = this.categorize(action);

    this.window.push(hash);
    if (this.window.length > this.windowSize) this.window.shift();

    this.categoryWindow.push(category);
    if (this.categoryWindow.length > this.windowSize) this.categoryWindow.shift();

    // Layer 1: Exact action repeat (original behavior)
    const repeats = this.window.filter(h => h === hash).length;
    const exactHit = this.thresholds.find(t => repeats === t) ?? null;
    if (exactHit !== null) return exactHit;

    // Layer 2: Category dominance — catches scroll/noop interleaving
    const categoryCount = this.categoryWindow.filter(c => c === category).length;
    const categoryHit = this.thresholds.find(t => categoryCount === t) ?? null;
    if (categoryHit !== null && category !== "productive") return categoryHit;

    return null;
  }

  /** Track URL changes. Returns stall level if stuck on same URL too long.
   *  URLs are normalized to origin+pathname to ignore tracking params
   *  (e.g. booking.com appends different srpvid/sid on each redirect). */
  recordUrl(url: string): number | null {
    const normalized = this.normalizeUrl(url);
    if (normalized !== this.currentUrl) {
      this.currentUrl = normalized;
      this.stepsOnUrl = 0;
      return null;
    }
    this.stepsOnUrl++;

    // Escalating stall thresholds: warn at urlStallThreshold, harder at 1.5x, hardest at 2x
    if (this.stepsOnUrl === this.urlStallThreshold) return 5;
    if (this.stepsOnUrl === Math.round(this.urlStallThreshold * 1.5)) return 8;
    if (this.stepsOnUrl === this.urlStallThreshold * 2) return 12;

    return null;
  }

  /** Returns the ratio of productive actions in the recent category window (0..1). */
  recentProductiveRatio(): number {
    if (this.categoryWindow.length === 0) return 1;
    const productive = this.categoryWindow.filter(c => c === "productive").length;
    return productive / this.categoryWindow.length;
  }

  reset(): void {
    this.window.length = 0;
    this.categoryWindow.length = 0;
    this.stepsOnUrl = 0;
    this.currentUrl = "";
  }

  /**
   * Categorize actions into behavioral buckets:
   * - "passive": scroll, screenshot, wait — observing without changing state
   * - "productive": click, type, goto, writeState, terminate — actually doing something
   * - "noop": screenshot (model returned no actions)
   */
  private categorize(action: Action): string {
    switch (action.type) {
      case "scroll":
      case "wait":
      case "hover":
        return "passive";
      case "screenshot":
        return "noop";
      case "click":
      case "doubleClick":
      case "type":
      case "keyPress":
      case "goto":
      case "writeState":
      case "terminate":
      case "delegate":
      case "drag":
        return "productive";
      default:
        return "passive";
    }
  }

  /** Strip query params so tracking-heavy sites (booking.com, etc.) don't defeat stall detection. */
  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return url; // fallback for malformed URLs
    }
  }

  private normalize(action: Action): string {
    // Bucket size: 64px ≈ 5% of a 1280px viewport — treats nearby coords as identical
    const BUCKET = 64;
    switch (action.type) {
      case "click":
      case "doubleClick":
      case "hover":
        return `${action.type}:${Math.round(action.x / BUCKET) * BUCKET},${Math.round(action.y / BUCKET) * BUCKET}`;
      case "type":
        return `type:${action.text}`;
      case "goto":
        return `goto:${action.url}`;
      case "keyPress":
        return `keyPress:${action.keys.join("+")}`;
      case "scroll":
        return `scroll:${Math.round(action.x / BUCKET) * BUCKET},${Math.round(action.y / BUCKET) * BUCKET},${action.direction}`;
      default:
        return action.type;
    }
  }
}

export function nudgeMessage(level: number, context?: "action" | "url"): string {
  if (context === "url") {
    if (level >= 12) return [
      "CRITICAL STRATEGY RESET: You have spent far too many steps on this page.",
      "You MUST: 1) Save everything you've found with update_state RIGHT NOW.",
      "2) Then either navigate to a different page, try a completely different approach,",
      "or call task_complete with your best answer based on what you have.",
      "Do NOT continue with the same approach — it is not working.",
    ].join(" ");
    if (level >= 8) return [
      "WARNING: You have been on this same page for many steps without saving progress.",
      "Use update_state to save what you've done so far before continuing.",
      "If you're stuck on an interaction, try a completely different approach — click elsewhere, or skip this step and move on.",
    ].join(" ");
    return [
      "You have been on this page for a while.",
      "Consider using update_state to checkpoint your progress before continuing.",
    ].join(" ");
  }

  if (level >= 12) return [
    "STRATEGY RESET: You have repeated the same action many times and the page has not changed.",
    "Stop completely and try a DIFFERENT approach:",
    "1) Save everything you've found so far with update_state.",
    "2) If clicking isn't working, try keyboard navigation (Tab, Enter, Page_Down).",
    "3) If a form is stuck, try navigating directly to a URL with parameters instead.",
    "4) If you have enough information to answer, call task_complete NOW with your best answer.",
  ].join(" ");
  if (level >= 8) return [
    "You are repeating the same action. The page does not appear to be changing.",
    "Try a different approach — click a different element, navigate to a different page, or save your progress and move on.",
  ].join(" ");
  return "You seem to be repeating an action. If the page is not responding, try something different.";
}
