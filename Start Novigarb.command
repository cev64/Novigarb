#!/bin/bash
#
# Double-click this file in Finder to start Novigarb and open it in your browser.
# Closing the Terminal window that appears stops the scanner.

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
URL="http://localhost:$PORT"

printf '\n  Novigarb — Kalshi x Novig arbitrage\n'
printf '  ───────────────────────────────────\n\n'

pause_and_exit() {
  printf '\n  Press any key to close this window.\n'
  read -n 1 -s -r
  exit "${1:-1}"
}

# --- Node check -------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is not installed.\n\n'
  printf '  Install it from https://nodejs.org (choose the LTS build),\n'
  printf '  then double-click this file again.\n'
  pause_and_exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf '  Node.js 18 or newer is required (found %s).\n\n' "$(node --version)"
  printf '  Update it from https://nodejs.org, then try again.\n'
  pause_and_exit 1
fi

# --- Already running? -------------------------------------------------------

if curl -s -o /dev/null --max-time 2 "$URL/api/snapshot" 2>/dev/null; then
  printf '  Novigarb is already running on port %s.\n' "$PORT"
  printf '  Opening %s\n' "$URL"
  open "$URL"
  pause_and_exit 0
fi

# --- Start ------------------------------------------------------------------

printf '  Starting the scanner on port %s...\n' "$PORT"

# Open the browser once the first scan has landed, so the page is never empty.
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null --max-time 2 "$URL/api/snapshot" 2>/dev/null; then
      open "$URL"
      exit 0
    fi
    sleep 1
  done
) &

printf '  Your browser will open automatically. Close this window to stop.\n\n'

PORT="$PORT" node server.js
