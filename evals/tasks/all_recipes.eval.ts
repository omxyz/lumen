import type { EvalTask } from "../runner.js";
import { exactMatch } from "../scoring.js";

export const allRecipesTask: EvalTask = {
  name: "all_recipes",
  instruction: "Go to allrecipes.com and find a recipe for chocolate chip cookies. Tell me the preparation time.",
  url: "https://www.allrecipes.com",
  maxSteps: 15,
  score: exactMatch(["minute", "prep"]),
};
