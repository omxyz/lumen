#!/usr/bin/env tsx
/**
 * Lumen Benchmark Loop
 * Runs all 3 frameworks on 6 tasks repeatedly until Lumen wins all metrics,
 * or MAX_ITER is hit.
 *
 * Usage:
 *   npm run benchmark             # all frameworks, all tasks
 *   npm run benchmark:lumen       # lumen only
 *   MAX_ITER=3 npm run benchmark  # limit iterations
 *   TASKS=hacker_news,wikipedia_guido npm run benchmark  # subset of tasks
 */

import { runBenchmark, ALL_FRAMEWORKS } from "./runner.js";
import { summarize, printReport, detectWinner, printDiagnostics } from "./reporter.js";
import type { BenchmarkTask, Framework } from "./types.js";
import { createInterface } from "node:readline";

// --- Task registry ---
import { hackerNewsTask } from "./tasks/hacker_news.js";
import { wikipediaTask } from "./tasks/wikipedia.js";
import { githubReactTask } from "./tasks/github_react.js";
import { pythonVersionTask } from "./tasks/python.js";
import { bbcNewsTask } from "./tasks/bbc_news.js";
import { booksToScrapeTask } from "./tasks/books_toscrape.js";
import { arxivAttentionTask } from "./tasks/arxiv.js";
import { githubLinuxStarsTask } from "./tasks/github_stars.js";
import { timeanddateNycTask } from "./tasks/timeanddate.js";
import { wikipediaEverestTask } from "./tasks/wikipedia_everest.js";

const TASK_REGISTRY: Record<string, BenchmarkTask> = {
  hacker_news: hackerNewsTask,
  wikipedia_guido: wikipediaTask,
  npm_react_version: githubReactTask,
  python_version: pythonVersionTask,
  bbc_news: bbcNewsTask,
  books_mystery_cheapest: booksToScrapeTask,
  arxiv_attention: arxivAttentionTask,
  github_linux_stars: githubLinuxStarsTask,
  timeanddate_nyc: timeanddateNycTask,
  wikipedia_everest: wikipediaEverestTask,
};

function resolveTasks(): BenchmarkTask[] {
  const taskEnv = process.env.TASKS;
  if (taskEnv) {
    return taskEnv.split(",").map((name) => {
      const t = TASK_REGISTRY[name.trim()];
      if (!t) throw new Error(`Unknown task: ${name}. Available: ${Object.keys(TASK_REGISTRY).join(", ")}`);
      return t;
    });
  }
  return Object.values(TASK_REGISTRY);
}

function resolveFrameworks(): Framework[] {
  const fwEnv = process.env.FRAMEWORKS;
  if (fwEnv) {
    return fwEnv.split(",").map((f) => f.trim() as Framework);
  }
  const arg = process.argv[2];
  if (arg === "--lumen-only") return ["lumen"];
  return ALL_FRAMEWORKS;
}

async function promptContinue(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive: stop
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

async function main() {
  const tasks = resolveTasks();
  const frameworks = resolveFrameworks();
  const maxIter = parseInt(process.env.MAX_ITER ?? "5");

  console.log("Lumen Benchmark Loop");
  console.log(`  Tasks (${tasks.length}): ${tasks.map((t) => t.name).join(", ")}`);
  console.log(`  Frameworks: ${frameworks.join(", ")}`);
  console.log(`  Max iterations: ${maxIter}`);

  for (let iter = 1; iter <= maxIter; iter++) {
    console.log(`\n${"━".repeat(80)}`);
    console.log(`ITERATION ${iter}/${maxIter}`);
    console.log("━".repeat(80));

    const report = await runBenchmark(tasks, frameworks);
    const summaries = summarize(report);
    printReport(report, summaries);

    // Only check winner when comparing multiple frameworks
    if (frameworks.length < 2) {
      console.log("\nSingle-framework mode — no winner comparison.");
      break;
    }

    const { lumenWins, losing, metricsLine } = detectWinner(summaries);

    console.log(`\nMetrics: ${metricsLine}`);

    if (lumenWins) {
      console.log("\n✅ Lumen outperforms all frameworks on all metrics — DONE");
      break;
    }

    console.log("\n❌ Lumen losing on:");
    for (const l of losing) console.log(`   • ${l}`);

    printDiagnostics(report);

    if (iter === maxIter) {
      console.log("\n⛔ Max iterations reached. Review diagnostics above and fix issues.");
      break;
    }

    const cont = await promptContinue(`\nApply fixes and run iteration ${iter + 1}?`);
    if (!cont) {
      console.log("Stopped.");
      break;
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
