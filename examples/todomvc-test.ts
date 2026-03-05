/**
 * TodoMVC SPA test — apples-to-apples comparison with Stagehand CUA.
 * Same task, same model, same viewport.
 *
 * Usage:
 *   npx tsx examples/todomvc-test.ts
 */

import { readFileSync } from "fs";
import { Agent } from "../src/index.js";

// Load .env manually (no dotenv dependency)
try {
  const envFile = readFileSync(new URL("../.env", import.meta.url), "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]!.trim()]) {
      process.env[match[1]!.trim()] = match[2]!.trim();
    }
  }
} catch { /* no .env file */ }

const model = process.env.LUMEN_MODEL ?? "anthropic/claude-sonnet-4-6";
const headed = process.env.LUMEN_HEADED === "true";

const TASK = {
  instruction: [
    "You are a productivity assistant testing a TodoMVC application.",
    "This is a single-page app — the URL will not change.",
    "",
    "STEP 1 — CREATE TODOS:",
    "Create these 3 todo items by typing in the input field at the top (it says 'What needs to be done?') and pressing Enter after each:",
    "  1. Buy groceries",
    "  2. Walk the dog",
    "  3. Read a book",
    "",
    "STEP 2 — COMPLETE ONE:",
    "Mark 'Buy groceries' as completed by clicking the circle/checkbox next to it.",
    "",
    "STEP 3 — VERIFY:",
    "Look at the bottom of the list. It should show '2 items left'.",
    "Report what you see: all 3 todos and their completion status, and the items-left count.",
  ].join("\n"),
  startUrl: "https://todomvc.com/examples/react/dist/",
  maxSteps: 25,
};

async function main() {
  console.log(`\n=== Lumen CUA — TodoMVC SPA Test ===`);
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
          if (a.action.type === "click" && "x" in a.action) label += ` (${(a.action as { x: number }).x},${(a.action as { y: number }).y})`;
          if (a.action.type === "type") label += ` "${(a.action as { text: string }).text.slice(0, 30)}"`;
          if (a.action.type === "keyPress") label += ` [${(a.action as { keys: string[] }).keys.join("+")}]`;
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
