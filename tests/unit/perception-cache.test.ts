import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ActionCache } from "../../src/loop/action-cache";
import type { Action, ActionExecution } from "../../src/types";
import type { ModelResponse } from "../../src/model/adapter";

// Minimal mock for testing tryCache integration points
// These tests validate the cache-hit fast path logic without a real browser

describe("ActionCache stepKey", () => {
  let cache: ActionCache;

  beforeEach(() => {
    cache = new ActionCache("/tmp/test-cache");
  });

  it("produces deterministic keys", () => {
    const key1 = cache.stepKey("https://example.com", "abc123");
    const key2 = cache.stepKey("https://example.com", "abc123");
    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
  });

  it("differs when url differs", () => {
    const key1 = cache.stepKey("https://a.com", "abc123");
    const key2 = cache.stepKey("https://b.com", "abc123");
    expect(key1).not.toBe(key2);
  });

  it("differs when instructionHash differs", () => {
    const key1 = cache.stepKey("https://example.com", "hash1");
    const key2 = cache.stepKey("https://example.com", "hash2");
    expect(key1).not.toBe(key2);
  });

  it("does not include action type (unlike cacheKey)", () => {
    const stepKey = cache.stepKey("https://example.com", "abc123");
    const cacheKey = cache.cacheKey("click", "https://example.com", "abc123");
    // stepKey should differ from cacheKey since cacheKey includes "click"
    expect(stepKey).not.toBe(cacheKey);
  });
});

describe("viewportMismatch", () => {
  // Import directly since it's a pure function
  let viewportMismatch: typeof import("../../src/loop/action-cache").viewportMismatch;

  beforeEach(async () => {
    const mod = await import("../../src/loop/action-cache");
    viewportMismatch = mod.viewportMismatch;
  });

  it("returns false when cached has no viewport", () => {
    const cached = { version: 1 as const, type: "click" as const, url: "", instructionHash: "", args: {} };
    expect(viewportMismatch(cached, { width: 1280, height: 720 })).toBe(false);
  });

  it("returns false when viewports match", () => {
    const cached = {
      version: 1 as const, type: "click" as const, url: "", instructionHash: "",
      viewport: { width: 1280, height: 720 }, args: {},
    };
    expect(viewportMismatch(cached, { width: 1280, height: 720 })).toBe(false);
  });

  it("returns true when width differs", () => {
    const cached = {
      version: 1 as const, type: "click" as const, url: "", instructionHash: "",
      viewport: { width: 1280, height: 720 }, args: {},
    };
    expect(viewportMismatch(cached, { width: 1920, height: 720 })).toBe(true);
  });

  it("returns true when height differs", () => {
    const cached = {
      version: 1 as const, type: "click" as const, url: "", instructionHash: "",
      viewport: { width: 1280, height: 720 }, args: {},
    };
    expect(viewportMismatch(cached, { width: 1280, height: 1080 })).toBe(true);
  });
});

describe("ActionCache with viewport", () => {
  let cache: ActionCache;
  let cacheDir: string;

  beforeEach(async () => {
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    cacheDir = join(tmpdir(), `lumen-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cache = new ActionCache(cacheDir);
  });

  afterEach(async () => {
    const { promises: fs } = await import("fs");
    try { await fs.rm(cacheDir, { recursive: true }); } catch {}
  });

  it("stores and retrieves viewport in cache entry", async () => {
    const action = { type: "click" as const, x: 100, y: 200 };
    const key = cache.stepKey("https://example.com", "abc");
    await cache.set(key, action, "https://example.com", "abc", undefined, { width: 1280, height: 720 });

    const result = await cache.get(key);
    expect(result).not.toBeNull();
    expect(result!.viewport).toEqual({ width: 1280, height: 720 });
  });

  it("retrieves entry without viewport (backward compat)", async () => {
    const action = { type: "goto" as const, url: "https://example.com" };
    const key = cache.stepKey("https://example.com", "abc");
    await cache.set(key, action, "https://example.com", "abc");

    const result = await cache.get(key);
    expect(result).not.toBeNull();
    expect(result!.viewport).toBeUndefined();
  });

  it("stepKey cache hit works without screenshotHash validation", async () => {
    const action = { type: "click" as const, x: 100, y: 200 };
    const key = cache.stepKey("https://example.com", "abc");
    // Set with a screenshot hash
    await cache.set(key, action, "https://example.com", "abc", "hash_at_record_time", { width: 1280, height: 720 });

    // Get WITHOUT passing a screenshot hash — should still return the entry
    // (stepKey lookups don't require screenshot validation)
    const result = await cache.get(key);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("click");
  });
});
