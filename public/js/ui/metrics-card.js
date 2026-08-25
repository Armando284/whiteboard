'use strict';

/**
 * MetricsCard — right-side card showing live NetworkMetrics.
 * Loaded via dynamic import when the user opens it (or ?debug=1),
 * so the default page pays nothing for instrumentation UI.
 */

const KB = 1024;

/**
 * @param {number} bytes
 * @returns {string}
 */
function fmtBytes(bytes) {
  if (bytes < KB) return `${bytes} B`;
  return `${(bytes / KB).toFixed(1)} KB`;
}

/**
 * @param {number} bps bytes per second
 * @returns {string}
 */
function fmtRate(bps) {
  return `${(bps / KB).toFixed(1)} kB/s`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** @typedef {import('../net/connection.js').Connection} Conn */
/** @typedef {ReturnType<import('../whiteboard/store.js').createStore>} Store */

export class MetricsCard {
  /**
   * @param {Conn} conn
   * @param {Store} store
   */
  constructor(conn, store) {
    this.conn = conn;
    this.store = store;
    this.visible = false;
    /** @type {number | undefined} */
    this.timer = undefined;

    const el = document.createElement('aside');
    el.className = 'metrics-card';
    el.hidden = true;
    el.innerHTML = `
      <header>
        <span>NETWORK</span>
        <button type="button" class="close" title="Close" aria-label="Close network stats">×</button>
      </header>
      <dl>
        <dt>Status</dt><dd data-k="status">—</dd>
        <dt>Room</dt><dd data-k="room">—</dd>
        <dt>Uptime</dt><dd data-k="uptime">—</dd>
        <dt>RTT</dt><dd data-k="rtt">—</dd>
        <dt>Msg/s</dt><dd data-k="mps">—</dd>
        <dt>Rate now</dt><dd data-k="rate">—</dd>
        <dt>Rate peak</dt><dd data-k="peak">—</dd>
        <dt>Total sent</dt><dd data-k="up">—</dd>
        <dt>Total recv</dt><dd data-k="down">—</dd>
        <dt>Board traffic</dt><dd data-k="board">—</dd>
        <dt>Control traffic</dt><dd data-k="ctrl">—</dd>
        <dt>Strokes</dt><dd data-k="strokes">—</dd>
        <dt>Outbox</dt><dd data-k="outbox">—</dd>
        <dt>Reconnects</dt><dd data-k="reconnects">—</dd>
        <dt>FPS</dt><dd data-k="fps">—</dd>
      </dl>`;
    document.body.appendChild(el);
    this.el = el;

    /** @type {Record<string, HTMLElement>} */
    const fields = {};
    for (const dd of el.querySelectorAll('dd[data-k]')) {
      fields[/** @type {HTMLElement} */ (dd).dataset.k] = /** @type {HTMLElement} */ (dd);
    }
    this.fields = fields;
    el.querySelector('.close')?.addEventListener('click', () => this.hide());
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  show() {
    this.visible = true;
    this.el.hidden = false;
    this._startFps();
    this._render();
    clearInterval(this.timer);
    this.timer = setInterval(() => this._render(), 1000);
  }

  hide() {
    this.visible = false;
    this.el.hidden = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  _render() {
    const m = this.conn.metrics.snapshot();
    const r = m.rate;
    const f = this.fields;
    f.status.textContent = this.conn.status;
    f.status.dataset.state = this.conn.status;
    f.room.textContent = `#${this.conn.room} · ${this.conn.uid}`;
    f.uptime.textContent = fmtUptime(m.uptimeMs);
    f.rtt.textContent = m.rtt.samples
      ? `${m.rtt.last} ms (avg ${m.rtt.ema})`
      : '—';
    f.mps.textContent = `↑ ${r.upMps} · ↓ ${r.downMps}`;
    f.rate.textContent = `↑ ${fmtRate(r.upBps)} · ↓ ${fmtRate(r.downBps)}`;
    f.peak.textContent = `↑ ${fmtRate(r.peakUpBps)} · ↓ ${fmtRate(r.peakDownBps)}`;
    f.up.textContent = `${fmtBytes(m.sent.bytes)} (${fmtRate(r.upBpsAvg)} avg)`;
    f.down.textContent = `${fmtBytes(m.recv.bytes)} (${fmtRate(r.downBpsAvg)} avg)`;
    f.board.textContent =
      `${fmtBytes(m.sent.board + m.recv.board)} ` +
      `(↑${fmtBytes(m.sent.board)} ↓${fmtBytes(m.recv.board)})`;
    f.ctrl.textContent =
      `${fmtBytes(m.sent.control + m.recv.control)} ` +
      `(↑${fmtBytes(m.sent.control)} ↓${fmtBytes(m.recv.control)})`;
    f.strokes.textContent =
      `${this.store.strokes.size} · gen ${this.store.gen}` +
      (this.store.hidden.size ? ` · erasing ${this.store.hidden.size}` : '');
    f.outbox.textContent = `${this.conn.queue.length}/256`;
    f.reconnects.textContent = String(m.reconnects);
    f.fps.textContent = this._fps > 0 ? String(this._fps) : '—';
  }

  /**
   * FPS counter, started once on first open.
   */
  _startFps() {
    if (this._fpsStarted) return;
    this._fpsStarted = true;
    this._fps = 0;
    let frames = 0;
    /** @type {(t: number) => void} */
    const tick = () => {
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setInterval(() => {
      this._fps = frames;
      frames = 0;
    }, 1000);
  }
}
