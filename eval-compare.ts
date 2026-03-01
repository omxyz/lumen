#!/usr/bin/env node
/**
 * eval-compare.ts — Lumen vs Stagehand-style comprehensive benchmark
 *
 * Measures across two adapters on 8 real-world tasks:
 *   LumenCUAAdapter     — computer_20251124 + screenshot compression after keepRecent steps
 *   StagehandCUAAdapter — computer_20251124, full history, never compresses (mirrors Stagehand V3)
 *
 * Dimensions measured:
 *   • Token efficiency  — input, output, cache, total; per-step average
 *   • Time              — total, per-step average
 *   • Actions           — count, breakdown by type, actions-per-step
 *   • Cost              — estimated USD at Anthropic list prices
 *   • Success           — pass/fail with partial credit scores
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx eval-compare.ts              # all 8 tasks
 *   ANTHROPIC_API_KEY=... npx tsx eval-compare.ts wikipedia    # task filter
 *   ANTHROPIC_API_KEY=... npx tsx eval-compare.ts --lumen-only # skip stagehand-style
 */

import Anthropic from "@anthropic-ai/sdk";
import { CdpConnection } from "./src/browser/cdp.js";
import { CDPTab } from "./src/browser/cdptab.js";
import { ViewportManager } from "./src/browser/viewport.js";
import { launchChrome } from "./src/browser/launch/local.js";
import { ActionDecoder } from "./src/model/decoder.js";
import { ActionRouter } from "./src/loop/router.js";
import { FactStore } from "./src/loop/facts.js";
import { StateStore } from "./src/loop/state.js";
import type { CUAAction } from "./src/types.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first");
  process.exit(1);
}

const MODEL = "claude-sonnet-4-6";
const PORT = 9444;
const KEEP_RECENT = 2;
const decoder = new ActionDecoder();

// Anthropic claude-sonnet-4-6 pricing (as of early 2026)
const PRICE_INPUT_PER_M = 3.00;    // $3.00 / 1M input tokens
const PRICE_OUTPUT_PER_M = 15.00;  // $15.00 / 1M output tokens
const PRICE_CACHE_PER_M = 0.30;    // $0.30 / 1M cache-read tokens

// ─── Task definitions ──────────────────────────────────────────────────────────

interface EvalTask {
  name: string;
  url: string;
  instruction: string;
  maxSteps: number;
  /** Returns 0.0 (fail), 0.5 (partial), or 1.0 (full) */
  score(result: string, status: string, finalUrl?: string): number;
  /** Brief description of what success looks like */
  successCriteria: string;
}

const TASKS: EvalTask[] = [
  // ── Short tasks (1-5 steps expected) ────────────────────────────────────────
  {
    name: "hacker_news_top",
    url: "https://news.ycombinator.com",
    instruction: "On Hacker News, find the title of the #1 ranked story right now. Call terminate with the title.",
    maxSteps: 10,
    successCriteria: "Non-empty story title returned",
    score: (r, s) => (s === "success" && r.trim().length > 5 ? 1.0 : 0),
  },
  {
    name: "github_react_version",
    url: "https://github.com/facebook/react",
    instruction:
      "On github.com/facebook/react, find the latest stable release version of React. Call terminate with the version number (e.g. 'v19.0.0').",
    maxSteps: 12,
    successCriteria: "Version number like v18.x or v19.x",
    score: (r, s) => {
      if (s !== "success") return 0;
      return /v?\d+\.\d+(\.\d+)?/.test(r) ? 1.0 : 0.3;
    },
  },
  // ── Medium tasks (5-12 steps expected) ──────────────────────────────────────
  {
    name: "wikipedia_shannon",
    url: "https://en.wikipedia.org/wiki/Main_Page",
    instruction:
      "Search Wikipedia for 'Claude Shannon'. Find his birth year and birth city. Call terminate with 'year, city'.",
    maxSteps: 15,
    successCriteria: "1916 and Petoskey in result",
    score: (r, s) => {
      if (s !== "success") return 0;
      const has1916 = r.includes("1916");
      const hasPetoskey = r.toLowerCase().includes("petoskey");
      if (has1916 && hasPetoskey) return 1.0;
      if (has1916) return 0.7;
      return 0.2;
    },
  },
  {
    name: "arxiv_gpt4_report",
    url: "https://arxiv.org/",
    instruction:
      "On arxiv.org, find the paper 'GPT-4 Technical Report'. What date was version 3 (v3) submitted? Call terminate with the date.",
    maxSteps: 15,
    successCriteria: "Date '03-27-2023' or 'March 27, 2023'",
    score: (r, s) => {
      if (s !== "success") return 0;
      const lower = r.toLowerCase().replace(/-/g, " ");
      // Accept various date formats for March 27, 2023
      const isCorrect =
        r.includes("03-27-2023") ||
        r.includes("03/27/2023") ||
        lower.includes("march 27, 2023") ||
        lower.includes("march 27 2023") ||
        lower.includes("27 march 2023") ||
        (lower.includes("march 27") && lower.includes("2023")) ||
        (r.includes("27") && lower.includes("march") && r.includes("2023"));
      return isCorrect ? 1.0 : (r.includes("2023") ? 0.3 : 0.1);
    },
  },
  {
    name: "huggingface_top_model",
    url: "https://huggingface.co/models",
    instruction:
      "On HuggingFace, filter models by Apache-2.0 license and sort by most likes. What is the top-liked model name? Call terminate with the model name.",
    maxSteps: 15,
    successCriteria: "Model name contains 'kokoro', 'Kokoro', or 'hexgrad'",
    score: (r, s) => {
      if (s !== "success") return 0;
      const lower = r.toLowerCase();
      // Known answer: hexgrad/Kokoro-82M (may change over time)
      if (lower.includes("kokoro") || lower.includes("hexgrad")) return 1.0;
      // Partial: got a valid model name (username/modelname format)
      if (/[a-z0-9_-]+\/[a-z0-9_-]+/i.test(r)) return 0.5;
      return 0.2;
    },
  },
  // ── Long tasks (10-20 steps expected) ───────────────────────────────────────
  {
    name: "allrecipes_wellington",
    url: "https://www.allrecipes.com",
    instruction:
      "On allrecipes.com, search for 'Beef Wellington'. Find a highly-rated recipe (4+ stars, 100+ reviews). List the top 5 main ingredients. Call terminate with the ingredient list.",
    maxSteps: 20,
    successCriteria: "Result mentions beef tenderloin AND pastry/puff",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const hasBeef = l.includes("beef") || l.includes("tenderloin") || l.includes("filet");
      const hasPastry =
        l.includes("pastry") || l.includes("puff") || l.includes("dough") || l.includes("croissant");
      const hasMushroom = l.includes("mushroom") || l.includes("duxelle");
      if (hasBeef && hasPastry && hasMushroom) return 1.0;
      if (hasBeef && hasPastry) return 0.8;
      if (hasBeef || hasPastry) return 0.4;
      return r.trim().length > 15 ? 0.2 : 0;
    },
  },
  {
    name: "google_flights_sf_ny",
    url: "https://www.google.com/travel/flights",
    instruction:
      "On google.com/travel/flights, search for one-way flights from San Francisco (SFO) to New York (JFK or LGA or EWR) departing next Saturday. Find the cheapest non-stop option and report the airline and price. Call terminate with 'Airline: X, Price: $Y'.",
    maxSteps: 20,
    successCriteria: "Result mentions an airline name and a price",
    score: (r, s) => {
      if (s !== "success") return 0;
      const lower = r.toLowerCase();
      const hasAirline =
        lower.includes("united") || lower.includes("delta") || lower.includes("american") ||
        lower.includes("southwest") || lower.includes("alaska") || lower.includes("jetblue") ||
        lower.includes("frontier") || lower.includes("spirit") || lower.includes("airline");
      const hasPrice = /\$\d+|\d+\s*usd/i.test(r);
      if (hasAirline && hasPrice) return 1.0;
      if (hasAirline || hasPrice) return 0.5;
      return lower.includes("flight") ? 0.3 : 0;
    },
  },
  {
    name: "steam_top_players",
    url: "https://store.steampowered.com/charts/mostplayed",
    instruction:
      "On store.steampowered.com/charts/mostplayed, find the #1 and #2 games by current player count. Call terminate with 'Game1: X (N players), Game2: Y (M players)'.",
    maxSteps: 12,
    successCriteria: "Two game names and player counts returned",
    score: (r, s) => {
      if (s !== "success") return 0;
      // Should contain two game names and some numbers
      const hasNumbers = /\d[\d,]+/.test(r);
      const hasColon = r.includes(":") || r.toLowerCase().includes("player");
      // Known top games (fluctuates): CS2, Dota 2, PUBG, etc.
      const commonGames = ["counter-strike", "cs2", "dota", "pubg", "path of exile",
        "baldur", "elden ring", "apex", "rust", "ark", "grand theft", "gta"];
      const hasKnownGame = commonGames.some((g) => r.toLowerCase().includes(g));
      if (hasNumbers && hasColon) return hasKnownGame ? 1.0 : 0.8;
      if (hasNumbers || hasColon) return 0.4;
      return r.trim().length > 10 ? 0.2 : 0;
    },
  },

  // ── Extended tasks from Stagehand eval suite ─────────────────────────────────
  {
    name: "trivago_madrid",
    url: "https://www.trivago.com",
    instruction:
      "On trivago.com, search for the hotel 'H10 Tribeca' in Madrid for next weekend (2 nights). Find and report the cheapest room price shown. Call terminate with 'Hotel: H10 Tribeca Madrid, Cheapest rate: $X/night' (fill in the actual price).",
    maxSteps: 20,
    successCriteria: "Result mentions H10 Tribeca or Madrid and a price",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const hasHotel = l.includes("h10") || l.includes("tribeca") || l.includes("madrid");
      const hasPrice = /\$\d+|€\d+|\d+\s*(usd|eur|per night)/i.test(r);
      if (hasHotel && hasPrice) return 1.0;
      if (hasHotel || hasPrice) return 0.5;
      return l.includes("hotel") || l.includes("room") ? 0.2 : 0;
    },
  },
  {
    name: "nba_trades",
    url: "https://www.espn.com",
    instruction:
      "On espn.com, navigate to NBA transactions (Scores > NBA > More > Transactions, or search for 'NBA transactions'). Find the most recent team transaction (trade, signing, or waiver) from the past week. Call terminate with the transaction details, e.g. 'Player X signed/traded/waived by Team Y'.",
    maxSteps: 25,
    successCriteria: "Result mentions an NBA team name and a transaction type",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const nbaTeams = ["lakers", "celtics", "warriors", "nets", "heat", "bulls", "knicks",
        "bucks", "suns", "nuggets", "clippers", "76ers", "raptors", "hawks", "mavs",
        "mavericks", "jazz", "spurs", "thunder", "blazers", "kings", "hornets", "pistons",
        "cavaliers", "magic", "pelicans", "rockets", "timberwolves", "pacers", "grizzlies"];
      const transactionWords = ["signed", "traded", "waived", "acquired", "released",
        "claimed", "converted", "drafted", "exercised", "declined", "two-way"];
      const hasTeam = nbaTeams.some((t) => l.includes(t));
      const hasTransaction = transactionWords.some((w) => l.includes(w));
      if (hasTeam && hasTransaction) return 1.0;
      if (hasTeam || hasTransaction) return 0.5;
      return l.includes("nba") || l.includes("basketball") ? 0.2 : 0;
    },
  },
  {
    name: "columbia_tuition",
    url: "https://columbia.edu",
    instruction:
      "On columbia.edu, use the search functionality to find the tuition and fees page for undergraduate programs. Report the annual tuition cost. Call terminate with 'Columbia undergraduate tuition: $X per year'.",
    maxSteps: 30,
    successCriteria: "Result mentions a dollar amount for Columbia undergraduate tuition",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const hasDollarAmount = /\$[\d,]+/.test(r);
      const hasTuition = l.includes("tuition") || l.includes("fee");
      const hasUndergrad = l.includes("undergrad") || l.includes("columbia");
      if (hasDollarAmount && hasTuition && hasUndergrad) return 1.0;
      if (hasDollarAmount && hasTuition) return 0.8;
      if (hasDollarAmount || hasTuition) return 0.3;
      return 0;
    },
  },
  {
    name: "instacart_bananas",
    url: "https://www.instacart.com",
    instruction:
      "On instacart.com, search for 'organic bananas'. List the top 3 results with their prices and retailer names. Call terminate with '1. [retailer]: $X.XX, 2. [retailer]: $X.XX, 3. [retailer]: $X.XX'.",
    maxSteps: 20,
    successCriteria: "Result mentions prices and at least one retailer name",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const hasPrice = /\$\d+\.\d{2}|\d+\.\d{2}\s*\$/.test(r);
      const retailers = ["kroger", "costco", "whole foods", "safeway", "publix", "walmart",
        "target", "sprouts", "trader joe", "aldi", "heb", "wegmans", "stop & shop"];
      const hasRetailer = retailers.some((r) => l.includes(r));
      const hasBanana = l.includes("banana");
      if (hasPrice && hasRetailer && hasBanana) return 1.0;
      if (hasPrice && (hasRetailer || hasBanana)) return 0.7;
      if (hasPrice || hasRetailer) return 0.3;
      return 0;
    },
  },
  {
    name: "webmd_ovulation",
    url: "https://www.webmd.com",
    instruction:
      "On webmd.com, find the ovulation calculator. Enter March 1 as the first day of the last menstrual period and calculate the ovulation date and fertile window. Call terminate with 'Ovulation date: [date], Fertile window: [start] to [end]'.",
    maxSteps: 20,
    successCriteria: "Result mentions an ovulation date in March",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const hasOvulation = l.includes("ovulation") || l.includes("ovulate") || l.includes("fertile");
      const hasMarchDate = /march\s+\d+|\d+\s+march|mar\s+\d+|\d+\/\d+/i.test(r);
      const hasDate = /\d{1,2}[\/-]\d{1,2}|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d+/i.test(r);
      if (hasOvulation && hasMarchDate) return 1.0;
      if (hasOvulation && hasDate) return 0.8;
      if (hasOvulation || hasDate) return 0.3;
      return 0;
    },
  },
  {
    name: "nvidia_hgx_driver",
    url: "https://nvidia.com",
    instruction:
      "On nvidia.com, find the driver download for HGX H100 GPU on Ubuntu 22.04 for AMD64 architecture. Report the driver version number and download information. Call terminate with 'HGX H100 Ubuntu 22.04 AMD64 driver: version X.Y.Z'.",
    maxSteps: 25,
    successCriteria: "Result mentions HGX H100 or a driver version number",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const hasProduct = l.includes("hgx") || l.includes("h100") || l.includes("nvidia");
      const hasVersion = /\d+\.\d+(\.\d+)?/.test(r);
      const hasDriverContext = l.includes("driver") || l.includes("ubuntu") || l.includes("download");
      if (hasProduct && hasVersion && hasDriverContext) return 1.0;
      if (hasProduct && (hasVersion || hasDriverContext)) return 0.7;
      if (hasProduct || hasDriverContext) return 0.3;
      return 0;
    },
  },
  {
    name: "kayak_tokyo",
    url: "https://www.kayak.com",
    instruction:
      "On kayak.com, search for one-way flights from San Francisco (SFO) to Tokyo (NRT or HND) departing next week. Sort by price and report the cheapest flight. Call terminate with 'Cheapest flight: [airline], $X, [duration]'.",
    maxSteps: 25,
    successCriteria: "Result mentions an airline name and a price for SFO-Tokyo",
    score: (r, s) => {
      if (s !== "success") return 0;
      const l = r.toLowerCase();
      const airlines = ["ana", "jal", "japan airlines", "united", "delta", "american",
        "alaska", "korean air", "cathay", "air canada", "china", "eva air"];
      const hasAirline = airlines.some((a) => l.includes(a));
      const hasPrice = /\$\d+|\d+\s*usd/i.test(r);
      const hasTokyo = l.includes("tokyo") || l.includes("nrt") || l.includes("hnd") || l.includes("narita") || l.includes("haneda");
      if (hasAirline && hasPrice && hasTokyo) return 1.0;
      if (hasAirline && hasPrice) return 0.8;
      if (hasAirline || hasPrice) return 0.4;
      return hasTokyo ? 0.2 : 0;
    },
  },
];

// ─── Types ──────────────────────────────────────────────────────────────────────

type ActionType = CUAAction["type"];

interface RunResult {
  task: string;
  adapter: string;
  status: string;
  result: string;
  steps: number;
  // Token metrics
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  avgInputTokensPerStep: number;
  avgTotalTokensPerStep: number;
  // Time metrics
  durationMs: number;
  avgTimePerStepMs: number;
  // Action metrics
  actionsExecuted: number;     // real actions (excl. screenshot/terminate)
  avgActionsPerStep: number;
  actionBreakdown: Partial<Record<ActionType, number>>;
  // Cost
  estimatedCostUSD: number;
  // Score
  score: number;
  error?: string;
}

interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

// ─── Shared tools & decoders ──────────────────────────────────────────────────

const TERMINATE_TOOL = {
  name: "terminate",
  description:
    "Signal that you have completed the task and provide the final answer. Call this as soon as you have the information requested.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["success", "failure"] },
      result: { type: "string", description: "Your final answer or reason for failure." },
    },
    required: ["status", "result"],
  },
} as const;

const MEMORIZE_TOOL = {
  name: "memorize",
  description: "Save an important fact to memory for later steps.",
  input_schema: {
    type: "object",
    properties: { fact: { type: "string" } },
    required: ["fact"],
  },
} as const;

function decodeBlocks(
  toolBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  viewport: { width: number; height: number },
): CUAAction[] {
  return toolBlocks.map((b): CUAAction => {
    if (b.name === "terminate") {
      return {
        type: "terminate",
        status: (b.input.status as "success" | "failure") ?? "success",
        result: (b.input.result as string) ?? "",
      };
    }
    if (b.name === "memorize") {
      return { type: "memorize", fact: b.input.fact as string };
    }
    return decoder.fromAnthropic(b, viewport);
  });
}

function estimateCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M +
    (cacheReadTokens / 1_000_000) * PRICE_CACHE_PER_M
  );
}

// ─── Lumen adapter (screenshot compression) ───────────────────────────────────

class LumenCUAAdapter {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private pendingToolIds: string[] = [];
  private totalTokens: TokenStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  private viewport = { width: 1344, height: 756 };
  private screenshotMsgIndex = new Map<number, number>();

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
    private readonly keepRecent = 2,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  reset(): void {
    this.messages = [];
    this.pendingToolIds = [];
    this.totalTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    this.screenshotMsgIndex.clear();
  }

  setViewport(w: number, h: number): void {
    this.viewport = { width: w, height: h };
  }

  getTokenStats(): TokenStats {
    return { ...this.totalTokens };
  }

  async callStep(
    stepIndex: number,
    screenshotData: Buffer,
    system: string,
  ): Promise<{ actions: CUAAction[]; usage: TokenStats }> {
    const userContent: Anthropic.MessageParam["content"] = [];
    for (const id of this.pendingToolIds) {
      userContent.push({
        type: "tool_result",
        tool_use_id: id,
        content: "Action completed successfully",
      } as unknown as Anthropic.ImageBlockParam);
    }
    this.pendingToolIds = [];
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: screenshotData.toString("base64") },
    } as Anthropic.ImageBlockParam);

    this.screenshotMsgIndex.set(stepIndex, this.messages.length);
    this.messages.push({ role: "user", content: userContent });

    const response = await this.client.beta.messages.create({
      model: this.modelId,
      max_tokens: 4096,
      system,
      messages: this.messages,
      tools: [
        {
          type: "computer_20251124" as "computer_20250124",
          name: "computer",
          display_width_px: this.viewport.width,
          display_height_px: this.viewport.height,
        },
        TERMINATE_TOOL,
        MEMORIZE_TOOL,
      ] as unknown as Anthropic.Beta.BetaToolUnion[],
      betas: ["computer-use-2025-11-24"],
    });

    this.messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlock[] });
    const toolBlocks = response.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
    }>;
    this.pendingToolIds = toolBlocks.map((b) => b.id);

    const actions = decodeBlocks(toolBlocks, this.viewport);
    if (actions.length === 0) actions.push({ type: "screenshot" });

    const step: TokenStats = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
    };
    this.totalTokens.inputTokens += step.inputTokens;
    this.totalTokens.outputTokens += step.outputTokens;
    this.totalTokens.cacheReadTokens += step.cacheReadTokens;
    return { actions, usage: step };
  }

  onStepDone(stepIndex: number): void {
    const compressUpTo = stepIndex - this.keepRecent;
    for (let s = 0; s <= compressUpTo; s++) {
      const msgIdx = this.screenshotMsgIndex.get(s);
      if (msgIdx === undefined) continue;
      const msg = this.messages[msgIdx];
      if (!msg || msg.role !== "user") continue;
      const arr = Array.isArray(msg.content) ? msg.content : [];
      for (let i = 0; i < arr.length; i++) {
        if ((arr[i] as { type: string }).type === "image") {
          arr[i] = {
            type: "text",
            text: `[screenshot step ${s + 1} — compressed]`,
          } as unknown as Anthropic.ImageBlockParam;
          break;
        }
      }
      this.screenshotMsgIndex.delete(s);
    }
  }
}

// ─── Stagehand-style adapter (full history, no compression) ───────────────────

class StagehandCUAAdapter {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private pendingToolIds: string[] = [];
  private totalTokens: TokenStats = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  private viewport = { width: 1344, height: 756 };

  constructor(
    private readonly apiKey: string,
    private readonly modelId: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  reset(): void {
    this.messages = [];
    this.pendingToolIds = [];
    this.totalTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  }

  setViewport(w: number, h: number): void {
    this.viewport = { width: w, height: h };
  }

  getTokenStats(): TokenStats {
    return { ...this.totalTokens };
  }

  async callStep(
    _stepIndex: number,
    screenshotData: Buffer,
    system: string,
  ): Promise<{ actions: CUAAction[]; usage: TokenStats }> {
    const userContent: Anthropic.MessageParam["content"] = [];
    for (const id of this.pendingToolIds) {
      userContent.push({
        type: "tool_result",
        tool_use_id: id,
        content: "Action completed successfully",
      } as unknown as Anthropic.ImageBlockParam);
    }
    this.pendingToolIds = [];
    userContent.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: screenshotData.toString("base64") },
    } as Anthropic.ImageBlockParam);

    this.messages.push({ role: "user", content: userContent });

    const response = await this.client.beta.messages.create({
      model: this.modelId,
      max_tokens: 4096,
      system,
      messages: this.messages,
      tools: [
        {
          type: "computer_20251124" as "computer_20250124",
          name: "computer",
          display_width_px: this.viewport.width,
          display_height_px: this.viewport.height,
        },
        TERMINATE_TOOL,
        MEMORIZE_TOOL,
      ] as unknown as Anthropic.Beta.BetaToolUnion[],
      betas: ["computer-use-2025-11-24"],
    });

    this.messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlock[] });
    const toolBlocks = response.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
    }>;
    this.pendingToolIds = toolBlocks.map((b) => b.id);

    const actions = decodeBlocks(toolBlocks, this.viewport);
    if (actions.length === 0) actions.push({ type: "screenshot" });

    const step: TokenStats = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
    };
    this.totalTokens.inputTokens += step.inputTokens;
    this.totalTokens.outputTokens += step.outputTokens;
    this.totalTokens.cacheReadTokens += step.cacheReadTokens;
    return { actions, usage: step };
  }

  // No compression
  onStepDone(_stepIndex: number): void {}
}

type AnyAdapter = LumenCUAAdapter | StagehandCUAAdapter;

// ─── Eval loop ─────────────────────────────────────────────────────────────────

const REAL_ACTIONS: ActionType[] = [
  "click", "doubleClick", "drag", "scroll", "type", "keyPress", "wait", "goto", "hover",
];

async function runEvalLoop(
  adapter: AnyAdapter,
  tab: CDPTab,
  task: EvalTask,
  adapterName: string,
): Promise<RunResult> {
  console.log(`  [${adapterName}] ${task.name}…`);
  const start = Date.now();

  const stepTimings: number[] = [];
  const actionBreakdown: Partial<Record<ActionType, number>> = {};
  let actionsExecuted = 0;

  const router = new ActionRouter();
  const facts = new FactStore();
  const state = new StateStore();

  const system = [
    `Task: ${task.instruction}`,
    "You are a computer use agent. Coordinates in the computer tool are pixel coordinates relative to the screenshot.",
    "Use the terminate tool as soon as you have the final answer. Use memorize to save key information.",
  ].join("\n\n");

  function countAction(type: ActionType): void {
    if (REAL_ACTIONS.includes(type)) {
      actionsExecuted++;
      actionBreakdown[type] = (actionBreakdown[type] ?? 0) + 1;
    }
  }

  try {
    for (let step = 0; step < task.maxSteps; step++) {
      const stepStart = Date.now();
      const screenshotResult = await tab.screenshot({ cursorOverlay: false });

      let stepResult: { actions: CUAAction[]; usage: TokenStats };
      try {
        stepResult = await adapter.callStep(step, screenshotResult.data, system);
      } catch (err) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        console.error(`    API error step ${step}: ${msg}`);
        return mkErrResult(task.name, adapterName, `API error: ${msg}`, step + 1,
          adapter.getTokenStats(), start, stepTimings, actionBreakdown, actionsExecuted);
      }

      let terminated = false;
      let terminateStatus = "";
      let terminateResult = "";

      for (const action of stepResult.actions) {
        countAction(action.type);
        if (action.type === "memorize") { facts.memorize(action.fact); continue; }
        if (action.type === "writeState") { state.write(action.state); continue; }
        if (action.type === "screenshot") { continue; }
        if (action.type === "terminate") {
          terminated = true;
          terminateStatus = action.status;
          terminateResult = action.result;
          break;
        }
        const outcome = await router.execute(action, tab, facts, state);
        if (outcome.terminated) {
          terminated = true;
          terminateStatus = outcome.status!;
          terminateResult = outcome.result!;
          break;
        }
      }

      adapter.onStepDone(step);
      stepTimings.push(Date.now() - stepStart);

      if (terminated) {
        const stepsUsed = step + 1;
        const tokens = adapter.getTokenStats();
        const durationMs = Date.now() - start;
        const score = task.score(terminateResult, terminateStatus, tab.url());
        console.log(
          `    → ${terminateStatus} (score=${score.toFixed(2)}) in ${stepsUsed} steps | ` +
            `${tokens.inputTokens.toLocaleString()}in/${tokens.outputTokens.toLocaleString()}out | ` +
            `${(durationMs / 1000).toFixed(1)}s`,
        );
        return mkResult(task.name, adapterName, terminateStatus, terminateResult,
          stepsUsed, tokens, durationMs, stepTimings, actionBreakdown, actionsExecuted, score);
      }
    }

    const tokens = adapter.getTokenStats();
    console.log(`    → maxSteps (${task.maxSteps})`);
    return mkResult(task.name, adapterName, "maxSteps", "", task.maxSteps,
      tokens, Date.now() - start, stepTimings, actionBreakdown, actionsExecuted, 0);
  } catch (err) {
    return mkErrResult(task.name, adapterName, String(err), 0,
      adapter.getTokenStats(), start, stepTimings, actionBreakdown, actionsExecuted);
  }
}

function mkResult(
  task: string, adapter: string, status: string, result: string, steps: number,
  tokens: TokenStats, durationMs: number, stepTimings: number[],
  actionBreakdown: Partial<Record<ActionType, number>>, actionsExecuted: number,
  score: number,
): RunResult {
  const totalTokens = tokens.inputTokens + tokens.outputTokens;
  return {
    task, adapter, status, result, steps,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    totalTokens,
    avgInputTokensPerStep: steps > 0 ? Math.round(tokens.inputTokens / steps) : 0,
    avgTotalTokensPerStep: steps > 0 ? Math.round(totalTokens / steps) : 0,
    durationMs,
    avgTimePerStepMs: stepTimings.length > 0
      ? Math.round(stepTimings.reduce((a, b) => a + b, 0) / stepTimings.length)
      : 0,
    actionsExecuted,
    avgActionsPerStep: steps > 0 ? +(actionsExecuted / steps).toFixed(2) : 0,
    actionBreakdown,
    estimatedCostUSD: estimateCost(tokens.inputTokens, tokens.outputTokens, tokens.cacheReadTokens),
    score,
  };
}

function mkErrResult(
  task: string, adapter: string, error: string, steps: number,
  tokens: TokenStats, start: number, stepTimings: number[],
  actionBreakdown: Partial<Record<ActionType, number>>, actionsExecuted: number,
): RunResult {
  return mkResult(task, adapter, "error", "", steps, tokens, Date.now() - start,
    stepTimings, actionBreakdown, actionsExecuted, 0);
}

// ─── Report ────────────────────────────────────────────────────────────────────

const W = 130;
const SEP = "═".repeat(W);
const sep = "─".repeat(W);
const sep2 = "·".repeat(W);

function pct(a: number, b: number): string {
  if (b === 0) return "  n/a";
  const v = ((b - a) / b) * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function bar(value: number, max: number, width = 20): string {
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function printReport(results: RunResult[], tasksRun: EvalTask[]): void {
  const lumen = (task: string) => results.find((r) => r.task === task && r.adapter === "lumen");
  const sh = (task: string) => results.find((r) => r.task === task && r.adapter === "stagehand-style");
  const lumenAll = results.filter((r) => r.adapter === "lumen");
  const shAll = results.filter((r) => r.adapter === "stagehand-style");

  console.log("\n" + SEP);
  console.log(" LUMEN vs STAGEHAND-STYLE  —  Comprehensive Benchmark");
  console.log(` Model: ${MODEL}  |  Tasks: ${tasksRun.length}  |  Screenshot keepRecent: ${KEEP_RECENT}`);
  console.log(SEP);

  // ── Section 1: Per-task overview ──────────────────────────────────────────
  console.log("\n▶  1. TASK OVERVIEW");
  console.log(sep);
  const h1 =
    `${"Task".padEnd(26)} ${"Adapter".padEnd(18)} ${"Status".padEnd(10)} ${"Steps".padEnd(7)} ` +
    `${"Score".padEnd(7)} ${"Total Tok".padEnd(12)} ${"Cost USD".padEnd(12)} ${"Time (s)".padEnd(10)} Result`;
  console.log(h1);
  console.log(sep2);

  for (const task of tasksRun) {
    for (const adp of ["lumen", "stagehand-style"]) {
      const r = results.find((x) => x.task === task.name && x.adapter === adp);
      if (!r) continue;
      const resultPreview = r.result.slice(0, 40).replace(/\n/g, " ");
      console.log(
        `${r.task.padEnd(26)} ${r.adapter.padEnd(18)} ${r.status.padEnd(10)} ${String(r.steps).padEnd(7)} ` +
          `${r.score.toFixed(2).padEnd(7)} ${r.totalTokens.toLocaleString().padEnd(12)} ` +
          `${usd(r.estimatedCostUSD).padEnd(12)} ${(r.durationMs / 1000).toFixed(1).padEnd(10)} ${resultPreview}`,
      );
    }
    const l = lumen(task.name);
    const s = sh(task.name);
    if (l && s && s.totalTokens > 0) {
      const saving = ((s.totalTokens - l.totalTokens) / s.totalTokens) * 100;
      const arrow = saving > 0 ? "▼" : saving < 0 ? "▲" : "=";
      console.log(
        `${"".padEnd(26)} ${"  token delta".padEnd(18)} Lumen ${arrow} ${Math.abs(saving).toFixed(1)}% tokens | ` +
          `${s.steps !== l.steps ? `steps: ${l.steps} vs ${s.steps}` : "same steps"} | ` +
          `time: ${(l.durationMs / 1000).toFixed(1)}s vs ${(s.durationMs / 1000).toFixed(1)}s`,
      );
    }
    console.log();
  }

  // ── Section 2: Token efficiency ────────────────────────────────────────────
  console.log(SEP);
  console.log("\n▶  2. TOKEN EFFICIENCY  (lower is better)");
  console.log(sep);
  console.log(
    `${"Task".padEnd(26)} ${"Adapter".padEnd(18)} ${"Input".padEnd(12)} ${"Output".padEnd(10)} ` +
      `${"Cache".padEnd(10)} ${"Total".padEnd(12)} ${"In/step".padEnd(10)} ${"Tot/step".padEnd(10)} Savings`,
  );
  console.log(sep2);

  for (const task of tasksRun) {
    for (const adp of ["lumen", "stagehand-style"]) {
      const r = results.find((x) => x.task === task.name && x.adapter === adp);
      if (!r) continue;
      const savStr = adp === "lumen" && sh(task.name)
        ? pct(r.totalTokens, sh(task.name)!.totalTokens)
        : "";
      console.log(
        `${r.task.padEnd(26)} ${r.adapter.padEnd(18)} ${r.inputTokens.toLocaleString().padEnd(12)} ` +
          `${r.outputTokens.toLocaleString().padEnd(10)} ${r.cacheReadTokens.toLocaleString().padEnd(10)} ` +
          `${r.totalTokens.toLocaleString().padEnd(12)} ${r.avgInputTokensPerStep.toLocaleString().padEnd(10)} ` +
          `${r.avgTotalTokensPerStep.toLocaleString().padEnd(10)} ${savStr}`,
      );
    }
    console.log();
  }

  // ── Section 3: Speed & timing ──────────────────────────────────────────────
  console.log(SEP);
  console.log("\n▶  3. SPEED & TIMING  (lower is better)");
  console.log(sep);
  console.log(
    `${"Task".padEnd(26)} ${"Adapter".padEnd(18)} ${"Total (s)".padEnd(12)} ${"Steps".padEnd(8)} ` +
      `${"Avg s/step".padEnd(12)} Time bar`,
  );
  console.log(sep2);

  const maxDuration = Math.max(...results.map((r) => r.durationMs));
  for (const task of tasksRun) {
    for (const adp of ["lumen", "stagehand-style"]) {
      const r = results.find((x) => x.task === task.name && x.adapter === adp);
      if (!r) continue;
      const barStr = bar(r.durationMs, maxDuration, 30);
      console.log(
        `${r.task.padEnd(26)} ${r.adapter.padEnd(18)} ${(r.durationMs / 1000).toFixed(1).padEnd(12)} ` +
          `${String(r.steps).padEnd(8)} ${(r.avgTimePerStepMs / 1000).toFixed(2).padEnd(12)} ${barStr}`,
      );
    }
    console.log();
  }

  // ── Section 4: Action analysis ─────────────────────────────────────────────
  console.log(SEP);
  console.log("\n▶  4. ACTION ANALYSIS");
  console.log(sep);
  console.log(
    `${"Task".padEnd(26)} ${"Adapter".padEnd(18)} ${"Total".padEnd(8)} ${"Per step".padEnd(10)} ` +
      `Click  Scroll Type   Key    Goto   Other`,
  );
  console.log(sep2);

  for (const task of tasksRun) {
    for (const adp of ["lumen", "stagehand-style"]) {
      const r = results.find((x) => x.task === task.name && x.adapter === adp);
      if (!r) continue;
      const b = r.actionBreakdown;
      const click = ((b.click ?? 0) + (b.doubleClick ?? 0)).toString().padEnd(7);
      const scroll = (b.scroll ?? 0).toString().padEnd(7);
      const type = (b.type ?? 0).toString().padEnd(7);
      const key = (b.keyPress ?? 0).toString().padEnd(7);
      const goto = (b.goto ?? 0).toString().padEnd(7);
      const other = (Object.entries(b)
        .filter(([k]) => !["click","doubleClick","scroll","type","keyPress","goto"].includes(k))
        .reduce((s, [, v]) => s + v, 0)).toString();
      console.log(
        `${r.task.padEnd(26)} ${r.adapter.padEnd(18)} ${r.actionsExecuted.toString().padEnd(8)} ` +
          `${r.avgActionsPerStep.toFixed(2).padEnd(10)} ${click}${scroll}${type}${key}${goto}${other}`,
      );
    }
    console.log();
  }

  // ── Section 5: Cost breakdown ──────────────────────────────────────────────
  console.log(SEP);
  console.log("\n▶  5. COST BREAKDOWN  (Anthropic list prices)");
  console.log(`   Input: $${PRICE_INPUT_PER_M}/1M  |  Output: $${PRICE_OUTPUT_PER_M}/1M  |  Cache read: $${PRICE_CACHE_PER_M}/1M`);
  console.log(sep);
  console.log(
    `${"Task".padEnd(26)} ${"Adapter".padEnd(18)} ${"Est. USD".padEnd(12)} ${"$/step".padEnd(12)} Savings vs SH-style`,
  );
  console.log(sep2);

  const maxCost = Math.max(...results.map((r) => r.estimatedCostUSD));
  for (const task of tasksRun) {
    for (const adp of ["lumen", "stagehand-style"]) {
      const r = results.find((x) => x.task === task.name && x.adapter === adp);
      if (!r) continue;
      const costPerStep = r.steps > 0 ? r.estimatedCostUSD / r.steps : 0;
      const savStr = adp === "lumen" && sh(task.name)
        ? pct(r.estimatedCostUSD, sh(task.name)!.estimatedCostUSD)
        : "";
      console.log(
        `${r.task.padEnd(26)} ${r.adapter.padEnd(18)} ${usd(r.estimatedCostUSD).padEnd(12)} ` +
          `${usd(costPerStep).padEnd(12)} ${savStr}`,
      );
    }
    console.log();
  }

  // ── Section 6: Aggregate summary ──────────────────────────────────────────
  console.log(SEP);
  console.log("\n▶  6. AGGREGATE SUMMARY");
  console.log(sep);

  function agg(arr: RunResult[]) {
    return {
      passed: arr.filter((r) => r.score >= 0.5).length,
      total: arr.length,
      avgScore: arr.reduce((s, r) => s + r.score, 0) / (arr.length || 1),
      inputTokens: arr.reduce((s, r) => s + r.inputTokens, 0),
      outputTokens: arr.reduce((s, r) => s + r.outputTokens, 0),
      cacheReadTokens: arr.reduce((s, r) => s + r.cacheReadTokens, 0),
      totalTokens: arr.reduce((s, r) => s + r.totalTokens, 0),
      durationMs: arr.reduce((s, r) => s + r.durationMs, 0),
      costUSD: arr.reduce((s, r) => s + r.estimatedCostUSD, 0),
      actionsExecuted: arr.reduce((s, r) => s + r.actionsExecuted, 0),
    };
  }

  const la = agg(lumenAll);
  const sa = agg(shAll);

  const rows: [string, string, string][] = [
    ["Pass rate", `${la.passed}/${la.total} (${(la.avgScore * 100).toFixed(0)}% avg score)`, `${sa.passed}/${sa.total} (${(sa.avgScore * 100).toFixed(0)}% avg score)`],
    ["Input tokens", la.inputTokens.toLocaleString(), sa.inputTokens.toLocaleString()],
    ["Output tokens", la.outputTokens.toLocaleString(), sa.outputTokens.toLocaleString()],
    ["Cache read", la.cacheReadTokens.toLocaleString(), sa.cacheReadTokens.toLocaleString()],
    ["TOTAL tokens", la.totalTokens.toLocaleString(), sa.totalTokens.toLocaleString()],
    ["Estimated cost", usd(la.costUSD), usd(sa.costUSD)],
    ["Total time", `${(la.durationMs / 1000).toFixed(1)}s`, `${(sa.durationMs / 1000).toFixed(1)}s`],
    ["Actions executed", la.actionsExecuted.toString(), sa.actionsExecuted.toString()],
  ];

  const col = 28;
  console.log(`${"Metric".padEnd(col)} ${"Lumen".padEnd(22)} Stagehand-style`);
  console.log(sep2);
  for (const [label, lv, sv] of rows) {
    console.log(`${label.padEnd(col)} ${lv.padEnd(22)} ${sv}`);
  }

  console.log("\n" + sep);

  const tokenSaving = sa.totalTokens > 0 ? ((sa.totalTokens - la.totalTokens) / sa.totalTokens) * 100 : 0;
  const costSaving = sa.costUSD > 0 ? ((sa.costUSD - la.costUSD) / sa.costUSD) * 100 : 0;
  const timeDiff = sa.durationMs > 0 ? ((sa.durationMs - la.durationMs) / sa.durationMs) * 100 : 0;

  console.log(`\n  Token reduction:  ${tokenSaving.toFixed(1)}%  (${(la.totalTokens).toLocaleString()} vs ${(sa.totalTokens).toLocaleString()})`);
  console.log(`  Cost reduction:   ${costSaving.toFixed(1)}%  (${usd(la.costUSD)} vs ${usd(sa.costUSD)})`);
  console.log(`  Time delta:       ${timeDiff.toFixed(1)}%  (${(la.durationMs / 1000).toFixed(1)}s vs ${(sa.durationMs / 1000).toFixed(1)}s)`);
  console.log(`  Success rate:     ${(la.avgScore * 100).toFixed(0)}% vs ${(sa.avgScore * 100).toFixed(0)}%`);

  const target = 40;
  console.log(`\n  PRD token target ≥${target}%: ${tokenSaving >= target ? `✓ PASSING  (${tokenSaving.toFixed(1)}%)` : `✗ BELOW TARGET  (${tokenSaving.toFixed(1)}% < ${target}%)`}`);
  console.log(SEP + "\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const lumenOnly = args.includes("--lumen-only");
const taskFilter = args.filter((a) => !a.startsWith("--"))[0];

const tasksToRun = taskFilter ? TASKS.filter((t) => t.name.includes(taskFilter)) : TASKS;
if (tasksToRun.length === 0) {
  console.error(`No tasks matched: ${taskFilter}`);
  console.error(`Available: ${TASKS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

console.log(`Tasks:   ${tasksToRun.map((t) => t.name).join(", ")}`);
console.log(`Adapters: lumen${lumenOnly ? "" : ", stagehand-style"}`);
console.log(`Model:   ${MODEL}\n`);

console.log("Launching Chrome...");
const { kill } = await launchChrome({ headless: false, port: PORT });

const pagesRes = await fetch(`http://localhost:${PORT}/json`);
const pages = (await pagesRes.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
const pageTarget = pages.find((p) => p.type === "page");
if (!pageTarget?.webSocketDebuggerUrl) throw new Error("No page target found");

const conn = await CdpConnection.connect(pageTarget.webSocketDebuggerUrl);
const tab = new CDPTab(conn.mainSession());

const vm = new ViewportManager(tab);
const vp = await vm.alignToModel(28, 1344);
console.log(`Viewport: ${vp.width}×${vp.height}\n`);

const lumenAdapter = new LumenCUAAdapter(ANTHROPIC_API_KEY, MODEL, KEEP_RECENT);
const shAdapter = new StagehandCUAAdapter(ANTHROPIC_API_KEY, MODEL);
lumenAdapter.setViewport(vp.width, vp.height);
shAdapter.setViewport(vp.width, vp.height);

const results: RunResult[] = [];

for (const task of tasksToRun) {
  console.log(`\n─── ${task.name} (${task.successCriteria}) ───`);

  lumenAdapter.reset();
  await tab.goto(task.url);
  await new Promise((r) => setTimeout(r, 1500));
  results.push(await runEvalLoop(lumenAdapter, tab, task, "lumen"));

  await new Promise((r) => setTimeout(r, 2000));

  if (!lumenOnly) {
    shAdapter.reset();
    await tab.goto(task.url);
    await new Promise((r) => setTimeout(r, 1500));
    results.push(await runEvalLoop(shAdapter, tab, task, "stagehand-style"));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

printReport(results, tasksToRun);

conn.close();
kill();
