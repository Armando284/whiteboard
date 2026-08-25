'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, clientTracking: true, maxPayload: 64 * 1024 });

// ---------------------------------------------------------------------------
// Static assets + cache busting
//
// There is no build step, so browsers/CDNs can silently serve stale JS after
// a deploy and make fixed bugs look alive. Every deploy changes a content
// hash that is appended to the asset URLs in index.html; sub-resources are
// then cached immutably while the HTML itself always revalidates.
// ---------------------------------------------------------------------------
function computeAssetVersion() {
  const hash = crypto.createHash('sha1');
  hash.update(Date.now().toString(36)); // new value on every process start/deploy
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else {
        const s = fs.statSync(p);
        hash.update(`${p}:${s.size}:${s.mtimeMs}`);
      }
    }
  };
  try {
    walk(path.join(__dirname, 'public'));
  } catch {
    // fall back to timestamp-only version
  }
  return hash.digest('hex').slice(0, 10);
}

const ASSET_V = computeAssetVersion();
console.info(`[low-net] build ${ASSET_V}`);

let indexHtml = '';
try {
  indexHtml = fs
    .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace(/(href="style\.css")/g, `href="style.css?v=${ASSET_V}"`)
    .replace(/(src="js\/main\.js")/g, `src="js/main.js?v=${ASSET_V}"`)
    .replace('</head>', `<meta name="build" content="${ASSET_V}"></head>`);
} catch {
  // static middleware will serve it untouched as a fallback
}

app.get('/', (_req, res) => {
  res.type('html').set('Cache-Control', 'no-cache').send(indexHtml);
});
app.get('/index.html', (_req, res) => {
  res.type('html').set('Cache-Control', 'no-cache').send(indexHtml);
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res) {
      // Versioned URLs (?v=...) are safe to cache hard; dynamic ES module
      // imports inherit the query string from their importer.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }),
);

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/ping', (req, res) => res.send('pong'));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PROTOCOL_VERSION = 1;
const WORLD_W = 800;
const WORLD_H = 600;
const MAX_POINTS_PER_STROKE = 4096;
const MAX_PROGRESS_POINTS = 512;
const MAX_STROKES_PER_ROOM = 2000;
const MAX_ROOM_MEMBERS = 16;
const HELLO_TIMEOUT_MS = 10000;

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const STROKE_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,24}$/;

// ---------------------------------------------------------------------------
// Rooms
//
// Room state is intentionally ephemeral (in-memory). It dies with the process;
// clients resync via `init` snapshots on (re)connect. See docs/VERCEL_LIMITATIONS.md.
//
// ---------------------------------------------------------------------------
/**
 * @typedef {{ id: string, uid: string, ws: WebSocket, lastAvatarTs?: number }} Member
 * @typedef {{ id: string, gen: number, seq: number, strokes: Map<string, {id: string, pts: number[]}>, members: Map<string, Member> }} Room
 */
/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @param {string} id
 * @returns {Room}
 */
function getOrCreateRoom(id) {
  let room = rooms.get(id);
  if (!room) {
    room = { id, gen: 0, seq: 0, strokes: new Map(), members: new Map() };
    rooms.set(id, room);
  }
  return room;
}

/**
 * Next sequence number for a room's state-changing ops. Clients use it to
 * detect delivery gaps (see NETWORK_PROTOCOL.md).
 * @param {Room} room
 * @returns {number}
 */
function nextSeq(room) {
  return ++room.seq;
}

/** @param {Room} room */
function pruneRoom(room) {
  if (room.members.size === 0 && rooms.get(room.id) === room) {
    rooms.delete(room.id);
  }
}

/**
 * @param {Room} room
 * @returns {{cid: string, uid: string}[]}
 */
function memberList(room) {
  const out = [];
  for (const m of room.members.values()) out.push({ cid: m.id, uid: m.uid });
  return out;
}

// ---------------------------------------------------------------------------
// Sanitizers — never trust the wire
// ---------------------------------------------------------------------------

/**
 * Clamps a flat [x0,y0,x1,y1,...] array into world coordinates.
 * @param {unknown} raw
 * @param {number} maxPoints
 * @returns {number[] | null}
 */
function sanitizePoints(raw, maxPoints) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 2 || raw.length % 2 !== 0 || raw.length > maxPoints * 2) return null;
  const out = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    // Strict: JSON null/strings must not be coerced into coordinates.
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    if (i % 2 === 0) {
      out[i] = n < 0 ? 0 : n > WORLD_W ? WORLD_W : Math.round(n);
    } else {
      out[i] = n < 0 ? 0 : n > WORLD_H ? WORLD_H : Math.round(n);
    }
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {string | null}
 */
function sanitizeId(raw) {
  return typeof raw === 'string' && STROKE_ID_RE.test(raw) ? raw : null;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeUid(raw) {
  return typeof raw === 'string' && UID_RE.test(raw) ? raw : 'anon';
}

/**
 * @param {unknown} raw
 * @returns {{id: string, pts: number[]} | null}
 */
function sanitizeStrokeData(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeId(/** @type {any} */ (raw).id);
  if (!id) return null;
  const pts = sanitizePoints(/** @type {any} */ (raw).pts, MAX_POINTS_PER_STROKE);
  if (!pts) return null;
  return { id, pts };
}

// ---------------------------------------------------------------------------
// Messaging helpers
// ---------------------------------------------------------------------------

/**
 * @param {Member} member
 * @param {object} msg
 */
function sendTo(member, msg) {
  try {
    if (member.ws.readyState === WebSocket.OPEN) member.ws.send(JSON.stringify(msg));
  } catch {
    // socket dying mid-send is not fatal
  }
}

/**
 * @param {Room} room
 * @param {string | null} exceptCid
 * @param {object} msg
 */
function broadcast(room, exceptCid, msg) {
  for (const m of room.members.values()) {
    if (m.id !== exceptCid) sendTo(m, msg);
  }
}

/**
 * Binary broadcast for avatar frames. Format contract lives in
 * public/js/avatar/codec.js and docs/NETWORK_PROTOCOL.md.
 * @param {Room} room
 * @param {string} exceptCid
 * @param {Buffer} buf
 */
function broadcastBinary(room, exceptCid, buf) {
  for (const m of room.members.values()) {
    if (m.id === exceptCid) continue;
    try {
      if (m.ws.readyState === WebSocket.OPEN) m.ws.send(buf, { binary: true });
    } catch {
      // dying socket is cleaned up by close handler
    }
  }
}

let nextCid = 1;

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

wss.on('connection', (ws, req) => {
  const ip = /** @type {string} */ (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  console.log(`WS connect from ${ip}`);
  const helloTimer = setTimeout(() => ws.terminate(), HELLO_TIMEOUT_MS);

  /**
   * @type {Member}
   */
  const member = { id: `c${nextCid++}`, uid: '', ws };

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw, isBinary) => {
    // Binary path: avatar pose frames only (see avatar/codec.js). They never
    // reset the hello timer — a socket must still say hello to live.
    if (isBinary) {
      handleAvatarBinary(member, /** @type {Buffer} */ (raw));
      return;
    }
    clearTimeout(helloTimer);
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;
    // Protocol version gate: refuse frames we cannot interpret instead of
    // guessing. hello also closes the socket so old clients fail fast.
    const versionOk = msg.v === PROTOCOL_VERSION;
    if (!versionOk) {
      sendTo(member, { v: 1, t: 'err', code: 'version', got: msg.v ?? null });
      if (msg.t === 'hello') member.ws.close();
      return;
    }
    handleMessage(member, msg);
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    if (member.roomRef) {
      const room = member.roomRef;
      room.members.delete(member.id);
      broadcast(room, null, { v: 1, t: 'presence', members: memberList(room) });
      pruneRoom(room);
      console.log(`WS closed (${member.uid}@${room.id}), ${room.members.size} left in room`);
    }
  });

  ws.on('error', (err) => {
    console.error(`WS error (${ip}): ${err.message}`);
  });
});

const HEARTBEAT_MS = 30000;
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{t: string} & Record<string, unknown>} msg
 */
function handleMessage(member, msg) {
  switch (msg.t) {
    case 'hello': return handleHello(member, msg);
    case 'stroke': return handleStroke(member, msg);
    case 'unstroke': return handleUnstroke(member, msg);
    case 'erase': return handleErase(member, msg);
    case 'restore': return handleRestore(member, msg);
    case 'clear': return handleClear(member, msg);
    case 'progress': return handleProgress(member, msg);
    case 'avatar_off': {
      const room = member.roomRef;
      if (!room) return;
      broadcast(room, member.id, { v: 1, t: 'avatar_off', cid: member.id });
      return;
    }
    case 'ping': return sendTo(member, { v: 1, t: 'pong', ts: Number(msg.ts) || 0 });
    default: return; // unknown types are ignored, never crash
  }
}

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{room?: unknown, uid?: unknown}} msg
 */
function handleHello(member, msg) {
  if (member.roomRef) return;
  const roomId = typeof msg.room === 'string' && ROOM_ID_RE.test(msg.room) ? msg.room : 'lobby';
  const room = getOrCreateRoom(roomId);

  if (room.members.size >= MAX_ROOM_MEMBERS) {
    sendTo(member, { v: 1, t: 'err', code: 'room_full' });
    member.ws.close();
    return;
  }

  member.uid = sanitizeUid(msg.uid);
  member.roomRef = room;
  room.members.set(member.id, member);

  sendTo(member, {
    v: 1,
    t: 'init',
    you: member.id,
    uid: member.uid,
    room: room.id,
    gen: room.gen,
    seq: room.seq,
    strokes: [...room.strokes.values()],
    members: memberList(room),
  });

  broadcast(room, member.id, { v: 1, t: 'join', cid: member.id, uid: member.uid });
  broadcast(room, null, { v: 1, t: 'presence', members: memberList(room) });
}

/**
 * @param {Room} room
 * @param {string} id
 * @param {number[]} pts
 */
function storeStroke(room, id, pts) {
  if (room.strokes.has(id)) return false;
  room.strokes.set(id, { id, pts });
  if (room.strokes.size > MAX_STROKES_PER_ROOM) {
    const oldest = room.strokes.keys().next().value;
    if (oldest !== undefined) room.strokes.delete(oldest);
  }
  return true;
}

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{id?: unknown, pts?: unknown}} msg
 */
function handleStroke(member, msg) {
  const room = member.roomRef;
  if (!room) return;
  const id = sanitizeId(msg.id);
  const pts = sanitizePoints(msg.pts, MAX_POINTS_PER_STROKE);
  if (!id || !pts) return;
  storeStroke(room, id, pts);
  broadcast(room, member.id, { v: 1, t: 'stroke', seq: nextSeq(room), id, pts });
}

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{id?: unknown}} msg
 */
function handleUnstroke(member, msg) {
  const room = member.roomRef;
  if (!room) return;
  const id = sanitizeId(msg.id);
  if (!id || !room.strokes.has(id)) return;
  room.strokes.delete(id);
  broadcast(room, member.id, { v: 1, t: 'unstroke', seq: nextSeq(room), id });
}

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{ids?: unknown}} msg
 */
function handleErase(member, msg) {
  const room = member.roomRef;
  if (!room) return;
  if (!Array.isArray(msg.ids)) return;
  /** @type {string[]} */
  const removed = [];
  for (const rawId of msg.ids.slice(0, MAX_STROKES_PER_ROOM)) {
    const id = sanitizeId(rawId);
    if (id && room.strokes.delete(id)) removed.push(id);
  }
  if (removed.length === 0) return;
  broadcast(room, member.id, { v: 1, t: 'erase', seq: nextSeq(room), ids: removed });
}

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{strokes?: unknown}} msg
 */
function handleRestore(member, msg) {
  const room = member.roomRef;
  if (!room) return;
  if (!Array.isArray(msg.strokes)) return;
  /** @type {{id: string, pts: number[]}[]} */
  const restored = [];
  for (const raw of msg.strokes.slice(0, MAX_STROKES_PER_ROOM)) {
    const s = sanitizeStrokeData(raw);
    if (s && !room.strokes.has(s.id)) {
      room.strokes.set(s.id, s);
      restored.push(s);
    }
  }
  if (restored.length === 0) return;
  broadcast(room, member.id, { v: 1, t: 'restore', seq: nextSeq(room), strokes: restored });
}

/**
 * @param {Member & {roomRef?: Room}} member
 * @param {{gen?: unknown}} _msg
 */
function handleClear(member, _msg) {
  const room = member.roomRef;
  if (!room) return;
  room.gen += 1;
  room.strokes.clear();
  broadcast(room, null, { v: 1, t: 'clear', seq: nextSeq(room), gen: room.gen });
}

/**
 * Relayed only; never stored.
 * @param {Member & {roomRef?: Room}} member
 * @param {{id?: unknown, i?: unknown, pts?: unknown}} msg
 */
function handleProgress(member, msg) {
  const room = member.roomRef;
  if (!room) return;
  const id = sanitizeId(msg.id);
  const pts = sanitizePoints(msg.pts, MAX_PROGRESS_POINTS);
  const startIdx = Number.isInteger(Number(msg.i)) && Number(msg.i) >= 0 ? Number(msg.i) : -1;
  if (!id || !pts || startIdx < 0) return;
  broadcast(room, member.id, { v: 1, t: 'progress', id, i: startIdx, pts });
}

// ---------------------------------------------------------------------------
// Avatar binary relay
// ---------------------------------------------------------------------------

// Must mirror public/js/avatar/codec.js (kept inline because server.js is CJS;
// the codec integration tests pin both sides to the same contract).
const AVATAR_TAG = 0x01;
const AVATAR_RELAY_TAG = 0x02;
const AVATAR_FRAME_BYTES = 13;
const AVATAR_MIN_INTERVAL_MS = 33; // ~30 Hz hard cap per sender

/**
 * Validates and relays an avatar pose frame to the sender's room peers,
 * prefixing it with the sender's cid so receivers can attribute it.
 * @param {Member & {roomRef?: Room}} member
 * @param {Buffer} buf
 */
function handleAvatarBinary(member, buf) {
  const room = member.roomRef;
  if (!room) return;
  if (buf.length !== AVATAR_FRAME_BYTES || buf[0] !== AVATAR_TAG) return;

  const now = Date.now();
  if (member.lastAvatarTs !== undefined && now - member.lastAvatarTs < AVATAR_MIN_INTERVAL_MS) return;
  member.lastAvatarTs = now;

  const cidBuf = Buffer.from(member.id, 'ascii');
  const out = Buffer.allocUnsafe(2 + cidBuf.length + (buf.length - 1));
  out[0] = AVATAR_RELAY_TAG;
  out[1] = cidBuf.length;
  cidBuf.copy(out, 2);
  buf.copy(out, 2 + cidBuf.length, 1);
  broadcastBinary(room, member.id, out);
}

// ---------------------------------------------------------------------------

module.exports = { server, wss, rooms };

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on port: ${PORT}`);
  });
}
