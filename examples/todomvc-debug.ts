/**
 * Minimal CDP-only test — no agent, no model.
 * Verify the CDP commands actually work on TodoMVC React.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { Agent } from "../src/index.js";

// Load .env
try {
  const envFile = readFileSync(new URL("../.env", import.meta.url), "utf-8");
  for (const line of envFile.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]!.trim()]) {
      process.env[match[1]!.trim()] = match[2]!.trim();
    }
  }
} catch { /* no .env file */ }

async function main() {
  // Use a trivial 1-step agent just to get a browser tab
  const agent = new Agent({
    model: "anthropic/claude-sonnet-4-6",
    browser: { type: "local", headless: true },
    maxSteps: 1,
    verbose: 0,
  });

  // Access internal tab via session
  const session = (agent as unknown as { _createSession: () => Promise<unknown> });
  // Actually, let's just use the low-level launch directly
  const { launchChrome } = await import("../src/browser/launch/local.js");
  const { CdpConnection } = await import("../src/browser/cdp.js");
  const { CDPTab } = await import("../src/browser/cdptab.js");

  const { wsUrl, pid } = await launchChrome({ headless: true });
  console.log(`Chrome pid=${pid}`);

  const cdp = await CdpConnection.connect(wsUrl);
  const targets = await cdp.mainSession().send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
  const pageTarget = targets.targetInfos.find(t => t.type === "page");
  if (!pageTarget) throw new Error("No page target found");

  const pageSession = await cdp.newSession(pageTarget.targetId);
  const tab = new CDPTab(pageSession);
  await tab.setViewport({ width: 1288, height: 728 });

  // Navigate to TodoMVC
  await tab.goto("https://todomvc.com/examples/react/dist/");
  console.log("Page loaded:", tab.url());

  mkdirSync("/tmp/todomvc-debug", { recursive: true });

  // Screenshot 1: initial
  const ss1 = await tab.screenshot({ cursorOverlay: false });
  writeFileSync("/tmp/todomvc-debug/01-initial.png", ss1.data);
  console.log(`SS1: ${ss1.width}x${ss1.height} initial`);

  // Click input (center of page, near top)
  console.log("Clicking input at (644, 140)...");
  await tab.click(644, 140);
  await new Promise(r => setTimeout(r, 300));

  const ss2 = await tab.screenshot({ cursorOverlay: false });
  writeFileSync("/tmp/todomvc-debug/02-after-click.png", ss2.data);
  console.log("SS2: after click");

  // Type "Buy groceries"
  console.log('Typing "Buy groceries"...');
  await tab.type("Buy groceries");
  await new Promise(r => setTimeout(r, 300));

  const ss3 = await tab.screenshot({ cursorOverlay: false });
  writeFileSync("/tmp/todomvc-debug/03-after-type.png", ss3.data);
  console.log("SS3: after type");

  // Press Enter
  console.log("Pressing Enter...");
  await tab.keyPress(["Return"]);
  await new Promise(r => setTimeout(r, 500));

  const ss4 = await tab.screenshot({ cursorOverlay: false });
  writeFileSync("/tmp/todomvc-debug/04-after-enter.png", ss4.data);
  console.log("SS4: after enter");

  // Type "Walk the dog"
  console.log('Typing "Walk the dog"...');
  await tab.type("Walk the dog");
  await tab.keyPress(["Return"]);
  await new Promise(r => setTimeout(r, 500));

  const ss5 = await tab.screenshot({ cursorOverlay: false });
  writeFileSync("/tmp/todomvc-debug/05-two-todos.png", ss5.data);
  console.log("SS5: two todos");

  // Type "Read a book"
  console.log('Typing "Read a book"...');
  await tab.type("Read a book");
  await tab.keyPress(["Return"]);
  await new Promise(r => setTimeout(r, 500));

  const ss6 = await tab.screenshot({ cursorOverlay: false });
  writeFileSync("/tmp/todomvc-debug/06-three-todos.png", ss6.data);
  console.log("SS6: three todos");

  // Check DOM
  const todoCount = await tab.evaluate<number>("document.querySelectorAll('.todo-list li').length");
  console.log(`\nTodo count in DOM: ${todoCount}`);

  const todoTexts = await tab.evaluate<string>("JSON.stringify(Array.from(document.querySelectorAll('.todo-list li label')).map(el => el.textContent))");
  console.log(`Todo texts: ${todoTexts}`);

  const itemsLeft = await tab.evaluate<string>("document.querySelector('.todo-count')?.textContent || 'none'");
  console.log(`Items left: ${itemsLeft}`);

  console.log("\nScreenshots saved to /tmp/todomvc-debug/");
  process.kill(pid!);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
