import type { EvalResult } from "./runner.js";

export interface BaselineResult {
  task: string;
  steps: number;
  totalTokens: number;
  passed: boolean;
}

// Stagehand V3 baseline numbers (from benchmarks)
const STAGEHAND_BASELINE: BaselineResult[] = [
  { task: "all_recipes", steps: 12, totalTokens: 45000, passed: true },
  { task: "google_flights", steps: 18, totalTokens: 62000, passed: true },
  { task: "amazon_shoes", steps: 16, totalTokens: 58000, passed: true },
  { task: "hacker_news", steps: 4, totalTokens: 12000, passed: true },
];

export function compareToBaseline(lumenResults: EvalResult[]): void {
  console.log("\n=== Lumen vs Stagehand V3 Baseline ===");
  console.log(
    `${"Task".padEnd(20)} ${"Lumen Steps".padEnd(14)} ${"Base Steps".padEnd(12)} ${"Token Delta".padEnd(12)} ${"Token Delta%".padEnd(10)}`
  );

  let totalLumenTokens = 0;
  let totalBaselineTokens = 0;

  for (const lumen of lumenResults) {
    const baseline = STAGEHAND_BASELINE.find((b) => b.task === lumen.task);
    if (!baseline) continue;

    const tokenDelta = lumen.totalTokens - baseline.totalTokens;
    const tokenPct = ((tokenDelta / baseline.totalTokens) * 100).toFixed(1);
    const direction = tokenDelta < 0 ? "down" : "up";

    totalLumenTokens += lumen.totalTokens;
    totalBaselineTokens += baseline.totalTokens;

    console.log(
      `${lumen.task.padEnd(20)} ${String(lumen.steps).padEnd(14)} ${String(baseline.steps).padEnd(12)} ${direction} ${Math.abs(tokenDelta).toLocaleString().padEnd(10)} ${tokenPct}%`
    );
  }

  const overallReduction = ((totalBaselineTokens - totalLumenTokens) / totalBaselineTokens) * 100;
  console.log(`\nOverall token reduction vs Stagehand V3: ${overallReduction.toFixed(1)}%`);
  console.log(`Target per PRD section 15: >=40% reduction`);
  console.log(`Status: ${overallReduction >= 40 ? "PASSING" : "BELOW TARGET"}`);
}
