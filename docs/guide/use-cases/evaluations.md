# Running Evaluations

Lumen includes a WebVoyager-based evaluation framework for measuring agent accuracy across real websites.

## Dataset format

Tasks are stored as JSONL with one task per line:

```json
{"web_name": "GitHub", "id": "GitHub--1", "ques": "Find the most starred TypeScript repo", "web": "https://github.com"}
```

Fields:
- `web_name` — site identifier (e.g., `GitHub`, `Allrecipes`, `Booking`)
- `id` — unique task ID
- `ques` — natural language instruction
- `web` — starting URL

The default dataset is `evals/webvoyager/data.jsonl` (25 tasks across 15 sites).

## Running evals

```bash
# Run all 25 tasks
npm run eval

# Run first 5 tasks only
npm run eval -- 5

# Compare frameworks
npm run eval -- 25 stagehand
npm run eval -- 25 browser-use
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `anthropic/claude-sonnet-4-6` | Agent model |
| `SITES` | all | Comma-separated site filter (e.g., `Allrecipes,GitHub`) |
| `DATA_FILE` | `data.jsonl` | Alternate dataset file |

## How judging works

Each task result is scored by an LLM judge (Gemini 2.5 Flash) that receives:
1. The original question
2. The agent's reasoning and result text
3. A final screenshot of the browser

The judge returns a structured `YES`/`NO` evaluation with reasoning.

## Retry with feedback injection

Failed tasks are retried up to 3 times. On each retry, the judge's feedback from the previous attempt is injected into the instruction:

```
[IMPORTANT: A previous attempt at this task failed. The evaluator said:
"The agent found flights but didn't select the cheapest option."
Try a DIFFERENT approach this time.]
```

This follows the Reflexion pattern — the agent learns from its mistakes within the same evaluation run.

## Date shifting

The WebVoyager dataset contains hardcoded 2023/2024 dates that travel sites reject (you can't book a flight in the past). The eval runner automatically shifts stale dates forward to valid future dates, preserving relative gaps between dates in the same instruction.

## Config

Key constants in `evals/webvoyager/run.ts`:

| Setting | Value | Description |
|---------|-------|-------------|
| `MAX_STEPS` | 50 | Maximum agent steps per task |
| `TASK_TIMEOUT_MS` | 600,000 (10 min) | Per-task timeout |
| `TRIALS` | 3 | Max retry attempts |
| `JUDGE_MODEL` | `gemini-2.5-flash` | LLM judge model |

## Output

Results are written to `evals/webvoyager/results/` as JSON reports containing per-task pass/fail status, step counts, token usage, and judge reasoning.
