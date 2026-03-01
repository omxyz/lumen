export interface BenchmarkTask {
  name: string;
  instruction: string;
  startUrl: string;
  maxSteps: number;
  check(result: string): { passed: boolean; score: number };
}

export type Framework = "lumen" | "stagehand" | "browser-use";

export interface FrameworkResult {
  framework: Framework;
  task: string;
  passed: boolean;
  score: number;
  steps: number;
  tokens: number | null;
  durationMs: number;
  result: string;
  error?: string;
}

export interface BenchmarkReport {
  timestamp: string;
  model: string;
  results: FrameworkResult[];
}

export interface FrameworkSummary {
  framework: Framework;
  successRate: number;
  avgSteps: number;
  avgTokens: number | null;
  avgDurationMs: number;
  passed: number;
  total: number;
}
