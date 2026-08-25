'use strict';

import { distPointToSegment } from './store.js';
import { envelope } from '../net/protocol.js';

const SAMPLE_STEP = 3;
const ERASER_RADIUS = 10;
const PROGRESS_INTERVAL_MS = 90;
const MAX_STROKE_POINTS = 4096;

/**
 * Unified pointer input (mouse / touch / pen via Pointer Events).
 *
 * Pencil: samples the pointer path, streams `progress` chunks at ~11 Hz,
 * and commits the full authoritative stroke on pointer-up.
 * Eraser: hit-tests committed strokes along the eraser path; whole-stroke
 * erase for the MVP. Hits are hidden live (preview) and batched into a
 * single erase op on pointer-up.
 */
export class Tools {
  /**
   * @param {BoardViewLike} view
   * @param {StoreLike} store
   * @param {(msg: Record<string, unknown>) => void} send
   * @param {string} uid
   * @param {string} salt
   */
  constructor(view, store, send, uid, salt) {
    this.view = view;
    this.store = store;
    this.send = send;
    this.uid = uid;
    this.salt = salt;
    /** @type {'pencil' | 'eraser'} */
    this.tool = 'pencil';

    /** @type {'draw' | 'erase' | null} */
    this.mode = null;
    this.lastX = 0;
    this.lastY = 0;
    this.flushedIdx = 0;
    this.lastFlush = 0;
    this.seq = 0;
    /** @type {Set<string>} */
    this.eraseHits = new Set();
  }

  /**
   * @param {HTMLCanvasElement} surface
   */
  attach(surface) {
    surface.addEventListener('pointerdown', (e) => this._down(e));
    surface.addEventListener('pointermove', (e) => this._move(e));
    surface.addEventListener('pointerup', (e) => this._up(e));
    surface.addEventListener('pointercancel', () => this._cancel());
    document.addEventListener('touchmove', (e) => {
      if (this.mode !== null) e.preventDefault();
    }, { passive: false });
  }

  /**
   * @param {PointerEvent} e
   */
  _down(e) {
    if (e.button > 0) return;
    const [x, y] = this.view.worldFromEvent(e);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // some browsers reject capture on synthetic events
    }
    if (this.tool === 'eraser') {
      this.mode = 'erase';
      this.eraseHits.clear();
      this._eraseSegment(x, y, x, y);
    } else {
      this.mode = 'draw';
      this.seq += 1;
      const id = `${this.uid}.${this.salt}.${this.seq}`;
      this.view.beginStroke(id, [x, y]);
      this.flushedIdx = 0;
      this.lastFlush = performance.now();
    }
    this.lastX = x;
    this.lastY = y;
    e.preventDefault();
  }

  /**
   * @param {PointerEvent} e
   */
  _move(e) {
    if (!this.mode) return;
    if (this.mode === 'draw' && !this.view.activeStroke) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = events.length ? events : [e];
    for (const ev of list) {
      const [x, y] = this.view.worldFromEvent(/** @type {PointerEvent} */ (ev));
      if (this.mode === 'draw') {
        this._sampleLine(this.lastX, this.lastY, x, y);
        this._maybeFlushProgress();
      } else {
        this._eraseSegment(this.lastX, this.lastY, x, y);
      }
      this.lastX = x;
      this.lastY = y;
    }
    e.preventDefault();
  }

  /**
   * @param {PointerEvent} _e
   */
  _up(_e) {
    if (this.mode === 'draw') {
      const active = this.view.activeStroke;
      if (active && active.pts.length >= 2) {
        this.store.localAddStroke(active.id, active.pts);
        this.send(envelope('stroke', { id: active.id, pts: active.pts }));
      }
      this.view.endStroke();
    } else if (this.mode === 'erase') {
      this._commitErase();
    }
    this.mode = null;
  }

  _cancel() {
    if (this.mode === 'draw') {
      // In-progress points are discarded; committed state is never touched.
      this.view.endStroke();
    } else if (this.mode === 'erase') {
      this.store.unhidePreview([...this.eraseHits]);
      this.eraseHits.clear();
    }
    this.mode = null;
  }

  /**
   * @private
   */
  _commitErase() {
    const ids = [...this.eraseHits].filter((id) => this.store.strokes.has(id));
    this.eraseHits.clear();
    if (ids.length === 0) return;
    if (this.store.localErase(ids)) {
      this.send(envelope('erase', { ids }));
    }
  }

  /**
   * Interpolates between pointer samples so fast strokes stay smooth
   * without flooding the point buffer.
   * @private
   */
  _sampleLine(x0, y0, x1, y1) {
    const active = this.view.activeStroke;
    if (!active) return;
    if (active.pts.length >= MAX_STROKE_POINTS * 2) return;
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / SAMPLE_STEP));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.view.appendPoint([Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t)]);
    }
  }

  /**
   * @private
   */
  _maybeFlushProgress() {
    const active = this.view.activeStroke;
    if (!active) return;
    const now = performance.now();
    if (now - this.lastFlush < PROGRESS_INTERVAL_MS) return;
    this.lastFlush = now;
    const chunk = active.pts.slice(this.flushedIdx);
    if (chunk.length < 2) return;
    const startIndex = this.flushedIdx / 2;
    this.flushedIdx = active.pts.length;
    this.send(envelope('progress', { id: active.id, i: startIndex, pts: chunk }));
  }

  /**
   * Hit-tests strokes intersecting the eraser path segment.
   * @private
   */
  _eraseSegment(x0, y0, x1, y1) {
    /** @type {string[]} */
    const hits = [];
    for (const s of this.store.strokes.values()) {
      if (this.store.hidden.has(s.id)) continue;
      if (this.eraseHits.has(s.id)) continue;
      if (this._strokeIntersects(s.pts, x0, y0, x1, y1)) hits.push(s.id);
    }
    for (const id of hits) {
      this.store.previewHide(id);
      this.eraseHits.add(id);
    }
  }

  /**
   * @private
   */
  _strokeIntersects(pts, x0, y0, x1, y1) {
    const n = pts.length;
    if (n < 2) return false;
    if (n === 2) {
      return distPointToSegment(pts[0], pts[1], x0, y0, x1, y1) <= ERASER_RADIUS;
    }
    for (let i = 0; i < n - 2; i += 2) {
      if (distPointToSegment(pts[i], pts[i + 1], x0, y0, x1, y1) <= ERASER_RADIUS ||
          distPointToSegment(x0, y0, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= ERASER_RADIUS) {
        return true;
      }
    }
    return false;
  }
}

/**
 * @typedef {{ worldFromEvent: (e: PointerEvent | MouseEvent) => [number, number],
 *             beginStroke: (id: string, pt: [number, number]) => void,
 *             appendPoint: (pt: [number, number]) => void,
 *             endStroke: () => void,
 *             activeStroke: { id: string, pts: number[] } | null }} BoardViewLike
 * @typedef {{ strokes: Map<string, { id: string, pts: number[] }>,
 *             hidden: Set<string>,
 *             localAddStroke: (id: string, pts: number[]) => void,
 *             localErase: (ids: string[]) => boolean,
 *             previewHide: (id: string) => void }} StoreLike
 */
