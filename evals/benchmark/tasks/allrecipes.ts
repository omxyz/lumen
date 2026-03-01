import type { BenchmarkTask } from "../types.js";

export const allrecipesTask: BenchmarkTask = {
  name: "allrecipes_cookies",
  instruction: "Find a recipe for chocolate chip cookies and tell me the prep time.",
  startUrl: "https://www.allrecipes.com",
  maxSteps: 20,
  check: (result) => {
    const text = result.toLowerCase();
    const passed = /\d+\s*(min|minute|hr|hour)/.test(text);
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
