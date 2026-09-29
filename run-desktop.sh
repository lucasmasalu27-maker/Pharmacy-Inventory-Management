#!/usr/bin/env bash
# Start the Pharmacy Ledger office server and open the app in an app window.
#   ./run-desktop.sh               (extra args go to server.py, e.g. --key MySecret)
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
PORT="${PORT:-8765}"
URL="http://localhost:${PORT}/"

if ! curl -fs "${URL}api/ping" >/dev/null 2>&1; then
  python3 server.py --port "$PORT" "$@" &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null' EXIT
  for _ in $(seq 1 30); do curl -fs "${URL}api/ping" >/dev/null 2>&1 && break; sleep 0.2; done
fi

BROWSER_CMD=""
for b in chromium chromium-browser google-chrome google-chrome-stable microsoft-edge brave-browser; do
  if command -v "$b" >/dev/null; then BROWSER_CMD="$b"; break; fi
done
if [ -n "$BROWSER_CMD" ]; then
  "$BROWSER_CMD" --app="$URL" >/dev/null 2>&1 &   # app window, installable, works offline
else
  xdg-open "$URL" >/dev/null 2>&1 || true          # e.g. Firefox
fi

echo "Pharmacy Ledger running at $URL — keep this window open while you work (Ctrl+C to stop)."
wait
