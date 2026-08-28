# 📟 Syslog Server — LXC Deployment

Fast, light syslog server for a Proxmox LXC: UDP+TCP receiver (RFC 3164/5424),
one file per day, web GUI, per-day + per-entry delete. Zero npm dependencies.

## Option 1: Proxmox VE — Paste & Run

**Open your Proxmox shell and paste:**

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/proxmox-create.sh)"
```

You'll be prompted for **Default** (DHCP, GUI port 8080, UDP/TCP 514) or **Advanced** setup.

**Or non-interactive with custom options:**

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/proxmox-create.sh)" -- \
  200 local-lvm vmbr0 192.168.1.50/24 192.168.1.1 --port 8080 --retention 30
```

**Or clone + run locally:**

```bash
git clone https://github.com/nikeng-forenade/syslog_mini.git /tmp/syslog_mini
cd /tmp/syslog_mini/lxc
bash proxmox-create.sh 200
```

> Hosting elsewhere? Set `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH` env vars
> (or just use the local-clone method above).

## Option 2: Any LXC / LXD host

```bash
# 1. Create a Debian 12 LXC container via your platform

# 2. Copy the project in and run the installer as root:
bash lxc/install.sh
# Or with options:
bash lxc/install.sh --port 8080 --udp-port 5514 --retention 7
```

## Option 3: Manual setup inside a Debian/Ubuntu LXC

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Copy the project to /opt/syslog-server, then:
mkdir -p /var/log/syslog-server
cp lxc/syslog-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now syslog-server
```

## Install Script Options

| Option | Description |
|--------|-------------|
| `--port PORT` | GUI/API HTTP port (default: 8080) |
| `--udp-port PORT` | UDP syslog port (default: 514) |
| `--tcp-port PORT` | TCP syslog port (default: 514) |
| `--log-dir DIR` | Log storage dir, one `.jsonl` per day (default: `/var/log/syslog-server`) |
| `--retention DAYS` | Auto-delete days older than N (default: 30, 0 = keep all) |
| `--keep-rsyslog` | Don't disable local rsyslog (may conflict on port 514) |
| `--help` | Show usage help |

## Proxmox Script Options

```
./proxmox-create.sh <CT_ID> [STORAGE] [BRIDGE] [IP/CIDR] [GATEWAY] [--install-opts...]
```

| Argument | Default | Description |
|----------|---------|-------------|
| `CT_ID` | `200` | Container ID |
| `STORAGE` | `local-lvm` | Proxmox storage pool |
| `BRIDGE` | `vmbr0` | Network bridge |
| `IP/CIDR` | `dhcp` | Static IP with CIDR, or `dhcp` |
| `GATEWAY` | *(none)* | Gateway IP (only used with static IP) |
| `--port`, `--udp-port`, `--tcp-port`, `--log-dir`, `--retention`, `--keep-rsyslog` | *(defaults above)* | Forwarded to `install.sh` |

## Updating the syslog app

`proxmox-create.sh` also pushes `lxc/update.sh` into the container (at
`/root/update.sh`). To update to the latest code, from the **Proxmox host**:

```bash
pct exec <CTID> -- bash /root/update.sh
```

Or run it directly from GitHub without a local copy:

```bash
pct exec <CTID> -- bash -c "$(curl -fsSL https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/update.sh)"
```

What it does: re-downloads `server.js` + `public/index.html`, backs up the
current version to `/opt/syslog-server/backups/<timestamp>/`, installs the new
files, and restarts the service. It also self-heals DNS if resolution fails
(injects `1.1.1.1`/`8.8.8.8`). Set `GITHUB_OWNER`/`GITHUB_REPO`/`GITHUB_BRANCH`
if you host it elsewhere.

Old backups are **pruned automatically** — only the newest `BACKUP_KEEP` are kept
(default 3, e.g. `BACKUP_KEEP=5 pct exec <CTID> -- bash /root/update.sh`).

## Defaults

| Setting | Value |
|---------|-------|
| OS | Debian 12 LXC (unprivileged, 1 core, 512 MB, 4 GB disk) |
| GUI | Port 8080 |
| Syslog | UDP + TCP port 514 |
| Logs | `/var/log/syslog-server/YYYY-MM-DD.jsonl` |
| Retention | 30 days (auto-purged) |

## Point your hosts at it

- **rsyslog** — `/etc/rsyslog.d/50-forward.conf`:
  ```
  *.* @<lxc-ip>:514    # UDP (single @)  |  @@ for TCP
  ```
- **syslog-ng**:
  ```
  destination d_syslog { network("<lxc-ip>" port(514) transport("udp")); };
  log { source(s_sys); destination(d_syslog); };
  ```

Firewall: allow UDP/TCP 514 (and 8080 for the GUI) in Proxmox
(Datacenter → node → CT → Firewall).
