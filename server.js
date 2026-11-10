'use strict';
/*
 * Private two-person chat. Zero dependencies.
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js
 *   DATA_FILE=/path/data.json node server.js   (where chats are stored)
 *
 * Realtime uses Server-Sent Events (server -> browser) plus plain POST requests
 * (browser -> server), so it works through most proxies and hosts.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_TEXT = 4000;          // characters per message
const MAX_BODY = 16 * 1024;     // bytes per request
const HISTORY_LIMIT = 500;      // messages sent to the browser on connect
const MAX_STORED = 20000;       // messages kept per room
const MAX_TOKENS_PER_USER = 5;  // devices signed in at once per person

/* ------------------------------------------------------------------ storage */

let db = { rooms: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
if (!db || typeof db !== 'object' || !db.rooms) db = { rooms: {} };

let saveTimer = null;
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { try { flush(); } catch (e) { console.error('save failed:', e.message); } }, 250);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// tokens are stored only as hashes, so a leaked data file cannot be used to sign in
const tokenIndex = new Map(); // sha(token) -> { roomId, userId }
for (const [roomId, room] of Object.entries(db.rooms)) {
  for (const u of room.users) for (const h of u.tokens) tokenIndex.set(h, { roomId, userId: u.id });
}

function auth(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const ref = tokenIndex.get(sha(token));
  if (!ref) return null;
  const room = db.rooms[ref.roomId];
  const user = room && room.users.find((u) => u.id === ref.userId);
  return user ? { roomId: ref.roomId, room, user, hash: sha(token) } : null;
}

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function checkPw(pw, room) {
  const a = Buffer.from(hashPw(pw, room.salt), 'hex');
  const b = Buffer.from(room.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------- brute-force protection */

const fails = new Map(); // ip -> { count, reset }
const FAIL_LIMIT = 8;
const FAIL_WINDOW = 10 * 60 * 1000;
const isLimited = (ip) => { const f = fails.get(ip); return !!f && f.reset > Date.now() && f.count >= FAIL_LIMIT; };
function noteFail(ip) {
  const now = Date.now();
  let f = fails.get(ip);
  if (!f || f.reset <= now) { f = { count: 0, reset: now + FAIL_WINDOW }; fails.set(ip, f); }
  f.count++;
}
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (f.reset <= now) fails.delete(ip); }, 60 * 1000).unref();

/* ----------------------------------------------------------- live clients */

const clients = new Map(); // roomId -> Map(userId -> Set<res>)
const conns = (roomId, userId) => (clients.get(roomId) && clients.get(roomId).get(userId)) || new Set();
const isOnline = (roomId, userId) => conns(roomId, userId).size > 0;
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function emit(roomId, userId, event, data) {
  const payload = sse(event, data);
  for (const res of conns(roomId, userId)) res.write(payload);
}
function emitRoom(roomId, room, event, data) {
  for (const u of room.users) emit(roomId, u.id, event, data);
}
const pub = (roomId, u) => ({ id: u.id, name: u.name, online: isOnline(roomId, u.id), lastSeen: u.lastSeen });
const otherUser = (room, user) => room.users.find((u) => u.id !== user.id) || null;

/* -------------------------------------------------------------------- http */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/* --------------------------------------------------------------- api: join */

function join(res, ip, b) {
  if (isLimited(ip)) return json(res, 429, { error: 'Too many failed attempts. Please wait a few minutes and try again.' });

  const roomName = clean(b.room, 40);
  const name = clean(b.name, 24);
  const password = typeof b.password === 'string' ? b.password : '';
  if (roomName.length < 2) return json(res, 400, { error: 'Room name must be at least 2 characters.' });
  if (!name) return json(res, 400, { error: 'Please enter your name.' });
  if (password.length < 6 || password.length > 100) return json(res, 400, { error: 'Password must be at least 6 characters.' });

  const roomId = sha('room:' + roomName.toLowerCase()).slice(0, 24);
  let room = db.rooms[roomId];
  if (!room) {
    const salt = crypto.randomBytes(16).toString('hex');
    room = db.rooms[roomId] = { salt, hash: hashPw(password, salt), users: [], messages: [], nextId: 1 };
  } else if (!checkPw(password, room)) {
    noteFail(ip);
    return json(res, 401, { error: 'Wrong room name or password.' });
  }

  let user = room.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  const isNew = !user;
  if (isNew) {
    if (room.users.length >= 2) return json(res, 403, { error: 'This chat already has two people.' });
    user = { id: crypto.randomBytes(6).toString('hex'), name, tokens: [], lastSeen: Date.now() };
    room.users.push(user);
  }

  const token = crypto.randomBytes(24).toString('hex');
  const hash = sha(token);
  user.tokens.push(hash);
  tokenIndex.set(hash, { roomId, userId: user.id });
  while (user.tokens.length > MAX_TOKENS_PER_USER) tokenIndex.delete(user.tokens.shift());
  save();

  if (isNew) {
    const other = otherUser(room, user);
    if (other) emit(roomId, other.id, 'peer', pub(roomId, user));
  }
  json(res, 200, { token, name: user.name });
}

/* ------------------------------------------------------------- api: stream */

function stream(req, res, url) {
  const a = auth(url.searchParams.get('token'));
  if (!a) return json(res, 401, { error: 'Not signed in.' });
  const { roomId, room, user } = a;

  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  res.write('retry: 2000\n\n');

  let byUser = clients.get(roomId);
  if (!byUser) clients.set(roomId, (byUser = new Map()));
  let set = byUser.get(user.id);
  if (!set) byUser.set(user.id, (set = new Set()));
  const wasOnline = set.size > 0;
  set.add(res);
  user.lastSeen = Date.now();

  const peer = otherUser(room, user);
  res.write(sse('init', {
    me: { id: user.id, name: user.name },
    peer: peer ? pub(roomId, peer) : null,
    messages: room.messages.slice(-HISTORY_LIMIT),
  }));
  if (!wasOnline && peer) emit(roomId, peer.id, 'peer', pub(roomId, user));

  const heartbeat = setInterval(() => res.write(sse('ping', 1)), 25 * 1000);
  req.on('close', () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) {
      user.lastSeen = Date.now();
      save();
      const other = otherUser(room, user);
      if (other) emit(roomId, other.id, 'peer', pub(roomId, user));
    }
  });
}

/* --------------------------------------------------------------- api: rest */

async function api(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (req.method === 'GET' && url.pathname === '/api/stream') return stream(req, res, url);
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });

  const body = await readBody(req);
  if (url.pathname === '/api/join') return join(res, ip, body);

  const a = auth(body.token);
  if (!a) return json(res, 401, { error: 'Not signed in.' });
  const { roomId, room, user } = a;
  const other = otherUser(room, user);

  switch (url.pathname) {
    case '/api/ping':
      return json(res, 200, { ok: true });

    case '/api/send': {
      const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
      if (!text) return json(res, 400, { error: 'Message is empty.' });
      if (text.length > MAX_TEXT) return json(res, 400, { error: `Message is too long (max ${MAX_TEXT} characters).` });
      const message = { id: room.nextId++, from: user.id, text, ts: Date.now(), seen: false };
      room.messages.push(message);
      if (room.messages.length > MAX_STORED) room.messages.splice(0, room.messages.length - MAX_STORED);
      user.lastSeen = Date.now();
      save();
      emitRoom(roomId, room, 'msg', message);
      return json(res, 200, { message });
    }

    case '/api/typing':
      if (other) emit(roomId, other.id, 'typing', { typing: !!body.typing });
      return json(res, 200, { ok: true });

    case '/api/seen': {
      const upTo = Math.floor(Number(body.upTo));
      if (!Number.isFinite(upTo) || upTo < 1) return json(res, 400, { error: 'Bad value.' });
      let changed = false;
      for (let i = room.messages.length - 1; i >= 0; i--) {
        const m = room.messages[i];
        if (m.from === user.id || m.id > upTo) continue;
        if (m.seen) break; // everything older is already marked
        m.seen = true;
        changed = true;
      }
      if (changed) { save(); emitRoom(roomId, room, 'seen', { by: user.id, upTo }); }
      return json(res, 200, { ok: true });
    }

    case '/api/logout': {
      user.tokens = user.tokens.filter((h) => h !== a.hash);
      tokenIndex.delete(a.hash);
      save();
      return json(res, 200, { ok: true });
    }

    default:
      return json(res, 404, { error: 'Not found.' });
  }
}

/* ------------------------------------------------------------ static files */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ------------------------------------------------------------------ server */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log('\nPrivate chat is running:');
  console.log(`  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  http://${i.address}:${PORT}   (same Wi-Fi / network)`);
  }
  console.log(`\nChats are saved in ${DATA_FILE}\n`);
});

function shutdown() {
  try { flush(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { server, flush };
