import type { BenchmarkTask } from "../types.js";

export const wikipediaEverestTask: BenchmarkTask = {
  name: "wikipedia_everest",
  instruction: "What is the height of Mount Everest in metres according to Wikipedia? Give the number.",
  startUrl: "https://en.wikipedia.org/wiki/Mount_Everest",
  maxSteps: 10,
  check: (result) => {
    // Accepted heights: 8,848 m (original) or 8,849 m (2020 survey)
    const passed = result.includes("8,848") || result.includes("8848") ||
      result.includes("8,849") || result.includes("8849");
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
