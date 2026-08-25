'use strict';

/**
 * Phase 8 — dev-only network simulator (client-side WebSocket shim).
 *
 * Models an awful link between this client and the server:
 *   - token-bucket bandwidth caps, uplink and downlink independently
 *   - fixed latency + random jitter, both directions
 *   - random frame loss (seeded PRNG for reproducible experiments)
 *   - periodic forced disconnects (exercises the reconnect path)
 *
 * The whiteboard never knows: it talks to a duck-typed WebSocket. Enabled via
 * URL, e.g. `?net=30k&netlat=150&netjit=80&netloss=2&netcut=20`.
 */

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * @typedef {object} NetSimOptions
 * @property {number} [upKbps] uplink cap; Infinity/omitted = unlimited
 * @property {number} [downKbps] downlink cap
 * @property {number} [latencyMs] one-way base delay
 * @property {number} [jitterMs] ± random variation around latency
 * @property {number} [lossPct] frame drop probability 0..100
 * @property {number} [cutEveryS] force-close roughly every N seconds (0 = off)
 * @property {() => number} [rng] seeded PRNG for reproducible runs
 */

export class NetSim {
  /**
   * @param {NetSimOptions} [opts]
   */
  constructor(opts = {}) {
    /** Wire rates in bytes/ms (kbps ÷ 8 → kB/s → ÷1000 → B/ms). */
    this.upRate = opts.upKbps !== undefined && Number.isFinite(opts.upKbps) ? opts.upKbps * 1000 / 8000 : Infinity;
    this.downRate = opts.downKbps !== undefined && Number.isFinite(opts.downKbps) ? opts.downKbps * 1000 / 8000 : Infinity;
    this.latencyMs = Math.max(0, opts.latencyMs ?? 0);
    this.jitterMs = Math.max(0, opts.jitterMs ?? 0);
    this.lossPct = Math.min(100, Math.max(0, opts.lossPct ?? 0));
    this.cutEveryS = Math.max(0, opts.cutEveryS ?? 0);
    /** @type {() => number} */
    this.rng = opts.rng || Math.random;
    /** @type {{ sentFrames: number, sentBytes: number, lostUp: number, lostDown: number, cuts: number }} */
    this.stats = { sentFrames: 0, sentBytes: 0, lostUp: 0, lostDown: 0, cuts: 0 };
  }

  /**
   * Parses `?net=...` style params into NetSimOptions.
   * Preset `net=NNk` sets symmetric bandwidth; all knobs compose.
   * @param {URLSearchParams} params
   * @returns {NetSimOptions | null} null when no `net` param present
   */
  static optionsFromURL(params) {
    const raw = params.get('net');
    if (!raw) return null;
    const num = (key, dflt) => {
      const v = Number(params.get(key));
      return Number.isFinite(v) && v >= 0 ? v : dflt;
    };
    const m = /^(\d{1,5})k$/i.exec(raw.trim());
    const kbps = m ? Number(m[1]) : NaN;
    const bw = Number.isFinite(kbps) && kbps > 0 ? kbps : Infinity;
    return {
      upKbps: bw,
      downKbps: bw,
      latencyMs: num('netlat', 0),
      jitterMs: num('netjit', 0),
      lossPct: num('netloss', 0),
      cutEveryS: num('netcut', 0),
    };
  }

  /**
   * Human-readable tag for UI badges.
   * @param {NetSimOptions} o
   */
  static describe(o) {
    const bw = Number.isFinite(o.upKbps) ? `${o.upKbps}k` : '∞';
    const parts = [`SIM ${bw}`];
    if (o.latencyMs || o.jitterMs) parts.push(`+${o.latencyMs}±${o.jitterMs}ms`);
    if (o.lossPct) parts.push(`loss ${o.lossPct}%`);
    if (o.cutEveryS) parts.push(`cut ${o.cutEveryS}s`);
    return parts.join(' · ');
  }

  /** @returns {number} randomized one-way propagation delay */
  _delay() {
    const j = this.jitterMs > 0 ? (this.rng() * 2 - 1) * this.jitterMs : 0;
    return Math.max(0, this.latencyMs + j);
  }

  /** @returns {boolean} true when the frame should be dropped */
  _rollLoss(counter) {
    if (this.rng() * 100 >= this.lossPct) return false;
    this.stats[counter] += 1;
    return true;
  }

  /**
   * Wraps a real WebSocket in a simulated one.
   * @param {WebSocket} inner
   * @returns {SimSocket}
   */
  wrap(inner) {
    return new SimSocket(this, inner);
  }
}

/**
 * Duck-typed WebSocket: same property surface Connection relies on
 * (readyState numeric codes, on{open,message,close,error} handlers,
 * binaryType, send, close).
 */
class SimSocket {
  /**
   * @param {NetSim} sim
   * @param {WebSocket} inner
   */
  constructor(sim, inner) {
    this.sim = sim;
    this.inner = inner;
    this.readyState = 0; // CONNECTING
    this.binaryType = 'arraybuffer';
    /** @type {any} */
    this.onopen = null;
    /** @type {any} */
    this.onmessage = null;
    /** @type {any} */
    this.onclose = null;
    /** @type {any} */
    this.onerror = null;

    // Token bucket: allows an initial burst of half a second of wire time.
    this.burstBytes = Number.isFinite(sim.upRate) ? Math.max(512, sim.upRate * 500) : Infinity;
    this.tokens = this.burstBytes;
    this.lastRefillAt = Date.now();
    /** @type {{ data: any, size: number }[]} */
    this.upQueue = [];
    this.pumpTimer = /** @type {any} */ (null);

    /** Downlink FIFO: earliest moment the wire is free again. */
    this.downFreeAt = Date.now();

    this.cutTimer = /** @type {any} */ (null);

    inner.binaryType = 'arraybuffer';
    inner.onopen = () => this._innerOpen();
    inner.onclose = () => this._innerClose();
    inner.onerror = () => this.onerror?.({ type: 'error' });
    inner.onmessage = (ev) => this._innerMessage(ev);

    if (sim.cutEveryS > 0) {
      const periodMs = sim.cutEveryS * 1000;
      const armCut = () => {
        this.cutTimer = setTimeout(() => {
          if (this.readyState !== OPEN) return;
          sim.stats.cuts += 1;
          this.close(4000, 'netsim cut');
        }, periodMs * (0.7 + sim.rng() * 0.6));
      };
      armCut();
    }
  }

  _innerOpen() {
    // Opening handshake also suffers propagation delay.
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = OPEN;
      this.onopen?.({ type: 'open' });
    }, this.sim._delay());
  }

  _innerClose() {
    clearTimeout(this.cutTimer);
    clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    const wasOpen = this.readyState === OPEN || this.readyState === CLOSING;
    this.readyState = CLOSED;
    if (wasOpen) this.onclose?.({ type: 'close' });
  }

  /**
   * @param {MessageEvent} ev
   */
  _innerMessage(ev) {
    if (this.readyState !== OPEN) return;
    const size = frameSize(ev.data);
    if (this.sim._rollLoss('lostDown')) return;
    // Serialize onto the downlink wire, then propagate.
    const now = Date.now();
    const start = Math.max(now, this.downFreeAt);
    const serialMs = Number.isFinite(this.sim.downRate) ? size / this.sim.downRate : 0;
    this.downFreeAt = start + serialMs;
    setTimeout(() => {
      if (this.readyState !== OPEN) return;
      this.onmessage?.({ type: 'message', data: ev.data });
    }, this.downFreeAt - now + this.sim._delay());
  }

  /**
   * @param {string | ArrayBuffer | Uint8Array} data
   */
  send(data) {
    if (this.readyState !== OPEN) {
      throw new Error('SimSocket: not open');
    }
    const size = frameSize(data);
    if (this.sim._rollLoss('lostUp')) return;
    this.upQueue.push({ data, size });
    this._ensurePump();
  }

  _ensurePump() {
    if (this.pumpTimer !== null) return;
    const pump = () => {
      if (!this.upQueue.length || this.readyState !== OPEN) {
        clearInterval(this.pumpTimer);
        this.pumpTimer = null;
        return;
      }
      // Refill bucket by elapsed wire capacity.
      const now = Date.now();
      if (Number.isFinite(this.sim.upRate)) {
        this.tokens = Math.min(this.burstBytes, this.tokens + (now - this.lastRefillAt) * this.sim.upRate);
      }
      this.lastRefillAt = now;
      const next = this.upQueue[0];
      if (next.size > this.tokens) {
        // Never starve a frame larger than the bucket: grow capacity like
        // TCP's buffered pipe would (tiny link still delivers big frames,
        // just slowly).
        this.burstBytes = next.size;
        if (this.tokens > this.burstBytes) this.tokens = this.burstBytes;
        return; // starved; retry next tick
      }
      this.tokens -= next.size;
      this.upQueue.shift();
      this.sim.stats.sentFrames += 1;
      this.sim.stats.sentBytes += next.size;
      // The bucket already paced this frame; only propagation remains.
      setTimeout(() => {
        if (this.readyState !== OPEN) return;
        try {
          this.inner.send(next.data);
        } catch {
          // inner died mid-flight; its close handler takes over
        }
      }, this.sim._delay());
    };
    this.pumpTimer = setInterval(pump, 10);
    pump();
  }

  /**
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    try {
      this.inner.close(code, reason.slice(0, 100));
    } catch {
      // already dead
    }
    this._innerClose();
  }
}

/**
 * @param {string | ArrayBuffer | Uint8Array} data
 * @returns {number} wire size in bytes
 */
function frameSize(data) {
  if (typeof data === 'string') {
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3; // JSON is ASCII-heavy; BMP cap fine
    }
    return n;
  }
  return /** @type {ArrayBuffer | Uint8Array} */ (data).byteLength;
}
