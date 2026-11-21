#!/usr/bin/env bash
# Run the Tower Siege game server on port 8080 (PORT overrides it) and expose it to the internet with a Cloudflare quick tunnel.
# Usage: npm run serve   (Ctrl+C stops the tunnel, and the game server if this script started it)
# The public https://*.trycloudflare.com address is new on every run and is printed below.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8080}
CLOUDFLARED=$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")

node scripts/build-web.mjs

SERVER_PID=
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  if curl -fsS "http://127.0.0.1:$PORT/info" 2>/dev/null | grep -q '"tower-siege"'; then
    echo "A Tower Siege server is already running on port $PORT: reusing it (restart it to load code changes)"
  else
    echo "Port $PORT is in use by something else (not a Tower Siege server). Stop it, or run with PORT=<other port>." >&2
    exit 1
  fi
else
  PORT=$PORT node server/server.mjs &
  SERVER_PID=$!
  sleep 0.5
fi
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Starting Cloudflare tunnel…"
"$CLOUDFLARED" tunnel --no-autoupdate --url "http://localhost:$PORT" 2>&1 | while IFS= read -r line; do
  if [[ $line =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    echo
    echo "  Public URL: ${BASH_REMATCH[1]}"
    echo
  elif [[ $line =~ ERR ]]; then
    echo "$line"
  fi
done
