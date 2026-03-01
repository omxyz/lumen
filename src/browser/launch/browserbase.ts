export interface BrowserbaseOptions {
  apiKey: string;
  projectId: string;
  sessionId?: string;
}

export async function connectBrowserbase(
  opts: BrowserbaseOptions,
): Promise<{ wsUrl: string; sessionId: string }> {
  let sessionId = opts.sessionId;

  if (!sessionId) {
    // Create a new session
    const res = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-API-Key": opts.apiKey,
      },
      body: JSON.stringify({ projectId: opts.projectId }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Browserbase session creation failed (${res.status}): ${text}`);
    }

    const data = await res.json() as { id: string; connectUrl: string };
    return {
      wsUrl: data.connectUrl,
      sessionId: data.id,
    };
  }

  // Resume existing session
  const res = await fetch(`https://api.browserbase.com/v1/sessions/${sessionId}/debug`, {
    headers: { "X-BB-API-Key": opts.apiKey },
  });

  if (!res.ok) {
    throw new Error(`Browserbase session lookup failed (${res.status})`);
  }

  const data = await res.json() as { wsUrl: string };
  return { wsUrl: data.wsUrl, sessionId };
}
