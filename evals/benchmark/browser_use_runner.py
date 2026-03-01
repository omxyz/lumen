#!/usr/bin/env python3
"""Browser-use runner. Called with JSON args via argv[1], outputs JSON to stdout."""
import asyncio
import json
import sys
import time
import os


async def run_task(task_name: str, instruction: str, start_url: str, max_steps: int) -> dict:
    from browser_use import Agent

    # BROWSER_USE_MODEL overrides MODEL for this runner (browser-use uses a chat interface,
    # so CUA-specific models like gemini-2.5-computer-use-preview-10-2025 won't work here)
    model = os.environ.get("BROWSER_USE_MODEL") or os.environ.get("MODEL", "anthropic/claude-sonnet-4-6")
    # Fall back to gemini-2.5-flash if CUA preview model requested (not supported in chat mode)
    if "computer-use-preview" in model:
        model = "google/gemini-2.5-flash"

    if model.startswith("google/"):
        from browser_use.llm.google.chat import ChatGoogle
        llm = ChatGoogle(
            model=model[len("google/"):],
            api_key=os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", ""),
        )
    else:
        from browser_use.llm.anthropic.chat import ChatAnthropic
        model_id = model[len("anthropic/"):] if model.startswith("anthropic/") else model
        llm = ChatAnthropic(
            model=model_id,
            api_key=os.environ["ANTHROPIC_API_KEY"],
        )

    agent = Agent(
        task=f"Navigate to {start_url} and then: {instruction}",
        llm=llm,
        max_steps=max_steps,
    )

    start = time.time()
    history = await agent.run()
    elapsed_ms = (time.time() - start) * 1000

    final_result = history.final_result() or ""
    is_done = history.is_done()

    # Step count from action history
    steps = 0
    try:
        steps = len(history.model_actions())
    except Exception:
        try:
            steps = len(history.history)
        except Exception:
            pass

    # Token usage — browser-use AgentHistoryList exposes these
    tokens = None
    try:
        input_tok = history.total_input_tokens()
        output_tok = getattr(history, "total_output_tokens", lambda: 0)()
        tokens = int(input_tok) + int(output_tok)
    except Exception:
        pass

    return {
        "task": task_name,
        "passed": bool(is_done and final_result),
        "result": str(final_result),
        "steps": steps,
        "tokens": tokens,
        "duration_ms": elapsed_ms,
        "error": None,
    }


if __name__ == "__main__":
    args = json.loads(sys.argv[1])
    try:
        result = asyncio.run(run_task(**args))
    except Exception as e:
        result = {
            "task": args.get("task_name", "unknown"),
            "passed": False,
            "result": "",
            "steps": 0,
            "tokens": None,
            "duration_ms": 0,
            "error": str(e),
        }
    print(json.dumps(result))
