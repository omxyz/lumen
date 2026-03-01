import { describe, it, expect, vi } from "vitest";
import { ActionRouter } from "../../src/loop/router.js";
import { StateStore } from "../../src/loop/state.js";
import type { BrowserTab, ClickOptions, DragOptions, TypeOptions } from "../../src/browser/tab.js";
import type { ActionOutcome, ScreenshotOptions, ScreenshotResult, ViewportSize } from "../../src/types.js";

// Simple in-line mock tab
function makeMockTab(viewport: ViewportSize = { width: 1280, height: 720 }): BrowserTab {
  return {
    screenshot: async (_opts?: ScreenshotOptions): Promise<ScreenshotResult> => ({
      data: Buffer.from(""),
      width: viewport.width,
      height: viewport.height,
      mimeType: "image/png",
    }),
    click: vi.fn(async (_x: number, _y: number, _opts?: ClickOptions) => ({ ok: true }) as ActionOutcome),
    doubleClick: vi.fn(async (_x: number, _y: number) => ({ ok: true }) as ActionOutcome),
    hover: vi.fn(async (_x: number, _y: number) => ({ ok: true }) as ActionOutcome),
    drag: vi.fn(async (_fx: number, _fy: number, _tx: number, _ty: number, _opts?: DragOptions) => ({ ok: true }) as ActionOutcome),
    scroll: vi.fn(async (_x: number, _y: number, _dx: number, _dy: number) => ({ ok: true }) as ActionOutcome),
    type: vi.fn(async (_text: string, _opts?: TypeOptions) => ({ ok: true }) as ActionOutcome),
    keyPress: vi.fn(async (_key: string | string[]) => ({ ok: true }) as ActionOutcome),
    goto: vi.fn(async (_url: string): Promise<void> => {}),
    waitForLoad: vi.fn(async (_timeoutMs?: number): Promise<void> => {}),
    url: () => "https://example.com",
    viewport: () => viewport,
    setViewport: vi.fn(async (_size: ViewportSize): Promise<void> => {}),
    evaluate: (async (_fn: string) => undefined) as BrowserTab["evaluate"],
    close: vi.fn(async (): Promise<void> => {}),
  };
}

describe("ActionRouter", () => {
  const state = new StateStore();

  it("click denormalizes (500, 500) on 1280x720 to (640, 360)", async () => {
    const tab = makeMockTab({ width: 1280, height: 720 });
    const router = new ActionRouter({ afterClick: 0 });
    await router.execute({ type: "click", x: 500, y: 500 }, tab, state);
    expect(tab.click).toHaveBeenCalledWith(640, 360, { button: "left" });
  });

  it("scroll direction 'down' maps to positive deltaY", async () => {
    const tab = makeMockTab();
    const router = new ActionRouter({ afterScroll: 0 });
    await router.execute({ type: "scroll", x: 500, y: 500, direction: "down", amount: 3 }, tab, state);
    const callArgs = (tab.scroll as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number, number, number];
    const [, , deltaX, deltaY] = callArgs;
    expect(deltaX).toBe(0);
    expect(deltaY).toBeGreaterThan(0);
  });

  it("scroll direction 'up' maps to negative deltaY", async () => {
    const tab = makeMockTab();
    const router = new ActionRouter({ afterScroll: 0 });
    await router.execute({ type: "scroll", x: 500, y: 500, direction: "up", amount: 3 }, tab, state);
    const callArgs = (tab.scroll as ReturnType<typeof vi.fn>).mock.calls[0] as [number, number, number, number];
    const [, , , deltaY] = callArgs;
    expect(deltaY).toBeLessThan(0);
  });

  it("writeState calls state.write()", async () => {
    const tab = makeMockTab();
    const router = new ActionRouter();
    const localState = new StateStore();
    await router.execute({ type: "writeState", data: { min_price: "£3.49" } }, tab, localState);
    expect(localState.current()).toEqual({ min_price: "£3.49" });
  });

  it("terminate returns terminated: true", async () => {
    const tab = makeMockTab();
    const router = new ActionRouter();
    const result = await router.execute({ type: "terminate", status: "success", result: "done" }, tab, state);
    expect(result.terminated).toBe(true);
    expect(result.status).toBe("success");
    expect(result.result).toBe("done");
  });

  it("hover denormalizes coordinates", async () => {
    const tab = makeMockTab({ width: 1280, height: 720 });
    const router = new ActionRouter({ afterClick: 0 });
    await router.execute({ type: "hover", x: 500, y: 500 }, tab, state);
    expect(tab.hover).toHaveBeenCalledWith(640, 360);
  });

  it("delegate returns isDelegateRequest: true", async () => {
    const tab = makeMockTab();
    const router = new ActionRouter();
    const result = await router.execute({ type: "delegate", instruction: "do something", maxSteps: 5 }, tab, state);
    expect(result.isDelegateRequest).toBe(true);
    expect(result.delegateInstruction).toBe("do something");
    expect(result.delegateMaxSteps).toBe(5);
  });

  it("screenshot returns isScreenshotRequest: true", async () => {
    const tab = makeMockTab();
    const router = new ActionRouter();
    const result = await router.execute({ type: "screenshot" }, tab, state);
    expect(result.isScreenshotRequest).toBe(true);
  });
});
