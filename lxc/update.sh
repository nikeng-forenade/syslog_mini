#!/bin/bash
# Syslog Server LXC Update Script
# Run inside the LXC container as root:
#   bash update.sh
# Or straight from the Proxmox host (one-liner):
#   pct exec <CTID> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/update.sh)"
#
# Set GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH if you host this elsewhere.
set -e

# ── Config ─────────────────────────────────────────────────
APP_DIR="/opt/syslog-server"
BACKUP_KEEP="${BACKUP_KEEP:-3}"   # keep newest N backups, prune older ones
GITHUB_OWNER="${GITHUB_OWNER:-nikeng-forenade}"
GITHUB_REPO="${GITHUB_REPO:-syslog_mini}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
BASE="https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}"

echo "=== Syslog Server Update ==="
echo "Source: $BASE"
echo "Target: $APP_DIR"
echo ""

[ -d "$APP_DIR" ] || { echo "ERROR: $APP_DIR not found — is the app installed?"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "ERROR: curl is not installed."; exit 1; }

# ── Ensure DNS works (fixes 'Temporary failure resolving') ──
if ! getent hosts raw.githubusercontent.com >/dev/null 2>&1; then
  echo "DNS resolution failing — injecting public nameservers..."
  cp /etc/resolv.conf /etc/resolv.conf.bak 2>/dev/null || true
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
fi

# ── Download new files (to temp so a failure leaves current version intact) ──
echo "Downloading latest code..."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/server.js" "$BASE/server.js" || { echo "ERROR: failed to download server.js"; exit 1; }
curl -fsSL -o "$TMP/index.html" "$BASE/public/index.html" || { echo "ERROR: failed to download public/index.html"; exit 1; }
[ -s "$TMP/server.js" ] || { echo "ERROR: downloaded server.js is empty — aborting."; exit 1; }

# ── Back up current version ────────────────────────────────
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$APP_DIR/backups/$TS"
mkdir -p "$BACKUP"
cp "$APP_DIR/server.js" "$BACKUP/server.js"
cp "$APP_DIR/public/index.html" "$BACKUP/index.html"
echo "Backed up current version to $BACKUP"

# ── Prune old backups (keep newest $BACKUP_KEEP) ───────────
# Honor the keep-count set from the GUI (settings.json)
[ -f "$APP_DIR/settings.json" ] && {
  KEEP_FILE=$(grep -oP '"backupKeep":\s*\K[0-9]+' "$APP_DIR/settings.json" | head -1)
  [ -n "$KEEP_FILE" ] && BACKUP_KEEP="$KEEP_FILE"
}
PRUNED=0
if [ -d "$APP_DIR/backups" ] && [ "$BACKUP_KEEP" -gt 0 ] 2>/dev/null; then
  while [ "$(ls -1 "$APP_DIR/backups" | wc -l)" -gt "$BACKUP_KEEP" ]; do
    OLDEST=$(ls -1 "$APP_DIR/backups" | sort | head -n1)
    [ -n "$OLDEST" ] && rm -rf "$APP_DIR/backups/$OLDEST" && PRUNED=$((PRUNED + 1))
  done
fi
[ "$PRUNED" -gt 0 ] && echo "Pruned $PRUNED old backup(s) — keeping the newest $BACKUP_KEEP."

# ── Install new ────────────────────────────────────────────
chmod +x "$TMP/server.js"
cp "$TMP/server.js" "$APP_DIR/server.js"
cp "$TMP/index.html" "$APP_DIR/public/index.html"

echo "Restarting service..."
systemctl restart syslog-server

echo ""
echo "=== Updated! ==="
VERSION_STR=$(grep -oP "VERSION = '\K[^']+" "$APP_DIR/server.js" | head -1 || true)
[ -n "$VERSION_STR" ] && echo "Version: v$VERSION_STR"
echo "Backup: $BACKUP"
echo "Backups kept: $BACKUP_KEEP (oldest pruned automatically)"
echo "Check:  systemctl status syslog-server"
echo "Logs:   journalctl -u syslog-server -f"
