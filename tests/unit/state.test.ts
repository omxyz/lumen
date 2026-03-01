import { describe, it, expect } from "vitest";
import { StateStore } from "../../src/loop/state.js";
import type { TaskState } from "../../src/types.js";

const mockState: TaskState = {
  currentUrl: "https://example.com",
  completedSteps: ["step1"],
  nextStep: "step2",
  data: { key: "value" },
};

describe("StateStore", () => {
  it("returns null initially", () => {
    const store = new StateStore();
    expect(store.current()).toBeNull();
  });

  it("returns written state", () => {
    const store = new StateStore();
    store.write(mockState);
    expect(store.current()).toEqual(mockState);
  });

  it("current() returns a copy (immutable)", () => {
    const store = new StateStore();
    store.write(mockState);
    const current = store.current()!;
    (current as Record<string, unknown>).currentUrl = "https://modified.com";
    expect((store.current() as Record<string, unknown>).currentUrl).toBe("https://example.com");
  });

  it("load sets state from persisted value", () => {
    const store = new StateStore();
    store.load(mockState);
    expect(store.current()).toEqual(mockState);
  });

  it("load(null) clears state", () => {
    const store = new StateStore();
    store.write(mockState);
    store.load(null);
    expect(store.current()).toBeNull();
  });
});
