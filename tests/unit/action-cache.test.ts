import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ActionCache, screenshotHash } from "../../src/loop/action-cache.js";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let cacheDir: string;
let cache: ActionCache;

beforeEach(async () => {
  cacheDir = join(tmpdir(), `lumen-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cache = new ActionCache(cacheDir);
});

afterEach(async () => {
  try { await fs.rm(cacheDir, { recursive: true }); } catch {}
});

describe("ActionCache", () => {
  it("returns null for cache miss", async () => {
    const result = await cache.get("nonexistent");
    expect(result).toBeNull();
  });

  it("stores and retrieves a non-coordinate action", async () => {
    const action = { type: "goto" as const, url: "https://example.com" };
    const key = cache.cacheKey("goto", "https://example.com", "abc123");
    await cache.set(key, action, "https://example.com", "abc123");

    const result = await cache.get(key);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("goto");
    expect(result!.args).toEqual(action);
  });

  it("stores screenshot hash for coordinate actions", async () => {
    const action = { type: "click" as const, x: 500, y: 300 };
    const key = cache.cacheKey("click", "https://example.com", "abc123");
    await cache.set(key, action, "https://example.com", "abc123", "screenhash123");

    const result = await cache.get(key, "screenhash123");
    expect(result).not.toBeNull();
    expect(result!.screenshotHash).toBe("screenhash123");
  });

  it("returns null when screenshot hash doesn't match", async () => {
    const action = { type: "click" as const, x: 500, y: 300 };
    const key = cache.cacheKey("click", "https://example.com", "abc123");
    await cache.set(key, action, "https://example.com", "abc123", "screenhash_old");

    // Different screenshot hash = layout changed
    const result = await cache.get(key, "screenhash_new");
    expect(result).toBeNull();
  });

  it("returns cached entry when screenshot hash matches exactly", async () => {
    const action = { type: "click" as const, x: 500, y: 300 };
    const key = cache.cacheKey("click", "https://example.com", "abc123");
    await cache.set(key, action, "https://example.com", "abc123", "same_hash");

    const result = await cache.get(key, "same_hash");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("click");
  });

  it("non-coordinate action ignores screenshot hash in entry", async () => {
    const action = { type: "type" as const, text: "hello" };
    const key = cache.cacheKey("type", "https://example.com", "abc123");
    await cache.set(key, action, "https://example.com", "abc123", "some_hash");

    // For non-coordinate actions, screenshotHash should NOT be stored
    const result = await cache.get(key);
    expect(result).not.toBeNull();
    expect(result!.screenshotHash).toBeUndefined();
  });

  it("generates deterministic cache keys", () => {
    const key1 = cache.cacheKey("click", "https://example.com", "abc123");
    const key2 = cache.cacheKey("click", "https://example.com", "abc123");
    expect(key1).toBe(key2);

    const key3 = cache.cacheKey("click", "https://example.com", "different");
    expect(key1).not.toBe(key3);
  });
});

describe("screenshotHash", () => {
  it("produces deterministic hash for same data", () => {
    const data = Buffer.from("hello world");
    expect(screenshotHash(data)).toBe(screenshotHash(data));
  });

  it("produces different hashes for different data", () => {
    expect(screenshotHash(Buffer.from("a"))).not.toBe(screenshotHash(Buffer.from("b")));
  });
});
