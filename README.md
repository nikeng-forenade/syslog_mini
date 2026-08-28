# Syslog Server (Node.js, zero dependencies)

Small, light syslog server designed to run in an LXC container on Proxmox.

- UDP + TCP syslog receivers (port 514), RFC 3164 + RFC 5424
- One JSON Lines file per day: `logs/YYYY-MM-DD.jsonl` (auto-rotates at midnight)
- Fast web GUI + REST API (port 8080), single static file
- Delete a whole day **or** individual log entries from the GUI
- Optional retention: auto-purge days older than N
- **No dependencies** — Node.js built-ins only, no `npm install`

## Run locally

```bash
node server.js
```

Open `http://localhost:8080`, then send a test message:

```bash
# UDP
logger -n 127.0.0.1 -P 514 -p user.info "hello from localhost"

# TCP
logger -n 127.0.0.1 -T -P 514 -p user.warning "tcp test"
```

## Configuration (env vars)

| Variable            | Default     | Description                                    |
|---------------------|-------------|------------------------------------------------|
| `SYSLOG_HOST`       | `0.0.0.0`   | Bind address for UDP/TCP receivers             |
| `SYSLOG_UDP_PORT`   | `514`       | UDP syslog port                                |
| `SYSLOG_TCP_PORT`   | `514`       | TCP syslog port                                |
| `SYSLOG_HTTP_HOST`  | `0.0.0.0`   | GUI bind address (use `127.0.0.1` for local)   |
| `SYSLOG_HTTP_PORT`  | `8080`      | GUI / API port                                 |
| `SYSLOG_LOG_DIR`    | `./logs`    | Where daily `.jsonl` files are stored          |
| `SYSLOG_RETENTION`  | `0`         | Auto-delete days older than N (0 = keep all)   |
| `SYSLOG_DISK_WARN_PCT` | `5`      | Log an `err` entry when free disk drops below N% |

## REST API

| Method | Path                          | Description                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/api/days`                   | List days with entry counts          |
| GET    | `/api/logs?date=YYYY-MM-DD&q=…&host=…&severity=…&limit=500&offset=0` | Query a day |
| GET    | `/api/export?date=YYYY-MM-DD&q=…&host=…&severity=…` | Download a day as CSV (Excel-ready) |
| DELETE | `/api/logs?date=YYYY-MM-DD`   | Delete a whole day's file            |
| DELETE | `/api/entry?date=YYYY-MM-DD&id=…` | Delete one entry                 |
| GET    | `/api/health`                 | Liveness check                       |

## Deploy on a Proxmox LXC (Debian 12)

Full docs: [`lxc/README-lxc.md`](lxc/README-lxc.md)

### Recommended: paste-and-run on the Proxmox host

Open the **Proxmox shell** and paste (creates the LXC + installs everything):

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/proxmox-create.sh)"
```

It prompts for **Default** (DHCP, GUI 8080, UDP/TCP 514) or **Advanced** (custom
IP, ports, retention, disk size). Non-interactive:

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main/lxc/proxmox-create.sh)" -- \
  200 local-lvm vmbr0 192.168.1.50/24 192.168.1.1 --port 8080 --retention 30
```

Or clone + run locally (no GitHub needed):

```bash
git clone https://github.com/nikeng-forenade/syslog_mini.git /tmp/syslog_mini
cd /tmp/syslog_mini/lxc && bash proxmox-create.sh 200
```

This uses the same `lxc/` layout as your homescreen project:
`proxmox-create.sh` (host) → pushes app files → runs `install.sh` (in-container).

### Alternative: in-container one-shot installer

Copy this folder into the container, then run as root (default LXC user):

```bash
# on the Proxmox host, push the project into the container:
#   pct push <CTID> install-lxc.sh /root/install-lxc.sh
#   pct push <CTID> server.js     /root/server.js
#   pct push <CTID> public        /root/public -r
#   pct enter <CTID>
# or just: scp -r Syslog_lxc root@<lxc-ip>:/root/

# inside the container:
cd /root/Syslog_lxc
bash install-lxc.sh
```

It installs Node.js, copies the app to `/opt/syslog-server`, installs the systemd
service, disables local `rsyslog` to free port 514, and runs a smoke test.

Tunables (set as env vars): `GIT_REPO`, `NODE_MAJOR`, `INSTALL_DIR`, `LOG_DIR`,
`HTTP_PORT`, `RETENTION_DAYS`, `DISABLE_RSYSLOG`, `RUN_SMOKE_TEST`. Example:
`RETENTION_DAYS=7 HTTP_PORT=9080 bash install-lxc.sh`

### Manual install

```bash
# 1. inside the container: install Node.js LTS
apt update && apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 2. copy this project to /opt/syslog-server (git clone or scp)

# 3. install and start the service
mkdir -p /var/log/syslog-server
cp syslog-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now syslog-server

# 4. verify
ss -ulnp | grep 514
journalctl -u syslog-server -f
```

If the container's `rsyslog` still listens on 514 and conflicts: `systemctl disable --now rsyslog`.

Firewall: allow UDP/TCP 514 (and 8080, or bind the GUI to `127.0.0.1` and SSH-tunnel).

### Forward from clients

- **rsyslog** — `/etc/rsyslog.d/50-forward.conf`:
  ```
  *.* @192.168.1.50:514    # UDP (single @)  |  @@ for TCP
  ```
- **syslog-ng**:
  ```
  destination d_syslog { network("192.168.1.50" port(514) transport("udp")); };
  log { source(s_sys); destination(d_syslog); };
  ```

## Notes

- Port 514 is privileged (<1024). Root in an LXC can bind it; for a non-root user add
  `AmbientCapabilities=CAP_NET_BIND_SERVICE` to the unit or raise the port via `SYSLOG_UDP_PORT`/`SYSLOG_TCP_PORT`.
- TCP uses newline framing (RFC 6587 octet-counting is not implemented — fine for rsyslog/syslog-ng).
- Deleting an entry rewrites that day's file (temp file + atomic rename), O(n) — fine for small/medium volumes.
- Day files are named by the container's **local time**.
