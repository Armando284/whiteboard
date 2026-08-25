'use strict';

export const WORLD_W = 800;
export const WORLD_H = 600;
const MAX_UNDO = 100;

/**
 * @typedef {{ id: string, pts: number[] }} StrokeData
 * @typedef {{ t: string, [k: string]: unknown }} WireOp
 * @typedef {{ do: WireOp, undo: WireOp }} OpPair
 *
 * State model:
 *   strokes    committed ops (append-only log, shared source of truth)
 *   hidden     strokes visually hidden during a live erase preview
 *   transient  REMOTE in-progress strokes (live point streams)
 *   (the LOCAL in-progress stroke lives in the render layer, never here,
 *    so remote updates can never destroy it)
 */

/**
 * @returns {{
 *   strokes: Map<string, StrokeData>,
 *   gen: number,
 *   uid: string,
 *   room: string,
 *   hidden: Set<string>,
 *   transient: Map<string, { pts: number[], lastSeen: number }>,
 *   on: (kind: string, fn: (detail?: any) => void) => void,
 *   localAddStroke: (id: string, pts: number[]) => void,
 *   localErase: (ids: string[]) => boolean,
 *   localClear: () => void,
 *   previewHide: (id: string) => void,
 *   undo: () => WireOp | null,
 *   redo: () => WireOp | null,
 *   canUndo: () => boolean,
 *   canRedo: () => boolean,
 *   applyRemote: (msg: Record<string, unknown>) => void,
 * }}
 */
export function createStore() {
  const listeners = new Map();

  /**
   * @param {string} kind
   * @param {(detail?: any) => void} fn
   */
  function on(kind, fn) {
    if (!listeners.has(kind)) listeners.set(kind, new Set());
    listeners.get(kind).add(fn);
  }

  /**
   * @param {string} kind
   * @param {any} [detail]
   */
  function emit(kind, detail) {
    const set = listeners.get(kind);
    if (set) for (const fn of set) fn(detail);
  }

  /** @type {Map<string, StrokeData>} */
  const strokes = new Map();
  /** @type {Set<string>} */
  const hidden = new Set();
  /** @type {Map<string, { pts: number[], lastSeen: number }>} */
  const transient = new Map();
  let gen = 0;
  let uid = '';
  let roomName = '';

  /** @type {OpPair[]} */
  const undoStack = [];
  /** @type {OpPair[]} */
  const redoStack = [];

  /**
   * @param {string} id
   * @param {number[]} pts
   */
  function addStroke(id, pts) {
    strokes.set(id, { id, pts });
  }

  /**
   * @param {Iterable<string>} ids
   */
  function removeStrokes(ids) {
    for (const id of ids) {
      strokes.delete(id);
      hidden.delete(id);
    }
  }

  /**
   * @param {OpPair} pair
   */
  function pushUndo(pair) {
    undoStack.push(pair);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
    emit('ops');
  }

  // -- local actions ---------------------------------------------------------

  /**
   * @param {string} id
   * @param {number[]} pts
   */
  function localAddStroke(id, pts) {
    addStroke(id, pts);
    pushUndo({
      do: { t: 'stroke', id, pts },
      undo: { t: 'unstroke', id },
    });
    emit('add', id);
  }

  /**
   * Erase whole strokes by id. Returns false when nothing matched.
   * @param {string[]} ids
   * @returns {boolean}
   */
  function localErase(ids) {
    const existing = ids.filter((id) => strokes.has(id));
    if (existing.length === 0) return false;
    /** @type {StrokeData[]} */
    const captured = [];
    for (const id of existing) {
      captured.push(/** @type {StrokeData} */ (strokes.get(id)));
      strokes.delete(id);
    }
    pushUndo({
      do: { t: 'erase', ids: existing },
      undo: { t: 'restore', strokes: captured },
    });
    emit('remove', existing);
    return true;
  }

  function localClear() {
    const captured = [...strokes.values()];
    gen += 1;
    strokes.clear();
    hidden.clear();
    pushUndo({
      do: { t: 'clear', gen },
      undo: { t: 'restore', strokes: captured },
    });
    emit('clear');
  }

  // -- history ---------------------------------------------------------------

  /**
   * @param {WireOp} op
   */
  function applyWire(op) {
    switch (op.t) {
      case 'stroke':
        if (typeof op.id === 'string' && Array.isArray(op.pts)) {
          addStroke(op.id, /** @type {number[]} */ (op.pts));
          emit('add', op.id);
        }
        break;
      case 'unstroke':
        if (typeof op.id === 'string') {
          removeStrokes([op.id]);
          emit('remove', [op.id]);
        }
        break;
      case 'erase':
        if (Array.isArray(op.ids)) {
          removeStrokes(/** @type {string[]} */ (op.ids));
          emit('remove', op.ids);
        }
        break;
      case 'restore':
        if (Array.isArray(op.strokes)) {
          for (const s of /** @type {StrokeData[]} */ (op.strokes)) {
            if (s && typeof s.id === 'string' && Array.isArray(s.pts)) {
              addStroke(s.id, s.pts);
            }
          }
          emit('reset');
        }
        break;
      case 'clear':
        gen = Number(op.gen) || gen + 1;
        strokes.clear();
        hidden.clear();
        emit('clear');
        break;
    }
  }

  // -- live erase preview ------------------------------------------------------

  /**
   * Hides a stroke before its erase op commits on pointer-up.
   * @param {string} id
   */
  function previewHide(id) {
    if (!hidden.has(id)) {
      hidden.add(id);
      emit('hidden');
    }
  }

  /**
   * Rolls back live erase previews (pointer cancelled mid-erase).
   * @param {string[]} ids
   */
  function unhidePreview(ids) {
    let changed = false;
    for (const id of ids) {
      if (hidden.delete(id)) changed = true;
    }
    if (changed) emit('hidden');
  }

  /**
   * @returns {WireOp | null}
   */
  function undo() {
    const pair = undoStack.pop();
    if (!pair) return null;
    applyWire(pair.undo);
    redoStack.push(pair);
    emit('ops');
    return pair.undo;
  }

  /**
   * @returns {WireOp | null}
   */
  function redo() {
    const pair = redoStack.pop();
    if (!pair) return null;
    applyWire(pair.do);
    undoStack.push(pair);
    emit('ops');
    return pair.do;
  }

  // -- remote ----------------------------------------------------------------

  /**
   * @param {Record<string, unknown>} msg
   */
  function applyRemote(msg) {
    switch (msg.t) {
      case 'init': {
        uid = typeof msg.uid === 'string' ? msg.uid : '';
        roomName = typeof msg.room === 'string' ? msg.room : '';
        gen = Number(msg.gen) || 0;
        strokes.clear();
        hidden.clear();
        if (Array.isArray(msg.strokes)) {
          for (const raw of msg.strokes) {
            if (raw && typeof raw.id === 'string' && Array.isArray(raw.pts)) {
              addStroke(raw.id, /** @type {number[]} */ (raw.pts));
            }
          }
        }
        emit('reset');
        break;
      }
      case 'stroke':
      case 'unstroke':
      case 'erase':
      case 'restore':
      case 'clear':
        applyWire(msg);
        break;
    }
  }

  return {
    strokes,
    hidden,
    transient,
    get gen() { return gen; },
    get uid() { return uid; },
    get room() { return roomName; },
    on,
    localAddStroke,
    localErase,
    localClear,
    previewHide,
    unhidePreview,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    applyRemote,
  };
}

/**
 * Point-to-segment distance, used by the eraser hit test.
 * @param {number} px
 * @param {number} py
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @returns {number}
 */
export function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
