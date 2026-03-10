import type { BrowserTab } from "../browser/tab";
import type { TaskState } from "../types";

export interface BrowserCheckpoint {
  step: number;
  url: string;
  agentState: TaskState | null;
  scrollY: number;
}

/**
 * Manages lightweight browser state checkpoints.
 * On stuck detection, can restore to a previous checkpoint instead of just nudging.
 */
export class CheckpointManager {
  private checkpoints: BrowserCheckpoint[] = [];
  private readonly maxCheckpoints: number;
  readonly interval: number;

  constructor(opts?: { interval?: number; maxCheckpoints?: number }) {
    this.interval = opts?.interval ?? 5;
    this.maxCheckpoints = opts?.maxCheckpoints ?? 10;
  }

  /**
   * Save current browser state as a checkpoint.
   */
  async save(step: number, url: string, agentState: TaskState | null, tab: BrowserTab): Promise<void> {
    let scrollY = 0;
    try {
      scrollY = await tab.evaluate<number>("window.scrollY || 0");
    } catch {
      // CDP eval can fail
    }

    this.checkpoints.push({
      step,
      url,
      agentState: agentState ? { ...agentState } : null,
      scrollY,
    });

    // Cap at max
    if (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints = this.checkpoints.slice(-this.maxCheckpoints);
    }
  }

  /**
   * Restore browser to the latest checkpoint (or one before targetStep).
   * Returns the checkpoint so caller can restore agentState.
   */
  async restore(tab: BrowserTab, targetStep?: number): Promise<BrowserCheckpoint | null> {
    if (this.checkpoints.length === 0) return null;

    let checkpoint: BrowserCheckpoint | undefined;
    if (targetStep !== undefined) {
      // Find the latest checkpoint at or before targetStep
      for (let i = this.checkpoints.length - 1; i >= 0; i--) {
        if (this.checkpoints[i]!.step <= targetStep) {
          checkpoint = this.checkpoints[i];
          break;
        }
      }
    } else {
      // Use the most recent checkpoint that isn't the very latest step
      // (otherwise we'd restore to where we already are)
      checkpoint = this.checkpoints.length >= 2
        ? this.checkpoints[this.checkpoints.length - 2]
        : this.checkpoints[0];
    }

    if (!checkpoint) return null;

    // Navigate to checkpoint URL
    try {
      await tab.goto(checkpoint.url);
      // Restore scroll position
      if (checkpoint.scrollY > 0) {
        await tab.evaluate<void>(`window.scrollTo(0, ${checkpoint.scrollY})`);
      }
    } catch {
      // Navigation can fail if URL is no longer valid
    }

    // Remove checkpoints after the restored one (they're now invalid)
    const restoreIdx = this.checkpoints.indexOf(checkpoint);
    if (restoreIdx >= 0) {
      this.checkpoints = this.checkpoints.slice(0, restoreIdx + 1);
    }

    return checkpoint;
  }

  latest(): BrowserCheckpoint | null {
    return this.checkpoints[this.checkpoints.length - 1] ?? null;
  }

  count(): number {
    return this.checkpoints.length;
  }
}
