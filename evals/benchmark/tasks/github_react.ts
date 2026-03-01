import type { BenchmarkTask } from "../types.js";

export const githubReactTask: BenchmarkTask = {
  name: "npm_react_version",
  instruction: "What is the latest published version of the 'react' package? Tell me just the version number.",
  startUrl: "https://www.npmjs.com/package/react",
  maxSteps: 10,
  check: (result) => {
    // React versions: 18.x.x or 19.x.x
    const passed = /\d+\.\d+\.\d+/.test(result);
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
