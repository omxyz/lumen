import type { BrowserTab } from "../browser/tab.js";
import { denormalize } from "../model/adapter.js";
import type { ActionExecution, CUAAction } from "../types.js";
import type { FactStore } from "./facts.js";
import type { StateStore } from "./state.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RouterTiming {
  afterClick?: number;       // Default: 200ms
  afterType?: number;        // Default: 500ms
  afterScroll?: number;      // Default: 300ms
  afterNavigation?: number;  // Default: 1000ms
}

/** Translates CUAAction objects (normalized 0–1000 coords) into browser operations.
 *  Denormalization to pixels happens here, nowhere else.
 *  Errors are returned as ActionExecution, never thrown. */
export class ActionRouter {
  private lastClickPx: { x: number; y: number } | null = null;

  constructor(private readonly timing: RouterTiming = {}) {}

  async execute(
    action: CUAAction,
    tab: BrowserTab,
    facts: FactStore,
    state: StateStore,
  ): Promise<ActionExecution> {
    const viewport = tab.viewport();

    switch (action.type) {
      case "click": {
        const x = denormalize(action.x, viewport.width);
        const y = denormalize(action.y, viewport.height);
        this.lastClickPx = { x, y };
        const outcome = await tab.click(x, y, { button: action.button ?? "left" });
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "doubleClick": {
        const x = denormalize(action.x, viewport.width);
        const y = denormalize(action.y, viewport.height);
        this.lastClickPx = { x, y };
        const outcome = await tab.doubleClick(x, y);
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "drag": {
        const fromX = denormalize(action.startX, viewport.width);
        const fromY = denormalize(action.startY, viewport.height);
        const toX = denormalize(action.endX, viewport.width);
        const toY = denormalize(action.endY, viewport.height);
        const outcome = await tab.drag(fromX, fromY, toX, toY);
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "scroll": {
        const x = denormalize(action.x, viewport.width);
        const y = denormalize(action.y, viewport.height);
        const amount = action.amount * 100;
        const [deltaX, deltaY] =
          action.direction === "right" ? [amount, 0]
          : action.direction === "left" ? [-amount, 0]
          : action.direction === "down" ? [0, amount]
          : [0, -amount];
        const outcome = await tab.scroll(x, y, deltaX, deltaY);
        await sleep(this.timing.afterScroll ?? 300);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "type": {
        const outcome = await tab.type(action.text, { delayMs: 30 });
        await sleep(this.timing.afterType ?? 500);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "keyPress": {
        const outcome = await tab.keyPress(action.keys);
        await sleep(100);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "goto": {
        try {
          await tab.goto(action.url);
          await tab.waitForLoad(this.timing.afterNavigation ?? 1000);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }

      case "wait": {
        await sleep(action.ms);
        return { ok: true };
      }

      case "memorize": {
        facts.memorize(action.fact);
        return { ok: true };
      }

      case "writeState": {
        state.write(action.state);
        return { ok: true };
      }

      case "screenshot": {
        return { ok: true, isScreenshotRequest: true };
      }

      case "terminate": {
        return {
          ok: true,
          terminated: true,
          status: action.status,
          result: action.result,
        };
      }

      case "hover": {
        const x = denormalize(action.x, viewport.width);
        const y = denormalize(action.y, viewport.height);
        const outcome = await tab.hover(x, y);
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "delegate": {
        return {
          ok: true,
          isDelegateRequest: true,
          delegateInstruction: action.instruction,
          delegateMaxSteps: action.maxSteps,
        };
      }
    }
  }

  lastClick(): { x: number; y: number } | null {
    return this.lastClickPx;
  }
}
