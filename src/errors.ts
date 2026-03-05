export type LumenErrorCode =
  | "BROWSER_DISCONNECTED"
  | "MODEL_API_ERROR"
  | "SESSION_TIMEOUT"
  | "MAX_RETRIES_EXCEEDED"
  | "POLICY_VIOLATION"
  | "CHILD_LOOP_FAILED";

export class LumenError extends Error {
  readonly code: LumenErrorCode;
  readonly step?: number;

  constructor(code: LumenErrorCode, message: string, step?: number) {
    super(message);
    this.name = "LumenError";
    this.code = code;
    this.step = step;
  }
}
