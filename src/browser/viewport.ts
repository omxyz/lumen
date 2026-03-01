import type { BrowserTab } from "./tab.js";
import type { ViewportSize } from "../types.js";

export class ViewportManager {
  private current_: ViewportSize;
  private original: ViewportSize;

  constructor(private readonly tab: BrowserTab) {
    this.current_ = tab.viewport();
    this.original = { ...this.current_ };
  }

  async alignToModel(patchSize = 28, maxDim = 1344): Promise<ViewportSize> {
    const vp = this.tab.viewport();

    const roundUp = (n: number, step: number) => Math.ceil(n / step) * step;

    let width = roundUp(vp.width, patchSize);
    let height = roundUp(vp.height, patchSize);

    width = Math.min(width, maxDim);
    height = Math.min(height, maxDim);

    const aligned: ViewportSize = { width, height };
    await this.tab.setViewport(aligned);
    this.current_ = aligned;
    return aligned;
  }

  async restoreOriginal(): Promise<void> {
    await this.tab.setViewport(this.original);
    this.current_ = { ...this.original };
  }

  current(): ViewportSize {
    return { ...this.current_ };
  }
}
