#!/usr/bin/env node
'use strict';
// Zero-dependency syslog server for a light LXC container.
//  - UDP + TCP receivers on port 514 (RFC 3164 + RFC 5424)
//  - one JSON Lines file per day: logs/YYYY-MM-DD.jsonl
//  - web GUI + REST API on port 8080 (single static file in ./public)
//  - per-day and per-entry delete, optional retention sweep
//
// Env vars:
//   SYSLOG_HOST        bind address for UDP/TCP receivers (default 0.0.0.0)
//   SYSLOG_UDP_PORT    default 514
//   SYSLOG_TCP_PORT    default 514
//   SYSLOG_HTTP_HOST   GUI bind address (default 0.0.0.0; use 127.0.0.1 for local-only)
//   SYSLOG_HTTP_PORT   default 8080
//   SYSLOG_LOG_DIR     default ./logs
//   SYSLOG_RETENTION   auto-delete days older than N (0 = keep all)
const http      = require('http');
const dgram     = require('dgram');
const net       = require('net');
const fs        = require('fs');
const fsp       = fs.promises;
const path      = require('path');
const readline  = require('readline');
const crypto    = require('crypto');

const HOST      = process.env.SYSLOG_HOST       || '0.0.0.0';
const UDP_PORT  = Number(process.env.SYSLOG_UDP_PORT  || 514);
const TCP_PORT  = Number(process.env.SYSLOG_TCP_PORT  || 514);
const HTTP_HOST = process.env.SYSLOG_HTTP_HOST  || '0.0.0.0';
const HTTP_PORT = Number(process.env.SYSLOG_HTTP_PORT || 8080);
const LOG_DIR   = process.env.SYSLOG_LOG_DIR || path.join(__dirname, 'logs');
const PUBLIC    = path.join(__dirname, 'public');
const RETENTION = Number(process.env.SYSLOG_RETENTION || 0); // days, 0 = keep all

fs.mkdirSync(LOG_DIR, { recursive: true });

// ---------- daily files ----------
const dayStats = new Map();   // date -> { count, size }
const appendQ  = new Map();   // date -> promise chain (serialize appends)
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fileOf  = (date) => path.join(LOG_DIR, `${date}.jsonl`);

function bump(date, delta, bytes = 0) {
  const s = dayStats.get(date) || { count: 0, size: 0 };
  s.count = Math.max(0, s.count + delta);
  s.size  = Math.max(0, s.size + bytes);
  dayStats.set(date, s);
}

function append(date, line) {
  const prev = appendQ.get(date) || Promise.resolve();
  const next = prev
    .then(() => fsp.appendFile(fileOf(date), line + '\n', 'utf8'))
    .then(() => bump(date, 1, Buffer.byteLength(line) + 1))
    .catch((e) => console.error('append failed:', e));
  appendQ.set(date, next);
  next.finally(() => { if (appendQ.get(date) === next) appendQ.delete(date); });
  return next;
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

const store = (entry) => append(dateStr(new Date(entry.ts)), JSON.stringify(entry));

// ---------- receivers ----------
const udp = dgram.createSocket('udp4');
udp.on('message', (b, r) => store(parse(b, r)).catch(() => {}));
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
      if (line.trim()) store(parse(Buffer.from(line), { address: sock.remoteAddress })).catch(() => {});
    }
  });
}).listen(TCP_PORT, HOST);

// ---------- API ----------
const sendJSON = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(b);
};

async function readLogs(date, { q, host, severity, limit, offset }) {
  if (!fs.existsSync(fileOf(date))) return { total: 0, logs: [] };
  const out = []; let total = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(fileOf(date)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (q && !(e.msg + ' ' + e.tag).toLowerCase().includes(q.toLowerCase())) continue;
    if (host && e.host !== host) continue;
    if (severity && e.severity !== severity) continue;
    total++;
    if (total > offset && out.length < limit) out.push(e);
  }
  return { total, logs: out };
}

// ── CSV export ─────────────────────────────────────────────
const csvField = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

async function exportLogsCsv(res, date, { q, host, severity }) {
  res.on('error', () => {}); // client disconnected mid-stream
  const filename = `syslog-${date}.csv`;
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.write('\uFEFF'); // UTF-8 BOM so Excel opens it correctly
  res.write('timestamp,host,facility,severity,tag,message\n');
  if (!fs.existsSync(fileOf(date))) return res.end();
  const rl = readline.createInterface({ input: fs.createReadStream(fileOf(date)), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (q && !(e.msg + ' ' + e.tag).toLowerCase().includes(q.toLowerCase())) continue;
    if (host && e.host !== host) continue;
    if (severity && e.severity !== severity) continue;
    res.write([e.ts, e.host, e.facility, e.severity, e.tag, e.msg].map(csvField).join(',') + '\n');
  }
  return res.end();
}

async function deleteEntry(date, id) {
  const file = fileOf(date);
  if (!fs.existsSync(file)) return false;
  const tmp = file + '.tmp';
  const w = fs.createWriteStream(tmp);
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  let removed = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { w.write(line + '\n'); continue; }
    if (e.id === id) { removed++; continue; }
    w.write(line + '\n');
  }
  await new Promise((r) => w.end(r));
  await fsp.rename(tmp, file);
  if (removed) bump(date, -removed);
  return removed > 0;
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
  for (const [date] of dayStats) if (date < cutoff) {
    await fsp.unlink(fileOf(date)).catch(() => {});
    dayStats.delete(date);
  }
}

async function scan() {
  for (const f of await fsp.readdir(LOG_DIR).catch(() => [])) {
    if (!f.endsWith('.jsonl')) continue;
    const date = f.slice(0, 10);
    let count = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(fileOf(date)) });
    for await (const line of rl) count++;
    dayStats.set(date, { count, size: (await fsp.stat(fileOf(date))).size });
  }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, s = url.searchParams;
  try {
    if (p === '/api/days') {
      const days = [...dayStats.entries()].sort((a, b) => b[0].localeCompare(a[0]))
        .map(([date, st]) => ({ date, count: st.count, size: st.size }));
      return sendJSON(res, 200, { days });
    }
    if (p === '/api/logs' && req.method === 'GET') {
      const date = s.get('date') || dateStr();
      const r = await readLogs(date, {
        q: s.get('q') || '', host: s.get('host') || '', severity: s.get('severity') || '',
        limit: Math.min(Number(s.get('limit') || 500), 5000), offset: Number(s.get('offset') || 0) });
      return sendJSON(res, 200, { date, ...r });
    }
    if (p === '/api/export') {
      const date = s.get('date') || dateStr();
      return exportLogsCsv(res, date, {
        q: s.get('q') || '', host: s.get('host') || '', severity: s.get('severity') || '' });
    }
    if (p === '/api/logs' && req.method === 'DELETE') {
      const date = s.get('date');
      await fsp.unlink(fileOf(date)).catch(() => {});
      dayStats.delete(date);
      return sendJSON(res, 200, { ok: true, deleted: date });
    }
    if (p === '/api/entry' && req.method === 'DELETE') {
      const ok = await deleteEntry(s.get('date'), s.get('id'));
      return sendJSON(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'not found' });
    }
    if (p === '/api/health') return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
    return serveStatic(res, p);
  } catch (e) { console.error(e); sendJSON(res, 500, { error: e.message }); }
}).listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`syslog up — UDP/TCP :${UDP_PORT}/${TCP_PORT}, GUI http://${HTTP_HOST}:${HTTP_PORT}, dir ${LOG_DIR}`);
  sweep();
  setInterval(sweep, 3600e3).unref();
});

scan().then(() => console.log('indexed existing days:', [...dayStats.keys()].join(', ') || '(none)'));
