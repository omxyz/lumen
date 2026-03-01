/** Append-only within-session memory. Written by the model via the memorize action.
 *  Survives history compaction — re-injected from this store every step. */
export class FactStore {
  private facts: string[] = [];

  memorize(fact: string): void {
    if (!this.facts.includes(fact)) {
      this.facts.push(fact);
    }
  }

  forget(fact: string): void {
    this.facts = this.facts.filter((f) => f !== fact);
  }

  all(): string[] {
    return [...this.facts];
  }

  toContextString(): string {
    if (this.facts.length === 0) return "";
    return "Memory:\n" + this.facts.map((f) => `- ${f}`).join("\n");
  }

  load(facts: string[]): void {
    this.facts = [...facts];
  }
}
