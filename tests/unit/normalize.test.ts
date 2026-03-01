import { describe, it, expect } from "vitest";
import { denormalize, normalize, clampNormalized, denormalizePoint } from "../../src/model/adapter.js";

describe("denormalize", () => {
  it("converts 500 (50%) to half of dimension", () => {
    expect(denormalize(500, 1280)).toBe(640);
  });

  it("converts 0 to 0", () => {
    expect(denormalize(0, 1000)).toBe(0);
  });

  it("converts 1000 to full dimension", () => {
    expect(denormalize(1000, 720)).toBe(720);
  });

  it("rounds to nearest integer", () => {
    expect(denormalize(333, 1000)).toBe(333);
    expect(typeof denormalize(1, 3)).toBe("number");
  });
});

describe("normalize", () => {
  it("converts half dimension to 500", () => {
    expect(normalize(640, 1280)).toBe(500);
  });

  it("converts 0 to 0", () => {
    expect(normalize(0, 1000)).toBe(0);
  });

  it("converts full dimension to 1000", () => {
    expect(normalize(720, 720)).toBe(1000);
  });
});

describe("clampNormalized", () => {
  it("clamps below 0 to 0", () => {
    expect(clampNormalized(-50)).toBe(0);
  });

  it("clamps above 1000 to 1000", () => {
    expect(clampNormalized(1500)).toBe(1000);
  });

  it("passes through values in range", () => {
    expect(clampNormalized(500)).toBe(500);
    expect(clampNormalized(0)).toBe(0);
    expect(clampNormalized(1000)).toBe(1000);
  });
});

describe("denormalizePoint", () => {
  it("denormalizes x and y together", () => {
    const pt = denormalizePoint(500, 500, { width: 1280, height: 720 });
    expect(pt.x).toBe(640);
    expect(pt.y).toBe(360);
  });
});
