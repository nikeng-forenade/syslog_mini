#!/usr/bin/env node
'use strict';
// Zero-dependency syslog server for a light LXC container.
//  - UDP + TCP receivers on port 514 (RFC 3164 + RFC 5424)
//  - SQLite storage (built-in node:sqlite) in one DB file: <SYSLOG_LOG_DIR>/syslog.db
//  - web GUI + REST API on port 8080 (single static file in ./public)
//  - per-day and per-entry delete, optional retention sweep
//  - live stream (SSE) to the GUI + alert rules with webhook (Discord/Telegram/generic)
//  - optional Basic Auth for the GUI + API (SYSLOG_USERNAME / SYSLOG_PASSWORD)
//  - requires Node.js >= 22.5 for node:sqlite (recommended: Node 24 LTS)
//
// Env vars:
//   SYSLOG_HOST        bind address for UDP/TCP receivers (default 0.0.0.0)
//   SYSLOG_UDP_PORT    default 514
//   SYSLOG_TCP_PORT    default 514
//   SYSLOG_HTTP_HOST   GUI bind address (default 0.0.0.0; use 127.0.0.1 for local-only)
//   SYSLOG_HTTP_PORT   default 8080
//   SYSLOG_LOG_DIR     default ./logs  (holds syslog.db + hosts.json)
//   SYSLOG_RETENTION   auto-delete days older than N (0 = keep all)
//   SYSLOG_USERNAME / SYSLOG_PASSWORD   enable Basic Auth on GUI + API (both required)
//   SYSLOG_ALERTS_FILE alert rules JSON (default <LOG_DIR>/alerts.json)
const http      = require('http');
const dgram     = require('dgram');
const net       = require('net');
const fs        = require('fs');
const fsp       = fs.promises;
const path      = require('path');
const os        = require('os');
const crypto    = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { execFile, exec } = require('child_process');

const VERSION = '1.6.1'; // bump on every release; shown in the GUI header

const HOST      = process.env.SYSLOG_HOST       || '0.0.0.0';
const UDP_PORT  = Number(process.env.SYSLOG_UDP_PORT  || 514);
const TCP_PORT  = Number(process.env.SYSLOG_TCP_PORT  || 514);
const HTTP_HOST = process.env.SYSLOG_HTTP_HOST  || '0.0.0.0';
const HTTP_PORT = Number(process.env.SYSLOG_HTTP_PORT || 8080);
const LOG_DIR   = process.env.SYSLOG_LOG_DIR || path.join(__dirname, 'logs');
const PUBLIC    = path.join(__dirname, 'public');
const RETENTION = Number(process.env.SYSLOG_RETENTION || 0); // days, 0 = keep all

// ---------- optional HTTP Basic Auth (GUI + API + SSE) ----------
const AUTH_USER = process.env.SYSLOG_USERNAME || '';
const AUTH_PASS = process.env.SYSLOG_PASSWORD || '';
const AUTH_ENABLED = !!(AUTH_USER && AUTH_PASS);
const AUTH_REALM = 'syslog';
const authExpected = AUTH_ENABLED ? Buffer.from(`${AUTH_USER}:${AUTH_PASS}`) : null;

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- SQLite storage (built-in node:sqlite) ----------
const DB_FILE = process.env.SYSLOG_DB_FILE || path.join(LOG_DIR, 'syslog.db');
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS logs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms    INTEGER NOT NULL,
    date     TEXT    NOT NULL,
    host     TEXT    NOT NULL DEFAULT '',
    facility TEXT    NOT NULL DEFAULT '',
    severity TEXT    NOT NULL DEFAULT '',
    tag      TEXT    NOT NULL DEFAULT '',
    msg      TEXT    NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_logs_date ON logs(date, ts_ms);
  CREATE INDEX IF NOT EXISTS idx_logs_host ON logs(host);
  CREATE INDEX IF NOT EXISTS idx_logs_sev  ON logs(severity);
`);
const insertLog = db.prepare(
  'INSERT INTO logs (ts_ms, date, host, facility, severity, tag, msg) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const rowToEntry = (r) => ({
  id: r.id, ts: new Date(r.ts_ms).toISOString(),
  host: r.host, facility: r.facility, severity: r.severity, tag: r.tag, msg: r.msg
});

// ---------- self-monitoring (disk full warning) ----------
const DISK_WARN_PCT = Number(process.env.SYSLOG_DISK_WARN_PCT || 5); // % free that triggers an err entry
let diskLow = false;

function logSelf(severity, msg) {
  store({ ts: new Date().toISOString(), host: os.hostname(), facility: 'syslog', severity, tag: 'syslog', msg }, null);
}

function diskFreePct() {
  try {
    const s = fs.statfsSync(LOG_DIR);
    const total = s.blocks * s.bsize;
    return total ? (s.bavail * s.bsize) / total * 100 : 100;
  } catch { return 100; }
}

function checkDisk() {
  const pct = diskFreePct();
  if (pct < DISK_WARN_PCT && !diskLow) {
    diskLow = true;
    logSelf('err', `DISK ALMOST FULL: only ${pct.toFixed(1)}% disk space free`);
    console.error(`[syslog] disk almost full: ${pct.toFixed(1)}% free`);
  } else if (pct >= DISK_WARN_PCT && diskLow) {
    diskLow = false;
    logSelf('info', `Disk space OK: ${pct.toFixed(1)}% free`);
    console.log(`[syslog] disk recovered: ${pct.toFixed(1)}% free`);
  }
}

// ---------- parsing (RFC 3164 + RFC 5424) ----------
const FACILITIES = ['kern','user','mail','daemon','auth','syslog','lpr','news','uucp',
  'cron','authpriv','ftp','ntp','logaudit','logalert','clock','local0','local1','local2',
  'local3','local4','local5','local6','local7'];
const SEVERITIES = ['emerg','alert','crit','err','warning','notice','info','debug'];

function parse(buf, rinfo) {
  const m = buf.toString('utf8').replace(/\r?\n$/, '');
  let pri = 14; // default: user.info
  let body = m;
  const pm = m.match(/^<(\d{1,3})>(.*)$/s);
  if (pm) { pri = Number(pm[1]); body = pm[2]; }
  const facility = FACILITIES[pri >> 3]  || String(pri >> 3);
  const severity = SEVERITIES[pri & 7]   || String(pri & 7);

  let ts = new Date().toISOString();
  let host = (rinfo && rinfo.address) || '-';
  let tag = '-', msg = body;
  const rfc5424 = body.match(/^1\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/s);
  if (rfc5424) {
    ts = new Date(rfc5424[1]).toISOString();
    host = rfc5424[2]; tag = rfc5424[3]; msg = rfc5424[7];
  } else {
    const rfc3164 = body.match(/^([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s:]+)(?:\[\d+\])?:\s*(.*)$/s);
    if (rfc3164) {
      const t = new Date(`${dateStr()} ${rfc3164[1]}`);
      if (!isNaN(t)) ts = t.toISOString();
      host = rfc3164[2]; tag = rfc3164[3]; msg = rfc3164[4];
    }
  }
  return {
    id: crypto.createHash('sha1').update(`${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12),
    ts, host, facility, severity, tag, msg: msg.trim()
  };
}

// ---------- host tracking (online/offline counters) ----------
const HOST_ONLINE_MS = Number(process.env.SYSLOG_HOST_ONLINE_MS || 60000); // default: seen within 60s = online
const HOST_CONFIG_FILE = path.join(LOG_DIR, 'hosts.json'); // per-host overrides, persisted
const hosts = new Map();        // host -> { lastSeen, sourceIp, pingOk, pingAt }
const hostConfigs = new Map();  // host -> { onlineMs } (0/absent = use default)

// Ping liveness: a host is online if it answers ping OR sent logs recently.
const PING_ENABLED = process.env.SYSLOG_PING !== '0';
const PING_INTERVAL_MS = Number(process.env.SYSLOG_PING_INTERVAL || 15000);
const PING_TIMEOUT_S = Number(process.env.SYSLOG_PING_TIMEOUT || 2);
const PING_WINDOW_MS = Math.max(Number(process.env.SYSLOG_PING_WINDOW || 60000), PING_INTERVAL_MS * 2);

function pingTarget(target) {
  return new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', String(PING_TIMEOUT_S), target], { timeout: (PING_TIMEOUT_S + 1) * 1000 }, (err) => resolve(!err));
  });
}

async function pingLoop() {
  const now = Date.now();
  await Promise.all([...hosts.entries()].map(async ([key, rec]) => {
    if (!hostPingEnabled(key)) { rec.pingOk = false; rec.pingAt = now; return; }
    const target = rec.sourceIp || (/^\d+\.\d+\.\d+\.\d+$/.test(key) ? key : null);
    if (!target) { rec.pingOk = false; rec.pingAt = now; return; }
    rec.pingOk = await pingTarget(target);
    rec.pingAt = now;
  }));
}

function loadHostConfigs() {
  try {
    const data = JSON.parse(fs.readFileSync(HOST_CONFIG_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data)) {
      const ms = Number(v && v.onlineMs);
      const pms = Number(v && v.pingMs);
      const ping = v && v.ping !== undefined ? !!v.ping : true;
      hostConfigs.set(k, { onlineMs: (Number.isFinite(ms) && ms > 0) ? ms : null, pingMs: (Number.isFinite(pms) && pms > 0) ? pms : null, ping });
    }
  } catch {}
}

function saveHostConfigs() {
  const obj = {};
  for (const [k, v] of hostConfigs) obj[k] = { onlineMs: v.onlineMs || null, pingMs: v.pingMs || null, ping: v.ping === false ? false : true };
  try { fs.writeFileSync(HOST_CONFIG_FILE, JSON.stringify(obj, null, 2)); } catch {}
}

function hostPingEnabled(host) {
  const c = hostConfigs.get(host);
  return c ? c.ping !== false : PING_ENABLED;
}

function effectiveOnlineMs(host) {
  const c = hostConfigs.get(host);
  return (c && c.onlineMs) || HOST_ONLINE_MS;
}

function effectivePingMs(host) {
  const c = hostConfigs.get(host);
  return (c && c.pingMs) || PING_WINDOW_MS;
}

function noteHost(host, rinfo) {
  const key = (host && host !== '-') ? host : ((rinfo && rinfo.address) || 'unknown');
  const rec = hosts.get(key) || { lastSeen: 0, sourceIp: null, pingOk: false, pingAt: 0 };
  rec.lastSeen = Date.now();
  if (rinfo && rinfo.address) rec.sourceIp = rinfo.address;
  hosts.set(key, rec);
}

function pruneHosts() {
  const cutoff = Date.now() - 864e5; // forget hosts silent for 24h
  for (const [k, rec] of hosts) if (rec.lastSeen < cutoff) hosts.delete(k);
  while (hosts.size > 5000) { // hard cap, drop oldest
    let oldest = null;
    for (const [k, rec] of hosts) if (!oldest || rec.lastSeen < oldest.lastSeen) oldest = { k, lastSeen: rec.lastSeen };
    if (!oldest) break;
    hosts.delete(oldest.k);
  }
}

function hostCounts() {
  const now = Date.now();
  const online = [], offline = [];
  for (const [k, rec] of hosts) {
    const onlineMs = effectiveOnlineMs(k);
    const pingMs = effectivePingMs(k);
    const pingOn = hostPingEnabled(k);
    const logActive = (now - rec.lastSeen) < onlineMs;
    const pingActive = pingOn && rec.pingOk && (now - rec.pingAt) < pingMs;
    const isOnline = logActive || pingActive;
    const item = {
      host: k, online: isOnline, onlineMs, pingMs,
      configuredMs: (hostConfigs.get(k) || {}).onlineMs || null,
      configuredPingMs: (hostConfigs.get(k) || {}).pingMs || null,
      lastSeen: rec.lastSeen, lastSeenAgoMs: now - rec.lastSeen,
      ping: pingOn, pingOk: !!rec.pingOk, pingAt: rec.pingAt, pingAgoMs: rec.pingAt ? now - rec.pingAt : null,
      via: isOnline ? (pingActive ? 'ping' : 'logs') : 'none',
    };
    (isOnline ? online : offline).push(item);
  }
  online.sort((a, b) => a.host.localeCompare(b.host));
  offline.sort((a, b) => a.host.localeCompare(b.host));
  return { online, offline, onlineCount: online.length, offlineCount: offline.length };
}

async function hostsInLogs() {
  const set = new Set();
  for (const k of hosts.keys()) if (k && k !== '-' && k !== 'unknown') set.add(k);
  for (const r of db.prepare(`SELECT DISTINCT host FROM logs WHERE host != '' AND host != '-' AND host != 'unknown'`).all()) set.add(r.host);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function store(entry, rinfo) {
  noteHost(entry.host, rinfo);
  const t = new Date(entry.ts).getTime();
  const tsMs = Number.isFinite(t) ? t : Date.now();
  const d = dateStr(new Date(tsMs));
  let id = null;
  try {
    const info = insertLog.run(tsMs, d, entry.host, entry.facility, entry.severity, entry.tag, entry.msg);
    id = info.lastInsertRowid;
  } catch (e) { console.error('store failed:', e); }
  const row = { id, ts: entry.ts, date: d, host: entry.host, facility: entry.facility, severity: entry.severity, tag: entry.tag, msg: entry.msg };
  sseBroadcast(row);
  checkAlerts(row);
}

// ---------- live stream (SSE) ----------
const sseClients = new Set();
const SSE_MAX = Number(process.env.SYSLOG_SSE_MAX || 50);

function sseBroadcast(data) {
  const payload = `event: log\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) { try { res.write(payload); } catch {} }
}

function handleStream(res) {
  if (sseClients.size >= SSE_MAX) { res.writeHead(503); return res.end('busy'); }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, version: VERSION })}\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  const drop = () => { clearInterval(hb); sseClients.delete(res); };
  res.on('close', drop);
  res.on('error', drop);
}

// ---------- alert rules (webhook) ----------
const ALERTS_FILE = process.env.SYSLOG_ALERTS_FILE || path.join(LOG_DIR, 'alerts.json');
let alertRules = [];
const alertCooldowns = new Map(); // rule.id -> last fired ms

function loadAlerts() {
  try { alertRules = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')); } catch {}
  if (!Array.isArray(alertRules)) alertRules = [];
}
function saveAlerts() { try { fs.writeFileSync(ALERTS_FILE, JSON.stringify(alertRules, null, 2)); } catch {} }
const newRuleId = () => crypto.randomBytes(6).toString('hex');

const sevIndex = (sev) => { const i = SEVERITIES.indexOf(sev); return i === -1 ? 7 : i; };

function matchRule(rule, e) {
  if (rule.enabled === false) return false;
  if (rule.minSeverity && sevIndex(e.severity) > sevIndex(rule.minSeverity)) return false;
  if (rule.host && e.host !== rule.host) return false;
  if (rule.tag && e.tag !== rule.tag) return false;
  if (rule.msgPattern) { try { if (!new RegExp(rule.msgPattern).test(e.msg)) return false; } catch { return false; } }
  return true;
}

async function sendAlert(rule, e) {
  const ts = new Date(e.ts).toLocaleString();
  const text = `🚨 [${rule.name || 'syslog'}] ${e.host} ${e.facility}.${e.severity} ${e.tag}: ${e.msg} (${ts})`;
  const kind = (rule.webhookKind || 'generic').toLowerCase();
  let url = rule.webhook || '';
  let body;
  try {
    if (kind === 'discord') body = JSON.stringify({ content: text });
    else if (kind === 'telegram') {
      const u = new URL(url);
      const chatId = u.searchParams.get('chat_id');
      u.searchParams.delete('chat_id');
      url = u.toString();
      body = JSON.stringify({ chat_id: chatId || undefined, text });
    } else body = JSON.stringify({ text, host: e.host, severity: e.severity, tag: e.tag, msg: e.msg, ts: e.ts, rule: rule.name || 'syslog' });
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
    if (!res.ok) console.error(`[alerts] ${rule.name || rule.id}: webhook HTTP ${res.status}`);
  } catch (err) { console.error(`[alerts] ${rule.name || rule.id}:`, err.message); }
}

function checkAlerts(e) {
  for (const rule of alertRules) {
    if (!matchRule(rule, e)) continue;
    const cooldownMs = Math.max(Number(rule.cooldownSec) || 0, 0) * 1000;
    const now = Date.now();
    if (cooldownMs && (alertCooldowns.get(rule.id) || 0) + cooldownMs > now) continue;
    alertCooldowns.set(rule.id, now);
    sendAlert(rule, e);
  }
}

// ---------- receivers ----------
const udp = dgram.createSocket('udp4');
udp.on('message', (b, r) => { try { store(parse(b, r), r); } catch {} });
udp.on('error', (e) => console.error('UDP error:', e));
udp.bind(UDP_PORT, HOST);

net.createServer((sock) => {
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { try { store(parse(Buffer.from(line), { address: sock.remoteAddress }), { address: sock.remoteAddress }); } catch {} }
    }
  });
}).listen(TCP_PORT, HOST);

// ---------- API ----------
const sendJSON = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(b);
};

function authOk(req) {
  if (!AUTH_ENABLED) return true;
  const m = (req.headers.authorization || '').match(/^Basic\s+(.+)$/i);
  if (!m) return false;
  let got;
  try { got = Buffer.from(m[1], 'base64'); } catch { return false; }
  const a = Buffer.from(authExpected);
  const b = got.length === a.length ? got : Buffer.alloc(a.length);
  return got.length === a.length && crypto.timingSafeEqual(a, b);
}

function send401(res) {
  res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': `Basic realm="${AUTH_REALM}"` });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(new Error('invalid json')); } });
    req.on('error', reject);
  });
}

// ---------- backups ----------
const APP_DIR = process.env.SYSLOG_APP_DIR || __dirname;
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const UPDATE_BASE = process.env.SYSLOG_UPDATE_BASE || 'https://raw.githubusercontent.com/nikeng-forenade/syslog_mini/main';
let backupKeep = Number(process.env.SYSLOG_BACKUP_KEEP || 3);

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (Number.isFinite(Number(s.backupKeep)) && Number(s.backupKeep) >= 0) backupKeep = Math.min(Number(s.backupKeep), 50);
  } catch {}
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ backupKeep }, null, 2)); } catch {}
}

function dirSize(dir) {
  let total = 0;
  try { for (const f of fs.readdirSync(dir)) { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) total += st.size; } } catch {}
  return total;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, size: dirSize(path.join(BACKUP_DIR, d.name)) }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pruneBackups() {
  if (backupKeep <= 0 || !fs.existsSync(BACKUP_DIR)) return;
  const dirs = fs.readdirSync(BACKUP_DIR)
    .filter((n) => { try { return fs.statSync(path.join(BACKUP_DIR, n)).isDirectory(); } catch { return false; } })
    .sort();
  while (dirs.length > backupKeep) { const oldest = dirs.shift(); try { fs.rmSync(path.join(BACKUP_DIR, oldest), { recursive: true, force: true }); } catch {} }
}

function buildWhere(date, q, host, severity) {
  const conds = [], params = [];
  if (date && date !== 'all') { conds.push('date = ?'); params.push(date); }
  if (q) { conds.push('(msg LIKE ? OR tag LIKE ?)'); const like = `%${q}%`; params.push(like, like); }
  if (host) { conds.push('host = ?'); params.push(host); }
  const sevs = (severity || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (sevs.length) { conds.push(`severity IN (${sevs.map(() => '?').join(',')})`); params.push(...sevs); }
  return { where: conds.length ? ' WHERE ' + conds.join(' AND ') : '', params };
}

async function readLogs(date, { q, host, severity, limit, offset, order }) {
  const { where, params } = buildWhere(date, q, host, severity);
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  const total = db.prepare(`SELECT COUNT(*) c FROM logs${where}`).get(...params).c;
  const rows = db.prepare(`SELECT * FROM logs${where} ORDER BY ts_ms ${dir}, id ${dir} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { total, logs: rows.map(rowToEntry) };
}

// ── CSV export ─────────────────────────────────────────────
const csvField = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function exportLogsCsv(res, date, { q, host, severity, order }) {
  res.on('error', () => {}); // client disconnected mid-stream
  const filename = `syslog-${date}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.write('\uFEFF'); // UTF-8 BOM so Excel opens it correctly
  const { where, params } = buildWhere(date, q, host, severity);
  const rows = db.prepare(`SELECT * FROM logs${where} ORDER BY ts_ms ASC, id ASC`).all(...params);
  if (order === 'desc') rows.reverse();
  res.write('timestamp,host,facility,severity,tag,message\n');
  for (const r of rows) res.write([new Date(r.ts_ms).toISOString(), r.host, r.facility, r.severity, r.tag, r.msg].map(csvField).join(',') + '\n');
  return res.end();
}

function deleteEntry(date, id) {
  const r = db.prepare('DELETE FROM logs WHERE id = ?').run(id);
  return r.changes > 0;
}

async function serveStatic(res, p) {
  const map = { '/': 'index.html' };
  let file = path.join(PUBLIC, map[p] || p);
  if (!file.startsWith(PUBLIC)) { sendJSON(res, 403, { error: 'forbidden' }); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { sendJSON(res, 404, { error: 'not found' }); return; }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function sweep() {
  if (!RETENTION) return;
  const cutoff = dateStr(new Date(Date.now() - RETENTION * 864e5));
  const r = db.prepare('DELETE FROM logs WHERE date < ?').run(cutoff);
  if (r.changes) console.log(`[syslog] retention: purged ${r.changes} entries older than ${cutoff}`);
}

function daysList() {
  return db.prepare(`
    SELECT date, COUNT(*) AS count,
           SUM(LENGTH(msg) + LENGTH(host) + LENGTH(tag) + LENGTH(facility) + LENGTH(severity) + 96) AS size
    FROM logs GROUP BY date
  `).all();
}

function backupDb(dir) {
  try {
    const target = path.join(dir, 'syslog.db');
    fs.rmSync(target, { force: true }); // VACUUM INTO requires the target to not exist
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } catch (e) { console.error('db snapshot failed:', e); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, s = url.searchParams;
  if (!authOk(req)) return send401(res);
  try {
    if (p === '/api/stream' && req.method === 'GET') return handleStream(res);
    if (p === '/api/days') {
      const days = daysList().sort((a, b) => b.date.localeCompare(a.date));
      return sendJSON(res, 200, { days });
    }
    if (p === '/api/logs' && req.method === 'GET') {
      const date = s.get('date') || 'all';
      const r = await readLogs(date, {
        q: s.get('q') || '', host: s.get('host') || '', severity: s.get('severity') || '',
        limit: Math.min(Number(s.get('limit') || 500), 5000), offset: Number(s.get('offset') || 0),
        order: s.get('order') === 'desc' ? 'desc' : 'asc' });
      return sendJSON(res, 200, { date, ...r });
    }
    if (p === '/api/export') {
      const date = s.get('date') || 'all';
      return exportLogsCsv(res, date, {
        q: s.get('q') || '', host: s.get('host') || '', severity: s.get('severity') || '',
        order: s.get('order') === 'desc' ? 'desc' : 'asc' });
    }
    if (p === '/api/logs/all' && req.method === 'DELETE') {
      const r = db.prepare('DELETE FROM logs').run();
      return sendJSON(res, 200, { ok: true, deleted: 'all', count: r.changes });
    }
    if (p === '/api/logs' && req.method === 'DELETE') {
      const date = s.get('date');
      const r = db.prepare('DELETE FROM logs WHERE date = ?').run(date);
      return sendJSON(res, 200, { ok: true, deleted: date, count: r.changes });
    }
    if (p === '/api/entry' && req.method === 'DELETE') {
      const ok = await deleteEntry(s.get('date'), s.get('id'));
      return sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    }
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, uptime: process.uptime(), version: VERSION, auth: AUTH_ENABLED });
    if (p === '/api/disk') {
      let total = 0, free = 0;
      try { const s = fs.statfsSync(LOG_DIR); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch (e) {}
      const used = Math.max(0, total - free);
      return sendJSON(res, 200, { ok: true, total, free, used, percent: total ? Math.round(used / total * 100) : 0 });
    }
    if (p === '/api/hosts') {
      pruneHosts();
      return sendJSON(res, 200, { ...hostCounts() });
    }
    if (p === '/api/hosts/all') {
      return sendJSON(res, 200, { hosts: await hostsInLogs() });
    }
    if (p === '/api/hosts/config' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body.host) return sendJSON(res, 400, { error: 'host required' });
      const onlineMs = Math.min(Math.max(Number(body.onlineMs) || 0, 0), 86400000);
      const pingMs = Math.min(Math.max(Number(body.pingMs) || 0, 0), 86400000);
      const cur = hostConfigs.get(body.host) || {};
      const ping = body.ping === undefined ? (cur.ping === undefined ? true : cur.ping) : !!body.ping;
      if (onlineMs === 0 && pingMs === 0 && ping === true) hostConfigs.delete(body.host);
      else hostConfigs.set(body.host, { onlineMs: onlineMs || null, pingMs: pingMs || null, ping });
      saveHostConfigs();
      return sendJSON(res, 200, { ok: true, host: body.host, onlineMs: onlineMs || null, pingMs: pingMs || null, ping });
    }
    if (p === '/api/alerts' && req.method === 'GET') return sendJSON(res, 200, { alerts: alertRules });
    if (p === '/api/alerts' && req.method === 'PUT') {
      const body = await readBody(req);
      if (!body.webhook) return sendJSON(res, 400, { error: 'webhook URL required' });
      if (body.id) {
        const idx = alertRules.findIndex((r) => r.id === body.id);
        if (idx === -1) return sendJSON(res, 404, { error: 'rule not found' });
        alertRules[idx] = { ...alertRules[idx], ...body };
      } else {
        alertRules.push({ id: newRuleId(), enabled: true, minSeverity: 'err', host: '', tag: '', msgPattern: '', cooldownSec: 60, webhookKind: 'generic', ...body });
      }
      saveAlerts();
      return sendJSON(res, 200, { ok: true, alerts: alertRules });
    }
    if (p === '/api/alerts' && req.method === 'DELETE') {
      const id = s.get('id');
      alertRules = alertRules.filter((r) => r.id !== id);
      saveAlerts();
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/alerts/test' && req.method === 'POST') {
      const body = await readBody(req);
      const r = body.rule || {};
      sendAlert({ id: 'test', enabled: true, name: r.name || 'test', minSeverity: r.minSeverity || 'err', host: r.host || '', tag: r.tag || '', msgPattern: r.msgPattern || '', webhookKind: r.webhookKind || 'generic', webhook: r.webhook }, {
        ts: new Date().toISOString(), date: dateStr(), host: os.hostname() || 'syslog', facility: 'syslog', severity: 'err', tag: 'alert-test', msg: 'Test webhook from the syslog server',
      });
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/backups' && req.method === 'GET') {
      return sendJSON(res, 200, { backups: listBackups(), keep: backupKeep });
    }
    if (p === '/api/backups' && req.method === 'DELETE') {
      const name = path.basename(s.get('name') || '');
      const target = path.join(BACKUP_DIR, name);
      if (!name || !target.startsWith(BACKUP_DIR)) return sendJSON(res, 400, { error: 'invalid backup name' });
      await fsp.rm(target, { recursive: true, force: true });
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/backups/all' && req.method === 'DELETE') {
      await fsp.rm(BACKUP_DIR, { recursive: true, force: true });
      return sendJSON(res, 200, { ok: true });
    }
    if (p === '/api/backups/keep' && req.method === 'PUT') {
      const body = await readBody(req);
      const k = Number(body.keep);
      if (!Number.isFinite(k) || k < 0) return sendJSON(res, 400, { error: 'keep >= 0 required' });
      backupKeep = Math.min(k, 50);
      saveSettings();
      pruneBackups();
      return sendJSON(res, 200, { ok: true, keep: backupKeep });
    }
    if (p === '/api/backups/restore' && req.method === 'POST') {
      const body = await readBody(req);
      const name = path.basename(body.name || '');
      const src = path.join(BACKUP_DIR, name);
      if (!name || !src.startsWith(BACKUP_DIR) || !fs.existsSync(src)) return sendJSON(res, 404, { error: 'backup not found' });
      const restored = [];
      if (fs.existsSync(path.join(src, 'server.js'))) { await fsp.copyFile(path.join(src, 'server.js'), path.join(APP_DIR, 'server.js')); restored.push('server.js'); }
      if (fs.existsSync(path.join(src, 'index.html'))) { await fsp.copyFile(path.join(src, 'index.html'), path.join(APP_DIR, 'public', 'index.html')); restored.push('index.html'); }
      if (fs.existsSync(path.join(src, 'syslog.db'))) {
        try { db.close(); await fsp.copyFile(path.join(src, 'syslog.db'), DB_FILE); restored.push('syslog.db (logs)'); }
        catch (e) { console.error('db restore failed:', e); }
      }
      setTimeout(() => { try { exec('systemctl restart syslog-server', () => {}); } catch {} }, 400);
      return sendJSON(res, 200, { ok: true, restored, restarting: true });
    }
    if (p === '/api/update' && req.method === 'POST') {
      const [srvRes, htmlRes] = await Promise.all([
        fetch(UPDATE_BASE + '/server.js', { signal: AbortSignal.timeout(15000) }),
        fetch(UPDATE_BASE + '/public/index.html', { signal: AbortSignal.timeout(15000) }),
      ]);
      if (!srvRes.ok) return sendJSON(res, 502, { error: 'failed to download server.js' });
      if (!htmlRes.ok) return sendJSON(res, 502, { error: 'failed to download index.html' });
      const serverJs = await srvRes.text();
      const indexHtml = await htmlRes.text();
      if (!serverJs.includes('VERSION')) return sendJSON(res, 502, { error: 'downloaded server.js looks invalid' });
      const p2 = (n) => String(n).padStart(2, '0');
      const nw = new Date();
      const TS = `${nw.getFullYear()}${p2(nw.getMonth() + 1)}${p2(nw.getDate())}-${p2(nw.getHours())}${p2(nw.getMinutes())}${p2(nw.getSeconds())}`;
      const BACKUP = path.join(BACKUP_DIR, TS);
      await fsp.mkdir(BACKUP, { recursive: true });
      await fsp.copyFile(path.join(APP_DIR, 'server.js'), path.join(BACKUP, 'server.js'));
      await fsp.copyFile(path.join(APP_DIR, 'public', 'index.html'), path.join(BACKUP, 'index.html'));
      backupDb(BACKUP);
      await fsp.writeFile(path.join(APP_DIR, 'server.js'), serverJs);
      await fsp.writeFile(path.join(APP_DIR, 'public', 'index.html'), indexHtml);
      pruneBackups();
      setTimeout(() => { try { exec('systemctl restart syslog-server', () => {}); } catch {} }, 500);
      return sendJSON(res, 200, { ok: true, backup: TS, restarting: true });
    }
    return serveStatic(res, p);
  } catch (e) { console.error(e); sendJSON(res, 500, { error: e.message }); }
}).listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`syslog up — UDP/TCP :${UDP_PORT}/${TCP_PORT}, GUI http://${HTTP_HOST}:${HTTP_PORT}, db ${DB_FILE}`);
  sweep();
  checkDisk();
  setInterval(() => { sweep(); pruneHosts(); }, 3600e3).unref();
  setInterval(() => { checkDisk(); }, 15 * 60e3).unref();
});

loadHostConfigs();
loadAlerts();
loadSettings();
if (PING_ENABLED) {
  pingLoop().catch(() => {});
  setInterval(() => { pingLoop().catch(() => {}); }, PING_INTERVAL_MS).unref();
}
