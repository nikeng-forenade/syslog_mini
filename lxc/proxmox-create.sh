#!/usr/bin/env bash
# Syslog Server LXC Creator for Proxmox VE
# Paste this in your Proxmox shell:
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/proxmox-create.sh)"
#
# Or with options:
#   bash -c "$(wget -qLO - https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/proxmox-create.sh)" -- --port 8080 --retention 30
#
# Set GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH if you host this elsewhere.
set -e

# ── Source URLs ────────────────────────────────────────────
GITHUB_OWNER="${GITHUB_OWNER:-nikeng-forenade}"
GITHUB_REPO="${GITHUB_REPO:-syslog_mini}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
GITHUB_RAW="https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}"
INSTALL_SCRIPT_URL="${GITHUB_RAW}/lxc/install.sh"
UPDATE_SCRIPT_URL="${GITHUB_RAW}/lxc/update.sh"
SERVER_JS_URL="${GITHUB_RAW}/server.js"
INDEX_HTML_URL="${GITHUB_RAW}/public/index.html"

# ── Detect if running from local clone or URL ──────────────
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$LOCAL_DIR/install.sh" && -f "$LOCAL_DIR/../server.js" ]]; then
  echo "Running from local clone: $LOCAL_DIR"
  INSTALL_SCRIPT="$LOCAL_DIR/install.sh"
  UPDATE_SCRIPT="$LOCAL_DIR/update.sh"
  SERVER_JS="$LOCAL_DIR/../server.js"
  INDEX_HTML="$LOCAL_DIR/../public/index.html"
else
  mkdir -p /tmp/syslog-lxc
  INSTALL_SCRIPT="/tmp/syslog-lxc/install.sh"
  UPDATE_SCRIPT="/tmp/syslog-lxc/update.sh"
  SERVER_JS="/tmp/syslog-lxc/server.js"
  INDEX_HTML="/tmp/syslog-lxc/index.html"
  echo "Downloading scripts from $GITHUB_RAW ..."
  wget -qO "$INSTALL_SCRIPT" "$INSTALL_SCRIPT_URL" || { echo "ERROR: Could not download install.sh from $INSTALL_SCRIPT_URL"; exit 1; }
  wget -qO "$UPDATE_SCRIPT" "$UPDATE_SCRIPT_URL" || { echo "ERROR: Could not download update.sh from $UPDATE_SCRIPT_URL"; exit 1; }
  wget -qO "$SERVER_JS" "$SERVER_JS_URL" || { echo "ERROR: Could not download server.js from $SERVER_JS_URL"; exit 1; }
  wget -qO "$INDEX_HTML" "$INDEX_HTML_URL" || { echo "ERROR: Could not download public/index.html from $INDEX_HTML_URL"; exit 1; }
fi

# ── Defaults ───────────────────────────────────────────────
CT_ID="200"
STORAGE="local-lvm"
BRIDGE="vmbr0"
IP="dhcp"
GATEWAY=""
INSTALL_OPTS=""
MODE="default"

# ── Help ───────────────────────────────────────────────────
show_help() {
  echo "Usage: bash proxmox-create.sh [OPTIONS]"
  echo ""
  echo "Positional (optional):"
  echo "  <CT_ID> <STORAGE> <BRIDGE> <IP/CIDR> <GATEWAY>"
  echo ""
  echo "Options (passed through to install.sh):"
  echo "  --port PORT           GUI/API HTTP port (default: 8080)"
  echo "  --udp-port PORT       UDP syslog port (default: 514)"
  echo "  --tcp-port PORT       TCP syslog port (default: 514)"
  echo "  --log-dir DIR         Log storage dir (default: /var/log/syslog-server)"
  echo "  --retention DAYS      Auto-delete days older than N (default: 30, 0=keep all)"
  echo "  --keep-rsyslog        Keep local rsyslog inside the container"
  echo "  --help                Show this help"
  exit 0
}

# ── Parse args ─────────────────────────────────────────────
POS_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help) show_help ;;
    --port|--udp-port|--tcp-port|--log-dir|--retention)
      INSTALL_OPTS="$INSTALL_OPTS $1 $2"; shift 2 ;;
    --keep-rsyslog)
      INSTALL_OPTS="$INSTALL_OPTS $1"; shift ;;
    --*) echo "Unknown option: $1"; exit 1 ;;
    *)   POS_ARGS+=("$1"); shift ;;
  esac
done

CT_ID="${POS_ARGS[0]:-200}"
STORAGE="${POS_ARGS[1]:-local-lvm}"
BRIDGE="${POS_ARGS[2]:-vmbr0}"
IP="${POS_ARGS[3]:-dhcp}"
GATEWAY="${POS_ARGS[4]:-}"

# ── Interactive setup (no positional args → prompt) ────────
if [[ ${#POS_ARGS[@]} -eq 0 ]] && [[ -z "$INSTALL_OPTS" ]]; then
  echo ""
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │           📟 Syslog Server LXC          │"
  echo "  └─────────────────────────────────────────┘"
  echo ""
  echo "  Default:  DHCP, port 8080, UDP/TCP 514"
  echo "  Advanced: Custom IP, ports, retention"
  echo ""
  read -r -p "  Default [d] or Advanced [a]? (d/a): " MODE
  echo ""

  if [[ "$MODE" =~ ^[Aa]$ ]]; then
    read -r -p "  Container ID [200]: " input; CT_ID="${input:-200}"
    read -r -p "  Storage pool [local-lvm]: " input; STORAGE="${input:-local-lvm}"
    read -r -p "  Network bridge [vmbr0]: " input; BRIDGE="${input:-vmbr0}"
    read -r -p "  IP/CIDR [dhcp]: " input; IP="${input:-dhcp}"
    if [[ "$IP" != "dhcp" ]]; then
      read -r -p "  Gateway IP: " input; GATEWAY="${input:-}"
    fi
    read -r -p "  GUI port [8080]: " input; INSTALL_OPTS="--port ${input:-8080}"
    read -r -p "  Retention days [30] (0=keep all): " input; INSTALL_OPTS="$INSTALL_OPTS --retention ${input:-30}"
  fi
fi

# ── Summary ─────────────────────────────────────────────────
echo ""
echo "=== Syslog Server LXC Setup ==="
echo "CT ID:    $CT_ID"
echo "Storage:  $STORAGE"
echo "Bridge:   $BRIDGE"
echo "IP:       $IP"
[[ -n "$GATEWAY" ]] && echo "Gateway:  $GATEWAY"
[[ -n "$INSTALL_OPTS" ]] && echo "Options:  $INSTALL_OPTS"
echo ""

# ── Host DNS pre-check (template downloads + container apt need DNS) ──
if ! getent hosts deb.debian.org >/dev/null 2>&1; then
  echo "⚠️  DNS resolution is failing on this Proxmox host (deb.debian.org not resolving)."
  echo "    Template download and the in-container apt install will fail."
  echo "    Quick fix:"
  echo "      cp /etc/resolv.conf /etc/resolv.conf.bak"
  echo "      echo 'nameserver 1.1.1.1' > /etc/resolv.conf"
  echo "      echo 'nameserver 8.8.8.8' >> /etc/resolv.conf"
  read -r -p "    Fix DNS now and continue? (y/N): " FIX_DNS
  if [[ "$FIX_DNS" =~ ^[Yy]$ ]]; then
    cp /etc/resolv.conf /etc/resolv.conf.bak 2>/dev/null || true
    printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > /etc/resolv.conf
    getent hosts deb.debian.org >/dev/null 2>&1 && echo "✅ DNS is working now." || echo "⚠️  DNS still failing — check your network."
  else
    echo "Aborting (DNS is required for template + package downloads)."
    exit 1
  fi
fi

# ── Find template storage (must be directory type, not LVM-thin) ─
TEMPLATE_STORAGE="local"
for s in local "$STORAGE"; do
  if pveam list "$s" &>/dev/null; then
    TEMPLATE_STORAGE="$s"
    break
  fi
done

# ── Pick the newest Debian 12 standard template ────────────
TEMPLATE=""
TEMPLATE=$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' | grep -oP 'debian-12-standard_\S+_amd64\.tar\.zst' | sort -V | tail -1 || true)
if [ -z "$TEMPLATE" ]; then
  echo "No local Debian 12 template, checking online catalog..."
  pveam update 2>/dev/null || true
  TEMPLATE=$(pveam available -section system 2>/dev/null | awk '{print $2}' | grep -oP 'debian-12-standard_\S+_amd64\.tar\.zst' | sort -V | tail -1 || true)
fi
[ -n "$TEMPLATE" ] || { echo "ERROR: Debian 12 template not found. Run 'pveam update' and retry."; exit 1; }

if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  echo "Downloading $TEMPLATE to '$TEMPLATE_STORAGE'..."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" || {
    echo "ERROR: Could not download template. Check 'pveam available' on Proxmox."
    exit 1
  }
fi

# ── Sanitize variables (strip CRLF from Windows line endings) ─
sanitize() { echo "$1" | tr -d '\r\n'; }
CT_ID=$(sanitize "$CT_ID")
STORAGE=$(sanitize "$STORAGE")
BRIDGE=$(sanitize "$BRIDGE")
IP=$(sanitize "$IP")
GATEWAY=$(sanitize "$GATEWAY")
TEMPLATE_STORAGE=$(sanitize "$TEMPLATE_STORAGE")

# Auto-append /24 if bare IP entered (Proxmox requires CIDR)
if [[ "$IP" != "dhcp" && "$IP" != */* ]]; then
  IP="${IP}/24"
  echo "Auto-added /24 CIDR → $IP"
fi

# ── Build net0 ─────────────────────────────────────────────
NET0="name=eth0,bridge=${BRIDGE},ip=${IP}"
if [[ "$IP" != "dhcp" && -n "$GATEWAY" ]]; then
  NET0="${NET0},gw=${GATEWAY}"
fi

echo "Creating container with: net0=$NET0"

pct create "$CT_ID" \
  "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "syslog" \
  --rootfs "${STORAGE}:4" \
  --memory "512" \
  --cores "1" \
  --net0 "$NET0" \
  --unprivileged 1 \
  --features "nesting=1" \
  --onboot 1 \
  --start 1

echo ""
echo "Container created. Waiting for boot..."
sleep 10

# ── Install prerequisites in container ─────────────────────
echo "Installing prerequisites..."
pct exec "$CT_ID" -- bash -c "apt-get update && apt-get install -y curl ca-certificates"

# ── Push app files and install/update scripts ─────────────
echo "Pushing app files..."
pct exec "$CT_ID" -- mkdir -p /root/syslog/public
pct push "$CT_ID" "$INSTALL_SCRIPT" /root/install.sh
pct push "$CT_ID" "$UPDATE_SCRIPT" /root/update.sh
pct push "$CT_ID" "$SERVER_JS" /root/syslog/server.js
pct push "$CT_ID" "$INDEX_HTML" /root/syslog/public/index.html

# ── Run install script ─────────────────────────────────────
echo "Running install script..."
if [[ -n "$INSTALL_OPTS" ]]; then
  pct exec "$CT_ID" -- bash /root/install.sh $INSTALL_OPTS
else
  pct exec "$CT_ID" -- bash /root/install.sh
fi

# ── Done ───────────────────────────────────────────────────
IP_ADDR=$(pct exec "$CT_ID" -- ip -4 addr show eth0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
echo ""
echo "=============================================="
echo "  📟 Syslog server is ready!"
echo "  GUI:      http://${IP_ADDR:-<container-ip>}:8080"
echo "  Syslog:   udp://${IP_ADDR:-<container-ip>}:514   (tcp too)"
echo ""
echo "  Point your hosts at it (rsyslog):"
echo "  echo '*.* @${IP_ADDR:-<container-ip>}:514' > /etc/rsyslog.d/50-forward.conf"
echo "=============================================="
