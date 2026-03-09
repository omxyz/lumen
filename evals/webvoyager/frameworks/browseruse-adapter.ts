import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FrameworkAdapter, FrameworkAttemptResult } from "./types.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const VENV_PYTHON = join(__dir, "../../benchmark/.venv/bin/python3");
const RUNNER_SCRIPT = join(__dir, "../browser_use_webvoyager.py");

export const browserUseAdapter: FrameworkAdapter = {
  name: "browser-use",

  async run({ instruction, startUrl, maxSteps, model, timeoutMs }) {
    const start = Date.now();

    const args = JSON.stringify({
      task_name: "webvoyager",
      instruction,
      start_url: startUrl,
      max_steps: maxSteps,
    });

    return new Promise<FrameworkAttemptResult>((resolve) => {
      const proc = spawn(VENV_PYTHON, [RUNNER_SCRIPT, args], {
        env: { ...process.env, MODEL: model },
        timeout: timeoutMs,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

      proc.on("close", (code) => {
        try {
          const json = JSON.parse(stdout.trim());

          // Parse screenshot if present
          let screenshot: Buffer | undefined;
          if (json.screenshot_b64) {
            screenshot = Buffer.from(json.screenshot_b64, "base64");
          }

          resolve({
            framework: "browser-use",
            result: json.result ?? "",
            status: json.passed ? "success" : json.error ? "error" : "maxSteps",
            steps: json.steps ?? 0,
            tokens: json.tokens ?? 0,
            durationMs: Date.now() - start,
            screenshot,
            error: json.error ?? undefined,
          });
        } catch {
          resolve({
            framework: "browser-use",
            result: "",
            status: "error",
            steps: 0,
            tokens: 0,
            durationMs: Date.now() - start,
            error: `parse error — stdout: ${stdout.slice(0, 200)} | stderr: ${stderr.slice(0, 200)}`,
          });
        }
      });

      proc.on("error", (err) => {
        resolve({
          framework: "browser-use",
          result: "",
          status: "error",
          steps: 0,
          tokens: 0,
          durationMs: Date.now() - start,
          error: `spawn error: ${err.message}. Run: evals/benchmark/setup.sh`,
        });
      });
    });
  },
};
