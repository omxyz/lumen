import type { TaskState } from "../types";

/** Last-write-wins agent memory. Written by the model via writeState.
 *  Re-injected every step — survives history compaction. */
export class StateStore {
  private data: TaskState | null = null;

  current(): TaskState | null {
    return this.data ? { ...this.data } : null;
  }

  write(data: TaskState): void {
    this.data = { ...data };
  }

  load(data: TaskState | null): void {
    this.data = data ? { ...data } : null;
  }
}
