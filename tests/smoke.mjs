'use strict';
import { WebSocket } from 'ws';

const URL = `ws://127.0.0.1:${process.env.SMOKE_PORT || 3999}`;
const log = (...a) => console.log(...a);
const fail = (m) => { console.error('SMOKE FAIL:', m); process.exit(1); };

function client(uid) {
  const ws = new WebSocket(URL);
  const msgs = [];
  ws.on('message', (raw) => {
    try { msgs.push(JSON.parse(String(raw))); } catch {}
  });
  ws.uid = uid;
  return { ws, msgs };
}

const send = (ws, msg) => ws.send(JSON.stringify(msg));
const hello = (ws, room, uid) => send(ws, { v: 1, t: 'hello', room, uid });

/** @param {{msgs:any[]}} c @param {(m:any)=>boolean} pred @param {string} label */
function waitFor(c, pred, label, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = () => {
      const hit = c.msgs.filter(pred).pop();
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error('timeout: ' + label));
      setTimeout(poll, 15);
    };
    poll();
  });
}

const A = client('AAAA');
A.ws.on('open', () => hello(A.ws, 'smoke', 'AAAA'));
await waitFor(A, (m) => m.t === 'init', 'A init');

const B = client('BBBB');
B.ws.on('open', () => hello(B.ws, 'smoke', 'BBBB'));
const initB = await waitFor(B, (m) => m.t === 'init', 'B init');
if (!(initB.strokes.length === 0)) fail('expected empty snapshot for B');

// Concurrent interleaving: A streams progress, B commits mid-stream.
send(A.ws, { v: 1, t: 'progress', id: 'w1', i: 0, pts: [10, 10, 50, 50] });
send(B.ws, { v: 1, t: 'stroke', id: 'w2', pts: [90, 90, 120, 120] });
send(A.ws, { v: 1, t: 'stroke', id: 'w1', pts: [10, 10, 50, 50] });

const bGotW1 = await waitFor(B, (m) => m.t === 'stroke' && m.id === 'w1', 'B sees w1');
if (!bGotW1) fail('w1 lost');

// Late joiner must snapshot BOTH strokes.
const C = client('CCCC');
C.ws.on('open', () => hello(C.ws, 'smoke', 'CCCC'));
const initC = await waitFor(C, (m) => m.t === 'init', 'C init');
const snapIds = initC.strokes.map((s) => s.id).sort();
if (!(snapIds.join() === 'w1,w2')) fail(`snapshot missing strokes: ${snapIds}`);

// Erase propagates.
send(C.ws, { v: 1, t: 'erase', ids: ['w2'] });
await waitFor(A, (m) => m.t === 'erase' && Array.isArray(m.ids) && m.ids.includes('w2'), 'A erase echo');

log('B received strokes:', JSON.stringify(['w1', 'w2']));
log('late joiner snapshot:', JSON.stringify(snapIds));
log('SMOKE PASS');
process.exit(0);
