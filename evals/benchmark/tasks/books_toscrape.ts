import type { BenchmarkTask } from "../types.js";

export const booksToScrapeTask: BenchmarkTask = {
  name: "books_mystery_cheapest",
  instruction: "Find the cheapest book in the Mystery category. Tell me its title and price.",
  startUrl: "https://books.toscrape.com/catalogue/category/books/mystery_3/index.html",
  maxSteps: 35,
  check: (result) => {
    const hasPrice = /£\d+|\d+\.\d{2}|\$\d+/.test(result);
    const passed = hasPrice && result.trim().length > 10;
    return { passed, score: passed ? 1.0 : 0.0 };
  },
};
