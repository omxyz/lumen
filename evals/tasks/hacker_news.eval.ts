import type { EvalTask } from "../runner.js";

export const hackerNewsTask: EvalTask = {
  name: "hacker_news",
  instruction: "Go to Hacker News and tell me the title of the top story right now.",
  url: "https://news.ycombinator.com",
  maxSteps: 5,
  score: (result) => result.status === "success" && result.result.length > 10 ? 1.0 : 0.0,
};
