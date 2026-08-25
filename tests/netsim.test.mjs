'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { NetSim } from '../public/js/net/netsim.js';
import { wireBytes } from '../public/js/net/metrics.js';

// Minimal WebSocket-ish inner socket double.
class FakeInner {
  constructor() {
    this.readyState = 0;
    this.binaryType = '';
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closeArgs = null;
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close(code, reason) {
    this.closeArgs = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.sim?.onclose?.({ type: 'close' }));
  }

  // Test helper: pretend the server accepted the connection.
  open() {
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
  }

  // Test helper: server → client frame.
  message(data) {
    if (this.readyState !== 1) throw new Error('not open');
    this.onmessage?.({ type: 'message', data });
  }
}

const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('optionsFromURL parses presets and knobs; absent param disables', () => {
  assert.equal(NetSim.optionsFromURL(new URLSearchParams('')), null);
  const o = NetSim.optionsFromURL(new URLSearchParams('net=30k&netlat=150&netjit=80&netloss=2&netcut=20'));
  assert.deepEqual(o, { upKbps: 30, downKbps: 30, latencyMs: 150, jitterMs: 80, lossPct: 2, cutEveryS: 20 });
  const bad = NetSim.optionsFromURL(new URLSearchParams('net=gibberish'));
  assert.equal(bad.upKbps, Infinity); // unknown preset = unlimited pipe
  assert.equal(NetSim.describe(o), 'SIM 30k · +150±80ms · loss 2% · cut 20s');
});

test('passthrough: frames flow both ways in order with latency only', async () => {
  const sim = new NetSim({ latencyMs: 5, rng: () => 0.5 });
  const inner = new FakeInner();
  const sock = sim.wrap(inner);
  /** @type {string[]} */
  const got = [];
  sock.onmessage = (e) => got.push(e.data);
  inner.open();
  await flush(20);
  assert.equal(sock.readyState, 1);

  sock.send('{"t":"a"}');
  sock.send('{"t":"b"}');
  inner.message('{"t":"srv"}');
  await flush(40);
  assert.deepEqual(inner.sent, ['{"t":"a"}', '{"t":"b"}']);
  assert.deepEqual(got, ['{"t":"srv"}']);
});

test('token bucket throttles the uplink to the configured rate', async () => {
  // 8 kbps = 1 B/ms. Initial burst 500 ms worth = ~512 B; frame ≈1.4 kB.
  const sim = new NetSim({ upKbps: 8, latencyMs: 1, rng: () => 0.5 });
  const inner = new FakeInner();
  const sock = sim.wrap(inner);
  inner.open();
  await flush(15);

  const payload = JSON.stringify({ t: 'stroke', pts: 'x'.repeat(1400) }); // ~1.4 kB
  sock.send(payload);
  sock.send(payload);
  await flush(30);
  // After ~45 ms the budget (burst + refill) is far below one frame.
  assert.equal(inner.sent.length, 0, 'no frame fits early');

  await flush(1500); // budget now covers exactly one more frame
  assert.equal(inner.sent.length, 1);
  assert.equal(sim.stats.sentFrames, 1);

  await flush(2000); // second frame finally drains
  assert.equal(inner.sent.length, 2);
  sock.close(); // stop the pump timer so the test process can exit
  await flush(10);
});

test('loss drops frames deterministically with a seeded rng', async () => {
  // Sim rolls rng()*100 >= lossPct → KEEP. Alternating 1,0,1,0:
  let flip = false;
  const sim = new NetSim({ lossPct: 50, rng: () => (flip = !flip) }); // 1,0,1,0…
  const inner = new FakeInner();
  const sock = sim.wrap(inner);
  /** @type {string[]} */
  const got = [];
  sock.onmessage = (e) => got.push(e.data);
  inner.open();
  await flush(15);

  sock.send('a'); // roll 100 ≥ 50 → kept
  sock.send('b'); // roll 0 < 50 → dropped
  inner.message('c'); // kept
  inner.message('d'); // dropped
  await flush(40);
  assert.deepEqual(inner.sent, ['a']);
  assert.deepEqual(got, ['c']);
  assert.equal(sim.stats.lostUp, 1);
  assert.equal(sim.stats.lostDown, 1);
});

test('forced cuts close the socket periodically', async () => {
  const sim = new NetSim({ cutEveryS: 0.05, rng: () => 0.5 }); // ~50 ms period
  const inner = new FakeInner();
  /** @type {boolean[]} */
  const closes = [];
  const sock = sim.wrap(inner);
  sock.onclose = () => closes.push(true);
  inner.open();
  await flush(20);
  assert.equal(sock.readyState, 1);
  await flush(120);
  assert.ok(closes.length >= 1, 'sim forced a disconnect');
  assert.equal(sock.readyState, 3);
  assert.equal(inner.closeArgs.code, 4000);
  assert.equal(sim.stats.cuts, closes.length);
});

test('send on closed sim socket throws like a real WebSocket', async () => {
  const sim = new NetSim({});
  const inner = new FakeInner();
  const sock = sim.wrap(inner);
  inner.open();
  await flush(15);
  sock.close();
  await flush(10);
  assert.throws(() => sock.send('x'), /not open/);
});

test('frameSize counts UTF-8 bytes of JSON strings', () => {
  const sim = new NetSim({ upKbps: 1_000_000, latencyMs: 0, rng: Math.random });
  const inner = new FakeInner();
  const sock = sim.wrap(inner);
  inner.open();
  return flush(15).then(async () => {
    const s = JSON.stringify({ t: 'stroke' });
    sock.send(s);
    await flush(20);
    assert.equal(sim.stats.sentBytes, wireBytes(s));
  });
});
