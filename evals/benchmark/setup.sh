#!/bin/bash
# Setup script for browser-use Python environment and Stagehand Playwright browsers.
# Run once before using `npm run benchmark`.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "=== Lumen Benchmark Setup ==="
echo ""

# --- Python / browser-use ---
echo "1. Creating Python venv: $VENV_DIR"
python3 -m venv "$VENV_DIR"
echo "   Python: $("$VENV_DIR/bin/python3" --version)"

echo "2. Installing browser-use and langchain-anthropic..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet browser-use langchain-anthropic playwright

echo "3. Installing Playwright chromium (for browser-use)..."
"$VENV_DIR/bin/playwright" install chromium

# --- Stagehand Playwright ---
echo "4. Installing Playwright chromium (for Stagehand)..."
cd "$SCRIPT_DIR/../.." && npx playwright install chromium 2>/dev/null || true

echo ""
echo "=== Setup complete ==="
echo "   browser-use venv: $VENV_DIR"
echo "   Run: npm run benchmark"
