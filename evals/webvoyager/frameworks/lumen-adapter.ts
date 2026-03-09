import { Agent } from "../../../src/index.js";
import type { FrameworkAdapter, FrameworkAttemptResult } from "./types.js";

export const lumenAdapter: FrameworkAdapter = {
  name: "lumen",

  async run({ instruction, startUrl, maxSteps, model, apiKey, timeoutMs }) {
    const start = Date.now();
    const agent = new Agent({
      model,
      apiKey,
      browser: { type: "local" },
      maxSteps,
      compactionThreshold: 0.6,
      verbose: 0,
    });

    try {
      const agentResult = await withTimeout(
        agent.run({ instruction, maxSteps, startUrl }),
        timeoutMs,
        "lumen",
      );

      // Capture screenshot before closing
      let screenshot: Buffer | undefined;
      try {
        const ss = await agent.tab.screenshot();
        screenshot = ss.data;
      } catch { /* page may have crashed */ }

      await agent.close();

      const resultText =
        agentResult.status === "success"
          ? agentResult.result
          : `[${agentResult.status}] ${agentResult.result}`;
      const totalTokens =
        agentResult.tokenUsage.inputTokens + agentResult.tokenUsage.outputTokens;

      return {
        framework: "lumen",
        result: resultText,
        status: agentResult.status === "success" ? "success" : "maxSteps",
        steps: agentResult.steps,
        tokens: totalTokens,
        durationMs: Date.now() - start,
        screenshot,
      } satisfies FrameworkAttemptResult;
    } catch (err) {
      await agent.close().catch(() => {});
      return {
        framework: "lumen",
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
