'use strict';

/**
 * Notes UI — embeds the whiteboard in the sidebar (desktop) or drawer (mobile).
 * Reuses BoardView, Tools, Store from whiteboard modules.
 */

import { createStore } from '../whiteboard/store.js';
import { BoardView } from '../whiteboard/render.js';
import { Tools } from '../whiteboard/tools.js';
import { Toolbar } from './toolbar.js';
import { PresenceBar } from './presence.js';
import { envelope } from '../net/protocol.js';

export class NotesUI {
  /**
   * @param {{
   *   conn: import('../net/connection.js').Connection,
   *   uid: string,
   *   salt: string,
   *   baseCanvas: HTMLCanvasElement,
   *   overlayCanvas: HTMLCanvasElement,
   *   boardContainer: HTMLElement,
   *   presenceEl: HTMLElement,
   *   onToolChange: (tool: 'pencil'|'eraser') => void
   * }} opts
   */
  constructor(opts) {
    this.conn = opts.conn;
    this.uid = opts.uid;
    this.salt = opts.salt;

    this.store = createStore();
    this.baseCanvas = opts.baseCanvas;
    this.overlayCanvas = opts.overlayCanvas;
    this.boardContainer = opts.boardContainer;
    this.presenceEl = opts.presenceEl;

    this.view = new BoardView(this.boardContainer, this.baseCanvas, this.overlayCanvas, this.store);
    this.presence = new PresenceBar();
    this.presence.setIdentifiers(this.conn.room, this.uid);

    this.tools = new Tools(this.view, this.store, (msg) => this.conn.send(msg), this.uid, this.salt);
    this.tools.attach(this.overlayCanvas);

    this.toolbar = new Toolbar(this.store, {
      undo: () => this.conn.send(this.store.undo()),
      redo: () => this.conn.send(this.store.redo()),
      clear: () => {
        this.store.localClear();
        this.conn.send(envelope('clear'));
      },
    }, (tool) => {
      this.tools.tool = tool;
      opts.onToolChange?.(tool);
    });

    // Wire store events
    this.store.on('add', (id) => this.view.commitTransient(id));
    this.store.on('remove', () => this.view._schedule());
    this.store.on('clear', () => this.view._schedule());
    this.store.on('reset', () => this.view._schedule());
    this.store.on('hidden', () => this.view._schedule());

    // Handle remote messages
    this.conn.addEventListener('message', (e) => this._onMessage(e.detail));
    this.conn.addEventListener('binary', (e) => this._onBinary(e.detail));
    this.conn.addEventListener('status', (e) => this.presence.setStatus(e.detail));
  }

  _onMessage(msg) {
    switch (msg.t) {
      case 'init':
        this.store.applyRemote(msg);
        if (msg.cfgs) {
          // Avatar cfgs ignored in notes mode
        }
        break;
      case 'stroke':
      case 'unstroke':
      case 'erase':
      case 'restore':
      case 'clear':
        this.store.applyRemote(msg);
        break;
      case 'progress': {
        const id = typeof msg.id === 'string' ? msg.id : '';
        const pts = Array.isArray(msg.pts) ? msg.pts : [];
        if (id && pts.length >= 2 && !this.store.strokes.has(id)) {
          this.view.showTransient(id, pts);
        }
        break;
      }
      case 'presence': {
        const members = Array.isArray(msg.members) ? msg.members : [];
        this.presence.setMembers(members, this.uid);
        break;
      }
      case 'err':
        this.presence.setError(typeof msg.code === 'string' ? msg.code : 'unknown', msg);
        break;
    }
  }

  _onBinary(_buf) {
    // Ignore avatar/video binary in notes mode
  }

  /** Resize the board (call on container resize). */
  resize() {
    this.view.resize();
  }

  /** Get current tool. */
  get tool() {
    return this.tools.tool;
  }

  /** Set tool externally. */
  set tool(t) {
    this.tools.tool = t;
  }
}