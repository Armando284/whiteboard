'use strict';

/**
 * Top toolbar: tool switching, history actions, keyboard shortcuts.
 */
export class Toolbar {
  /**
   * @param {StoreLike} store
   * @param {{ undo: () => void, redo: () => void, clear: () => void, stats?: () => void, avatar?: () => void }} actions
   * @param {(tool: 'pencil' | 'eraser') => void} onToolChange
   */
  constructor(store, actions, onToolChange) {
    this.store = store;
    this.onToolChange = onToolChange;

    /** @type {NodeListOf<HTMLButtonElement>} */
    const toolButtons = document.querySelectorAll('[data-tool]');
    this.undoBtn = /** @type {HTMLButtonElement} */ (document.getElementById('act-undo'));
    this.redoBtn = /** @type {HTMLButtonElement} */ (document.getElementById('act-redo'));
    this.clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('act-clear'));

    for (const btn of toolButtons) {
      btn.addEventListener('click', () => this.selectTool(/** @type {'pencil'|'eraser'} */ (btn.dataset.tool)));
    }
    this.undoBtn.addEventListener('click', () => actions.undo());
    this.redoBtn.addEventListener('click', () => actions.redo());
    this.clearBtn.addEventListener('click', () => actions.clear());
    if (actions.stats) {
      document.getElementById('act-stats')?.addEventListener('click', () => actions.stats());
    }
    if (actions.avatar) {
      document.getElementById('act-avatar')?.addEventListener('click', () => actions.avatar());
    }

    store.on('ops', () => this._refreshHistory());
    this._refreshHistory();

    document.addEventListener('keydown', (e) => {
      if (this._shortcut(e)) e.preventDefault();
    });
  }

  /**
   * @param {'pencil' | 'eraser'} tool
   */
  selectTool(tool) {
    /** @type {NodeListOf<HTMLButtonElement>} */
    const buttons = document.querySelectorAll('[data-tool]');
    for (const btn of buttons) {
      btn.classList.toggle('active', btn.dataset.tool === tool);
      btn.setAttribute('aria-pressed', String(btn.dataset.tool === tool));
    }
    // Drives the board cursor (body[data-tool='eraser'] .board).
    document.body.dataset.tool = tool;
    this.onToolChange(tool);
  }

  _refreshHistory() {
    this.undoBtn.disabled = !this.store.canUndo();
    this.redoBtn.disabled = !this.store.canRedo();
  }

  /**
   * @param {KeyboardEvent} e
   * @returns {boolean} true when the event was a handled shortcut
   */
  _shortcut(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      this.undoBtn.disabled || this.undoBtn.click();
      return true;
    }
    if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (mod && e.key.toLowerCase() === 'y')) {
      this.redoBtn.disabled || this.redoBtn.click();
      return true;
    }
    if (mod || e.altKey) return false;
    if (e.key.toLowerCase() === 'p') {
      this.selectTool('pencil');
      return true;
    }
    if (e.key.toLowerCase() === 'e') {
      this.selectTool('eraser');
      return true;
    }
    return false;
  }
}

/**
 * @typedef {{ canUndo: () => boolean, canRedo: () => boolean,
 *             on: (kind: string, fn: () => void) => void }} StoreLike
 */
