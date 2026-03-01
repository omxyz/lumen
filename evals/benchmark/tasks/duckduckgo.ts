import type { BenchmarkTask } from "../types.js";

export const duckduckgoAustraliaTask: BenchmarkTask = {
  name: "duckduckgo_australia",
  instruction: "Search DuckDuckGo for 'capital of Australia' and tell me the answer.",
  startUrl: "https://duckduckgo.com/",
  maxSteps: 8,
  check: (result) => {
    const passed = result.toLowerCase().includes("canberra");
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
