// SendIt server — a minimal, self-hosted backend for the SendIt browser extension.
// Implements the Via-compatible API the extension speaks:
//   GET  /v1/info                     server info + limits
//   POST /v1/auth/login               {username,password} -> {token} (session)
//   POST /v1/auth/logout
//   GET  /v1/devices                  list devices (marks "current" via token)
//   POST /v1/devices                  {name,type} -> {token, device}
//   GET  /v1/devices/me
//   GET  /v1/contacts                 [] (contacts not implemented)
//   POST /v1/pushes                   {kind: link|note, url?, title?, body?, to[]}
//   POST /v1/pushes/file?filename&to  raw file body -> file item
//   GET  /v1/inbox?limit&cursor       items for the current device
//   GET  /v1/inbox/events             SSE stream (ready/push/recalled/revoked)
//   GET  /v1/inbox/:id                single item
//   POST /v1/inbox/:id/ack  or /v1/inbox/ack {ids}
//   GET  /v1/inbox/:id/file           download file
// Run:  node server/index.js            (env: PORT=8080, SENDIT_DATA=./data.json, SENDIT_ADMIN_USER/PASS)
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname } from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.SENDIT_DATA || new URL('./data.json', import.meta.url).pathname;
const LIMITS = { max_file_size: Number(process.env.SENDIT_MAX_FILE_SIZE || 100 * 1024 * 1024), max_text_length: 262144 };

// --- storage ---------------------------------------------------------------------------
const hash = (s) => createHash('sha256').update(s).digest('hex');
let db = { users: {}, devices: {}, items: {}, seq: 1 };
try { db = { ...db, ...JSON.parse(readFileSync(DATA, 'utf8')) }; } catch { /* fresh */ }
// Seed an admin user on first start.
if (!Object.keys(db.users).length && process.env.SENDIT_ADMIN_USER) {
  db.users[process.env.SENDIT_ADMIN_USER] = { pass: hash(process.env.SENDIT_ADMIN_PASS || 'sendit'), admin: true };
}
const save = () => { mkdirSync(dirname(DATA), { recursive: true }); writeFileSync(DATA, JSON.stringify(db)); };
const id = () => (db.seq++).toString(36) + randomBytes(4).toString('hex');
const sessions = new Map(); // sessionToken -> username
const deviceTokens = new Map(Object.entries(db.devices).map(([t, d]) => [t, d.id]));

// --- SSE clients -------------------------------------------------------------------------
const sseClients = new Set(); // {res, deviceId}
function sseSend(deviceId, type, data) {
  const block = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) if (c.deviceId === deviceId) c.res.write(block);
}

// --- helpers ---------------------------------------------------------------------------
const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
};
const err = (res, code, codeName, message) => json(res, code, { error: { code: codeName, message } });
async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
function authDevice(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  return deviceTokens.get(t) ?? null;
}
function authUser(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  return sessions.get(t) ?? null;
}

// --- server ----------------------------------------------------------------------------
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  try {
    if (p === '/v1/info') return json(res, 200, { name: 'via', api_version: 1, limits: LIMITS, features: {} });

    if (p === '/v1/auth/login' && req.method === 'POST') {
      const { username, password } = JSON.parse((await body(req)).toString() || '{}');
      const user = db.users[username];
      if (!user || user.pass !== hash(password || '')) return err(res, 401, 'invalid_credentials', 'Wrong username or password.');
      const token = randomBytes(24).toString('hex');
      sessions.set(token, username);
      return json(res, 200, { token });
    }
    if (p === '/v1/auth/logout' && req.method === 'POST') {
      sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''));
      return json(res, 204, null);
    }

    if (p === '/v1/devices' && req.method === 'GET') {
      const me = authDevice(req);
      const username = authUser(req);
      const list = Object.values(db.devices)
        .filter((d) => d.username === (username || Object.values(db.devices).find((d) => d.id === me)?.username))
        .map((d) => ({ id: d.id, name: d.name, type: d.type, current: d.id === me }));
      return json(res, 200, list);
    }
    if (p === '/v1/devices' && req.method === 'POST') {
      const username = authUser(req);
      if (!username) return err(res, 401, 'unauthorized', 'Sign in first.');
      const { name, type } = JSON.parse((await body(req)).toString() || '{}');
      const device = { id: id(), username, name: name || 'device', type: type || 'browser' };
      const token = randomBytes(24).toString('hex');
      db.devices[token] = device;
      deviceTokens.set(token, device.id);
      save();
      return json(res, 200, { token, device });
    }
    if (p === '/v1/devices/me') {
      const me = authDevice(req);
      const d = Object.values(db.devices).find((d) => d.id === me);
      if (!d) return err(res, 401, 'unauthorized', 'Unknown device.');
      return json(res, 200, { id: d.id, name: d.name, type: d.type, accepts_shares: d.accepts_shares ?? false });
    }
    if (p === '/v1/contacts') return json(res, 200, []);

    // --- pushes ---
    if (p === '/v1/pushes' && req.method === 'POST') {
      const me = authDevice(req);
      if (!me) return err(res, 401, 'unauthorized', 'Unknown device.');
      const b = JSON.parse((await body(req)).toString() || '{}');
      const targets = resolveTargets(b.to, me);
      const item = mkItem(me, b.kind, { url: b.url, title: b.title, body: b.body }, null);
      deliver(item, targets);
      return json(res, 200, { id: item.id });
    }
    if (p === '/v1/pushes/file' && req.method === 'POST') {
      const me = authDevice(req);
      if (!me) return err(res, 401, 'unauthorized', 'Unknown device.');
      const raw = await body(req);
      if (raw.length > LIMITS.max_file_size) return err(res, 413, 'too_large', 'File exceeds the server limit.');
      const targets = resolveTargets((u.searchParams.get('to') || '').split(',').filter(Boolean), me);
      const item = mkItem(me, 'file', {}, { name: u.searchParams.get('filename') || 'file', size: raw.length, mime: req.headers['content-type'] || 'application/octet-stream', data: raw.toString('base64') });
      deliver(item, targets);
      return json(res, 200, { id: item.id });
    }

    // --- inbox ---
    const inboxMatch = p.match(/^\/v1\/inbox\/([^/]+)(\/(ack|file))?$/);
    if (p === '/v1/inbox' && req.method === 'GET') {
      const me = authDevice(req);
      const items = Object.values(db.items).filter((i) => i.to === me && !i.acked).map(publicItem);
      return json(res, 200, { items, cursor: null });
    }
    if (p === '/v1/inbox/events' && req.method === 'GET') {
      const me = authDevice(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`event: ready\ndata: {}\n\n`);
      const client = { res, deviceId: me };
      sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return;
    }
    if (inboxMatch) {
      const [, itemId, , action] = inboxMatch;
      const item = db.items[itemId];
      if (!item) return err(res, 404, 'not_found', 'No such item.');
      if (action === 'ack' && req.method === 'POST') { item.acked = true; save(); return json(res, 204, null); }
      if (action === 'file' && req.method === 'GET') {
        const buf = Buffer.from(item.file?.data || '', 'base64');
        res.writeHead(200, { 'content-type': item.file?.mime || 'application/octet-stream', 'content-length': buf.length, 'content-disposition': `attachment; filename="${item.file?.name || 'file'}"` });
        return res.end(buf);
      }
      return json(res, 200, publicItem(item));
    }
    if (p === '/v1/inbox/ack' && req.method === 'POST') {
      const { ids } = JSON.parse((await body(req)).toString() || '{}');
      for (const i of ids || []) if (db.items[i]) { db.items[i].acked = true; }
      save();
      return json(res, 204, null);
    }

    // optional features the extension probes: not supported -> extension falls back
    if (p.startsWith('/v1/rtc/') || p === '/v1/shares') return err(res, 404, 'not_supported', 'Not supported by this server.');

    if (p === '/' ) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<h1>SendIt server</h1><p>API at /v1/info — connect the SendIt browser extension here.</p>');
    }
    err(res, 404, 'not_found', 'Unknown endpoint.');
  } catch (e) {
    err(res, 500, 'server_error', String(e?.message || e));
  }
}).listen(PORT, '0.0.0.0', () => console.log(`SendIt server listening on http://0.0.0.0:${PORT}`));

function mkItem(fromDeviceId, kind, fields, file) {
  const from = Object.values(db.devices).find((d) => d.id === fromDeviceId);
  const item = { id: id(), kind, ...fields, file, sender: null, source_device_id: fromDeviceId, created_at: new Date().toISOString(), acked: false, to: null };
  db.items[item.id] = item;
  return item;
}
function resolveTargets(to, fromDeviceId) {
  const mine = Object.values(db.devices).filter((d) => d.username === Object.values(db.devices).find((x) => x.id === fromDeviceId)?.username);
  if (!to?.length || to.includes('*')) return mine.filter((d) => d.id !== fromDeviceId).map((d) => d.id);
  return to.map((t) => t.startsWith('@') ? null : t).filter(Boolean);
}
function deliver(item, targets) {
  for (const t of targets) {
    const copy = { ...item, id: id(), to: t };
    db.items[copy.id] = copy;
    sseSend(t, 'push', { id: copy.id });
  }
  save();
}
function publicItem(i) {
  return { id: i.id, kind: i.kind, url: i.url ?? null, title: i.title ?? null, body: i.body ?? null,
    file: i.file ? { name: i.file.name, size: i.file.size, mime: i.file.mime, available: true } : null,
    sender: i.sender, source_device_id: i.source_device_id, created_at: i.created_at };
}
