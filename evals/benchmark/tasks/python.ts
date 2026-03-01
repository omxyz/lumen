import type { BenchmarkTask } from "../types.js";

export const pythonVersionTask: BenchmarkTask = {
  name: "python_version",
  instruction: "What is the latest stable Python 3 version listed on python.org/downloads?",
  startUrl: "https://www.python.org/downloads/",
  maxSteps: 5,
  check: (result) => {
    const passed = /3\.\d+\.?\d*/.test(result);
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
