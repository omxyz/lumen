import { WebSocket } from "ws";

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

export class CdpSession implements CDPSessionLike {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(params: unknown) => void>>();

  constructor(
    private readonly send_: (msg: Record<string, unknown>) => void,
    private readonly sessionId?: string,
  ) {}

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params) msg.params = params;
    if (this.sessionId) msg.sessionId = this.sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
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
      const handlers = this.listeners.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          handler(msg.params);
        }
      }
    }
  }

  _rejectAll(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }
}

export class CdpConnection {
  private ws: WebSocket;
  private main: CdpSession;
  private sessions = new Map<string, CdpSession>();

  private constructor(ws: WebSocket, main: CdpSession) {
    this.ws = ws;
    this.main = main;
  }

  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let conn: CdpConnection;

      ws.on("open", () => {
        const send_ = (msg: Record<string, unknown>) => ws.send(JSON.stringify(msg));
        const mainSession = new CdpSession(send_);
        conn = new CdpConnection(ws, mainSession);
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
        console.error(`[cdp] WebSocket error: ${err}`);
        reject(err);
        conn?.main._rejectAll(err as Error);
        for (const s of conn?.sessions?.values() ?? []) s._rejectAll(err as Error);
      });

      ws.on("close", (code, reason) => {
        console.error(`[cdp] WebSocket closed — code=${code} reason="${reason.toString()}"`);
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
    const session = new CdpSession(send_, result.sessionId);
    this.sessions.set(result.sessionId, session);
    return session;
  }

  close(): void {
    this.ws.close();
  }
}
