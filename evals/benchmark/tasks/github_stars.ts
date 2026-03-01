import type { BenchmarkTask } from "../types.js";

export const githubLinuxStarsTask: BenchmarkTask = {
  name: "github_linux_stars",
  instruction: "How many GitHub stars does this repository have? Give the number (e.g. '190k' or '190,000').",
  startUrl: "https://github.com/torvalds/linux",
  maxSteps: 10,
  check: (result) => {
    // Star count should be a large number — linux has 100k+ stars
    const passed = /\d+[kK,]\d*|\d{5,}/.test(result);
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
