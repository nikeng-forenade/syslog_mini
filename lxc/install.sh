#!/bin/bash
# Syslog Server LXC Install Script
# Run inside an LXC container (Debian 12+ or Ubuntu 22.04+)
#
# Usage:
#   bash install.sh
#   bash install.sh --port 8080 --udp-port 514 --retention 30
set -e

# ── Parse CLI options ──────────────────────────────────────
PORT="8080"
UDP_PORT="514"
TCP_PORT="514"
LOG_DIR="/var/log/syslog-server"
RETENTION="30"
DISABLE_RSYSLOG="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)          PORT="$2"; shift 2 ;;
    --udp-port)      UDP_PORT="$2"; shift 2 ;;
    --tcp-port)      TCP_PORT="$2"; shift 2 ;;
    --log-dir)       LOG_DIR="$2"; shift 2 ;;
    --retention)     RETENTION="$2"; shift 2 ;;
    --keep-rsyslog)  DISABLE_RSYSLOG="0"; shift ;;
    --help)
      echo "Usage: bash install.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --port PORT           GUI/API HTTP port (default: 8080)"
      echo "  --udp-port PORT       UDP syslog port (default: 514)"
      echo "  --tcp-port PORT       TCP syslog port (default: 514)"
      echo "  --log-dir DIR         Log storage dir, one .jsonl per day (default: /var/log/syslog-server)"
      echo "  --retention DAYS      Auto-delete days older than N (default: 30, 0 = keep all)"
      echo "  --keep-rsyslog        Don't disable local rsyslog (may conflict on port 514)"
      echo "  --help                Show this help"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== Syslog Server LXC Setup ==="
echo "GUI port:    $PORT"
echo "UDP/TCP:     $UDP_PORT / $TCP_PORT"
echo "Log dir:     $LOG_DIR"
echo "Retention:   $RETENTION days"
echo ""

# ── Update system ──────────────────────────────────────────
apt-get update && apt-get upgrade -y

# ── Install Node.js 20.x ───────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Installing Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get update
  apt-get install -y nodejs
fi
echo "Node.js $(node -v)"

# ── Locate app files ───────────────────────────────────────
# 1) /root/syslog  (pushed by lxc/proxmox-create.sh)
# 2) next to this script (local clone / manual copy)
# 3) GIT_REPO env var
SRC_DIR=""
if [ -f /root/syslog/server.js ]; then
  SRC_DIR="/root/syslog"
elif [ -f "$(dirname "$0")/server.js" ]; then
  SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
elif [ -n "$GIT_REPO" ]; then
  echo "Cloning $GIT_REPO ..."
  command -v git &>/dev/null || apt-get install -y git
  git clone --depth 1 "$GIT_REPO" /tmp/syslog-src
  SRC_DIR="/tmp/syslog-src"
else
  echo "ERROR: server.js not found. Use lxc/proxmox-create.sh, or place server.js + public/ next to this script, or set GIT_REPO."
  exit 1
fi

# ── Install app ────────────────────────────────────────────
APP_DIR="/opt/syslog-server"
echo "Installing app to $APP_DIR ..."
mkdir -p "$APP_DIR/public" "$LOG_DIR"
cp "$SRC_DIR/server.js" "$APP_DIR/"
cp "$SRC_DIR/public/index.html" "$APP_DIR/public/"
chmod +x "$APP_DIR/server.js"

# ── Free port 514 if needed ────────────────────────────────
if [ "$DISABLE_RSYSLOG" = "1" ] && systemctl list-unit-files 2>/dev/null | grep -q '^rsyslog'; then
  echo "Disabling local rsyslog to free port 514..."
  systemctl disable --now rsyslog || true
fi

# ── Install systemd service ────────────────────────────────
echo "Installing systemd service..."
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/syslog-server.service <<EOF
[Unit]
Description=Syslog Server (Node.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3
Environment=SYSLOG_LOG_DIR=$LOG_DIR
Environment=SYSLOG_UDP_PORT=$UDP_PORT
Environment=SYSLOG_TCP_PORT=$TCP_PORT
Environment=SYSLOG_HTTP_PORT=$PORT
Environment=SYSLOG_RETENTION=$RETENTION

# Security hardening
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable syslog-server
systemctl restart syslog-server

echo ""
echo "=== Done! Syslog server is running ==="
echo "GUI:     http://<container-ip>:$PORT"
echo "UDP/TCP: :$UDP_PORT / :$TCP_PORT"
echo "Logs:    $LOG_DIR (one file per day)"
echo ""
echo "Check status: systemctl status syslog-server"
echo "View logs:    journalctl -u syslog-server -f"
