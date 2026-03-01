import type { EvalTask } from "../runner.js";
import { exactMatch } from "../scoring.js";

export const amazonShoesTask: EvalTask = {
  name: "amazon_shoes",
  instruction: "Go to Amazon and find a pair of running shoes under $100 with at least 4 stars rating. Tell me the name and price.",
  url: "https://www.amazon.com",
  maxSteps: 20,
  score: exactMatch(["$", "star"]),
};
