import { WebSocket } from "ws";
import { LumenLogger } from "../logger";

interface CDPMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

export interface CDPSessionLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
}

// Commands to skip in CDP logging — too noisy or result is megabytes
const SKIP_CDP_CMDS = new Set([
  "Page.captureScreenshot",   // result is base64 image data
  "Runtime.evaluate",         // result can be large; callers log at a higher level
  "Input.dispatchMouseEvent", // ~3 calls per click; covered by ActionRouter logging
  "Input.dispatchKeyEvent",   // noisy; covered by ActionRouter logging
  "Input.insertText",         // covered by ActionRouter logging
]);

// CDP events to skip in general logging (handled with a special case below)
const SKIP_CDP_EVENTS = new Set([
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.domContentEventFired",
  "Page.lifecycleEvent",       // logged selectively below (networkIdle, load, commit)
]);

export class CdpSession implements CDPSessionLike {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    private readonly send_: (msg: Record<string, unknown>) => void,
    private readonly sessionId?: string,
    private readonly log: LumenLogger = LumenLogger.NOOP,
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params) msg.params = params;
    if (this.sessionId) msg.sessionId = this.sessionId;

    const shouldLog = !SKIP_CDP_CMDS.has(method);
    if (shouldLog) {
      const pStr = params ? JSON.stringify(params).slice(0, 200) : "";
      this.log.cdp(`→ ${method}${pStr ? " " + pStr : ""}`, { id });
    }

    const t0 = Date.now();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v: unknown) => {
          if (shouldLog) {
            const elapsed = Date.now() - t0;
            const rStr = JSON.stringify(v ?? {}).slice(0, 200);
            this.log.cdp(`← ${method} (${elapsed}ms) ${rStr}`, { id, elapsed });
          }
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e: Error) => {
          const elapsed = Date.now() - t0;
          this.log.cdp(`✗ ${method} (${elapsed}ms) ERROR: ${e.message}`, { id, elapsed, error: e.message });
          reject(e);
        },
      });
      this.send_(msg);
    });
  }

  on(event: string, handler: (params: unknown) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: (params: unknown) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  _handleMessage(msg: CDPMessage): void {
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.method) {
      // Selective lifecycle event logging
      if (msg.method === "Page.lifecycleEvent") {
        const p = msg.params as { name?: string };
        if (p?.name === "networkIdle" || p?.name === "load" || p?.name === "commit") {
          this.log.cdp(`ev Page.lifecycleEvent name=${p.name}`);
        }
        // other lifecycle events (DOMContentLoaded, etc.) are silently skipped
      } else if (!SKIP_CDP_EVENTS.has(msg.method)) {
        const pStr = JSON.stringify(msg.params ?? {}).slice(0, 200);
        this.log.cdp(`ev ${msg.method} ${pStr}`);
      }

      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params);
        }
      }
    }
  }

  _rejectAll(err: Error): void {
    if (this.pending.size > 0) {
      this.log.cdp(`_rejectAll: rejecting ${this.pending.size} pending call(s): ${err.message}`);
    }
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

export class CdpConnection {
  private ws: WebSocket;
  private main: CdpSession;
  private sessions = new Map<string, CdpSession>();
  private readonly log: LumenLogger;

  private constructor(ws: WebSocket, main: CdpSession, log: LumenLogger) {
    this.ws = ws;
    this.main = main;
    this.log = log;
  }

  static connect(wsUrl: string, log: LumenLogger = LumenLogger.NOOP): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let conn: CdpConnection;

      ws.on("open", () => {
        log.cdp(`connected: ${wsUrl}`);
        const send_ = (msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));
        const mainSession = new CdpSession(send_, undefined, log);
        conn = new CdpConnection(ws, mainSession, log);
        resolve(conn);
      });

      ws.on("message", (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as CDPMessage;
          if (msg.sessionId && conn.sessions.has(msg.sessionId)) {
            conn.sessions.get(msg.sessionId)!._handleMessage(msg);
          } else {
            conn.main._handleMessage(msg);
          }
        } catch {
          // ignore parse errors
        }
      });

      ws.on("error", (err) => {
        log.error(`[cdp] WebSocket error: ${(err as Error).message}`, { url: wsUrl });
        reject(err);
        conn?.main._rejectAll(err as Error);
        for (const s of conn?.sessions?.values() ?? []) s._rejectAll(err as Error);
      });

      ws.on("close", (code, reason) => {
        log.warn(`[cdp] WebSocket closed`, { code, reason: reason.toString() });
        const err = new Error("CDP WebSocket closed");
        conn?.main._rejectAll(err);
        for (const s of conn?.sessions?.values() ?? []) s._rejectAll(err);
      });

      // Connection timeout
      setTimeout(() => reject(new Error(`CDP connection timeout: ${wsUrl}`)), 15000);
    });
  }

  mainSession(): CdpSession {
    return this.main;
  }

  async newSession(targetId: string): Promise<CdpSession> {
    const result = await this.main.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const send_ = (msg: Record<string, unknown>) => this.ws.send(JSON.stringify(msg));
    const session = new CdpSession(send_, result.sessionId, this.log);
    this.sessions.set(result.sessionId, session);
    return session;
  }

  close(): void {
    this.ws.close();
  }
}
