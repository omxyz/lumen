export interface LocalLaunchOptions {
  port?: number;
  headless?: boolean;
  userDataDir?: string;
}

export async function launchChrome(
  opts: LocalLaunchOptions = {},
): Promise<{ wsUrl: string; kill(): void }> {
  const chromeLauncher = await import("chrome-launcher");

  const chrome = await chromeLauncher.launch({
    port: opts.port ?? 9222,
    chromeFlags: [
      ...(opts.headless !== false ? ["--headless=new", "--disable-gpu"] : []),
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
