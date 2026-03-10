import { describe, it, expect } from "vitest";
import { RepeatDetector, nudgeMessage } from "../../src/loop/repeat-detector";

describe("RepeatDetector", () => {
  it("returns null when no repeats", () => {
    const detector = new RepeatDetector();
    const result = detector.record({ type: "click", x: 100, y: 200 });
    expect(result).toBeNull();
  });

  it("returns 5 after 5 identical actions", () => {
    const detector = new RepeatDetector();
    const action = { type: "click" as const, x: 100, y: 200 };
    for (let i = 0; i < 4; i++) {
      expect(detector.record(action)).toBeNull();
    }
    expect(detector.record(action)).toBe(5);
  });

  it("returns 8 after 8 identical actions", () => {
    const detector = new RepeatDetector();
    const action = { type: "type" as const, text: "hello" };
    for (let i = 0; i < 7; i++) {
      detector.record(action);
    }
    expect(detector.record(action)).toBe(8);
  });

  it("returns 12 after 12 identical actions", () => {
    const detector = new RepeatDetector();
    const action = { type: "goto" as const, url: "https://example.com" };
    for (let i = 0; i < 11; i++) {
      detector.record(action);
    }
    expect(detector.record(action)).toBe(12);
  });

  it("buckets nearby clicks as the same action", () => {
    const detector = new RepeatDetector();
    // These are all within the same 64px bucket (pixel coords)
    for (let i = 0; i < 4; i++) {
      detector.record({ type: "click", x: 640 + i, y: 360 + i });
    }
    // 5th click in the same bucket should trigger
    expect(detector.record({ type: "click", x: 650, y: 370 })).toBe(5);
  });

  it("respects rolling window of 20", () => {
    const detector = new RepeatDetector();
    // Fill window with 4 clicks at (100, 200)
    for (let i = 0; i < 4; i++) {
      detector.record({ type: "click", x: 100, y: 200 });
    }
    // Push 20 different actions to flush the window
    for (let i = 0; i < 20; i++) {
      detector.record({ type: "goto", url: `https://example.com/page-${i}` });
    }
    // Now the original 4 clicks are gone from the window
    const result = detector.record({ type: "click", x: 100, y: 200 });
    expect(result).toBeNull(); // only 1 in window now
  });

  it("reset clears the window", () => {
    const detector = new RepeatDetector();
    for (let i = 0; i < 4; i++) {
      detector.record({ type: "click", x: 100, y: 200 });
    }
    detector.reset();
    // After reset, the 5th click should not trigger — window is empty
    expect(detector.record({ type: "click", x: 100, y: 200 })).toBeNull();
  });

  it("normalizes keyPress by joined keys", () => {
    const detector = new RepeatDetector();
    for (let i = 0; i < 4; i++) {
      detector.record({ type: "keyPress", keys: ["Enter"] });
    }
    expect(detector.record({ type: "keyPress", keys: ["Enter"] })).toBe(5);
  });
});

describe("RepeatDetector — category detection", () => {
  it("detects interleaved scroll/noop as stuck (category dominance)", () => {
    const detector = new RepeatDetector();
    // Alternate scroll and noop screenshot — neither hits exact threshold
    // but "passive" category accumulates from scrolls
    for (let i = 0; i < 4; i++) {
      detector.record({ type: "scroll", x: 500, y: 500, direction: "down" as const, amount: 100 + i * 10 });
      detector.record({ type: "screenshot" });
    }
    // 5th noop — "noop" category has 4 entries, but also passive has 4 scrolls
    // The 5th scroll should trigger passive category at 5
    const result = detector.record({ type: "scroll", x: 500, y: 500, direction: "down" as const, amount: 200 });
    expect(result).toBe(5);
  });

  it("does not trigger category detection on productive actions", () => {
    const detector = new RepeatDetector();
    // 5 different productive actions should NOT trigger (productive is exempt)
    detector.record({ type: "click", x: 100, y: 200 });
    detector.record({ type: "click", x: 200, y: 300 });
    detector.record({ type: "click", x: 300, y: 400 });
    detector.record({ type: "click", x: 400, y: 500 });
    // This 5th click triggers exact repeat detection (all different positions though)
    // But category should not trigger since "productive" is exempt
    const result = detector.record({ type: "goto", url: "https://example.com" });
    expect(result).toBeNull(); // only 1 goto, and productive category is exempt
  });

  it("detects pure noop runs", () => {
    const detector = new RepeatDetector();
    for (let i = 0; i < 4; i++) {
      detector.record({ type: "screenshot" });
    }
    // 5th noop triggers both exact (all screenshots) and category
    expect(detector.record({ type: "screenshot" })).toBe(5);
  });
});

describe("RepeatDetector — URL stall detection", () => {
  it("returns null when URL changes", () => {
    const detector = new RepeatDetector();
    expect(detector.recordUrl("https://a.com")).toBeNull();
    expect(detector.recordUrl("https://b.com")).toBeNull();
    expect(detector.recordUrl("https://c.com")).toBeNull();
  });

  it("triggers at urlStallThreshold (default=10)", () => {
    const detector = new RepeatDetector(); // default threshold = 10
    detector.recordUrl("https://example.com");
    for (let i = 0; i < 9; i++) {
      expect(detector.recordUrl("https://example.com")).toBeNull();
    }
    expect(detector.recordUrl("https://example.com")).toBe(5);
  });

  it("triggers at custom urlStallThreshold", () => {
    const detector = new RepeatDetector(5); // custom threshold for testing
    detector.recordUrl("https://example.com");
    for (let i = 0; i < 4; i++) {
      expect(detector.recordUrl("https://example.com")).toBeNull();
    }
    expect(detector.recordUrl("https://example.com")).toBe(5);
  });

  it("escalates at 1.5x and 2x threshold", () => {
    const detector = new RepeatDetector(4); // threshold=4
    detector.recordUrl("https://example.com");
    // Steps 1-3: null
    for (let i = 0; i < 3; i++) detector.recordUrl("https://example.com");
    // Step 4: level 5 (threshold hit)
    expect(detector.recordUrl("https://example.com")).toBe(5);
    // Step 5: null
    expect(detector.recordUrl("https://example.com")).toBeNull();
    // Step 6: level 8 (1.5x = 6)
    expect(detector.recordUrl("https://example.com")).toBe(8);
    // Step 7: null
    expect(detector.recordUrl("https://example.com")).toBeNull();
    // Step 8: level 12 (2x = 8)
    expect(detector.recordUrl("https://example.com")).toBe(12);
  });

  it("resets counter when URL changes", () => {
    const detector = new RepeatDetector(3);
    detector.recordUrl("https://a.com");
    detector.recordUrl("https://a.com");
    detector.recordUrl("https://a.com");
    // Switch URL — counter resets
    detector.recordUrl("https://b.com");
    expect(detector.recordUrl("https://b.com")).toBeNull();
    expect(detector.recordUrl("https://b.com")).toBeNull();
    expect(detector.recordUrl("https://b.com")).toBe(5); // hits threshold=3
  });

  it("reset clears URL tracking", () => {
    const detector = new RepeatDetector(3);
    detector.recordUrl("https://example.com");
    detector.recordUrl("https://example.com");
    detector.reset();
    // After reset, counter is 0
    expect(detector.recordUrl("https://example.com")).toBeNull();
  });

  it("normalizes URLs — ignores query params (tracking defeat fix)", () => {
    const detector = new RepeatDetector(3);
    // Simulate booking.com appending different tracking params on each redirect
    detector.recordUrl("https://www.booking.com/index.html?sid=abc&srpvid=111");
    detector.recordUrl("https://www.booking.com/index.html?sid=def&srpvid=222");
    detector.recordUrl("https://www.booking.com/index.html?sid=ghi&srpvid=333");
    // All normalize to booking.com/index.html → should hit threshold=3
    expect(detector.recordUrl("https://www.booking.com/index.html?sid=jkl&srpvid=444")).toBe(5);
  });

  it("treats different pathnames as different URLs", () => {
    const detector = new RepeatDetector(3);
    detector.recordUrl("https://example.com/page-a?q=1");
    detector.recordUrl("https://example.com/page-b?q=2");
    detector.recordUrl("https://example.com/page-c?q=3");
    // Different pathnames = different pages, no stall
    expect(detector.recordUrl("https://example.com/page-d?q=4")).toBeNull();
  });
});

describe("nudgeMessage", () => {
  it("returns mild nudge at level 5", () => {
    const msg = nudgeMessage(5);
    expect(msg).toContain("repeating");
  });

  it("returns medium nudge at level 8", () => {
    const msg = nudgeMessage(8);
    expect(msg).toContain("different approach");
  });

  it("returns strong nudge at level 12", () => {
    const msg = nudgeMessage(12);
    expect(msg).toContain("STRATEGY RESET");
  });

  it("returns URL-specific nudge with context", () => {
    const msg5 = nudgeMessage(5, "url");
    expect(msg5).toContain("page for a while");

    const msg8 = nudgeMessage(8, "url");
    expect(msg8).toContain("same page for many steps");

    const msg12 = nudgeMessage(12, "url");
    expect(msg12).toContain("STRATEGY RESET");
    expect(msg12).toContain("update_state RIGHT NOW");
  });
});
