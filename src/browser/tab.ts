import type { ActionOutcome, ScreenshotOptions, ScreenshotResult, ViewportSize } from "../types.js";

export interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  delayMs?: number;
}

export interface DragOptions {
  steps?: number;
}

export interface TypeOptions {
  delayMs?: number;
  clearFirst?: boolean;
}

/** The only browser abstraction exposed to the perception loop.
 *  All coordinate parameters are in viewport pixels (already denormalized). */
export interface BrowserTab {
  // Screenshot — primary input to the loop
  screenshot(options?: ScreenshotOptions): Promise<ScreenshotResult>;

  // Coordinate input
  click(x: number, y: number, options?: ClickOptions): Promise<ActionOutcome>;
  doubleClick(x: number, y: number): Promise<ActionOutcome>;
  hover(x: number, y: number): Promise<ActionOutcome>;
  drag(fromX: number, fromY: number, toX: number, toY: number, options?: DragOptions): Promise<ActionOutcome>;
  scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<ActionOutcome>;

  // Keyboard
  type(text: string, options?: TypeOptions): Promise<ActionOutcome>;
  keyPress(key: string | string[]): Promise<ActionOutcome>;

  // Navigation
  goto(url: string): Promise<void>;
  waitForLoad(timeoutMs?: number): Promise<void>;
  url(): string;

  // Viewport
  viewport(): ViewportSize;
  setViewport(size: ViewportSize): Promise<void>;

  // Low-level escape hatch
  evaluate<T>(fn: string): Promise<T>;
  close(): Promise<void>;
}
