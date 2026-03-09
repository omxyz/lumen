import type { FrameworkAdapter, FrameworkAttemptResult } from "./types.js";

export const stagehandAdapter: FrameworkAdapter = {
  name: "stagehand",

  async run({ instruction, startUrl, maxSteps, model, apiKey, timeoutMs }) {
    const start = Date.now();
    let stagehand: import("@browserbasehq/stagehand").V3 | null = null;

    try {
      const { Stagehand } = await import("@browserbasehq/stagehand");

      stagehand = new Stagehand({
        env: "LOCAL",
        verbose: 0,
        disablePino: true,
        localBrowserLaunchOptions: { headless: true },
      });

      await stagehand.init();

      // Navigate to startUrl
      const pages = (stagehand as unknown as {
        context: { pages(): Array<{ goto(url: string, opts?: Record<string, unknown>): Promise<unknown> }> };
      }).context.pages();
      if (pages.length > 0) {
        await pages[0].goto(startUrl, { waitUntil: "domcontentloaded" });
      }

      // Use `any` for agent config — stagehand's types are broken across zod versions
      const agent = stagehand.agent({
        mode: "cua",
        model: model as any,
      } as any);

      const agentResult: any = await withTimeout(
        agent.execute({ instruction, maxSteps }),
        timeoutMs,
        "stagehand",
      );

      // Capture screenshot before closing
      let screenshot: Buffer | undefined;
      try {
        const currentPages = (stagehand as unknown as {
          context: { pages(): Array<{ screenshot(opts?: Record<string, unknown>): Promise<Buffer> }> };
        }).context.pages();
        if (currentPages.length > 0) {
          screenshot = await currentPages[0].screenshot({ type: "jpeg", quality: 75 });
        }
      } catch { /* page may have closed */ }

      await stagehand.close();
      stagehand = null;

      const resultText = agentResult.success
        ? (agentResult.message ?? "")
        : `[incomplete] ${agentResult.message ?? ""}`;

      return {
        framework: "stagehand",
        result: resultText,
        status: agentResult.success ? "success" : "maxSteps",
        steps: agentResult.actions?.length ?? 0,
        tokens: agentResult.usage
          ? agentResult.usage.input_tokens + agentResult.usage.output_tokens
          : 0,
        durationMs: Date.now() - start,
        screenshot,
      } satisfies FrameworkAttemptResult;
    } catch (err) {
      if (stagehand) {
        try { await stagehand.close(); } catch { /* ignore */ }
      }
      return {
        framework: "stagehand",
        result: "",
        status: "error",
        steps: 0,
        tokens: 0,
        durationMs: Date.now() - start,
        error: String(err),
      };
    }
  },
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
