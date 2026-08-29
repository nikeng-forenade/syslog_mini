#!/usr/bin/env bash
# install-lxc.sh — installs the syslog server inside a Proxmox LXC (Debian/Ubuntu).
#
# Run as root inside the container (default user for LXC templates):
#   bash install-lxc.sh
#
# Or bootstrap straight from a git repo:
#   GIT_REPO=https://github.com/you/syslog-lxc.git bash install-lxc.sh
#
# Env knobs:
#   GIT_REPO          fetch source from git instead of local files
#   NODE_MAJOR        Node major version to install (default 24)
#   INSTALL_DIR       target install dir (default /opt/syslog-server)
#   LOG_DIR           log storage dir (default /var/log/syslog-server)
#   HTTP_PORT         GUI/API port (default 8080)
#   RETENTION_DAYS    auto-purge days older than N (default 30, 0 = keep all)
#   DISABLE_RSYSLOG   1 stop+disable local rsyslog to free port 514 (default 1)
#   RUN_SMOKE_TEST    1 send a test message and verify the API (default 1)

set -euo pipefail

GIT_REPO="${GIT_REPO:-}"
NODE_MAJOR="${NODE_MAJOR:-24}"
INSTALL_DIR="${INSTALL_DIR:-/opt/syslog-server}"
LOG_DIR="${LOG_DIR:-/var/log/syslog-server}"
HTTP_PORT="${HTTP_PORT:-8080}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
DISABLE_RSYSLOG="${DISABLE_RSYSLOG:-1}"
RUN_SMOKE_TEST="${RUN_SMOKE_TEST:-1}"

log() { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (Proxmox LXC containers default to root)."
command -v curl >/dev/null 2>&1 || apt-get install -y curl

# ---------- 1. Node.js ----------
if command -v node >/dev/null 2>&1; then
  log "Node.js already installed: $(node --version)"
else
  log "Installing Node.js ${NODE_MAJOR} (NodeSource)..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  mkdir -p /etc/apt/keyrings
  curl -fsSL "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key" \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"

# ---------- 2. Source ----------
TMP_SRC="$(mktemp -d)"
trap 'rm -rf "$TMP_SRC"' EXIT

if [ -n "$GIT_REPO" ]; then
  log "Cloning source from $GIT_REPO"
  command -v git >/dev/null 2>&1 || apt-get install -y git
  git clone --depth 1 "$GIT_REPO" "$TMP_SRC/syslog"
  SRC="$TMP_SRC/syslog"
else
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$SCRIPT_DIR/server.js" ] || die "server.js not found next to this script and GIT_REPO is not set."
  SRC="$SCRIPT_DIR"
fi

# ---------- 3. Install files ----------
log "Installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR/public" "$LOG_DIR"
cp "$SRC/server.js" "$INSTALL_DIR/"
cp "$SRC/public/index.html" "$INSTALL_DIR/public/"
chmod +x "$INSTALL_DIR/server.js"

# ---------- 4. systemd unit ----------
log "Installing systemd unit"
cat > /etc/systemd/system/syslog-server.service <<EOF
[Unit]
Description=Syslog Server (Node.js)
After=network.target

[Service]
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3
Environment=SYSLOG_LOG_DIR=$LOG_DIR
Environment=SYSLOG_HTTP_PORT=$HTTP_PORT
Environment=SYSLOG_RETENTION=$RETENTION_DAYS

[Install]
WantedBy=multi-user.target
EOF

# ---------- 5. Free port 514 ----------
if [ "$DISABLE_RSYSLOG" = "1" ]; then
  if systemctl list-unit-files 2>/dev/null | grep -q '^rsyslog'; then
    log "Disabling local rsyslog so port 514 is free for the syslog server"
    systemctl disable --now rsyslog || true
  fi
else
  warn "Keeping rsyslog enabled — make sure it does not bind port 514"
fi

# ---------- 6. Start ----------
log "Starting service"
systemctl daemon-reload
systemctl enable --now syslog-server
sleep 1
systemctl --no-pager --full status syslog-server --lines=0 || true

if command -v ss >/dev/null 2>&1; then
  ss -ulnp | grep -E ':514\b' >/dev/null 2>&1 \
    && log "UDP 514 listening" || warn "could not confirm UDP 514 is listening"
else
  grep -q '^[[:space:]]*00000000:0202' /proc/net/udp 2>/dev/null \
    && log "UDP 514 listening" || warn "could not confirm UDP 514 is listening"
fi

# ---------- 7. Smoke test ----------
if [ "$RUN_SMOKE_TEST" = "1" ]; then
  if command -v logger >/dev/null 2>&1; then
    log "Sending a test message..."
    logger -n 127.0.0.1 -P 514 -p user.info "syslog server install test $(date -u +%FT%TZ)"
    sleep 1
    echo "API /api/days ->"
    curl -fsS "http://127.0.0.1:${HTTP_PORT}/api/days" && echo
  else
    warn "logger not found; skipping smoke test"
  fi
fi

# ---------- 8. Summary ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
IP="${IP:-<container-ip>}"
cat <<EOF

✅ Syslog server installed.
  GUI / API : http://${IP}:${HTTP_PORT}
  Log dir   : $LOG_DIR   (SQLite DB: syslog.db)
  Service   : systemctl status syslog-server

Point your hosts at it (rsyslog example):
  echo '*.* @${IP}:514' > /etc/rsyslog.d/50-forward.conf
  systemctl restart rsyslog
  # use '@@' (double) for TCP instead of UDP

Firewall: allow UDP/TCP 514 in Proxmox
  Datacenter > <node> > <CT> > Firewall > Add rule (source = your networks).
EOF
