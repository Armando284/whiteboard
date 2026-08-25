'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { WebSocket } = require('ws');
const { server, wss } = require('../server.js');

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => server.close(resolve));
});

const port = () => /** @type {{port:number}} */ (server.address()).port;

/**
 * @returns {Promise<{ws: import('ws').WebSocket, messages: any[]}>}
 */
function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port()}`);
    /** @type {any[]} */
    const messages = [];
    ws.on('message', (raw) => {
      try {
        messages.push(JSON.parse(String(raw)));
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {string} room
 * @param {string} uid
 */
function sayHello(ws, room, uid) {
  ws.send(JSON.stringify({ v: 1, t: 'hello', room, uid }));
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {Record<string, unknown>} msg
 */
function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

/**
 * @param {any[]} messages
 * @param {string} type
 * @param {(m: any) => boolean} [predicate]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function waitFor(messages, type, predicate = () => true, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() {
      const matches = messages.filter((m) => m.t === type && predicate(m));
      if (matches.length > 0) return resolve(matches[matches.length - 1]);
      if (Date.now() - t0 > timeoutMs) {
        return reject(new Error(`timeout waiting for "${type}" (got: ${messages.map((m) => m.t).join(',')})`));
      }
      setTimeout(poll, 15);
    })();
  });
}

test('hello yields init and both clients converge on presence', async () => {
  const a = await connect();
  sayHello(a.ws, 't-conv', 'AAAA');
  const initA = await waitFor(a.messages, 'init');
  assert.equal(initA.uid, 'AAAA');
  assert.equal(initA.room, 't-conv');
  assert.ok(Array.isArray(initA.strokes));

  const b = await connect();
  sayHello(b.ws, 't-conv', 'BBBB');
  await waitFor(b.messages, 'init');
  const presA = await waitFor(a.messages, 'presence', (m) => m.members.length === 2);
  const uids = presA.members.map((/** @type {any} */ m) => m.uid).sort();
  assert.deepEqual(uids, ['AAAA', 'BBBB']);
  a.ws.close();
  b.ws.close();
});

test('concurrent strokes are never lost (regression for overwrite bug)', async () => {
  const a = await connect();
  const b = await connect();
  await Promise.all([
    (async () => { sayHello(a.ws, 't-conc', 'AAAA'); await waitFor(a.messages, 'init'); })(),
    (async () => { sayHello(b.ws, 't-conc', 'BBBB'); await waitFor(b.messages, 'init'); })(),
  ]);

  // Interleaved: B commits while A is mid-stroke (progress first).
  send(a.ws, { v: 1, t: 'progress', id: 'sa', i: 0, pts: [10, 10, 40, 40] });
  send(b.ws, { v: 1, t: 'stroke', id: 'sb', pts: [100, 100, 150, 150] });
  send(a.ws, { v: 1, t: 'progress', id: 'sa', i: 2, pts: [70, 70] });
  send(a.ws, { v: 1, t: 'stroke', id: 'sa', pts: [10, 10, 40, 40, 70, 70] });

  await waitFor(b.messages, 'stroke', (m) => m.id === 'sa');

  const c = await connect();
  const initC = await helloSnapshot(c, 't-conc', 'CCCC');
  const ids = initC.strokes.map((/** @type {any} */ s) => s.id).sort();
  assert.deepEqual(ids, ['sa', 'sb'], 'both concurrent strokes survive');
  a.ws.close();
  b.ws.close();
  c.ws.close();
});

/**
 * @param {{ws: import('ws').WebSocket, messages: any[]}} client
 * @param {string} room
 * @param {string} uid
 */
async function helloSnapshot(client, room, uid) {
  sayHello(client.ws, room, uid);
  return waitFor(client.messages, 'init');
}

test('erase removes strokes for everyone including late joiners', async () => {
  const a = await connect();
  const b = await connect();
  await helloSnapshot(a, 't-erase', 'AAAA');
  await helloSnapshot(b, 't-erase', 'BBBB');

  send(a.ws, { v: 1, t: 'stroke', id: 'victim', pts: [1, 1, 9, 9] });
  await waitFor(b.messages, 'stroke', (m) => m.id === 'victim');

  send(a.ws, { v: 1, t: 'erase', ids: ['victim'] });
  await waitFor(b.messages, 'erase', (m) => Array.isArray(m.ids) && m.ids.includes('victim'));

  const late = await connect();
  const initLate = await helloSnapshot(late, 't-erase', 'LLLL');
  assert.equal(initLate.strokes.some((/** @type {any} */ s) => s.id === 'victim'), false);
  a.ws.close();
  b.ws.close();
  late.ws.close();
});

test('clear broadcasts a generation bump and wipes committed state', async () => {
  const a = await connect();
  const b = await connect();
  await helloSnapshot(a, 't-clear', 'AAAA');
  await helloSnapshot(b, 't-clear', 'BBBB');

  send(a.ws, { v: 1, t: 'stroke', id: 'pre-clear', pts: [2, 2, 4, 4] });
  send(a.ws, { v: 1, t: 'clear' });

  const clearA = await waitFor(a.messages, 'clear');
  assert.ok(clearA.gen >= 1, 'sender receives canonical generation too');
  await waitFor(b.messages, 'clear', (m) => m.gen >= 1);

  const late = await connect();
  const initLate = await helloSnapshot(late, 't-clear', 'LLLL');
  assert.equal(initLate.strokes.length, 0);
  assert.ok(initLate.gen >= 1, 'late joiner inherits generation');
  a.ws.close();
  b.ws.close();
  late.ws.close();
});

test('duplicate stroke ids keep the first version', async () => {
  const a = await connect();
  await helloSnapshot(a, 't-dup', 'AAAA');
  send(a.ws, { v: 1, t: 'stroke', id: 'dupe', pts: [5, 5, 6, 6] });
  send(a.ws, { v: 1, t: 'stroke', id: 'dupe', pts: [7, 7, 8, 8] });

  const late = await connect();
  const initLate = await helloSnapshot(late, 't-dup', 'LLLL');
  const copies = initLate.strokes.filter((/** @type {any} */ s) => s.id === 'dupe');
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0].pts, [5, 5, 6, 6]);
  a.ws.close();
  late.ws.close();
});

test('progress is relayed live but never persisted', async () => {
  const a = await connect();
  const b = await connect();
  await helloSnapshot(a, 't-live', 'AAAA');
  await helloSnapshot(b, 't-live', 'BBBB');

  send(a.ws, { v: 1, t: 'progress', id: 'wip', i: 0, pts: [10, 10, 20, 20] });
  await waitFor(b.messages, 'progress', (m) => m.id === 'wip');

  const late = await connect();
  const initLate = await helloSnapshot(late, 't-live', 'LLLL');
  assert.equal(initLate.strokes.some((/** @type {any} */ s) => s.id === 'wip'), false);
  a.ws.close();
  b.ws.close();
  late.ws.close();
});

test('rooms cap membership and reject extras with room_full', async () => {
  const crowd = [];
  for (let i = 0; i < 16; i++) {
    const client = await connect();
    crowd.push(client);
    await helloSnapshot(client, 't-crowd', `U${String(i).padStart(2, '0')}`);
  }
  const over = await connect();
  sayHello(over.ws, 't-crowd', 'EXTRA');
  const err = await waitFor(over.messages, 'err');
  assert.equal(err.code, 'room_full');
  for (const client of crowd) client.ws.close();
  over.ws.close();
});

test('malformed input does not kill the connection or server', async () => {
  const a = await connect();
  await helloSnapshot(a, 't-fuzz', 'AAAA');
  a.ws.send('this is not json');
  a.ws.send(JSON.stringify({ t: 'unknown-type', junk: true }));
  a.ws.send(JSON.stringify({ t: 'stroke', id: 'bad', pts: 'not-an-array' }));
  a.ws.send(JSON.stringify({ t: 'stroke', id: 'bad', pts: [NaN, Infinity] }));

  send(a.ws, { v: 1, t: 'ping', ts: 1234 });
  const pong = await waitFor(a.messages, 'pong');
  assert.equal(pong.ts, 1234);

  const late = await connect();
  const initLate = await helloSnapshot(late, 't-fuzz', 'LLLL');
  assert.equal(initLate.strokes.some((/** @type {any} */ s) => s.id === 'bad'), false);
  a.ws.close();
  late.ws.close();
});

test('frames with a wrong protocol version are rejected with err{version}', async () => {
  const a = await connect();
  sayHello(a.ws, 't-ver', 'AAAA');
  await waitFor(a.messages, 'init');

  // An unsupported version is refused and the frame is not applied.
  send(a.ws, { v: 99, t: 'stroke', id: 'nope', pts: [1, 1, 2, 2] });
  const err = await waitFor(a.messages, 'err');
  assert.equal(err.code, 'version');
  assert.equal(err.got, 99);

  // The connection stays usable afterwards.
  send(a.ws, { v: 1, t: 'ping', ts: 7 });
  await waitFor(a.messages, 'pong', (m) => m.ts === 7);

  // A hello with a wrong version closes the socket so old clients fail fast.
  send(a.ws, { v: 0, t: 'hello', room: 't-ver', uid: 'AAAA' });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(a.ws.readyState >= WebSocket.CLOSING, 'socket closed after bad hello version');
});

test('state ops carry a contiguous per-room seq and init carries the baseline', async () => {
  const a = await connect();
  const b = await connect();
  const initA = await helloSnapshot(a, 't-seq', 'AAAA');
  const initB = await helloSnapshot(b, 't-seq', 'BBBB');
  assert.equal(typeof initA.seq, 'number', 'init carries seq baseline');
  assert.equal(initB.seq, initA.seq, 'join/presence do not consume seq');

  // Sender A does not get echoes of its own state ops; B observes them.
  send(a.ws, { v: 1, t: 'stroke', id: 's1', pts: [1, 1, 2, 2] });
  send(a.ws, { v: 1, t: 'unstroke', id: 's1' });
  // clear is the one op broadcast to everyone including the sender.
  send(a.ws, { v: 1, t: 'clear' });

  const sStroke = await waitFor(b.messages, 'stroke', (m) => m.id === 's1');
  const sUnstroke = await waitFor(b.messages, 'unstroke', (m) => m.id === 's1');
  const sClear = await waitFor(a.messages, 'clear');
  assert.deepEqual(
    [sStroke.seq, sUnstroke.seq, sClear.seq],
    [initA.seq + 1, initA.seq + 2, initA.seq + 3],
    'one increment per state op',
  );

  // A late joiner gets the current seq as its baseline.
  const c = await connect();
  const late = await helloSnapshot(c, 't-seq', 'CCCC');
  assert.equal(late.seq, initA.seq + 3);
  c.ws.close();
  b.ws.close();
  a.ws.close();
});
