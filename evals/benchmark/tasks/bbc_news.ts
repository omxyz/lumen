import type { BenchmarkTask } from "../types.js";

export const bbcNewsTask: BenchmarkTask = {
  name: "bbc_news",
  instruction: "What is the main headline on BBC News right now? Tell me the headline text.",
  startUrl: "https://www.bbc.com/news",
  maxSteps: 15,
  check: (result) => {
    const lower = result.toLowerCase();
    const isBlocked = lower.includes("cloudflare") || lower.includes("verification") ||
      lower.includes("security check") || lower.includes("just a moment");
    const passed = result.trim().length > 15 && !isBlocked;
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
