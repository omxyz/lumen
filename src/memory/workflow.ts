import { readFileSync, writeFileSync } from "fs";
import type { SemanticStep, Action } from "../types";

export interface Workflow {
  name: string;
  /** Pipe-separated trigger keywords: "book flight|search flight|find flights" */
  trigger: string;
  /** Human-readable step descriptions */
  steps: string[];
  /** Primary domain */
  domain: string;
  /** Number of times this workflow led to success */
  successCount: number;
}

/**
 * AWM-inspired workflow memory.
 * Stores reusable multi-step routines extracted from successful runs.
 * On similar tasks, injects the workflow as a suggested plan.
 */
export class WorkflowMemory {
  private workflows: Workflow[];

  constructor(workflows?: Workflow[]) {
    this.workflows = workflows ?? [];
  }

  static fromFile(path: string): WorkflowMemory {
    try {
      const data = JSON.parse(readFileSync(path, "utf-8")) as Workflow[];
      return new WorkflowMemory(data);
    } catch {
      return new WorkflowMemory();
    }
  }

  /**
   * Find the best matching workflow for a given instruction.
   */
  match(instruction: string, url?: string): Workflow | null {
    const lower = instruction.toLowerCase();
    let bestMatch: Workflow | null = null;
    let bestScore = 0;

    for (const wf of this.workflows) {
      const triggers = wf.trigger.split("|").map((t) => t.trim().toLowerCase());
      let score = 0;

      for (const trigger of triggers) {
        if (lower.includes(trigger)) {
          score += trigger.length; // longer matches score higher
        }
      }

      // Bonus for domain match
      if (url && score > 0) {
        try {
          const hostname = new URL(url).hostname;
          if (hostname.includes(wf.domain)) {
            score += 10;
          }
        } catch {
          // URL parsing can fail
        }
      }

      // Bonus for past success
      score += Math.min(wf.successCount, 5);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = wf;
      }
    }

    return bestMatch;
  }

  /**
   * Format a matched workflow as a system prompt hint.
   */
  toPromptHint(workflow: Workflow): string {
    const steps = workflow.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    return (
      `SUGGESTED WORKFLOW (from past success on "${workflow.name}"):\n` +
      `${steps}\n` +
      `This is a suggestion — adapt as needed for the current task.`
    );
  }

  /**
   * Extract a workflow from a successful run's semantic history.
   */
  static extract(instruction: string, history: SemanticStep[], domain?: string): Workflow | null {
    if (history.length < 3) return null;

    const steps: string[] = [];
    let lastActionType = "";

    for (const step of history) {
      for (const { action } of step.actions) {
        const desc = describeAction(action, step.url);
        // Compress consecutive same-type actions
        if (action.type === lastActionType && (action.type === "scroll" || action.type === "wait")) {
          continue;
        }
        if (desc) {
          steps.push(desc);
          lastActionType = action.type;
        }
      }
    }

    if (steps.length < 2) return null;

    // Extract trigger keywords from instruction (first 3-4 significant words)
    const triggerWords = instruction
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
      .slice(0, 4);

    const trigger = triggerWords.join(" ");
    if (!trigger) return null;

    // Extract domain from most common URL
    let primaryDomain = domain ?? "";
    if (!primaryDomain) {
      const domains = history.map((s) => {
        try { return new URL(s.url).hostname; } catch { return ""; }
      }).filter(Boolean);
      primaryDomain = mode(domains) ?? "";
    }

    return {
      name: instruction.slice(0, 60),
      trigger,
      steps: steps.slice(0, 15), // cap at 15 steps
      domain: primaryDomain,
      successCount: 1,
    };
  }

  add(workflow: Workflow): void {
    // Check for existing similar workflow
    const existing = this.workflows.find(
      (w) => w.domain === workflow.domain && w.trigger === workflow.trigger,
    );
    if (existing) {
      existing.successCount++;
      // Update steps if the new workflow is shorter (more efficient)
      if (workflow.steps.length < existing.steps.length) {
        existing.steps = workflow.steps;
      }
    } else {
      this.workflows.push(workflow);
    }
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.workflows, null, 2), "utf-8");
  }

  toJSON(): Workflow[] {
    return this.workflows;
  }
}

/** Describe an action in human-readable form */
function describeAction(action: Action, url: string): string | null {
  switch (action.type) {
    case "click":
      return `Click at (${action.x}, ${action.y})`;
    case "type":
      return `Type "${action.text.slice(0, 30)}"`;
    case "keyPress":
      return `Press ${action.keys.join("+")}`;
    case "goto": {
      let domain = action.url;
      try { domain = new URL(action.url).hostname; } catch { /* keep full URL */ }
      return `Navigate to ${domain}`;
    }
    case "scroll":
      return `Scroll ${action.direction}`;
    case "writeState":
      return `Save progress`;
    case "terminate":
      return null; // Don't include in workflow
    case "wait":
      return null;
    case "screenshot":
      return null;
    default:
      return action.type;
  }
}

/** Find most common element in array */
function mode(arr: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const item of arr) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [item, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = item;
    }
  }
  return best;
}

const STOP_WORDS = new Set([
  "the", "this", "that", "what", "which", "where", "when", "how",
  "from", "with", "into", "about", "than", "then", "them", "their",
  "have", "been", "will", "would", "could", "should", "does",
  "find", "show", "tell", "give", "make", "take", "look",
]);
