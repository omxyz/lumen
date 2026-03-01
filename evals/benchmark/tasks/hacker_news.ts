import type { BenchmarkTask } from "../types.js";

export const hackerNewsTask: BenchmarkTask = {
  name: "hacker_news",
  instruction: "Tell me the title of the #1 story on Hacker News right now.",
  startUrl: "https://news.ycombinator.com",
  maxSteps: 10,
  check: (result) => {
    const passed = result.trim().length > 10;
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
