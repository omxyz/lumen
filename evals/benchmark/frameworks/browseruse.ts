import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { BenchmarkTask, FrameworkResult } from "../types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const VENV_PYTHON = join(__dir, "../.venv/bin/python3");
const RUNNER_SCRIPT = join(__dir, "../browser_use_runner.py");

export async function runWithBrowserUse(task: BenchmarkTask): Promise<FrameworkResult> {
  const start = Date.now();

  const args = JSON.stringify({
    task_name: task.name,
    instruction: task.instruction,
    start_url: task.startUrl,
    max_steps: task.maxSteps,
  });

  return new Promise((resolve) => {
    const timeoutMs = (task.maxSteps * 45 + 90) * 1000;

    const proc = spawn(VENV_PYTHON, [RUNNER_SCRIPT, args], {
      env: { ...process.env },
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try {
        const json = JSON.parse(stdout.trim());
        const pyPassed: boolean = Boolean(json.passed);
        const { passed, score } = pyPassed ? task.check(json.result ?? "") : { passed: false, score: 0 };
        resolve({
          framework: "browser-use",
          task: task.name,
          passed,
          score,
          steps: json.steps ?? 0,
          tokens: json.tokens ?? null,
          durationMs: Date.now() - start,
          result: json.result ?? "",
          error: json.error ?? (code !== 0 ? `exit ${code}` : undefined),
        });
      } catch {
        resolve({
          framework: "browser-use",
          task: task.name,
          passed: false,
          score: 0,
          steps: 0,
          tokens: null,
          durationMs: Date.now() - start,
          result: "",
          error: `parse error — stdout: ${stdout.slice(0, 200)} | stderr: ${stderr.slice(0, 200)}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        framework: "browser-use",
        task: task.name,
        passed: false,
        score: 0,
        steps: 0,
        tokens: null,
        durationMs: Date.now() - start,
        result: "",
        error: `spawn error: ${err.message}. Run: evals/benchmark/setup.sh`,
      });
    });
  });
}
