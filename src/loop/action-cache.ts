import { createHash } from "crypto";
import { promises as fs } from "fs";
import { join } from "path";
import type { Action } from "../types.js";

const COORD_ACTIONS = new Set(["click", "doubleClick", "hover", "scroll", "drag"]);
const SIMILARITY_THRESHOLD = 0.92;

export interface CachedAction {
  version: 1;
  type: Action["type"];
  url: string;
  instructionHash: string;
  screenshotHash?: string;
  args: Record<string, unknown>;
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
  ): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const entry: CachedAction = {
      version: 1,
      type: action.type,
      url,
      instructionHash,
      screenshotHash: COORD_ACTIONS.has(action.type) ? currentScreenshotHash : undefined,
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
