import type { BenchmarkTask } from "../types.js";

export const wikipediaTask: BenchmarkTask = {
  name: "wikipedia_guido",
  instruction: "What year was Guido van Rossum born? Just tell me the year.",
  startUrl: "https://en.wikipedia.org/wiki/Guido_van_Rossum",
  maxSteps: 15,
  check: (result) => {
    const passed = result.includes("1956");
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
