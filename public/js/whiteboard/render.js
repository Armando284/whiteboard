'use strict';

import { WORLD_W, WORLD_H } from './store.js';

const INK = '#00171f';
const TRANSIENT_ALPHA = 0.5;
const GC_INTERVAL_MS = 2000;

/**
 * Layered renderer:
 *   base canvas     committed strokes (incremental draw; full repaint on remove/reset)
 *   overlay canvas  LOCAL active stroke + REMOTE transient strokes
 *
 * The local in-progress stroke lives here — network updates only ever touch
 * committed state, so they can never destroy work in progress.
 */
export class BoardView {
  /**
   * @param {HTMLElement} container sized by CSS, preserves world aspect
   * @param {HTMLCanvasElement} baseCanvas
   * @param {HTMLCanvasElement} overlayCanvas
   * @param {ReturnType<import('./store.js').createStore>} store
   */
  constructor(container, baseCanvas, overlayCanvas, store) {
    this.container = container;
    this.base = baseCanvas;
    this.overlay = overlayCanvas;
    this.store = store;
    this.bctx = /** @type {CanvasRenderingContext2D} */ (baseCanvas.getContext('2d'));
    this.octx = /** @type {CanvasRenderingContext2D} */ (overlayCanvas.getContext('2d'));
    this.scale = 1;
    this.dpr = 1;

    /** @type {{ id: string, pts: number[] } | null} */
    this.activeStroke = null;
    this.baseDirty = true;
    this.overlayDirty = false;
    /** @type {number | undefined} */
    this.frameHandle = undefined;
    this.lastGc = performance.now();

    for (const ctx of [this.bctx, this.octx]) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK;
      ctx.fillStyle = INK;
    }

    // State changes mark the affected layer dirty AND must schedule the
    // repaint frame — otherwise the canvas stays stale until the next
    // pointer-driven draw happens to flush a frame (erased strokes and
    // clears would only become visible after touching the board again).
    const baseRepaint = () => {
      this.baseDirty = true;
      this._schedule();
    };
    const fullRepaint = () => {
      this.baseDirty = true;
      this.overlayDirty = true;
      this._schedule();
    };
    store.on('add', (id) => this._onAdd(id));
    store.on('remove', baseRepaint);
    store.on('clear', fullRepaint);
    store.on('reset', fullRepaint);
    store.on('hidden', baseRepaint);

    const observeTarget = /** @type {HTMLElement} */ (container.parentElement ?? container);
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(observeTarget);
    this.resize();
  }

  /**
   * Fits the world (preserving aspect) into the parent box and sizes
   * both canvases' backing stores for the device pixel ratio.
   */
  resize() {
    const parent = /** @type {HTMLElement} */ (this.container.parentElement ?? this.container);
    const rect = parent.getBoundingClientRect();
    const availW = Math.max(0, rect.width);
    const availH = Math.max(0, rect.height);
    if (availW < 1 || availH < 1) return;
    this.dpr = window.devicePixelRatio || 1;
    const scale = Math.min(availW / WORLD_W, availH / WORLD_H);
    this.scale = scale;
    const cssW = Math.max(1, Math.floor(WORLD_W * scale));
    const cssH = Math.max(1, Math.floor(WORLD_H * scale));
    this.container.style.width = `${cssW}px`;
    this.container.style.height = `${cssH}px`;
    for (const canvas of [this.base, this.overlay]) {
      canvas.width = Math.round(cssW * this.dpr);
      canvas.height = Math.round(cssH * this.dpr);
    }
    this.baseDirty = true;
    this.overlayDirty = true;
    this._schedule();
  }

  /**
   * Maps a pointer event to world coordinates.
   * @param {PointerEvent | MouseEvent} e
   * @returns {[number, number]}
   */
  worldFromEvent(e) {
    const rect = this.overlay.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WORLD_W;
    const y = ((e.clientY - rect.top) / rect.height) * WORLD_H;
    return [
      Math.max(0, Math.min(WORLD_W - 1, Math.round(x))),
      Math.max(0, Math.min(WORLD_H - 1, Math.round(y))),
    ];
  }

  // -- local active stroke ----------------------------------------------------

  /**
   * @param {string} id
   * @param {[number, number]} pt
   */
  beginStroke(id, [x, y]) {
    this.activeStroke = { id, pts: [x, y] };
    this.overlayDirty = true;
    this._schedule();
  }

  /**
   * @param {[number, number]} pt
   */
  appendPoint([x, y]) {
    if (!this.activeStroke) return;
    const pts = this.activeStroke.pts;
    const n = pts.length;
    if (n >= 2 && pts[n - 2] === x && pts[n - 1] === y) return;
    pts.push(x, y);
    this.overlayDirty = true;
    this._schedule();
  }

  endStroke() {
    this.activeStroke = null;
    this.overlayDirty = true;
    this._schedule();
  }

  // -- remote transient strokes ----------------------------------------------

  /**
   * @param {string} id
   * @param {number[]} ptsChunk
   */
  showTransient(id, ptsChunk) {
    let entry = this.store.transient.get(id);
    if (!entry) {
      entry = { pts: [], lastSeen: performance.now() };
      this.store.transient.set(id, entry);
    }
    for (const v of ptsChunk) entry.pts.push(v);
    if (entry.pts.length > 8192) entry.pts.splice(0, entry.pts.length - 8192);
    entry.lastSeen = performance.now();
    this.overlayDirty = true;
    this._schedule();
  }

  /**
   * @param {string} id
   */
  commitTransient(id) {
    if (this.store.transient.delete(id)) {
      this.overlayDirty = true;
      this._schedule();
    }
  }

  // -- internals ----------------------------------------------------------------

  /**
   * @param {string} id
   */
  _onAdd(id) {
    this.commitTransient(id);
    const s = this.store.strokes.get(id);
    if (!s) return;
    if (this.baseDirty) return; // full pass will include it
    this._setWorldTransform(this.bctx);
    this._drawPath(this.bctx, s.pts);
  }

  _renderBase() {
    const ctx = this.bctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.base.width, this.base.height);
    ctx.restore();
    this._setWorldTransform(ctx);
    for (const s of this.store.strokes.values()) {
      if (this.store.hidden.has(s.id)) continue;
      this._drawPath(ctx, s.pts);
    }
  }

  _renderOverlay() {
    const ctx = this.octx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.restore();
    this._setWorldTransform(ctx);

    ctx.globalAlpha = TRANSIENT_ALPHA;
    for (const entry of this.store.transient.values()) {
      this._drawPath(ctx, entry.pts);
    }
    ctx.globalAlpha = 1;

    if (this.activeStroke) {
      this._drawPath(ctx, this.activeStroke.pts);
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   */
  _setWorldTransform(ctx) {
    ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, 0, 0);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number[]} pts flat [x0,y0,...]
   */
  _drawPath(ctx, pts) {
    const n = pts.length;
    if (n < 2) return;
    if (n === 2) {
      ctx.beginPath();
      ctx.arc(pts[0], pts[1], ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < n; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    ctx.stroke();
  }

  _schedule() {
    if (this.frameHandle !== undefined) return;
    this.frameHandle = requestAnimationFrame(() => {
      this.frameHandle = undefined;
      const now = performance.now();
      if (now - this.lastGc > GC_INTERVAL_MS) {
        this.lastGc = now;
        this._gcTransients(now);
      }
      if (this.baseDirty) {
        this._renderBase();
        this.baseDirty = false;
      }
      if (this.overlayDirty) {
        this._renderOverlay();
        this.overlayDirty = false;
      }
    });
  }

  _gcTransients(now) {
    const TTL = 8000;
    let changed = false;
    for (const [id, entry] of this.store.transient) {
      if (now - entry.lastSeen > TTL) {
        this.store.transient.delete(id);
        changed = true;
      }
    }
    if (changed) this.overlayDirty = true;
  }
}
