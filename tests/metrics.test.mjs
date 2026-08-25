'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, wireBytes, countMissing, NetworkMetrics } from '../public/js/net/metrics.js';

test('classify sorts wire types into budget categories', () => {
  assert.equal(classify('hello'), 'control');
  assert.equal(classify('init'), 'control');
  assert.equal(classify('ping'), 'control');
  assert.equal(classify('pong'), 'control');
  assert.equal(classify('err'), 'control');
  assert.equal(classify('join'), 'presence');
  assert.equal(classify('presence'), 'presence');
  for (const t of ['stroke', 'unstroke', 'erase', 'restore', 'clear', 'progress']) {
    assert.equal(classify(t), 'board', t);
  }
  assert.equal(classify('avatar'), 'avatar'); // binary frames metered synthetically
});

test('wireBytes measures UTF-8 length, not code units', () => {
  assert.equal(wireBytes('{"t":"stroke"}'), 14);
  // ñ is 2 bytes in UTF-8 but 1 code unit
  assert.equal(wireBytes('ñ'), 2);
});

test('totals accumulate per direction and category', () => {
  const m = new NetworkMetrics();
  m.onSend({ t: 'stroke' }, 100);
  m.onSend({ t: 'progress' }, 50);
  m.onSend({ t: 'ping' }, 20);
  m.onRecv({ t: 'init' }, 300);
  m.onRecv({ t: 'presence' }, 40);

  assert.equal(m.totals.sent.bytes, 170);
  assert.equal(m.totals.sent.msgs, 3);
  assert.equal(m.totals.sent.board, 150);
  assert.equal(m.totals.sent.control, 20);
  assert.equal(m.totals.recv.bytes, 340);
  assert.equal(m.totals.recv.control, 300);
  assert.equal(m.totals.recv.presence, 40);
});

test('snapshot exposes current and peak rates within the window', async () => {
  const m = new NetworkMetrics();
  m.onRecv({ t: 'init' }, 1000);
  const snap1 = m.snapshot();
  assert.ok(snap1.rate.downBps >= 1000);
  assert.equal(snap1.rate.peakDownBps >= 1000, true);

  // A later second with less traffic must not raise the peak.
  await new Promise((r) => setTimeout(r, 2100));
  m.onRecv({ t: 'pong' }, 10);
  const snap2 = m.snapshot();
  assert.ok(snap2.rate.peakDownBps >= snap1.rate.peakDownBps - 1000);
  assert.equal(snap2.recv.control >= 1010, true);
});

test('rtt EMA converges towards recent samples', () => {
  const m = new NetworkMetrics();
  m.addRtt(100);
  assert.equal(m.rttEma, 100); // first sample seeds directly
  m.addRtt(0); // 100*0.8 + 0*0.2
  assert.equal(Math.round(m.rttEma * 10) / 10, 80);
  assert.equal(m.rttSamples, 2);
  assert.equal(m.rttLast, 0);
});

test('reconnects count independently of connection state', () => {
  const m = new NetworkMetrics();
  m.noteReconnect();
  m.noteReconnect();
  assert.equal(m.snapshot().reconnects, 2);
});

test('countMissing detects sequence gaps only', () => {
  assert.equal(countMissing(1, 2), 0); // contiguous
  assert.equal(countMissing(1, 1), 0); // duplicate/replay
  assert.equal(countMissing(5, 3), 0); // out of order: never counts
  assert.equal(countMissing(1, 4), 2); // ops 2 and 3 missing
  assert.equal(countMissing(0, 100), 99);
});

test('noteGap accumulates lost ops into the snapshot', () => {
  const m = new NetworkMetrics();
  m.noteGap(2);
  m.noteGap(1);
  assert.equal(m.snapshot().lostOps, 3);
});
