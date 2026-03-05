import { GoogleGenAI, Environment } from "@google/genai";
import type { ModelAdapter, StepContext } from "./adapter.js";
import type { ModelResponse } from "./adapter.js";
import { withRetry } from "./adapter.js";
import type { CUAAction, TaskState, WireMessage } from "../types.js";
import { ActionDecoder } from "./decoder.js";

const decoder = new ActionDecoder();

function buildSystemInstruction(context: StepContext): string {
  const parts: string[] = [];
  if (context.systemPrompt) parts.push(context.systemPrompt);
  parts.push(
    `You are a computer use agent browsing the web.` +
    `\nCurrent URL: ${context.url || "(unknown)"}` +
    `\nStep ${context.stepIndex + 1} of ${context.maxSteps}` +
    "\n\n#1 RULE — TERMINATE IMMEDIATELY: If the answer to the task is visible anywhere in the current screenshot (in any text, header, infobox, table, or element), call terminate(status='success', result='your answer') RIGHT NOW. Do NOT scroll, click, navigate, or take any other action first." +
    "\n\nOTHER RULES:" +
    "\n- Screenshots are provided automatically; never request one." +
    "\n- Use navigate(url='...') to go to a URL." +
    "\n- Take only ONE action per step; a new screenshot follows each action." +
    "\n- If the page has a cookie/consent banner, dismiss it, then proceed with the task." +
    "\n- LIST VIEWS: When a page shows items in a list or grid with visible values (prices, counts, ratings), read those values directly from the list. Do NOT click into individual items to verify data already visible in the list view." +
    "\n- EFFICIENT SCROLLING: To move through a long page, press the Page_Down key (keyPress action) instead of small mouse scrolls — each Page_Down advances a full screen and covers content 3x faster." +
    "\n- TRUST YOUR MEMORY: If you have already memorized data from a page, do NOT navigate back to that page to re-verify. Trust what you recorded and use it directly to answer." +
    "\n- MULTI-PAGE COLLECTION: Collect data page by page, memorize as you go, then terminate once you have data from all pages. Never revisit a page you already processed." +
    "\n- BE DECISIVE: Once you have sufficient information to answer the task, call terminate immediately. Do not keep scrolling or browsing to double-check." +
    "\n- THINK FIRST: Before acting, briefly consider: What key information is visible? What have I accomplished? What is my next step?" +
    "\n- CHECKPOINT PROGRESS: Save your findings every 3-5 steps so they persist even if history is compacted. Include ALL data collected so far." +
    "\n- VERIFY ACTIONS: After any form interaction (date picker, dropdown, filter, checkbox), CHECK the next screenshot to confirm your selection was applied correctly. If the field shows a wrong value or the filter shows wrong results, try again with a different approach." +
    "\n- DATE PICKERS: 1) First try typing the date directly into the input field (common formats: MM/DD/YYYY, YYYY-MM-DD). 2) If using a calendar widget, navigate to the correct MONTH first using arrow buttons, then click the specific date. 3) After selecting, READ the date field value in the next screenshot to verify it matches your intent." +
    "\n- FORMS: Fill one field at a time. For dropdowns, click to open then click the exact option text. If an element doesn't respond to clicks, try Tab key to move between fields, or type directly into focused inputs." +
    "\n- URL FALLBACK: If form filling (especially date pickers or complex filters) fails after 2-3 attempts, construct the search URL with query parameters and navigate directly. Most sites encode search parameters in the URL (e.g. check-in/check-out dates, destinations, filters)." +
    "\n- COMPLETE ALL SUB-TASKS: If the task asks for multiple pieces of information, track each one. Do NOT call terminate until ALL requested items are found." +
    "\n- NEVER HALLUCINATE: Only report information you can see on screen. If a specific piece of data is not visible, say so rather than guessing.",
  );
  if (context.agentState && Object.keys(context.agentState).length > 0) {
    parts.push(`Current state: ${JSON.stringify(context.agentState)}`);
  }
  // Urgency warning when nearing step limit
  const stepsRemaining = context.maxSteps - context.stepIndex - 1;
  if (stepsRemaining <= Math.max(3, Math.floor(context.maxSteps * 0.1))) {
    parts.push(
      `⚠️ URGENT: Only ${stepsRemaining} step(s) remaining! You MUST call terminate with your best answer on your NEXT action. Do NOT continue browsing.`,
    );
  }
  return parts.join("\n\n");
}

// Google GenAI Content/Part types (loosely typed for flexibility across SDK versions)
type GContent = { role: string; parts: GPart[] };
type GFunctionCall = { name: string; args?: Record<string, unknown> };
type GPart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: GFunctionCall;
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
    parts?: { inlineData?: { mimeType: string; data: string } }[];
  };
};

export class GoogleAdapter implements ModelAdapter {
  readonly provider = "google";
  readonly nativeComputerUse = true;
  readonly patchSize = 56;
  readonly maxImageDimension = 1568;

  get contextWindowTokens(): number {
    return 1_000_000;
  }

  private readonly client: GoogleGenAI;

  // Stateful conversation history for multi-turn CUA models
  private conversationHistory: GContent[] = [];
  private pendingFunctionCalls: GFunctionCall[] = [];
  private pendingHasSafetyDecision: boolean[] = [];
  // Keep the initial turn + last N turn pairs (model + user) to limit token growth
  private static readonly MAX_HISTORY_TURNS = 4; // initial + 4 pairs = 9 entries max

  constructor(readonly modelId: string, apiKey?: string) {
    this.client = new GoogleGenAI({ apiKey: apiKey ?? process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "" });
  }

  /** Keep initial user turn + last MAX_HISTORY_TURNS model/user pairs to limit token growth */
  private pruneHistory(): void {
    // History structure: [initial_user, model, user, model, user, ...]
    // Always keep index 0 (initial user message) and last MAX_HISTORY_TURNS*2 entries
    if (this.conversationHistory.length <= 1 + GoogleAdapter.MAX_HISTORY_TURNS * 2) return;
    const initial = this.conversationHistory[0]!;
    const recent = this.conversationHistory.slice(-(GoogleAdapter.MAX_HISTORY_TURNS * 2));
    this.conversationHistory = [initial, ...recent];
  }

  async step(context: StepContext): Promise<ModelResponse> {
    return withRetry(async () => {
      const systemInstruction = buildSystemInstruction(context);
      const screenshotData = context.screenshot.data.toString("base64");

      // Build user turn for this step
      if (this.pendingFunctionCalls.length > 0) {
        // Send function responses for the previous step's actions
        // Screenshot goes inside functionResponse.parts (matching Google's expected format)
        const responseParts: GPart[] = this.pendingFunctionCalls.map((fc, i) => ({
          functionResponse: {
            name: fc.name,
            response: {
              url: context.url || "",
              // Auto-acknowledge safety decisions (required by Google API)
              ...(this.pendingHasSafetyDecision[i] ? { safety_acknowledgement: "true" } : {}),
            },
            parts: [{ inlineData: { mimeType: "image/png", data: screenshotData } }],
          },
        }));
        this.conversationHistory.push({ role: "user", parts: responseParts });
        this.pendingFunctionCalls = [];
        this.pendingHasSafetyDecision = [];
        // Prune history: keep initial turn + last MAX_HISTORY_TURNS model/user turn pairs
        this.pruneHistory();
      } else {
        // First step: send instruction + screenshot
        const userParts: GPart[] = [];
        if (context.systemPrompt) {
          userParts.push({ text: context.systemPrompt });
        }
        userParts.push({ inlineData: { mimeType: "image/png", data: screenshotData } });
        this.conversationHistory.push({ role: "user", parts: userParts });
      }

      // Keep calling the API, handling open_web_browser inline
      let lastResponse: Awaited<ReturnType<typeof this.client.models.generateContent>> | null = null;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (let turn = 0; turn < 5; turn++) {
        const response = await this.client.models.generateContent({
          model: this.modelId,
          contents: this.conversationHistory as Parameters<typeof this.client.models.generateContent>[0]["contents"],
          config: {
            systemInstruction,
            tools: [{ computerUse: { environment: Environment.ENVIRONMENT_BROWSER } }],
          },
        });
        lastResponse = response;
        totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
        totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

        const candidate = response.candidates?.[0];
        const parts = (candidate?.content?.parts ?? []) as GPart[];
        const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!);


        // No function calls = text response (model is done or confused)
        if (functionCalls.length === 0) {
          // Try to extract a text answer
          const text = parts.filter((p) => p.text).map((p) => p.text).join(" ");
          if (text) {
            // Treat text response as a terminate action
            this.conversationHistory.push({ role: "model", parts });
            return {
              actions: [{ type: "terminate", status: "success", result: text }],
              usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
              rawResponse: lastResponse,
            };
          }
          break;
        }

        // Add model's turn to history
        this.conversationHistory.push({ role: "model", parts });

        const openWebBrowserCalls = functionCalls.filter((fc) => fc.name === "open_web_browser");
        const actionCalls = functionCalls.filter((fc) => fc.name !== "open_web_browser");

        if (openWebBrowserCalls.length > 0 && actionCalls.length === 0) {
          // Only open_web_browser — respond immediately and continue in the same step.
          // Include a hint so the model knows to examine the screenshot and terminate if the answer is visible.
          const responseParts: GPart[] = openWebBrowserCalls.map((fc) => ({
            functionResponse: {
              name: fc.name,
              response: {
                url: context.url || "",
                status: "Browser is open. Examine the screenshot carefully. If the answer to the task is visible, call terminate(status='success', result='answer') immediately.",
              },
              parts: [{ inlineData: { mimeType: "image/png", data: screenshotData } }],
            },
          }));
          this.conversationHistory.push({ role: "user", parts: responseParts });
          continue;
        }

        // Decode action calls and return them to PerceptionLoop
        const actions: CUAAction[] = [];
        const googleViewport = { width: context.screenshot.width, height: context.screenshot.height };
        for (const fc of actionCalls) {
          const action = decoder.fromGoogle({
            name: fc.name,
            args: (fc.args ?? {}) as Record<string, unknown>,
          }, googleViewport);
          actions.push(action);
        }

        // Terminate actions don't need a function response
        const hasTerminate = actions.some((a) => a.type === "terminate");
        if (!hasTerminate) {
          this.pendingFunctionCalls = actionCalls;
          this.pendingHasSafetyDecision = actionCalls.map((fc) => Boolean(fc.args?.safety_decision));
        }

        return {
          actions,
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
          rawResponse: lastResponse,
        };
      }

      return {
        actions: [],
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        rawResponse: lastResponse,
      };
    });
  }

  private _lastStreamResponse: ModelResponse | null = null;

  getLastStreamResponse(): ModelResponse | null {
    return this._lastStreamResponse;
  }

  async *stream(context: StepContext): AsyncIterable<CUAAction> {
    // Delegate to step() for correct token tracking; cache response for PerceptionLoop
    try {
      const response = await this.step(context);
      this._lastStreamResponse = response;
      for (const action of response.actions) {
        yield action;
      }
    } finally {
      // _lastStreamResponse set inside try block; no-op here if step() throws
    }
  }

  estimateTokens(context: StepContext): number {
    return context.wireHistory.length * 200 + 1500;
  }

  async summarize(wireHistory: WireMessage[], currentState: Record<string, unknown> | null): Promise<string> {
    const response = await this.client.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{
        role: "user" as const,
        parts: [{
          text: [
            "Summarize this computer use session history concisely.",
            currentState ? `Current state: ${JSON.stringify(currentState)}` : "",
            `History (${wireHistory.length} messages): ${JSON.stringify(wireHistory.slice(-10))}`,
          ].filter(Boolean).join("\n\n"),
        }],
      }],
    });

    return response.candidates?.[0]?.content?.parts?.[0]?.text ?? "Session history summarized.";
  }
}
