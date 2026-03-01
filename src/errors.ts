export type CUAErrorCode =
  | "BROWSER_DISCONNECTED"
  | "MODEL_API_ERROR"
  | "SESSION_TIMEOUT"
  | "INIT_REQUIRED"
  | "MAX_RETRIES_EXCEEDED"
  | "POLICY_VIOLATION"
  | "CHILD_LOOP_FAILED";

export class CUAError extends Error {
  readonly code: CUAErrorCode;
  readonly step?: number;

  constructor(code: CUAErrorCode, message: string, step?: number) {
    super(message);
    this.name = "CUAError";
    this.code = code;
    this.step = step;
  }
}
