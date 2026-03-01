import type { BenchmarkTask } from "../types.js";

export const timeanddateNycTask: BenchmarkTask = {
  name: "timeanddate_nyc",
  instruction: "What time is it right now in New York City according to this page? Give the time in HH:MM format.",
  startUrl: "https://www.timeanddate.com/worldclock/usa/new-york",
  maxSteps: 10,
  check: (result) => {
    // Any valid HH:MM time format
    const passed = /\d{1,2}:\d{2}/.test(result);
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
