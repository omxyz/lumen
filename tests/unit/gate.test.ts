import { describe, it, expect } from "vitest";
import { UrlMatchesGate, CustomGate } from "../../src/loop/verifier.js";
import type { ScreenshotResult } from "../../src/types.js";

const mockScreenshot: ScreenshotResult = {
  data: Buffer.from(""),
  width: 1280,
  height: 720,
  mimeType: "image/png",
};

describe("UrlMatchesGate", () => {
  it("passes when URL matches pattern", async () => {
    const gate = new UrlMatchesGate(/example\.com\/success/);
    const result = await gate.verify(mockScreenshot, "https://example.com/success");
    expect(result.passed).toBe(true);
  });

  it("fails when URL does not match pattern", async () => {
    const gate = new UrlMatchesGate(/example\.com\/success/);
    const result = await gate.verify(mockScreenshot, "https://example.com/other");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("does not match");
  });
});

describe("CustomGate", () => {
  it("passes when predicate returns true", async () => {
    const gate = new CustomGate(async () => true);
    const result = await gate.verify(mockScreenshot, "https://example.com");
    expect(result.passed).toBe(true);
  });

  it("fails when predicate returns false", async () => {
    const gate = new CustomGate(async () => false, "custom failure reason");
    const result = await gate.verify(mockScreenshot, "https://example.com");
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("custom failure reason");
  });

  it("receives screenshot and url in predicate", async () => {
    let capturedUrl = "";
    const gate = new CustomGate(async (_ss, url) => {
      capturedUrl = url;
      return true;
    });
    await gate.verify(mockScreenshot, "https://test.com/page");
    expect(capturedUrl).toBe("https://test.com/page");
  });
});
