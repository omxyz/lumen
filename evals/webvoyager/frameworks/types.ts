/**
 * Shared types for the unified WebVoyager comparison runner.
 */

export type FrameworkName = "lumen" | "stagehand" | "browser-use";

/** What each adapter must implement. */
export interface FrameworkAdapter {
  name: FrameworkName;
  run(opts: {
    instruction: string;
    startUrl: string;
    maxSteps: number;
    model: string;
    apiKey: string | undefined;
    timeoutMs: number;
  }): Promise<FrameworkAttemptResult>;
}

/** Raw result from a single framework attempt (before judging). */
export interface FrameworkAttemptResult {
  framework: FrameworkName;
  result: string;
  status: "success" | "maxSteps" | "error";
  steps: number;
  tokens: number;
  durationMs: number;
  screenshot?: Buffer;
  error?: string;
}

/** Result after the judge has evaluated. */
export interface JudgedResult extends FrameworkAttemptResult {
  judgePass: boolean;
  judgeReason: string;
  trial: number;
  taskId: string;
  webName: string;
  question: string;
}

/** Per-task comparison across frameworks. */
export interface TaskComparison {
  taskId: string;
  webName: string;
  question: string;
  startUrl: string;
  results: Record<FrameworkName, JudgedResult | null>;
}

/** Full comparison report saved to disk. */
export interface ComparisonReport {
  timestamp: string;
  model: string;
  judgeModel: string;
  trials: number;
  frameworks: FrameworkName[];
  tasks: TaskComparison[];
  summary: Record<FrameworkName, FrameworkSummary>;
}

export interface FrameworkSummary {
  framework: FrameworkName;
  total: number;
  passed: number;
  passRate: number;
  avgSteps: number;
  avgTokens: number;
  avgDurationMs: number;
}
