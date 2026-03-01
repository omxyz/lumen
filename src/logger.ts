import type { LogLine } from "./types.js";

type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 99,
};

function resolveMinLevel(verbose: number): LogLevel {
  // Env var takes priority over verbose arg
  const env = (process.env["LUMEN_LOG"] ?? "").toLowerCase() as LogLevel;
  if (env in LEVELS) return env;
  if (verbose === 0) return "silent";
  return "info";
}

/**
 * Granular debug logger threaded through all Lumen layers.
 *
 * Log level is controlled by (in priority order):
 *   1. LUMEN_LOG env var: "debug" | "info" | "warn" | "error" | "silent"
 *   2. verbose constructor arg: 0=silent, 1=info (default), 2=info+surfaces
 *
 * Individual surfaces can be enabled regardless of level via env vars:
 *   LUMEN_LOG_CDP=1      — CDP WebSocket wire traffic (very noisy)
 *   LUMEN_LOG_ACTIONS=1  — ActionRouter dispatch + timing
 *   LUMEN_LOG_BROWSER=1  — CDPTab navigation/input/screenshot ops
 *   LUMEN_LOG_HISTORY=1  — HistoryManager compaction/compression state
 *   LUMEN_LOG_ADAPTER=1  — Model adapter call timing and token counts
 *   LUMEN_LOG_LOOP=1     — PerceptionLoop step internals
 *
 * The optional callback receives every emitted LogLine as structured data,
 * regardless of console verbosity level.
 */
export class LumenLogger {
  private readonly min: number;
  private readonly callback?: (line: LogLine) => void;

  /** Whether CDP wire-level logging is enabled (commands, responses, events). */
  readonly cdpEnabled: boolean;
  /** Whether ActionRouter dispatch logging is enabled. */
  readonly actionsEnabled: boolean;
  /** Whether CDPTab browser-operation logging is enabled. */
  readonly browserEnabled: boolean;
  /** Whether HistoryManager compaction/compression logging is enabled. */
  readonly historyEnabled: boolean;
  /** Whether model adapter call logging is enabled. */
  readonly adapterEnabled: boolean;
  /** Whether PerceptionLoop step internals are logged. */
  readonly loopEnabled: boolean;

  constructor(verbose: number, callback?: (line: LogLine) => void) {
    const level = resolveMinLevel(verbose);
    this.min = LEVELS[level];
    this.callback = callback;
    const isDebug = level === "debug";
    const v2 = verbose >= 2;
    this.cdpEnabled     = isDebug || !!process.env["LUMEN_LOG_CDP"];
    this.actionsEnabled = isDebug || v2 || !!process.env["LUMEN_LOG_ACTIONS"];
    this.browserEnabled = isDebug || v2 || !!process.env["LUMEN_LOG_BROWSER"];
    this.historyEnabled = isDebug || v2 || !!process.env["LUMEN_LOG_HISTORY"];
    this.adapterEnabled = isDebug || v2 || !!process.env["LUMEN_LOG_ADAPTER"];
    this.loopEnabled    = isDebug || v2 || !!process.env["LUMEN_LOG_LOOP"];
  }

  private emit(level: Exclude<LogLevel, "silent">, msg: string, data?: Record<string, unknown>): void {
    // Callback always receives emitted lines (for structured logging pipelines)
    if (this.callback) {
      this.callback({ level, message: msg, data, timestamp: Date.now() });
    }
    // Console output is gated by the resolved minimum level
    if (LEVELS[level] < this.min) return;
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const prefix = `[lumen ${ts}]`;
    if (level === "error") console.error(prefix, msg, ...(data ? [data] : []));
    else if (level === "warn") console.warn(prefix, msg, ...(data ? [data] : []));
    else console.log(prefix, msg, ...(data ? [data] : []));
  }

  // ─── Surface-specific debug emitters ───────────────────────────────────────

  /** CDP WebSocket wire traffic: commands (→), responses (←), events (ev). */
  cdp(msg: string, data?: Record<string, unknown>): void {
    if (this.cdpEnabled) this.emit("debug", `[cdp] ${msg}`, data);
  }

  /** ActionRouter action dispatch with denormalized coords and timing. */
  action(msg: string, data?: Record<string, unknown>): void {
    if (this.actionsEnabled) this.emit("debug", `[action] ${msg}`, data);
  }

  /** CDPTab browser operations: navigation, input, screenshot, viewport. */
  browser(msg: string, data?: Record<string, unknown>): void {
    if (this.browserEnabled) this.emit("debug", `[browser] ${msg}`, data);
  }

  /** HistoryManager compaction and screenshot compression internals. */
  history(msg: string, data?: Record<string, unknown>): void {
    if (this.historyEnabled) this.emit("debug", `[history] ${msg}`, data);
  }

  /** Model adapter call timing and token accounting. */
  adapter(msg: string, data?: Record<string, unknown>): void {
    if (this.adapterEnabled) this.emit("debug", `[adapter] ${msg}`, data);
  }

  /** PerceptionLoop step-level internals: utilization, wire length, etc. */
  loop(msg: string, data?: Record<string, unknown>): void {
    if (this.loopEnabled) this.emit("debug", `[loop] ${msg}`, data);
  }

  // ─── Level-based emitters ──────────────────────────────────────────────────

  info(msg: string, data?: Record<string, unknown>): void { this.emit("info", msg, data); }
  warn(msg: string, data?: Record<string, unknown>): void { this.emit("warn", msg, data); }
  error(msg: string, data?: Record<string, unknown>): void { this.emit("error", msg, data); }

  /** Shared no-op instance — all methods are zero-cost when no env flags are set. */
  static readonly NOOP = new LumenLogger(0);
}
