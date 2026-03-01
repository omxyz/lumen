#!/usr/bin/env node
/**
 * Live CUA tests using real AnthropicAdapter + PerceptionLoop (via CUASession).
 * Browser starts at about:blank — the model navigates from scratch using Ctrl+L emulation.
 *
 * Tasks:
 *   1. wikipedia_shannon  — Find Claude Shannon's birth year and birth city
 *   2. columbia_tuition   — Find Columbia University undergraduate tuition
 *
 * Usage: ANTHROPIC_API_KEY=sk-ant-... npx tsx run-test.ts
 */
import { CdpConnection } from "./src/browser/cdp.js";
import { CDPTab } from "./src/browser/cdptab.js";
import { ViewportManager } from "./src/browser/viewport.js";
import { AnthropicAdapter } from "./src/model/anthropic.js";
import { CUASession } from "./src/session.js";
import { launchChrome } from "./src/browser/launch/local.js";
import type { LoopMonitor } from "./src/loop/monitor.js";
import type { StepContext, ModelResponse } from "./src/model/adapter.js";
import type { CUAAction, LoopResult } from "./src/types.js";
import type { ActionExecution } from "./src/types.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌  Set ANTHROPIC_API_KEY first");
  process.exit(1);
}

// ─── Verbose monitor ──────────────────────────────────────────────────────────

class VerboseMonitor implements LoopMonitor {
  stepStarted(step: number, context: StepContext): void {
    console.log(`[step ${step + 1}/${context.maxSteps}] url=${context.url}`);
  }
  stepCompleted(step: number, response: ModelResponse): void {
    const actions = response.actions.map((a) => {
      if (a.type === "click") return `click(${a.x},${a.y})`;
      if (a.type === "type") return `type("${a.text.slice(0, 30)}")`;
      if (a.type === "keyPress") return `keyPress(${a.keys.join("+")})`;
      if (a.type === "goto") return `goto(${a.url})`;
      if (a.type === "scroll") return `scroll(${a.direction},${a.amount})`;
      if (a.type === "hover") return `hover(${a.x},${a.y})`;
      if (a.type === "doubleClick") return `doubleClick(${a.x},${a.y})`;
      if (a.type === "terminate") return `terminate(${a.status}: ${a.result.slice(0, 60)})`;
      if (a.type === "memorize") return `memorize("${a.fact.slice(0, 40)}")`;
      return a.type;
    });
    console.log(`  → [${actions.join(", ")}] ${response.usage.inputTokens}in/${response.usage.outputTokens}out`);
  }
  actionExecuted(step: number, action: CUAAction, outcome: ActionExecution): void {
    if (!outcome.ok) {
      console.warn(`  ✗ ${action.type} failed: ${outcome.error}`);
    }
  }
  actionBlocked(step: number, action: CUAAction, reason: string): void {
    console.warn(`  ✗ ${action.type} blocked: ${reason}`);
  }
  terminationRejected(step: number, reason: string): void {
    console.warn(`  ✗ termination rejected: ${reason}`);
  }
  compactionTriggered(step: number, tokensBefore: number, tokensAfter: number): void {
    console.log(`  [compaction] ${tokensBefore} → ${tokensAfter} tokens`);
  }
  terminated(result: LoopResult): void {
    console.log(`\n[done] status=${result.status} steps=${result.steps}`);
    console.log(`[done] result="${result.result}"`);
  }
  error(err: Error): void {
    console.error(`[error] ${err.message}`);
  }
}

// ─── Browser setup ────────────────────────────────────────────────────────────

console.log("🚀  Launching Chrome...");
const { kill, wsUrl } = await launchChrome({ headless: false, port: 9333 });
console.log(`  browser wsUrl: ${wsUrl}`);

await new Promise((r) => setTimeout(r, 1500)); // let Chrome settle

// Connect to the BROWSER-level WebSocket (stable across navigations).
// Do NOT connect directly to the page target — that WebSocket closes on navigation.
const conn = await CdpConnection.connect(wsUrl);
console.log(`  browser connected ✓`);

// Find the initial page target and attach a proper CDP session to it.
const { targetInfos } = await conn.mainSession().send<{
  targetInfos: Array<{ targetId: string; type: string; url: string }>;
}>("Target.getTargets", {});
console.log(`  targets: ${targetInfos.map((t) => `${t.type}(${t.url.slice(0, 30)})`).join(", ")}`);
const pageInfo = targetInfos.find((t) => t.type === "page");
if (!pageInfo) throw new Error("No page target found");

const pageSession = await conn.newSession(pageInfo.targetId);
console.log(`  page session attached (targetId=${pageInfo.targetId.slice(0, 12)})`);
const tab = new CDPTab(pageSession);
await tab.syncUrl(); // sync currentUrl with the actual page (may differ if Chrome was reused)

const vm = new ViewportManager(tab);
const vp = await vm.alignToModel(28, 1344);
console.log(`✓  Viewport: ${vp.width}×${vp.height}`);

const MODEL = "claude-sonnet-4-6";
console.log(`✓  Model: ${MODEL}\n`);

// ─── Task runner ──────────────────────────────────────────────────────────────

async function runTask(name: string, instruction: string, maxSteps: number): Promise<void> {
  console.log("═".repeat(60));
  console.log(`🎯  Task: ${name}`);
  console.log(`    ${instruction}`);
  console.log("═".repeat(60));

  // Fresh adapter + session per task — browser starts from current page (first task: about:blank)
  const adapter = new AnthropicAdapter(MODEL, ANTHROPIC_API_KEY);
  const monitor = new VerboseMonitor();

  const session = new CUASession({
    tab,
    adapter,
    monitor,
    keepRecentScreenshots: 2,
    cursorOverlay: true,
    systemPrompt: [
      "You are a precise research agent controlling a web browser.",
      "To navigate to a URL: press Ctrl+L to open the address bar, type the URL, then press Enter.",
      "Call terminate() as soon as you have found the answer.",
    ].join("\n"),
  });
  await session.init();

  const start = Date.now();
  const result = await session.run({ instruction, maxSteps });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log("\n" + "─".repeat(60));
  console.log(`Status:  ${result.status}`);
  console.log(`Result:  ${result.result}`);
  console.log(`Steps:   ${result.steps}`);
  console.log(`Tokens:  ${result.tokenUsage.inputTokens}in / ${result.tokenUsage.outputTokens}out`);
  console.log(`Time:    ${elapsed}s`);
  console.log("─".repeat(60) + "\n");
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

await runTask(
  "wikipedia_shannon",
  "Go to en.wikipedia.org, search for 'Claude Shannon', find his birth year and birth city (Petoskey, Michigan). Call terminate with status:success and the answer.",
  20,
);

await runTask(
  "columbia_tuition",
  "Go to columbia.edu and find the current undergraduate tuition cost per year. Navigate to financial aid or tuition pages as needed. Call terminate with status:success and the dollar amount.",
  30,
);

// ─── Cleanup ─────────────────────────────────────────────────────────────────

conn.close();
kill();
console.log("✓  Done");
