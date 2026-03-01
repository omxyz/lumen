import { describe, it, expect } from "vitest";
import { FactStore } from "../../src/loop/facts.js";

describe("FactStore", () => {
  it("memorizes a fact", () => {
    const store = new FactStore();
    store.memorize("Paris is the capital of France");
    expect(store.all()).toContain("Paris is the capital of France");
  });

  it("deduplicates facts", () => {
    const store = new FactStore();
    store.memorize("same fact");
    store.memorize("same fact");
    expect(store.all()).toHaveLength(1);
  });

  it("forgets a fact", () => {
    const store = new FactStore();
    store.memorize("to forget");
    store.memorize("to keep");
    store.forget("to forget");
    expect(store.all()).not.toContain("to forget");
    expect(store.all()).toContain("to keep");
  });

  it("toContextString returns empty for empty store", () => {
    const store = new FactStore();
    expect(store.toContextString()).toBe("");
  });

  it("toContextString formats facts correctly", () => {
    const store = new FactStore();
    store.memorize("fact one");
    store.memorize("fact two");
    const str = store.toContextString();
    expect(str).toContain("Memory:");
    expect(str).toContain("- fact one");
    expect(str).toContain("- fact two");
  });

  it("load replaces all facts", () => {
    const store = new FactStore();
    store.memorize("old fact");
    store.load(["new fact 1", "new fact 2"]);
    expect(store.all()).toEqual(["new fact 1", "new fact 2"]);
  });
});
