#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "./index.js";
import type { Action, LoopResult } from "./types.js";
import type { LoopMonitor } from "./loop/monitor.js";
import type { ModelResponse, StepContext } from "./model/adapter.js";
import type { ActionExecution } from "./types.js";

function describeAction(action: Action): string {
  switch (action.type) {
    case "click":       return `click at (${action.x}, ${action.y})`;
    case "doubleClick": return `double-click at (${action.x}, ${action.y})`;
    case "hover":       return `hover at (${action.x}, ${action.y})`;
    case "drag":        return `drag (${action.startX}, ${action.startY}) → (${action.endX}, ${action.endY})`;
    case "scroll":      return `scroll ${action.direction} at (${action.x}, ${action.y})`;
    case "type":        return `type "${action.text.length > 60 ? action.text.slice(0, 60) + "…" : action.text}"`;
    case "keyPress":    return `key press [${action.keys.join(" + ")}]`;
    case "goto":        return `navigate to ${action.url}`;
    case "wait":        return `wait ${action.ms}ms`;
    case "screenshot":  return `take screenshot`;
    case "writeState":  return `write state`;
    case "delegate":    return `delegate: "${action.instruction}"`;
    case "fold":        return `fold: "${action.summary.slice(0, 60)}${action.summary.length > 60 ? "…" : ""}"`;
    case "terminate":   return `terminate (${action.status}): "${action.result.slice(0, 80)}${action.result.length > 80 ? "…" : ""}"`;
    default:            return (action as Action).type;
  }
}

class CLIMonitor implements LoopMonitor {
  stepStarted(step: number, context: StepContext): void {
    const stepLabel = context.maxSteps ? `step ${step + 1}/${context.maxSteps}` : `step ${step + 1}`;
    console.log(`\n[${stepLabel}] ${context.url}`);
  }

  stepCompleted(_step: number, _response: ModelResponse): void {}

  actionExecuted(step: number, action: Action, outcome: ActionExecution): void {
    const desc = describeAction(action);
    if (outcome.ok) {
      console.log(`  → ${desc}`);
    } else {
      console.warn(`  → ${desc}  [failed: ${outcome.error}]`);
    }
  }

  actionBlocked(step: number, action: Action, reason: string): void {
    console.warn(`  → ${describeAction(action)}  [blocked: ${reason}]`);
  }

  terminationRejected(_step: number, reason: string): void {
    console.warn(`  ! termination rejected: ${reason}`);
  }

  compactionTriggered(_step: number, tokensBefore: number, tokensAfter: number): void {
    console.log(`  ~ compacting history: ${tokensBefore} → ${tokensAfter} tokens`);
  }

  terminated(_result: LoopResult): void {}

  error(err: Error): void {
    console.error(`  ! error: ${err.message}`);
  }
}

function printHelp(): void {
  console.log(`
Usage: lumen <instruction> [options]

Arguments:
  instruction               The task for the agent (required)

Options:
  -m, --model <id>          Model identifier
                            (default: anthropic/claude-sonnet-4-6)
  -b, --browser <type>      Browser type: local | cdp | browserbase
                            (default: local)
      --headless            Run browser headless (default)
      --no-headless         Run browser with visible UI
  -s, --max-steps <n>       Cap agent iterations (optional, library default: 30)
      --env-file <path>     .env file containing API key (default: .env)
  -h, --help                Show this help message

Examples:
  lumen "go to example.com and take a screenshot"
  lumen "find the cheapest flight to NYC" --max-steps 20 --no-headless
  lumen "fill out the contact form" --model anthropic/claude-opus-4-6
  lumen "search for node.js docs" --env-file .env.local
`);
}

function loadEnvFile(envPath: string): void {
  const absPath = resolve(process.cwd(), envPath);
  if (!existsSync(absPath)) return;
  const content = readFileSync(absPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Only set if not already present in the environment
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Pre-process argv to handle --no-headless before parseArgs sees it
const rawArgs = process.argv.slice(2);
const noHeadlessFlag = rawArgs.includes("--no-headless");
const filteredArgs = rawArgs.filter((a) => a !== "--no-headless");

let values: Record<string, string | boolean | undefined>;
let positionals: string[];

try {
  const parsed = parseArgs({
    args: filteredArgs,
    options: {
      model: { type: "string", short: "m", default: "anthropic/claude-sonnet-4-6" },
      browser: { type: "string", short: "b", default: "local" },
      headless: { type: "boolean", default: true },
      "max-steps": { type: "string", short: "s" },
      "env-file": { type: "string", default: ".env" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  values = parsed.values as Record<string, string | boolean | undefined>;
  positionals = parsed.positionals;
} catch (err) {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

const instruction = positionals[0];
if (!instruction) {
  console.error("Error: instruction is required\n");
  printHelp();
  process.exit(1);
}

const envFile = (values["env-file"] as string) ?? ".env";
loadEnvFile(envFile);

const maxStepsRaw = values["max-steps"] as string | undefined;
const maxSteps = maxStepsRaw !== undefined ? parseInt(maxStepsRaw, 10) : undefined;
if (maxSteps !== undefined && (isNaN(maxSteps) || maxSteps < 1)) {
  console.error("Error: --max-steps must be a positive integer");
  process.exit(1);
}

const browserType = (values.browser as string) ?? "local";
const supportedBrowserTypes = ["local", "cdp", "browserbase"];
if (!supportedBrowserTypes.includes(browserType)) {
  console.error(`Error: --browser must be one of: ${supportedBrowserTypes.join(", ")}`);
  process.exit(1);
}
if (browserType !== "local") {
  console.error(
    `Error: browser type "${browserType}" requires additional options not supported by the CLI.\n` +
      `Use the JavaScript API for cdp or browserbase browser types.`,
  );
  process.exit(1);
}

const headless = noHeadlessFlag ? false : true;
const model = (values.model as string) ?? "anthropic/claude-sonnet-4-6";

(async () => {
  try {
    const result = await Agent.run({
      model,
      browser: { type: "local", headless },
      instruction,
      maxSteps,
      monitor: new CLIMonitor(),
      verbose: 0,
    });

    const statusLine =
      result.status === "success"
        ? "✓ success"
        : result.status === "maxSteps"
          ? "⚠ stopped (max steps reached)"
          : "✗ failure";

    console.log(`\n${"─".repeat(60)}`);
    console.log(`Status : ${statusLine}`);
    console.log(`Steps  : ${result.steps}${maxSteps !== undefined ? ` / ${maxSteps}` : ""}`);
    console.log(`Tokens : ${result.tokenUsage.inputTokens} in / ${result.tokenUsage.outputTokens} out`);
    console.log(`${"─".repeat(60)}`);
    console.log(result.result);

    process.exit(result.status === "success" ? 0 : 1);
  } catch (err) {
    console.error("\nError:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
})();
