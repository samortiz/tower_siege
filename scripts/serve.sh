#!/usr/bin/env bash
# Serve the web build on port 8080 and expose it to the internet with a Cloudflare quick tunnel.
# Usage: npm run serve   (Ctrl+C stops the tunnel, and the web server if this script started it)
# The public https://*.trycloudflare.com address is new on every run and is printed below.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${PORT:-8080}
CLOUDFLARED=$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")

node scripts/build-web.mjs

SERVER_PID=
if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  echo "Port $PORT already in use: reusing the server that is running there"
else
  python3 -m http.server "$PORT" --bind 0.0.0.0 --directory www >/dev/null 2>&1 &
  SERVER_PID=$!
  echo "Web server started on port $PORT (LAN: http://$(hostname -I | awk '{print $1}'):$PORT)"
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
