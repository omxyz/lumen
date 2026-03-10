# MCP Integration

Lumen can be wrapped as an [MCP](https://modelcontextprotocol.io/) tool server, letting any MCP-compatible client (Claude Desktop, Cursor, etc.) trigger browser tasks through a `browse` tool.

## Example: MCP server with a `browse` tool

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Agent } from "@omxyz/lumen";

const server = new McpServer({
  name: "lumen-browser",
  version: "1.0.0",
});

server.tool(
  "browse",
  "Run a browser agent to complete a task on the web",
  {
    instruction: z.string().describe("What the agent should do"),
    startUrl: z.string().optional().describe("URL to start on"),
    maxSteps: z.number().optional().default(20),
  },
  async ({ instruction, startUrl, maxSteps }) => {
    const result = await Agent.run({
      model: "anthropic/claude-sonnet-4-6",
      browser: { type: "local", headless: true },
      instruction,
      startUrl,
      maxSteps,
    });

    return {
      content: [{ type: "text", text: result.result ?? "Task completed" }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

## Running the server

```bash
npx tsx mcp-server.ts
```

## Claude Desktop configuration

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "lumen-browser": {
      "command": "npx",
      "args": ["tsx", "/path/to/mcp-server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

## Notes

- Lumen is not a built-in MCP server yet — you create the wrapper yourself as shown above.
- The `@modelcontextprotocol/sdk` package is already in Lumen's dependencies.
- Use `headless: true` for MCP servers since there's no user watching the browser.
- For long-running tasks, consider increasing `maxSteps` and using the streaming API to report progress.
