import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Lumen",
  description: "Vision-first browser agent for Node.js",
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "Architecture", link: "/architecture/overview" },
      { text: "Reference", link: "/reference/options" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Best Practices", link: "/guide/best-practices" },
        ],
      },
      {
        text: "Setup",
        collapsed: false,
        items: [
          { text: "Model Configuration", link: "/guide/use-cases/models" },
          { text: "Browser Connections", link: "/guide/use-cases/browsers" },
          { text: "Session Management", link: "/guide/use-cases/sessions" },
          { text: "Error Handling", link: "/guide/use-cases/error-handling" },
          { text: "Action Caching", link: "/guide/use-cases/caching" },
          { text: "Stealth", link: "/guide/use-cases/stealth" },
        ],
      },
      {
        text: "Recipes",
        collapsed: false,
        items: [
          { text: "Basic Usage", link: "/guide/use-cases/basic" },
          { text: "Data Extraction", link: "/guide/use-cases/data-extraction" },
          { text: "Verifying Completion", link: "/guide/use-cases/verification" },
          { text: "Safety & Control", link: "/guide/use-cases/safety" },
          { text: "Navigating Tricky Sites", link: "/guide/use-cases/site-knowledge" },
          { text: "Observability", link: "/guide/use-cases/observability" },
          { text: "Evaluations", link: "/guide/use-cases/evaluations" },
          { text: "MCP Integration", link: "/guide/use-cases/mcp" },
          { text: "Deterministic Automation", link: "/guide/use-cases/deterministic" },
          { text: "Advanced", link: "/guide/use-cases/advanced" },
        ],
      },
      {
        text: "Architecture",
        items: [
          { text: "Overview", link: "/architecture/overview" },
          { text: "Comparison", link: "/architecture/comparison" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "API Reference", link: "/reference/api" },
          { text: "API Options", link: "/reference/options" },
          { text: "References", link: "/reference/references" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/AugmentedMind/lumen" },
    ],
    search: {
      provider: "local",
    },
  },
});
