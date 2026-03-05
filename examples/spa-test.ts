/**
 * Single-Page App stress test — RealWorld Conduit (Angular SPA).
 * Tests CUA agent on a true SPA with hash-based routing.
 *
 * This is a content-heavy SPA (Medium clone) — the URL uses hash routing
 * (/#/ prefix) and navigation never triggers full page reloads.
 * The agent needs to browse articles, click into them, and extract data.
 *
 * Usage:
 *   npx tsx examples/spa-test.ts
 */

import { Agent } from "../src/index.js";

const model = process.env.LUMEN_MODEL ?? "anthropic/claude-sonnet-4-6";
const headed = process.env.LUMEN_HEADED === "true";

const TASK = {
  instruction: [
    "You are a content research assistant browsing a blog platform (similar to Medium).",
    "This is a single-page application — URLs will use hash-based routing.",
    "",
    "STEP 1 — GLOBAL FEED:",
    "You are on the homepage of Conduit, a social blogging platform.",
    "Click on the 'Global Feed' tab if not already selected.",
    "Record the first 5 articles shown: title, author, date, and number of likes.",
    "Use update_state to save this data.",
    "",
    "STEP 2 — ARTICLE DETAIL:",
    "Click on the first article to open it.",
    "Record: the full title, author name, article body (first 2 sentences), and any tags.",
    "Use update_state to save this data.",
    "",
    "STEP 3 — TAGS:",
    "Go back to the homepage (click the 'conduit' logo or 'Home' link).",
    "Look at the 'Popular Tags' sidebar on the right.",
    "Record all visible tags.",
    "Click on one tag to filter articles by that tag.",
    "Record the first 2 articles shown for that tag.",
    "Use update_state to save this data.",
    "",
    "STEP 4 — AUTHOR PROFILE:",
    "Click on any author's name to visit their profile.",
    "Record: author name, bio (if any), and their most recent article title.",
    "Use update_state to save this data.",
    "",
    "STEP 5 — SUMMARY:",
    "Compile all collected data into a clean report with sections for:",
    "- Global Feed (5 articles)",
    "- Article Detail (1 deep-dive)",
    "- Popular Tags and filtered articles",
    "- Author Profile",
    "Call task_complete with the full report.",
  ].join("\n"),
  startUrl: "https://angular.realworld.io/",
  maxSteps: 35,
};

async function main() {
  console.log(`\n=== Lumen SPA Test — RealWorld Conduit ===`);
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
          if (a.action.type === "type") label += ` "${(a.action as { text: string }).text.slice(0, 30)}"`;
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
