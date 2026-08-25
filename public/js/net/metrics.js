'use strict';

/**
 * NetworkMetrics — Low-Net phase 3.
 * Pure accounting logic, no DOM/browser dependencies, so it runs in Node tests.
 *
 * Categories follow the bandwidth budget in docs/LOW_NET_ARCHITECTURE.md:
 *   control  — hello/init/ping/pong/err
 *   presence — join/presence chips
 *   board    — stroke/unstroke/erase/restore/clear/progress
 */

/** @type {Set<string>} */
const CONTROL_TYPES = new Set(['hello', 'init', 'ping', 'pong', 'err']);
/** @type {Set<string>} */
const PRESENCE_TYPES = new Set(['join', 'presence']);

/**
 * @param {string} type
 * @returns {'control'|'presence'|'board'}
 */
export function classify(type) {
  if (CONTROL_TYPES.has(type)) return 'control';
  if (PRESENCE_TYPES.has(type)) return 'presence';
  return 'board';
}

const ENCODER = new TextEncoder();

/**
 * @param {string} wire
 * @returns {number} UTF-8 byte length
 */
export function wireBytes(wire) {
  return ENCODER.encode(wire).length;
}

const SLOT_MS = 1000;
const WINDOW_SLOTS = 60;
const RTT_ALPHA = 0.2;

function emptyTotals() {
  return { bytes: 0, msgs: 0, control: 0, presence: 0, board: 0 };
}

/**
 * Rolling per-second buckets + lifetime totals + RTT EMA.
 */
export class NetworkMetrics {
  constructor() {
    this.startedAt = Date.now();
    /** @type {Map<number, {ub:number, db:number, um:number, dm:number}>} */
    this.slots = new Map();
    /** @type {{sent: ReturnType<typeof emptyTotals>, recv: ReturnType<typeof emptyTotals>}} */
    this.totals = { sent: emptyTotals(), recv: emptyTotals() };
    this.rttLast = 0;
    this.rttEma = 0;
    this.rttSamples = 0;
    this.reconnects = 0;
    this.droppedFrames = 0;
  }

  /**
   * @param {{t: string}} msg
   * @param {number} bytes wire size
   */
  onSend(msg, bytes) {
    this._account(this.totals.sent, msg.t, bytes, 'u');
  }

  /**
   * @param {{t: string}} msg
   * @param {number} bytes wire size
   */
  onRecv(msg, bytes) {
    this._account(this.totals.recv, msg.t, bytes, 'd');
  }

  /**
   * @param {number} ms round-trip milliseconds
   */
  addRtt(ms) {
    this.rttLast = ms;
    this.rttEma = this.rttSamples === 0 ? ms : this.rttEma * (1 - RTT_ALPHA) + ms * RTT_ALPHA;
    this.rttSamples += 1;
  }

  noteReconnect() {
    this.reconnects += 1;
  }

  /**
   * Immutable-ish point-in-time report for the metrics card.
   */
  snapshot() {
    const now = Date.now();
    const slot = Math.floor(now / SLOT_MS);
    this._prune(slot);

    let curUb = 0; let curDb = 0; let curUm = 0; let curDm = 0;
    let peakUb = 0; let peakDb = 0; let peakUm = 0; let peakDm = 0;
    for (const [s, b] of this.slots) {
      if (s === slot || s === slot - 1) {
        curUb += b.ub; curDb += b.db; curUm += b.um; curDm += b.dm;
      }
      if (b.ub > peakUb) peakUb = b.ub;
      if (b.db > peakDb) peakDb = b.db;
      if (b.um > peakUm) peakUm = b.um;
      if (b.dm > peakDm) peakDm = b.dm;
    }

    const secs = Math.max(1, (now - this.startedAt) / 1000);
    return {
      now,
      uptimeMs: now - this.startedAt,
      sent: { ...this.totals.sent },
      recv: { ...this.totals.recv },
      rate: {
        // "current" = events seen in the last two 1 s slots (~1–2 s smoothing)
        upBps: curUb, downBps: curDb,
        upMps: curUm, downMps: curDm,
        upBpsAvg: Math.round(this.totals.sent.bytes / secs),
        downBpsAvg: Math.round(this.totals.recv.bytes / secs),
        peakUpBps: peakUb, peakDownBps: peakDb,
        peakUpMps: peakUm, peakDownMps: peakDm,
      },
      rtt: { last: this.rttLast, ema: Math.round(this.rttEma * 10) / 10, samples: this.rttSamples },
      reconnects: this.reconnects,
      droppedFrames: this.droppedFrames,
    };
  }

  /**
   * @param {ReturnType<typeof emptyTotals>} side
   * @param {string} type
   * @param {number} bytes
   * @param {'u'|'d'} dir
   */
  _account(side, type, bytes, dir) {
    const cat = classify(type);
    side.bytes += bytes;
    side.msgs += 1;
    side[cat] += bytes;
    const slot = Math.floor(Date.now() / SLOT_MS);
    let b = this.slots.get(slot);
    if (!b) {
      this._prune(slot);
      b = { ub: 0, db: 0, um: 0, dm: 0 };
      this.slots.set(slot, b);
    }
    if (dir === 'u') {
      b.ub += bytes; b.um += 1;
    } else {
      b.db += bytes; b.dm += 1;
    }
  }

  /**
   * @param {number} nowSlot
   */
  _prune(nowSlot) {
    const oldest = nowSlot - WINDOW_SLOTS + 1;
    for (const key of this.slots.keys()) {
      if (key < oldest) this.slots.delete(key);
    }
  }
}
