/**
 * Travel research task — flights and hotels.
 * Tests CUA agent on complex booking UIs.
 *
 * Strategy: Use direct URL construction to bypass complex search forms,
 * then let the agent read and collect results from the results page.
 *
 * Usage:
 *   npx tsx examples/travel-research.ts
 */

import { Agent } from "../src/index.js";

const model = process.env.LUMEN_MODEL ?? "anthropic/claude-sonnet-4-6";
const headed = process.env.LUMEN_HEADED === "true";

const TASK = {
  instruction: [
    "You are a travel research assistant. Find flight and hotel options for a trip from San Francisco to Tokyo.",
    "",
    "TRIP DETAILS:",
    "- From: San Francisco (SFO)",
    "- To: Tokyo (NRT)",
    "- Dates: July 15 to July 25, 2026",
    "- Travelers: 2 adults",
    "",
    "PART 1 — FLIGHTS:",
    "You are on a Google Flights results page for SFO→NRT.",
    "Scroll through the results and record the top 3 cheapest flight options shown.",
    "For each: airline, total price, duration, and number of stops.",
    "Use update_state to save the flight data before moving on.",
    "",
    "PART 2 — HOTELS:",
    "Use the navigate tool to go to this exact URL:",
    "https://www.google.com/travel/hotels/Tokyo?q=Tokyo+hotels&dates=2026-07-15,2026-07-25&hl=en&gl=us&curr=USD",
    "Once results appear, scroll and record the first 5 hotels shown.",
    "For each: hotel name, price per night, and review rating.",
    "Use update_state to save the hotel data.",
    "",
    "PART 3 — SUMMARY:",
    "Calculate total estimated trip cost: cheapest flight (round trip for 2 passengers) + cheapest hotel (10 nights).",
    "Present everything in a clean report and call task_complete.",
  ].join("\n"),
  // Pre-constructed URL bypasses the search form entirely
  startUrl: "https://www.google.com/travel/flights/search?tfs=CBwQAhoeEgoyMDI2LTA3LTE1agcIARIDU0ZPcgcIARIDTlJUGh4SCjIwMjYtMDctMjVqBwgBEgNOUlRyBwgBEgNTRk8&hl=en&gl=us&curr=USD",
  maxSteps: 40,
};

async function main() {
  console.log(`\n=== Lumen Travel Research ===`);
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
