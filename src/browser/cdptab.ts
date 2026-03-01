import type { CDPSessionLike } from "./cdp.js";
import type { BrowserTab, ClickOptions, DragOptions, TypeOptions } from "./tab.js";
import type { ActionOutcome, ScreenshotOptions, ScreenshotResult, ViewportSize } from "../types.js";

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

  constructor(private readonly session: CDPSessionLike) {
    // Track navigation events
    session.on("Page.navigatedWithinDocument", (params) => {
      const p = params as { url: string };
      this.currentUrl = p.url;
    });
    session.on("Page.frameNavigated", (params) => {
      const p = params as { frame: { url: string; parentId?: string } };
      if (!p.frame.parentId) this.currentUrl = p.frame.url;
    });

    // Enable Page events
    this.session.send("Page.enable").catch(() => {});
  }

  /** Sync currentUrl with the actual page URL — call after attaching to an existing tab. */
  async syncUrl(): Promise<void> {
    try {
      const result = await this.session.send<EvaluateResponse>("Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      });
      const href = result.result.value as string;
      if (href) this.currentUrl = href;
    } catch { /* ignore — page may not be ready */ }
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    try {
      const format = options.format ?? "png";
      const params: Record<string, unknown> = { format };
      if (format === "jpeg" && options.quality) params.quality = options.quality;
      if (options.fullPage) params.captureBeyondViewport = true;

      console.log(`[cdptab] → Page.captureScreenshot`);
      const result = await this.session.send<ScreenshotResponse>("Page.captureScreenshot", params);
      console.log(`[cdptab] ← Page.captureScreenshot ok (${result.data.length} base64 chars)`);
      let data = Buffer.from(result.data, "base64");

      // Composite cursor overlay at last click position (skipped if cursorOverlay: false or no click yet)
      if (options.cursorOverlay !== false && this.lastClickPx) {
        data = await this.composeCursor(data, this.lastClickPx.x, this.lastClickPx.y);
      }

      return {
        data,
        width: this.currentViewport.width,
        height: this.currentViewport.height,
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      };
    } catch (err) {
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
    try {
      const button = options.button ?? "left";
      const clickCount = options.clickCount ?? 1;
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button });
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
      this.lastClickPx = { x, y };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async doubleClick(x: number, y: number): Promise<ActionOutcome> {
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 2 });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 2 });
      this.lastClickPx = { x, y };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async rightClick(x: number, y: number): Promise<ActionOutcome> {
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
      this.lastClickPx = { x, y };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async mouseDown(x: number, y: number): Promise<ActionOutcome> {
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async mouseUp(x: number, y: number): Promise<ActionOutcome> {
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left" });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async hover(x: number, y: number): Promise<ActionOutcome> {
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, options: DragOptions = {}): Promise<ActionOutcome> {
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
      return { ok: false, error: String(err) };
    }
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<ActionOutcome> {
    try {
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await this.session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
      return { ok: true };
    } catch (err) {
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
        console.log(`[cdptab] urlBar: buffered "${text.slice(0, 40)}" → buffer="${this.urlBar.buffer}"`);
        if (hasNewline) {
          // Treat embedded newline as Enter — navigate immediately
          const url = this.urlBar.buffer.trim();
          console.log(`[cdptab] urlBar: implicit Enter (newline in type), buffer="${url}"`);
          this.urlBar = { active: false, buffer: "" };
          await this.removeUrlBarOverlay();
          if (url) {
            const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
            await this.goto(fullUrl);
            // Don't waitForLoad here — the model's API round-trip gives pages time to settle
          }
        } else {
          await this.renderUrlBarOverlay(this.urlBar.buffer);
        }
        return { ok: true };
      }
      await this.session.send("Input.insertText", { text });
      return { ok: true };
    } catch (err) {
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
        console.log(`[cdptab] urlBar: activated (${keys.join("+")})`);
        this.urlBar = { active: true, buffer: "" };
        await this.renderUrlBarOverlay("");
        return { ok: true };
      }

      // Escape → cancel URL bar mode
      if (lowers.some((k) => k === "escape" || k === "esc")) {
        console.log(`[cdptab] urlBar: cancelled`);
        this.urlBar = { active: false, buffer: "" };
        await this.removeUrlBarOverlay();
      }

      // Enter/Return while in URL bar mode → navigate to the typed URL
      if (this.urlBar.active && lowers.some((k) => k === "return" || k === "enter")) {
        const url = this.urlBar.buffer.trim();
        console.log(`[cdptab] urlBar: Enter pressed, buffer="${url}"`);
        this.urlBar = { active: false, buffer: "" };
        await this.removeUrlBarOverlay();
        if (url) {
          // Ensure URL has a scheme
          const fullUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
          await this.goto(fullUrl);
          // Don't waitForLoad here — the model's API round-trip gives pages time to settle
        }
        return { ok: true };
      }
      // ─────────────────────────────────────────────────────────────────────

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
      return { ok: false, error: String(err) };
    }
  }

  /** Render (or update) a visible fake address bar so the model gets visual feedback. */
  private async renderUrlBarOverlay(buffer: string): Promise<void> {
    const display = buffer === "" ? "Address bar open — type a URL and press Enter" : buffer;
    const js = `(function(){
      let el = document.getElementById('__cua_urlbar__');
      if (!el) {
        el = document.createElement('div');
        el.id = '__cua_urlbar__';
        Object.assign(el.style, {
          position:'fixed', top:'0', left:'0', right:'0', zIndex:'2147483647',
          background:'#1a73e8', color:'#fff', fontFamily:'monospace', fontSize:'15px',
          padding:'10px 16px', boxShadow:'0 2px 6px rgba(0,0,0,0.4)'
        });
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = '\uD83D\uDD0D ' + ${JSON.stringify(display)};
    })()`;
    await this.session.send("Runtime.evaluate", { expression: js }).catch(() => {});
  }

  private async removeUrlBarOverlay(): Promise<void> {
    await this.session.send("Runtime.evaluate", {
      expression: `document.getElementById('__cua_urlbar__')?.remove()`,
    }).catch(() => {});
  }

  async goto(url: string): Promise<void> {
    console.log(`[cdptab] → Page.navigate url=${url}`);
    const result = await this.session.send<NavigateResponse>("Page.navigate", { url });
    console.log(`[cdptab] ← Page.navigate frameId=${result.frameId} error=${result.errorText ?? "none"}`);
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    this.currentUrl = url;
    await this.waitForLoad(8000); // wait for networkIdle before returning
  }

  async waitForLoad(timeoutMs = 5000): Promise<void> {
    // Enable lifecycle events so networkIdle fires (no-op if already enabled)
    await this.session.send("Page.setLifecycleEventsEnabled", { enabled: true }).catch(() => {});

    return new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.session.off("Page.lifecycleEvent", lifecycleHandler);
        this.session.off("Page.loadEventFired", loadHandler);
        resolve();
      };

      // Resolve on networkIdle (no pending network requests for 500ms) — works on SPAs
      const lifecycleHandler = (params: unknown) => {
        const p = params as { name: string };
        if (p.name === "networkIdle") done();
      };

      // Also resolve on plain load event as fallback
      const loadHandler = () => done();

      const timer = setTimeout(done, timeoutMs);
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
    console.log(`[cdptab] → Emulation.setDeviceMetricsOverride ${size.width}×${size.height}`);
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
