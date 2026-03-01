export interface LocalLaunchOptions {
  port?: number;
  headless?: boolean;
  userDataDir?: string;
}

export async function launchChrome(
  opts: LocalLaunchOptions = {},
): Promise<{ wsUrl: string; kill(): void }> {
  const chromeLauncher = await import("chrome-launcher");

  // Use a real Chrome user agent — the default headless UA contains "HeadlessChrome"
  // which many sites (BBC consent, Cloudflare, etc.) use to trigger bot flows.
  // This matches what Playwright does internally and is a global fix, not a site hack.
  const stealthUserAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

  const chrome = await chromeLauncher.launch({
    port: opts.port ?? 0, // 0 = pick a random available port, avoids reusing existing Chrome instances
    chromeFlags: [
      ...(opts.headless !== false ? ["--headless=new", "--disable-gpu"] : []),
      // Stealth: removes navigator.webdriver flag and HeadlessChrome UA marker
      "--disable-blink-features=AutomationControlled",
      `--user-agent=${stealthUserAgent}`,
      // Stability & performance
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
    userDataDir: opts.userDataDir,
  });

  // Fetch debugger info over HTTP (not ws://)
  const res = await fetch(`http://localhost:${chrome.port}/json/version`);
  const info = await res.json() as { webSocketDebuggerUrl: string };

  console.log(`  [launch] Chrome pid=${chrome.pid} port=${chrome.port} wsUrl=${info.webSocketDebuggerUrl}`);
  return {
    wsUrl: info.webSocketDebuggerUrl,
    kill: () => { try { chrome.kill(); } catch { /* ignore */ } },
  };
}
