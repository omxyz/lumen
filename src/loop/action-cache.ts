import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import type { Action } from "../types";

const COORD_ACTIONS = new Set(["click", "doubleClick", "hover", "scroll", "drag"]);
const SIMILARITY_THRESHOLD = 0.92;

export interface CachedAction {
  version: 1;
  type: Action["type"];
  url: string;
  instructionHash: string;
  screenshotHash?: string;
  viewport?: { width: number; height: number };
  args: Record<string, unknown>;
}

export function viewportMismatch(
  cached: CachedAction,
  current: { width: number; height: number },
): boolean {
  if (!cached.viewport) return false;
  return cached.viewport.width !== current.width || cached.viewport.height !== current.height;
}

export class ActionCache {
  private readonly dir: string;

  constructor(cacheDir = ".lumen-cache") {
    this.dir = cacheDir;
  }

  cacheKey(actionType: string, url: string, instructionHash: string): string {
    const sig = `${actionType}:${url}:${instructionHash}`;
    return createHash("sha256").update(sig).digest("hex").slice(0, 16);
  }

  /** Step-level cache key: url + instructionHash only (no action type, no screenshot hash).
   *  Solves the chicken-and-egg problem (don't know action type before lookup).
   *  Self-healing handles the case where the cached action is wrong for the current page state. */
  stepKey(url: string, instructionHash: string): string {
    const sig = `${url}:${instructionHash}`;
    return createHash("sha256").update(sig).digest("hex").slice(0, 16);
  }

  async get(key: string, currentScreenshotHash?: string): Promise<CachedAction | null> {
    try {
      const raw = await fs.readFile(join(this.dir, `${key}.json`), "utf8");
      const entry: CachedAction = JSON.parse(raw);
      if (entry.version !== 1) return null;
      // For coordinate actions, validate layout hasn't shifted
      if (entry.screenshotHash && currentScreenshotHash) {
        if (similarity(entry.screenshotHash, currentScreenshotHash) < SIMILARITY_THRESHOLD) {
          return null;
        }
      }
      return entry;
    } catch {
      return null;
    }
  }

  async set(
    key: string,
    action: Action,
    url: string,
    instructionHash: string,
    currentScreenshotHash?: string,
    viewport?: { width: number; height: number },
  ): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const entry: CachedAction = {
      version: 1,
      type: action.type,
      url,
      instructionHash,
      screenshotHash: COORD_ACTIONS.has(action.type) ? currentScreenshotHash : undefined,
      viewport,
      args: action as unknown as Record<string, unknown>,
    };
    await fs.writeFile(join(this.dir, `${key}.json`), JSON.stringify(entry));
  }
}

/**
 * Exact-match hash comparison stub.
 * Replace with a real perceptual hash (block-DCT via sharp) for fuzzy matching
 * across minor rendering differences.
 */
function similarity(a: string, b: string): number {
  return a === b ? 1.0 : 0.0;
}

export function screenshotHash(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
