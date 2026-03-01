import type { TaskState } from "../types.js";

/** Last-write-wins structured task progress artifact.
 *  Written by the model via writeState. Re-injected every step from this store —
 *  never from history — so it survives compaction. */
export class StateStore {
  private state: TaskState | null = null;

  current(): TaskState | null {
    return this.state ? { ...this.state } : null;
  }

  write(state: TaskState): void {
    this.state = { ...state };
  }

  toContextString(): string {
    if (!this.state) return "";
    const s = this.state;
    const lines = [
      "Current Task State:",
      `  URL: ${s.currentUrl}`,
      `  Completed: ${JSON.stringify(s.completedSteps)}`,
      `  Next: ${s.nextStep}`,
    ];
    if (s.blockers.length > 0) {
      lines.push(`  Blockers: ${JSON.stringify(s.blockers)}`);
    }
    if (Object.keys(s.data).length > 0) {
      lines.push(`  Data: ${JSON.stringify(s.data)}`);
    }
    return lines.join("\n");
  }

  load(state: TaskState | null): void {
    this.state = state ? { ...state } : null;
  }
}
