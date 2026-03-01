import type { CDPSessionLike } from "./cdp.js";
import type { BrowserTab, ClickOptions, DragOptions, TypeOptions } from "./tab.js";
import type { ActionOutcome, ScreenshotOptions, ScreenshotResult, ViewportSize } from "../types.js";
import { LumenLogger } from "../logger.js";

// CDP response shapes
interface ScreenshotResponse { data: string }
interface NavigateResponse { frameId: string; errorText?: string }
interface EvaluateResponse { result: { value: unknown; type: string }; exceptionDetails?: unknown }

// CDP modifier bit flags
const MOD_ALT   = 1;
const MOD_CTRL  = 2;
const MOD_META  = 4;
const MOD_SHIFT = 8;

// Map key names to CDP modifier flags
function modifierFlag(key: string): number {
  const k = key.toLowerCase();
  if (k === "alt") return MOD_ALT;
  if (k === "ctrl" || k === "control") return MOD_CTRL;
  if (k === "meta" || k === "command" || k === "cmd") return MOD_META;
  if (k === "shift") return MOD_SHIFT;
  return 0;
}

export class CDPTab implements BrowserTab {
  private currentUrl = "about:blank";
  private currentViewport: ViewportSize = { width: 1280, height: 720 };
  private lastClickPx: { x: number; y: number } | null = null;

  // Emulated address bar: CDP key events go to the PAGE, not browser chrome.
  // When the model tries to use Ctrl+L to open the address bar, we intercept the
  // sequence (Ctrl+L → type URL → Enter) and convert it to a real tab.goto() call.
  private urlBar: { active: boolean; buffer: string } = { active: false, buffer: "" };

  constructor(
    private session: CDPSessionLike,
    private readonly log: LumenLogger = LumenLogger.NOOP,
  ) {
    this._registerSessionListeners(session);
  }

  private _registerSessionListeners(session: CDPSessionLike): void {
    // Track navigation events
    session.on("Page.navigatedWithinDocument", (params) => {
      const p = params as { url: string };
      this.currentUrl = p.url;
      this.log.browser(`navigatedWithinDocument: ${p.url}`);
    });
    session.on("Page.frameNavigated", (params) => {
      const p = params as { frame: { url: string; parentId?: string } };
      if (!p.frame.parentId) {
        this.currentUrl = p.frame.url;
        this.log.browser(`frameNavigated: ${p.frame.url}`);
      }
    });

    // Enable Page events
    session.send("Page.enable").catch(() => {});
  }

  /** Swap in a new CDP session after a browsing-context replacement (e.g. COOP navigation).
   *  The CDPTab object identity stays the same so Session/PerceptionLoop don't need updating. */
  async reconnect(newSession: CDPSessionLike): Promise<void> {
    this.session = newSession;
    this.currentUrl = "about:blank";
    this.urlBar = { active: false, buffer: "" };
    this.lastClickPx = null;
    this._registerSessionListeners(newSession);
    this.log.browser(`CDPTab reconnected to new CDP session`);
    // Sync actual URL from the new session (it may already be navigated)
    await this.syncUrl();
  }

  /** Clear transient input state (URL bar buffer, last click position).
   *  Call between independent task runs that share the same tab instance. */
  resetInputState(): void {
    this.urlBar = { active: false, buffer: "" };
    this.lastClickPx = null;
  }

  /** Sync currentUrl with the actual page URL — call after attaching to an existing tab. */
  async syncUrl(): Promise<void> {
    try {
      const result = await this.session.send<EvaluateResponse>("Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      });
      const href = result.result.value as string;
      if (href) {
        this.log.browser(`syncUrl: ${href}`);
        this.currentUrl = href;
      }
    } catch { /* ignore — page may not be ready */ }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    try {
      const format = options.format ?? "png";
      const params: Record<string, unknown> = { format };
      if (format === "jpeg" && options.quality) params.quality = options.quality;
      if (options.fullPage) params.captureBeyondViewport = true;

      const result = await this.session.send<ScreenshotResponse>("Page.captureScreenshot", params);
      let data = Buffer.from(result.data, "base64");
      const sizeKB = (data.length / 1024).toFixed(1);

      // Composite cursor overlay at last click position (skipped if cursorOverlay: false or no click yet)
      const hasCursor = options.cursorOverlay !== false && this.lastClickPx !== null;
      if (hasCursor) {
        data = await this.composeCursor(data, this.lastClickPx!.x, this.lastClickPx!.y);
      }

      this.log.browser(
        `screenshot: ${this.currentViewport.width}x${this.currentViewport.height} ${format} ${sizeKB}KB` +
        (hasCursor ? ` cursor=(${this.lastClickPx!.x},${this.lastClickPx!.y})` : ""),
        { width: this.currentViewport.width, height: this.currentViewport.height, format, sizeKB: parseFloat(sizeKB) },
      );

      return {
        data,
        width: this.currentViewport.width,
        height: this.currentViewport.height,
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      };
    } catch (err) {
      this.log.browser(`screenshot FAILED: ${err}`, { error: String(err) });
      throw new Error(`Screenshot failed: ${err}`);
    }
  }

  private async composeCursor(buf: Buffer<ArrayBuffer>, x: number, y: number): Promise<Buffer<ArrayBuffer>> {
    try {
      const sharp = (await import("sharp")).default;
      const circleSize = 12;
      const half = circleSize / 2;
      const svg = Buffer.from(
        `<svg width="${circleSize}" height="${circleSize}"><circle cx="${half}" cy="${half}" r="${half - 1}" fill="red" fill-opacity="0.8"/></svg>`
      );
      return (await sharp(buf)
        .composite([{ input: svg, left: Math.max(0, Math.round(x - half)), top: Math.max(0, Math.round(y - half)) }])
        .png()
        .toBuffer()) as unknown as Buffer<ArrayBuffer>;
    } catch {
      return buf; // Return original if sharp fails
    }
  }

  async click(x: number, y: number, options: ClickOptions = {}): Promise<ActionOutcome> {
    const button = options.button ?? "left";
    this.log.browser(`click: px(${x},${y}) btn=${button}`);
    try {
      const clickCount = options.clickCount ?? 1;
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button });
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
      this.lastClickPx = { x, y };
      return { ok: true };
    } catch (err) {
      this.log.browser(`click FAILED: ${err}`, { x, y, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async doubleClick(x: number, y: number): Promise<ActionOutcome> {
    this.log.browser(`doubleClick: px(${x},${y})`);
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2 });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
      this.lastClickPx = { x, y };
      return { ok: true };
    } catch (err) {
      this.log.browser(`doubleClick FAILED: ${err}`, { x, y, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async hover(x: number, y: number): Promise<ActionOutcome> {
    this.log.browser(`hover: px(${x},${y})`);
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return { ok: true };
    } catch (err) {
      this.log.browser(`hover FAILED: ${err}`, { x, y, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, options: DragOptions = {}): Promise<ActionOutcome> {
    this.log.browser(`drag: px(${fromX},${fromY}) → px(${toX},${toY})`);
    try {
      const steps = options.steps ?? 10;
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fromX, y: fromY, button: "left" });
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(fromX + (toX - fromX) * (i / steps));
        const y = Math.round(fromY + (toY - fromY) * (i / steps));
        await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
      }
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: toY, button: "left" });
      return { ok: true };
    } catch (err) {
      this.log.browser(`drag FAILED: ${err}`, { fromX, fromY, toX, toY, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<ActionOutcome> {
    this.log.browser(`scroll: px(${x},${y}) delta=(${deltaX},${deltaY})`);
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
      return { ok: true };
    } catch (err) {
      this.log.browser(`scroll FAILED: ${err}`, { x, y, deltaX, deltaY, error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async type(text: string, _options: TypeOptions = {}): Promise<ActionOutcome> {
    try {
      // In URL bar mode, capture text into the URL buffer instead of sending to the page.
      // Models often append "\n" to the URL when typing (treating newline as Enter).
      // Detect this and trigger navigation immediately rather than waiting for keyPress.
      if (this.urlBar.active) {
        const newlineIdx = text.search(/[\r\n]/);
        const hasNewline = newlineIdx !== -1;
        this.urlBar.buffer += hasNewline ? text.slice(0, newlineIdx) : text;
        this.log.browser(`urlBar: buffered "${text.slice(0, 40)}" → buffer="${this.urlBar.buffer.slice(0, 80)}"`);
        if (hasNewline) {
          const url = this.urlBar.buffer.trim();
          this.log.browser(`urlBar: implicit Enter (newline in type) → "${url}"`);
          this.urlBar = { active: false, buffer: "" };
          if (url) {
            const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
            await this.goto(fullUrl);
          }
        }
        return { ok: true };
      }
      const preview = text.slice(0, 40);
      this.log.browser(`type: "${preview}${text.length > 40 ? "..." : ""}" (${text.length} chars)`);
      await this.session.send("Input.insertText", { text });
      return { ok: true };
    } catch (err) {
      this.log.browser(`type FAILED: ${err}`, { error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async keyPress(key: string | string[]): Promise<ActionOutcome> {
    try {
      const keys = Array.isArray(key) ? key : [key];

      // ── Address bar emulation ─────────────────────────────────────────────
      // CDP input events go to page content, not browser chrome. Intercept the
      // common address-bar navigation sequence: Ctrl+L → type URL → Enter.

      // Ctrl+L (or Ctrl+F6) → open simulated address bar
      const lowers = keys.map((k) => k.toLowerCase());
      const hasCtrl = lowers.some((k) => k === "ctrl" || k === "control");
      const hasL    = lowers.some((k) => k === "l");
      const hasF6   = lowers.some((k) => k === "f6");
      if ((hasCtrl && hasL) || hasF6) {
        this.log.browser(`urlBar: activated (${keys.join("+")})`);
        this.urlBar = { active: true, buffer: "" };
        return { ok: true };
      }

      // Escape → cancel URL bar mode
      if (lowers.some((k) => k === "escape" || k === "esc")) {
        if (this.urlBar.active) this.log.browser(`urlBar: cancelled`);
        this.urlBar = { active: false, buffer: "" };
      }

      // Enter/Return while in URL bar mode → navigate to the typed URL
      if (this.urlBar.active && lowers.some((k) => k === "return" || k === "enter")) {
        const url = this.urlBar.buffer.trim();
        this.log.browser(`urlBar: Enter → "${url}"`);
        this.urlBar = { active: false, buffer: "" };
        if (url) {
          const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
          await this.goto(fullUrl);
        }
        return { ok: true };
      }
      // ─────────────────────────────────────────────────────────────────────

      if (!this.urlBar.active) {
        this.log.browser(`keyPress: [${keys.join(", ")}]`);
      }

      // Separate modifiers from regular keys
      const modKeys = keys.filter((k) => modifierFlag(k) > 0);
      const mainKeys = keys.filter((k) => modifierFlag(k) === 0);
      const modBits = modKeys.reduce((acc, k) => acc | modifierFlag(k), 0);

      // Press modifiers down first, then main keys with modifier bits, then release all
      for (const mk of modKeys) {
        await this.session.send("Input.dispatchKeyEvent", { type: "keyDown", key: mk, modifiers: modBits });
      }
      for (const mk of mainKeys) {
        await this.session.send("Input.dispatchKeyEvent", { type: "keyDown", key: mk, modifiers: modBits });
        await this.session.send("Input.dispatchKeyEvent", { type: "keyUp",   key: mk, modifiers: modBits });
      }
      for (const mk of [...modKeys].reverse()) {
        await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", key: mk, modifiers: 0 });
      }

      return { ok: true };
    } catch (err) {
      this.log.browser(`keyPress FAILED: ${err}`, { keys: Array.isArray(key) ? key : [key], error: String(err) });
      return { ok: false, error: String(err) };
    }
  }

  async goto(url: string): Promise<void> {
    // Programmatic navigation supersedes any in-progress URL bar input
    if (this.urlBar.active) {
      this.urlBar = { active: false, buffer: "" };
    }
    this.log.browser(`goto: ${url}`);
    const result = await this.session.send<NavigateResponse>("Page.navigate", { url });
    if (result.errorText) {
      this.log.browser(`goto FAILED: ${result.errorText}`, { url, error: result.errorText });
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    this.currentUrl = url;
    await this.waitForLoad(8000); // wait for networkIdle before returning
  }

  async waitForLoad(timeoutMs = 5000): Promise<void> {
    // Enable lifecycle events so networkIdle fires (no-op if already enabled)
    await this.session.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});

    const t0 = Date.now();
    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = (reason: string) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.session.off("Page.lifecycleEvent", lifecycleHandler);
        this.session.off("Page.loadEventFired", loadHandler);
        const elapsed = Date.now() - t0;
        if (reason === "timeout") {
          this.log.browser(`waitForLoad: timed out after ${elapsed}ms`);
        } else {
          this.log.browser(`waitForLoad: ${reason} after ${elapsed}ms`, { reason, elapsed });
        }
        resolve();
      };

      // Resolve on networkIdle (no pending network requests for 500ms) — works on SPAs
      const lifecycleHandler = (params: unknown) => {
        const p = params as { name: string };
        if (p.name === "networkIdle") done("networkIdle");
      };

      // Also resolve on plain load event as fallback
      const loadHandler = () => done("loadEventFired");

      const timer = setTimeout(() => done("timeout"), timeoutMs);
      this.session.on("Page.lifecycleEvent", lifecycleHandler);
      this.session.on("Page.loadEventFired", loadHandler);
    });
  }

  url(): string {
    return this.currentUrl;
  }

  viewport(): ViewportSize {
    return { ...this.currentViewport };
  }

  async setViewport(size: ViewportSize): Promise<void> {
    this.log.browser(`setViewport: ${size.width}x${size.height}`);
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    this.currentViewport = { ...size };
  }

  async evaluate<T>(fn: string): Promise<T> {
    const result = await this.session.send<EvaluateResponse>("Runtime.evaluate", {
      expression: fn,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`Evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value as T;
  }

  async close(): Promise<void> {
    try {
      await this.session.send("Target.closeTarget", {});
    } catch {
      // ignore
    }
  }
}
