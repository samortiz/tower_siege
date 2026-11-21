#!/usr/bin/env bash
# Run the Tower Siege game server (and its Cloudflare quick tunnel) as systemd user services, so it starts at boot and keeps
# running after you log out.
# Usage: npm run service -- <command>
#   install     write and start tower-siege.service (the game server) and tower-siege-tunnel.service (the public tunnel).
#               PORT (default 8080) and SERVER_NAME are baked in at install time; NO_TUNNEL=1 skips the tunnel.
#   restart     restart the game server to load code changes (the tunnel keeps running, so the public URL stays the same)
#   url         print the current public https://*.trycloudflare.com address
#   status      show both services
#   logs        follow the game server's log
#   uninstall   stop both services and remove them
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
UNITS="$HOME/.config/systemd/user"
SERVER=tower-siege.service
TUNNEL=tower-siege-tunnel.service

# The address the tunnel printed since it last started (older runs had other addresses)
url() {
  local inv; inv=$(systemctl --user show -p InvocationID --value "$TUNNEL" 2>/dev/null)
  [ -n "$inv" ] || return 0
  journalctl --user _SYSTEMD_INVOCATION_ID="$inv" -o cat --no-pager 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1
}

case "${1:-}" in
  install)
    PORT=${PORT:-8080}
    NODE=$(command -v node) || { echo "node is not on PATH" >&2; exit 1; }
    CLOUDFLARED=$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")
    if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && ! systemctl --user -q is-active "$SERVER"; then
      echo "Port $PORT is already in use. Stop whatever is using it, or install with PORT=<other port>." >&2; exit 1
    fi
    mkdir -p "$UNITS"
    cat > "$UNITS/$SERVER" <<EOF
[Unit]
Description=Tower Siege game server (port $PORT)
After=network-online.target

[Service]
WorkingDirectory=$REPO
Environment=PORT=$PORT
${SERVER_NAME:+Environment=SERVER_NAME=$SERVER_NAME}
ExecStartPre=$NODE scripts/build-web.mjs
ExecStart=$NODE server/server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    if [ -z "${NO_TUNNEL:-}" ]; then
      [ -x "$CLOUDFLARED" ] || { echo "cloudflared not found (looked on PATH and at ~/.local/bin/cloudflared)" >&2; exit 1; }
      cat > "$UNITS/$TUNNEL" <<EOF
[Unit]
Description=Cloudflare quick tunnel for Tower Siege (public https://*.trycloudflare.com address)
Wants=$SERVER
After=$SERVER

[Service]
ExecStart=$CLOUDFLARED tunnel --no-autoupdate --url http://localhost:$PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    fi
    systemctl --user daemon-reload
    systemctl --user enable --now "$SERVER"
    [ -z "${NO_TUNNEL:-}" ] && systemctl --user enable --now "$TUNNEL"
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != yes ]; then
      loginctl enable-linger "$USER" 2>/dev/null || echo "Note: run 'loginctl enable-linger $USER' so the server keeps running after you log out."
    fi
    echo "Installed. Game server on port $PORT (node: $NODE — reinstall if you switch Node versions)."
    if [ -z "${NO_TUNNEL:-}" ]; then
      for _ in $(seq 1 20); do [ -n "$(url)" ] && break; sleep 1; done
      echo "Public URL: $(url || true)"
    fi
    ;;
  restart) systemctl --user restart "$SERVER"; echo "Game server restarted. Public URL (unchanged): $(url || true)" ;;
  url) u=$(url || true); [ -n "$u" ] && echo "$u" || { echo "No tunnel URL yet (is $TUNNEL running?)" >&2; exit 1; } ;;
  status) systemctl --user --no-pager status "$SERVER" "$TUNNEL" || true ;;
  logs) journalctl --user -u "$SERVER" -f -o cat ;;
  uninstall)
    systemctl --user disable --now "$SERVER" "$TUNNEL" 2>/dev/null || true
    rm -f "$UNITS/$SERVER" "$UNITS/$TUNNEL"
    systemctl --user daemon-reload
    echo "Removed."
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
