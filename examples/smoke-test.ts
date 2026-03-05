/**
 * Smoke test — validates all new features are wired correctly
 * by running through the full PerceptionLoop with mock components.
 *
 * Exercises:
 *   1. Repeat detection + nudge injection
 *   2. Action caching (writes to temp dir)
 *   3. Adapter retry backoff (imported successfully)
 *
 * No API key required — uses mock adapter and mock browser tab.
 *
 * Usage:
 *   npx tsx examples/smoke-test.ts
 */

import { PerceptionLoop } from "../src/loop/perception.js";
import { HistoryManager } from "../src/loop/history.js";
import { StateStore } from "../src/loop/state.js";
import { RepeatDetector, nudgeMessage } from "../src/loop/repeat-detector.js";
import { ActionCache, screenshotHash } from "../src/loop/action-cache.js";
import { withRetry } from "../src/model/adapter.js";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Inline mocks (same as integration tests) ──────────────────────────────

import type { ModelAdapter, StepContext, ModelResponse } from "../src/model/adapter.js";
import type { BrowserTab, ClickOptions, DragOptions, TypeOptions } from "../src/browser/tab.js";
import type {
  CUAAction, TaskState, WireMessage,
  ActionOutcome, ScreenshotOptions, ScreenshotResult, ViewportSize,
} from "../src/types.js";

class MockAdapter implements ModelAdapter {
  readonly modelId = "mock-model";
  readonly provider = "mock";
  readonly nativeComputerUse = false;
  readonly contextWindowTokens = 100_000;
  private actionQueue: CUAAction[][] = [];
  private stepCount = 0;
  private _lastStreamResponse: ModelResponse | null = null;

  queueActions(actions: CUAAction[]): this {
    this.actionQueue.push(actions);
    return this;
  }

  async step(_context: StepContext): Promise<ModelResponse> {
    const actions = this.actionQueue[this.stepCount] ?? [{ type: "terminate" as const, status: "success" as const, result: "done" }];
    this.stepCount++;
    const resp: ModelResponse = {
      actions,
      usage: { inputTokens: 100, outputTokens: 50 },
      rawResponse: null,
    };
    this._lastStreamResponse = resp;
    return resp;
  }

  getLastStreamResponse(): ModelResponse | null {
    return this._lastStreamResponse;
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    const response = await this.step(context);
    for (const action of response.actions) yield action;
  }

  estimateTokens(_context: StepContext): number { return 1000; }

  async summarize(_wireHistory: WireMessage[], _currentState: TaskState | null): Promise<string> {
    return "Session summary.";
  }
}

class MockBrowserTab implements BrowserTab {
  private _url = "https://example.com";
  private _viewport: ViewportSize = { width: 1280, height: 720 };

  async screenshot(_opts?: ScreenshotOptions): Promise<ScreenshotResult> {
    return { data: Buffer.alloc(100, 0), width: 1280, height: 720, mimeType: "image/png" };
  }
  async click(_x: number, _y: number, _options?: ClickOptions): Promise<ActionOutcome> { return { ok: true }; }
  async doubleClick(_x: number, _y: number): Promise<ActionOutcome> { return { ok: true }; }
  async hover(_x: number, _y: number): Promise<ActionOutcome> { return { ok: true }; }
  async drag(_fromX: number, _fromY: number, _toX: number, _toY: number, _opts?: DragOptions): Promise<ActionOutcome> { return { ok: true }; }
  async scroll(_x: number, _y: number, _deltaX: number, _deltaY: number): Promise<ActionOutcome> { return { ok: true }; }
  async type(_text: string, _opts?: TypeOptions): Promise<ActionOutcome> { return { ok: true }; }
  async keyPress(_key: string | string[]): Promise<ActionOutcome> { return { ok: true }; }
  async goto(url: string): Promise<void> { this._url = url; }
  async waitForLoad(_timeoutMs?: number): Promise<void> {}
  url(): string { return this._url; }
  viewport(): ViewportSize { return { ...this._viewport }; }
  async setViewport(size: ViewportSize): Promise<void> { this._viewport = { ...size }; }
  async evaluate<T>(_fn: string): Promise<T> { return undefined as unknown as T; }
  async close(): Promise<void> {}
}

// ─── Tests ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

async function main() {
  console.log("\n=== Lumen Smoke Test ===\n");

  // ── 1. RepeatDetector standalone ────────────────────────────────────────
  console.log("RepeatDetector:");
  {
    const detector = new RepeatDetector();
    const action: CUAAction = { type: "click", x: 500, y: 500 };
    let triggered = false;
    for (let i = 0; i < 5; i++) {
      const result = detector.record(action);
      if (result === 5) triggered = true;
    }
    assert(triggered, "triggers at threshold 5");
    assert(nudgeMessage(5).includes("repeating"), "nudge level 5 contains 'repeating'");
    assert(nudgeMessage(8).includes("different approach"), "nudge level 8 contains 'different approach'");
    assert(nudgeMessage(12).includes("completely different strategy"), "nudge level 12 contains 'completely different strategy'");
  }

  // ── 2. ActionCache standalone ──────────────────────────────────────────
  console.log("\nActionCache:");
  {
    const cacheDir = join(tmpdir(), `lumen-smoke-${Date.now()}`);
    const cache = new ActionCache(cacheDir);
    const key = cache.cacheKey("click", "https://example.com", "abc123");

    // Cache miss
    const miss = await cache.get(key);
    assert(miss === null, "returns null for cache miss");

    // Cache hit
    const action: CUAAction = { type: "click", x: 500, y: 300 };
    await cache.set(key, action, "https://example.com", "abc123", "hash1");
    const hit = await cache.get(key, "hash1");
    assert(hit !== null && hit.type === "click", "stores and retrieves cached action");

    // Screenshot hash mismatch
    const mismatch = await cache.get(key, "different_hash");
    assert(mismatch === null, "rejects on screenshot hash mismatch");

    // Deterministic keys
    const k1 = cache.cacheKey("click", "https://example.com", "abc123");
    const k2 = cache.cacheKey("click", "https://example.com", "abc123");
    assert(k1 === k2, "generates deterministic cache keys");

    // screenshotHash
    const h1 = screenshotHash(Buffer.from("hello"));
    const h2 = screenshotHash(Buffer.from("hello"));
    const h3 = screenshotHash(Buffer.from("world"));
    assert(h1 === h2, "screenshotHash is deterministic");
    assert(h1 !== h3, "screenshotHash differs for different data");

    await fs.rm(cacheDir, { recursive: true }).catch(() => {});
  }

  // ── 3. withRetry ───────────────────────────────────────────────────────
  console.log("\nAdapter Retry:");
  {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("429 rate limited");
      return "ok";
    }, 3);
    assert(result === "ok" && attempts === 3, "withRetry retries on 429 and succeeds");

    try {
      await withRetry(async () => { throw new Error("fatal"); }, 2);
      assert(false, "withRetry throws on non-retryable errors");
    } catch {
      assert(true, "withRetry throws on non-retryable errors");
    }
  }

  // ── 4. Full PerceptionLoop with repeat detection + action cache ────────
  console.log("\nPerceptionLoop integration:");
  {
    const cacheDir = join(tmpdir(), `lumen-smoke-loop-${Date.now()}`);
    const adapter = new MockAdapter();

    // 6 identical clicks (triggers repeat detection at 5), then terminate
    for (let i = 0; i < 6; i++) {
      adapter.queueActions([{ type: "click", x: 500, y: 500 }]);
    }
    adapter.queueActions([{ type: "terminate", status: "success", result: "done after nudge" }]);

    const tab = new MockBrowserTab();
    const history = new HistoryManager(100_000);
    const loop = new PerceptionLoop({
      tab,
      adapter,
      history,
      state: new StateStore(),
      cacheDir,
    });

    const result = await loop.run({ maxSteps: 15, instructionHash: "test-hash-123" });

    assert(result.status === "success", `loop terminates with success (got: ${result.status})`);
    assert(result.result === "done after nudge", `loop returns correct result`);
    assert(result.steps === 7, `loop ran 7 steps: 6 clicks + 1 terminate (got: ${result.steps})`);

    // Verify cache was written
    const cacheFiles = await fs.readdir(cacheDir).catch(() => [] as string[]);
    assert(cacheFiles.length > 0, `action cache wrote ${cacheFiles.length} entries`);

    await fs.rm(cacheDir, { recursive: true }).catch(() => {});
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log("\nAll features wired correctly!\n");
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
