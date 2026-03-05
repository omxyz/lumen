/**
 * Complex multi-page navigation task designed for 20+ steps.
 *
 * Task: Browse books.toscrape.com (a safe demo e-commerce site),
 * navigate multiple categories, collect data across pages.
 * Heavy on clicks and page navigation, light on scrolling.
 *
 * Usage:
 *   npx tsx examples/complex-task.ts
 */

import { Agent } from "../src/index.js";

const model = process.env.LUMEN_MODEL ?? "anthropic/claude-sonnet-4-6";
const headed = process.env.LUMEN_HEADED === "true";

const TASK = {
  instruction: [
    "Go to https://books.toscrape.com/.",
    "Step 1: Record the titles and prices of the first 5 books shown on the homepage.",
    "Step 2: Click on the 'Travel' category in the left sidebar.",
    "Record how many books are in the Travel category and the title + price of the first 2 books.",
    "Step 3: Go back to the homepage. Click on the 'Mystery' category.",
    "Record how many books are in Mystery and the title + price of the first 2 books.",
    "Step 4: Go back to the homepage. Click on the 'Science Fiction' category.",
    "Record how many books are in Science Fiction and the title + price of the first 2 books.",
    "Step 5: Click into the first book in Science Fiction. Record its full description, star rating, and availability.",
    "Step 6: Go back to the homepage and click 'next' to go to page 2.",
    "Record the titles and prices of the first 3 books on page 2.",
    "Return ALL collected data in a structured format with clear section headers.",
  ].join(" "),
  startUrl: "https://books.toscrape.com/",
  maxSteps: 45,
};

async function main() {
  console.log(`\n=== Lumen Complex Task (20+ steps) ===`);
  console.log(`Model:    ${model}`);
  console.log(`Headed:   ${headed}`);
  console.log(`MaxSteps: ${TASK.maxSteps}`);
  console.log();

  const startTime = Date.now();

  const agent = new Agent({
    model,
    browser: { type: "local", headless: !headed },
    maxSteps: TASK.maxSteps,
    verbose: 2,
  });

  try {
    const result = await agent.run({
      instruction: TASK.instruction,
      startUrl: TASK.startUrl,
      maxSteps: TASK.maxSteps,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Status:   ${result.status}`);
    console.log(`Steps:    ${result.steps}`);
    console.log(`Time:     ${elapsed}s`);
    console.log(`Tokens:   ${result.tokenUsage.inputTokens.toLocaleString()} in / ${result.tokenUsage.outputTokens.toLocaleString()} out`);
    console.log(`${"=".repeat(60)}`);
    console.log(`\n--- Agent Output ---\n`);
    console.log(result.result);
    console.log(`\n--- Execution Trace ---`);
    for (const step of result.history) {
      const actions = step.actions
        .map((a) => {
          let label = a.action.type;
          if (a.action.type === "goto") label += ` → ${(a.action as { url: string }).url.slice(0, 50)}`;
          if (a.action.type === "writeState") label += " 📝";
          if (!a.outcome.ok) label += " ✗";
          return label;
        })
        .join(", ");
      console.log(`  [${String(step.stepIndex + 1).padStart(2)}] ${actions} (${(step.durationMs / 1000).toFixed(1)}s)`);
    }
  } finally {
    await agent.close();
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err.message);
  process.exit(1);
});
