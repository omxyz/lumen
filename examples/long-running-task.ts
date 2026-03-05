/**
 * Long-running task example that exercises all new features:
 *
 *   1. Adapter retry backoff — survives rate limits during long runs
 *   2. Repeat detection — nudges the agent when stuck
 *   3. ModelVerifier — verifies task completion with a screenshot
 *   4. Action caching — speeds up repeat runs (opt-in)
 *
 * Usage:
 *   npx tsx examples/long-running-task.ts
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY — for the model
 *
 * Optional env vars:
 *   LUMEN_MODEL   — model to use (default: anthropic/claude-sonnet-4-6)
 *   LUMEN_HEADED  — set to "true" to see the browser (default: headless)
 *   LUMEN_CACHE   — set to a dir path to enable action caching
 */

import { Agent } from "../src/index.js";
import { ModelVerifier } from "../src/loop/gate.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const model = process.env.LUMEN_MODEL ?? "anthropic/claude-sonnet-4-6";
const headed = process.env.LUMEN_HEADED === "true";
const cacheDir = process.env.LUMEN_CACHE; // undefined = disabled

// ─── Task Definition ─────────────────────────────────────────────────────────
// This task is deliberately complex — multi-step research across multiple pages.
// It exercises repeat detection (agent may get stuck scrolling) and benefits
// from the verifier (confirming it actually found the data before exiting).

const TASK = {
  instruction: [
    "Go to Hacker News (https://news.ycombinator.com).",
    "Find the top 5 stories on the front page.",
    "For each story, record: the title, the number of points, and the number of comments.",
    "Then go to the second page (More link at the bottom) and find the top 3 stories there.",
    "Return ALL 8 stories in a numbered list with title, points, and comments.",
  ].join(" "),
  startUrl: "https://news.ycombinator.com",
  maxSteps: 30,
};

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Lumen Long-Running Task ===`);
  console.log(`Model:    ${model}`);
  console.log(`Headed:   ${headed}`);
  console.log(`Cache:    ${cacheDir ?? "disabled"}`);
  console.log(`MaxSteps: ${TASK.maxSteps}`);
  console.log(`Task:     ${TASK.instruction.slice(0, 100)}...`);
  console.log();

  const startTime = Date.now();

  const agent = new Agent({
    model,
    browser: { type: "local", headless: !headed },
    maxSteps: TASK.maxSteps,
    verbose: 2,
    // ModelVerifier: confirms the agent actually gathered all 8 stories before accepting terminate
    completionGate: new ModelVerifier(
      // Use a separate lightweight adapter instance for verification
      await createVerifierAdapter(model),
      "Return a numbered list of 8 stories (top 5 from page 1 + top 3 from page 2) with title, points, and comments for each.",
    ),
  });

  try {
    const result = await agent.run({
      instruction: TASK.instruction,
      startUrl: TASK.startUrl,
      maxSteps: TASK.maxSteps,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n=== Result ===`);
    console.log(`Status:   ${result.status}`);
    console.log(`Steps:    ${result.steps}`);
    console.log(`Time:     ${elapsed}s`);
    console.log(`Tokens:   ${result.tokenUsage.inputTokens.toLocaleString()} in / ${result.tokenUsage.outputTokens.toLocaleString()} out`);
    console.log(`\n--- Agent Output ---`);
    console.log(result.result);
    console.log(`\n--- Execution Trace ---`);
    for (const step of result.history) {
      const actions = step.actions.map(a => `${a.action.type}${a.outcome.ok ? "" : " [FAILED]"}`).join(", ");
      console.log(`  Step ${step.stepIndex + 1}: ${actions} (${step.durationMs}ms)`);
    }
  } finally {
    await agent.close();
  }
}

async function createVerifierAdapter(modelStr: string) {
  // Lazy import the adapter to match what Agent does internally
  if (modelStr.startsWith("anthropic/") || modelStr.startsWith("claude")) {
    const { AnthropicAdapter } = await import("../src/model/anthropic.js");
    const modelId = modelStr.startsWith("anthropic/") ? modelStr.slice("anthropic/".length) : modelStr;
    return new AnthropicAdapter(modelId);
  }
  if (modelStr.startsWith("google/") || modelStr.startsWith("gemini")) {
    const { GoogleAdapter } = await import("../src/model/google.js");
    const modelId = modelStr.startsWith("google/") ? modelStr.slice("google/".length) : modelStr;
    return new GoogleAdapter(modelId);
  }
  if (modelStr.startsWith("openai/")) {
    const { OpenAIAdapter } = await import("../src/model/openai.js");
    return new OpenAIAdapter(modelStr.slice("openai/".length));
  }
  throw new Error(`Cannot create verifier adapter for model: ${modelStr}`);
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
