import type { BrowserTab } from "../browser/tab.js";
import type { ActionExecution, Action, TaskState } from "../types.js";
import type { StateStore } from "./state.js";
import { LumenLogger } from "../logger.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RouterTiming {
  afterClick?: number;       // Default: 200ms
  afterType?: number;        // Default: 500ms
  afterScroll?: number;      // Default: 300ms
  afterNavigation?: number;  // Default: 1000ms
}

/** Translates Action objects (pixel coords) into browser operations.
 *  Coordinates are already in viewport pixels — no conversion needed.
 *  Errors are returned as ActionExecution, never thrown. */
export class ActionRouter {
  private lastClickPx: { x: number; y: number } | null = null;

  constructor(
    private readonly timing: RouterTiming = {},
    private readonly log: LumenLogger = LumenLogger.NOOP,
  ) {}

  async execute(
    action: Action,
    tab: BrowserTab,
    state: StateStore,
  ): Promise<ActionExecution> {
    const t0 = Date.now();

    switch (action.type) {
      case "click": {
        const x = action.x;
        const y = action.y;
        this.log.action(`click px(${x},${y}) btn=${action.button ?? "left"}`);
        const outcome = await tab.click(x, y, { button: action.button ?? "left" });
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`click FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`click ok (${elapsed}ms)`, { elapsed });
        this.lastClickPx = { x, y };
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "doubleClick": {
        const x = action.x;
        const y = action.y;
        this.log.action(`doubleClick px(${x},${y})`);
        const outcome = await tab.doubleClick(x, y);
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`doubleClick FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`doubleClick ok (${elapsed}ms)`, { elapsed });
        this.lastClickPx = { x, y };
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "drag": {
        const fromX = action.startX;
        const fromY = action.startY;
        const toX = action.endX;
        const toY = action.endY;
        this.log.action(
          `drag px(${fromX},${fromY})→(${toX},${toY})`,
        );
        const outcome = await tab.drag(fromX, fromY, toX, toY);
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`drag FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`drag ok (${elapsed}ms)`, { elapsed });
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "scroll": {
        const x = action.x;
        const y = action.y;
        const amount = action.amount * 100;
        const [deltaX, deltaY] =
          action.direction === "right" ? [amount, 0]
          : action.direction === "left" ? [-amount, 0]
          : action.direction === "down" ? [0, amount]
          : [0, -amount];
        this.log.action(`scroll px(${x},${y}) dir=${action.direction} amount=${action.amount}`);
        const outcome = await tab.scroll(x, y, deltaX, deltaY);
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`scroll FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`scroll ok (${elapsed}ms)`, { elapsed });
        await sleep(this.timing.afterScroll ?? 300);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "type": {
        const preview = action.text.slice(0, 40);
        this.log.action(`type "${preview}${action.text.length > 40 ? "..." : ""}" (${action.text.length} chars)`);
        const outcome = await tab.type(action.text, { delayMs: 30 });
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`type FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`type ok (${elapsed}ms)`, { elapsed });
        await sleep(this.timing.afterType ?? 500);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "keyPress": {
        this.log.action(`keyPress [${action.keys.join(", ")}]`);
        const outcome = await tab.keyPress(action.keys);
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`keyPress FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`keyPress ok (${elapsed}ms)`, { elapsed });
        await sleep(100);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "goto": {
        this.log.action(`goto ${action.url}`);
        try {
          await tab.goto(action.url);
          await tab.waitForLoad(this.timing.afterNavigation ?? 2000);
          const elapsed = Date.now() - t0;
          this.log.action(`goto ok (${elapsed}ms)`, { elapsed, url: action.url });
          return { ok: true };
        } catch (err) {
          const elapsed = Date.now() - t0;
          this.log.action(`goto FAILED (${elapsed}ms): ${err}`, { elapsed, url: action.url, error: String(err) });
          return { ok: false, error: String(err) };
        }
      }

      case "wait": {
        this.log.action(`wait ${action.ms}ms`);
        await sleep(action.ms);
        return { ok: true };
      }

      case "writeState": {
        this.log.action(`writeState ${JSON.stringify(action.data as TaskState).slice(0, 80)}`);
        state.write(action.data);
        return { ok: true };
      }

      case "screenshot": {
        this.log.action(`screenshot (noop — loop will capture next step)`);
        return { ok: true, isScreenshotRequest: true };
      }

      case "terminate": {
        this.log.action(`terminate status=${action.status}: "${action.result.slice(0, 80)}"`);
        return {
          ok: true,
          terminated: true,
          status: action.status,
          result: action.result,
        };
      }

      case "hover": {
        const x = action.x;
        const y = action.y;
        this.log.action(`hover px(${x},${y})`);
        const outcome = await tab.hover(x, y);
        const elapsed = Date.now() - t0;
        if (!outcome.ok) this.log.action(`hover FAILED (${elapsed}ms): ${outcome.error}`, { elapsed, error: outcome.error });
        else this.log.action(`hover ok (${elapsed}ms)`, { elapsed });
        await sleep(this.timing.afterClick ?? 200);
        return { ok: outcome.ok, error: outcome.error };
      }

      case "delegate": {
        this.log.action(
          `delegate "${action.instruction.slice(0, 80)}${action.instruction.length > 80 ? "..." : ""}" maxSteps=${action.maxSteps ?? 20}`,
        );
        return {
          ok: true,
          isDelegateRequest: true,
          delegateInstruction: action.instruction,
          delegateMaxSteps: action.maxSteps,
        };
      }

      case "fold": {
        this.log.action(`fold "${action.summary.slice(0, 60)}"`);
        // Storage handled in perception.ts — router just acknowledges
        return { ok: true };
      }
    }
  }

  lastClick(): { x: number; y: number } | null {
    return this.lastClickPx;
  }
}
