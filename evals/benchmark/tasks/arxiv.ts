import type { BenchmarkTask } from "../types.js";

export const arxivAttentionTask: BenchmarkTask = {
  name: "arxiv_attention",
  instruction: "What year was this arXiv paper originally submitted? Give just the year.",
  startUrl: "https://arxiv.org/abs/1706.03762",
  maxSteps: 10,
  check: (result) => {
    const passed = result.includes("2017");
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
