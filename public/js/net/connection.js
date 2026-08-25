'use strict';

import { decode, envelope } from './protocol.js';
import { NetworkMetrics, countMissing, wireBytes } from './metrics.js';

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
const MAX_QUEUE = 256;
const RTT_PROBE_MS = 5000;

/**
 * WebSocket lifecycle: hello handshake, exponential backoff with jitter,
 * and an offline outbox so ops drawn while disconnected are flushed on resume.
 * All traffic is metered into an internal NetworkMetrics instance.
 */
export class Connection extends EventTarget {
  /**
   * @param {NetworkMetrics} [metrics] injectable for tests
   */
  constructor(metrics) {
    super();
    /** @type {WebSocket | null} */
    this.socket = null;
    this.room = '';
    this.uid = '';
    this.status = 'down';
    this.reconnects = 0;
    /** @type {Record<string, unknown>[]} */
    this.queue = [];
    this.attempt = 0;
    this.stopped = false;
    /** @type {number | undefined} */
    this.timer = undefined;
    /** @type {number | undefined} */
    this.rttTimer = undefined;
    this.metrics = metrics || new NetworkMetrics();
    /** @type {number | null} last room-op seq seen; null until init baseline */
    this.lastSeq = null;
  }

  /**
   * @param {string} room
   * @param {string} uid
   */
  connect(room, uid) {
    this.room = room;
    this.uid = uid;
    this._open();
  }

  _open() {
    clearTimeout(this.timer);
    // Detach handlers from a superseded socket so a late close event
    // cannot schedule a duplicate reconnect loop.
    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
    }
    this._setStatus('connecting');
    const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const socket = new WebSocket(`${scheme}${location.host}`);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    socket.onopen = () => {
      this.attempt = 0;
      this.reconnects = 0;
      // New session: the seq baseline is re-established by init.
      this.lastSeq = null;
      // hello must be the first frame; queued ops follow it.
      this._sendNow(envelope('hello', { room: this.room, uid: this.uid }));
      const pending = this.queue.splice(0, MAX_QUEUE);
      for (const msg of pending) this._sendNow(msg);
      this._startRttProbe();
      this._setStatus('up');
    };

    socket.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const msg = decode(e.data);
        if (!msg) return;
        this.metrics.onRecv(msg, wireBytes(e.data));
        // Control chatter consumed at this layer; never reaches the app.
        if (msg.t === 'pong' && typeof msg.ts === 'number') {
          this.metrics.addRtt(Math.max(0, Date.now() - msg.ts));
          return;
        }
        if (msg.t === 'ping') return;
        this._observeSeq(msg);
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      } else {
        this.dispatchEvent(new CustomEvent('binary', { detail: e.data }));
      }
    };

    socket.onclose = () => {
      this._stopRttProbe();
      this._setStatus('down');
      if (this.stopped) return;
      this.metrics.noteReconnect();
      this.reconnects += 1;
      const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
      this.attempt += 1;
      this.timer = setTimeout(() => this._open(), base + Math.random() * 250);
    };

    socket.onerror = () => {};
  }

  _startRttProbe() {
    this._stopRttProbe();
    this.rttTimer = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this._sendNow(envelope('ping', { ts: Date.now() }));
      }
    }, RTT_PROBE_MS);
  }

  _stopRttProbe() {
    clearInterval(this.rttTimer);
    this.rttTimer = undefined;
  }

  /**
   * Tracks room-op sequence numbers to detect delivery gaps.
   * init re-baselines; state ops must be contiguous.
   * @param {{t: string, seq?: unknown}} msg
   */
  _observeSeq(msg) {
    const seq = typeof msg.seq === 'number' && Number.isInteger(msg.seq) ? msg.seq : null;
    if (seq === null) return;
    if (msg.t === 'init') {
      this.lastSeq = seq;
      return;
    }
    if (this.lastSeq !== null) this.metrics.noteGap(countMissing(this.lastSeq, seq));
    this.lastSeq = seq;
  }

  /**
   * @param {'up' | 'down' | 'connecting'} status
   */
  _setStatus(status) {
    if (this.status !== status) {
      this.status = status;
      this.dispatchEvent(new CustomEvent('status', { detail: status }));
    }
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  send(msg) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this._sendNow(msg);
    } else {
      if (this.queue.length >= MAX_QUEUE) this.queue.shift();
      this.queue.push(msg);
    }
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  _sendNow(msg) {
    try {
      const wire = JSON.stringify(msg);
      this.metrics.onSend(msg, wireBytes(wire));
      this.socket?.send(wire);
    } catch {
      // dropped frames are recovered by resync
    }
  }
}
