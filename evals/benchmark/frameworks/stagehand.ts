import type { BenchmarkTask, FrameworkResult } from "../types.js";

export async function runWithStagehand(task: BenchmarkTask): Promise<FrameworkResult> {
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

    // Navigate to startUrl using the internal V3Context page (Playwright-style)
    const pages = (stagehand as unknown as { context: { pages(): Array<{ goto(url: string, opts?: Record<string, unknown>): Promise<unknown> }> } }).context.pages();
    if (pages.length > 0) {
      await pages[0].goto(task.startUrl, { waitUntil: "domcontentloaded" });
    }

    const model = process.env.MODEL ?? "anthropic/claude-sonnet-4-6";
    const agent = stagehand.agent({
      mode: "cua",
      model: model as Parameters<typeof stagehand.agent>[0]["model"],
    });

    const agentResult = await agent.execute({
      instruction: task.instruction,
      maxSteps: task.maxSteps,
    });

    await stagehand.close();
    stagehand = null;

    const { passed, score } = agentResult.success
      ? task.check(agentResult.message ?? "")
      : { passed: false, score: 0 };
    return {
      framework: "stagehand",
      task: task.name,
      passed,
      score,
      steps: agentResult.actions?.length ?? 0,
      tokens: agentResult.usage
        ? agentResult.usage.input_tokens + agentResult.usage.output_tokens
        : null,
      durationMs: Date.now() - start,
      result: agentResult.success ? (agentResult.message ?? "") : `[incomplete] ${agentResult.message ?? ""}`,
    };
  } catch (e) {
    if (stagehand) {
      try { await stagehand.close(); } catch { /* ignore */ }
    }
    return {
      framework: "stagehand",
      task: task.name,
      passed: false,
      score: 0,
      steps: 0,
      tokens: null,
      durationMs: Date.now() - start,
      result: "",
      error: String(e),
    };
  }
}
