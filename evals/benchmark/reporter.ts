import type { BenchmarkReport, FrameworkResult, FrameworkSummary, Framework } from "./types.js";

const FRAMEWORKS: Framework[] = ["lumen", "stagehand", "browser-use"];

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function summarize(report: BenchmarkReport): FrameworkSummary[] {
  return FRAMEWORKS.map((fw) => {
    const results = report.results.filter((r) => r.framework === fw);
    const passed = results.filter((r) => r.passed).length;
    const successRate = results.length > 0 ? passed / results.length : 0;
    const avgSteps = avg(results.map((r) => r.steps));
    const tokenResults = results.filter((r) => r.tokens != null);
    const avgTokens = tokenResults.length > 0 ? avg(tokenResults.map((r) => r.tokens!)) : null;
    const avgDurationMs = avg(results.map((r) => r.durationMs));
    return { framework: fw, successRate, avgSteps, avgTokens, avgDurationMs, passed, total: results.length };
  });
}

export function printReport(report: BenchmarkReport, summaries: FrameworkSummary[]): void {
  const tasks = [...new Set(report.results.map((r) => r.task))];

  console.log(`\n${"=".repeat(90)}`);
  console.log(`BENCHMARK REPORT  ${report.timestamp}  model: ${report.model}`);
  console.log("=".repeat(90));

  // Per-task breakdown
  console.log("\nPer-task results:");
  const hdr = `${"Task".padEnd(24)} ${"Framework".padEnd(14)} ${"OK".padEnd(4)} ${"Steps".padEnd(7)} ${"Tokens".padEnd(10)} ${"Secs".padEnd(7)} Result`;
  console.log(hdr);
  console.log("-".repeat(hdr.length + 5));

  for (const task of tasks) {
    for (const fw of FRAMEWORKS) {
      const r = report.results.find((x) => x.task === task && x.framework === fw);
      if (!r) continue;
      const ok = r.passed ? "✅" : "❌";
      const tokens = r.tokens != null ? r.tokens.toLocaleString() : "n/a";
      const secs = (r.durationMs / 1000).toFixed(1);
      const res = r.error ? `ERR: ${r.error.slice(0, 40)}` : r.result.slice(0, 40).replace(/\n/g, " ");
      console.log(`${task.padEnd(24)} ${fw.padEnd(14)} ${ok.padEnd(4)} ${String(r.steps).padEnd(7)} ${tokens.padEnd(10)} ${secs.padEnd(7)} ${res}`);
    }
    console.log();
  }

  // Steps by task (side-by-side per framework)
  console.log("\nSteps per task:");
  const fwList = FRAMEWORKS.filter((fw) => report.results.some((r) => r.framework === fw));
  const stepHdr = `${"Task".padEnd(24)} ${fwList.map((fw) => fw.padEnd(12)).join(" ")}`;
  console.log(stepHdr);
  console.log("-".repeat(stepHdr.length));
  for (const task of tasks) {
    const cols = fwList.map((fw) => {
      const r = report.results.find((x) => x.task === task && x.framework === fw);
      if (!r) return "—".padEnd(12);
      const mark = r.passed ? "" : "✗";
      return `${r.steps}${mark}`.padEnd(12);
    });
    console.log(`${task.padEnd(24)} ${cols.join(" ")}`);
  }
  // Avg steps row
  const avgCols = fwList.map((fw) => {
    const s = summaries.find((x) => x.framework === fw);
    return s ? `avg:${s.avgSteps.toFixed(1)}`.padEnd(12) : "—".padEnd(12);
  });
  console.log(`${"".padEnd(24)} ${avgCols.join(" ")}`);

  // Aggregate
  console.log("\nAggregate summary:");
  const hdr2 = `${"Framework".padEnd(14)} ${"Success%".padEnd(10)} ${"Avg Steps".padEnd(11)} ${"Avg Tokens".padEnd(13)} ${"Avg Secs".padEnd(10)} Passed/Total`;
  console.log(hdr2);
  console.log("-".repeat(hdr2.length));
  for (const s of summaries) {
    const pct = `${(s.successRate * 100).toFixed(0)}%`;
    const tokens = s.avgTokens != null ? Math.round(s.avgTokens).toLocaleString() : "n/a";
    const secs = (s.avgDurationMs / 1000).toFixed(1);
    console.log(
      `${s.framework.padEnd(14)} ${pct.padEnd(10)} ${s.avgSteps.toFixed(1).padEnd(11)} ${tokens.padEnd(13)} ${secs.padEnd(10)} ${s.passed}/${s.total}`,
    );
  }
}

export function detectWinner(summaries: FrameworkSummary[]): {
  lumenWins: boolean;
  losing: string[];
  metricsLine: string;
} {
  const lumen = summaries.find((s) => s.framework === "lumen")!;
  const others = summaries.filter((s) => s.framework !== "lumen" && s.total > 0);
  const losing: string[] = [];

  // Success rate: lumen must be >= each other framework (primary metric)
  for (const o of others) {
    if (lumen.successRate + 0.001 < o.successRate) {
      losing.push(
        `success_rate: lumen ${(lumen.successRate * 100).toFixed(0)}% < ${o.framework} ${(o.successRate * 100).toFixed(0)}%`,
      );
    }
  }

  // Steps: lumen must be <= stagehand (20% tolerance).
  // browser-use uses DOM actions (different granularity), so excluded from step comparison.
  for (const o of others.filter((x) => x.framework === "stagehand")) {
    if (o.avgSteps > 0 && lumen.avgSteps > o.avgSteps * 1.2) {
      losing.push(
        `avg_steps: lumen ${lumen.avgSteps.toFixed(1)} > ${o.framework} ${o.avgSteps.toFixed(1)}`,
      );
    }
  }

  // Tokens: lumen must be <= each other (5% tolerance, skip if null)
  for (const o of others) {
    if (lumen.avgTokens != null && o.avgTokens != null && lumen.avgTokens > o.avgTokens * 1.05) {
      losing.push(
        `avg_tokens: lumen ${Math.round(lumen.avgTokens).toLocaleString()} > ${o.framework} ${Math.round(o.avgTokens).toLocaleString()}`,
      );
    }
  }

  // Time: lumen must be <= each other (15% tolerance — accounts for startup variance)
  for (const o of others) {
    if (lumen.avgDurationMs > o.avgDurationMs * 1.15) {
      losing.push(
        `avg_time: lumen ${(lumen.avgDurationMs / 1000).toFixed(1)}s > ${o.framework} ${(o.avgDurationMs / 1000).toFixed(1)}s`,
      );
    }
  }

  const metricsLine = summaries
    .map((s) => {
      const tok = s.avgTokens != null ? ` ${Math.round(s.avgTokens / 1000)}K tok` : "";
      return `${s.framework}: ${(s.successRate * 100).toFixed(0)}% success, ${(s.avgDurationMs / 1000).toFixed(1)}s${tok}`;
    })
    .join(" | ");

  return { lumenWins: losing.length === 0, losing, metricsLine };
}

export function printDiagnostics(report: BenchmarkReport): void {
  const lumenResults = report.results.filter((r) => r.framework === "lumen");
  const failed = lumenResults.filter((r) => !r.passed);
  const highSteps = lumenResults.filter((r) => r.steps > 10);

  console.log("\nLumen diagnostics:");
  if (failed.length > 0) {
    console.log(`  Failed tasks: ${failed.map((r) => r.task).join(", ")}`);
    for (const r of failed) {
      const hint = r.error ? `  error: ${r.error.slice(0, 100)}` : `  result: "${r.result.slice(0, 80)}"`;
      console.log(`    ${r.task}: ${hint}`);
    }
    console.log("  -> Re-run with LUMEN_LOG=debug env var to see verbose logs");
    console.log("  -> Check src/loop/perception.ts for termination logic");
  }
  if (highSteps.length > 0) {
    console.log(`  High step count: ${highSteps.map((r) => `${r.task}(${r.steps})`).join(", ")}`);
    console.log("  -> Consider tightening system prompt or adding examples");
    console.log("  -> Check compactionThreshold and keepRecentScreenshots options");
  }
  if (failed.length === 0 && highSteps.length === 0) {
    console.log("  All tasks passed with reasonable step counts.");
    console.log("  -> Token/time difference may be from screenshot compression ratio");
    console.log("  -> Try LUMEN_LOG_HISTORY=1 to inspect compaction events");
  }
}
