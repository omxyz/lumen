import type { BrowserTab, ClickOptions, DragOptions, TypeOptions } from "../../src/browser/tab.js";
import type { ActionOutcome, ScreenshotOptions, ScreenshotResult, ViewportSize } from "../../src/types.js";

export interface MockTabCall {
  method: string;
  args: unknown[];
}

export class MockBrowserTab implements BrowserTab {
  public calls: MockTabCall[] = [];
  private _url = "https://example.com";
  private _viewport: ViewportSize = { width: 1280, height: 720 };
  private screenshotData: Buffer;

  constructor(opts: { url?: string; viewport?: ViewportSize; screenshotData?: Buffer } = {}) {
    this._url = opts.url ?? "https://example.com";
    this._viewport = opts.viewport ?? { width: 1280, height: 720 };
    this.screenshotData = opts.screenshotData ?? Buffer.alloc(100, 0);
  }

  private record(method: string, args: unknown[]): ActionOutcome {
    this.calls.push({ method, args });
    return { ok: true };
  }

  async screenshot(_opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    this.calls.push({ method: "screenshot", args: [] });
    return {
      data: this.screenshotData,
      width: this._viewport.width,
      height: this._viewport.height,
      mimeType: "image/png",
    };
  }

  async click(x: number, y: number, options?: ClickOptions): Promise<ActionOutcome> {
    return this.record("click", [x, y, options]);
  }

  async doubleClick(x: number, y: number): Promise<ActionOutcome> {
    return this.record("doubleClick", [x, y]);
  }

  async hover(x: number, y: number): Promise<ActionOutcome> {
    return this.record("hover", [x, y]);
  }

  async drag(fromX: number, fromY: number, toX: number, toY: number, _opts?: DragOptions): Promise<ActionOutcome> {
    return this.record("drag", [fromX, fromY, toX, toY]);
  }

  async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<ActionOutcome> {
    return this.record("scroll", [x, y, deltaX, deltaY]);
  }

  async type(text: string, _opts?: TypeOptions): Promise<ActionOutcome> {
    return this.record("type", [text]);
  }

  async keyPress(key: string | string[]): Promise<ActionOutcome> {
    return this.record("keyPress", [key]);
  }

  async goto(url: string): Promise<void> {
    this.calls.push({ method: "goto", args: [url] });
    this._url = url;
  }

  async waitForLoad(_timeoutMs?: number): Promise<void> {
    this.calls.push({ method: "waitForLoad", args: [] });
  }

  url(): string { return this._url; }
  viewport(): ViewportSize { return { ...this._viewport }; }

  async setViewport(size: ViewportSize): Promise<void> {
    this.calls.push({ method: "setViewport", args: [size] });
    this._viewport = { ...size };
  }

  async evaluate<T>(_fn: string): Promise<T> {
    this.calls.push({ method: "evaluate", args: [_fn] });
    return undefined as unknown as T;
  }

  async close(): Promise<void> {
    this.calls.push({ method: "close", args: [] });
  }
}
