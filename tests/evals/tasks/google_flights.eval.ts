import type { EvalTask } from "../runner.js";
import { exactMatch } from "../scoring.js";

export const googleFlightsTask: EvalTask = {
  name: "google_flights",
  instruction: "Go to Google Flights and find the cheapest one-way flight from New York to Los Angeles next month.",
  url: "https://flights.google.com",
  maxSteps: 20,
  score: exactMatch(["$", "flight"]),
};
