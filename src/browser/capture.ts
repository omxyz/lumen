import type { BrowserTab } from "./tab.js";
import type { Point, ScreenshotOptions, ScreenshotResult } from "../types.js";

export class ScreenCapture {
  constructor(private readonly tab: BrowserTab) {}

  async capture(opts: ScreenshotOptions, lastClickPx: Point | null): Promise<ScreenshotResult> {
    const result = await this.tab.screenshot(opts);
    if (lastClickPx && opts.cursorOverlay !== false) {
      result.data = await this.composeCursor(result.data, lastClickPx.x, lastClickPx.y);
    }
    return result;
  }

  private async composeCursor(buf: Buffer, x: number, y: number): Promise<Buffer> {
    try {
      const sharp = (await import("sharp")).default;
      // Create a 12px red circle SVG
      const circleSize = 12;
      const half = circleSize / 2;
      const circleSvg = Buffer.from(
        `<svg width="${circleSize}" height="${circleSize}"><circle cx="${half}" cy="${half}" r="${half - 1}" fill="red" fill-opacity="0.8"/></svg>`
      );

      return await sharp(buf)
        .composite([{
          input: circleSvg,
          left: Math.max(0, Math.round(x - half)),
          top: Math.max(0, Math.round(y - half)),
        }])
        .png()
        .toBuffer();
    } catch {
      // If sharp fails, return original
      return buf;
    }
  }
}
