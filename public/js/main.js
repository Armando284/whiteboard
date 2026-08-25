'use strict';

import { Connection } from './net/connection.js';
import { getUid, getSessionSalt } from './net/identity.js';
import { createStore } from './whiteboard/store.js';
import { BoardView } from './whiteboard/render.js';
import { Tools } from './whiteboard/tools.js';
import { Toolbar } from './ui/toolbar.js';
import { PresenceBar } from './ui/presence.js';

const uid = getUid();
const salt = getSessionSalt();

// Visible build marker: lets anyone confirm which version the browser runs.
console.info(
  '[low-net] build',
  document.querySelector('meta[name="build"]')?.content || 'dev',
);

let room = '';
{
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  room = /^[A-Za-z0-9_-]{1,32}$/.test(raw) ? raw : 'lobby';
  if (location.hash.slice(1) !== room) history.replaceState(null, '', `#${room}`);
}

const store = createStore();
const baseCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board-base'));
const overlayCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('board-overlay'));
const boardEl = /** @type {HTMLElement} */ (document.querySelector('.board'));

const view = new BoardView(boardEl, baseCanvas, overlayCanvas, store);
const presence = new PresenceBar();
presence.setIdentifiers(room, uid);
presence.setStatus('connecting');

const conn = new Connection();
conn.addEventListener('message', (e) => {
  const msg = /** @type {CustomEvent<Record<string, unknown>>} */ (e).detail;
  switch (msg.t) {
    case 'init':
    case 'stroke':
    case 'unstroke':
    case 'erase':
    case 'restore':
    case 'clear':
      store.applyRemote(msg);
      break;
    case 'progress': {
      const id = typeof msg.id === 'string' ? msg.id : '';
      const pts = Array.isArray(msg.pts) ? msg.pts : [];
      if (id && pts.length >= 2 && !store.strokes.has(id)) {
        view.showTransient(id, pts);
      }
      break;
    }
    case 'presence': {
      const members = Array.isArray(msg.members) ? msg.members : [];
      presence.setMembers(/** @type {{cid: string, uid: string}[]} */ (members), uid);
      avatarManager?.syncMembers(/** @type {{cid: string, uid: string}[]} */ (members));
      break;
    }
    case 'avatar_off':
      avatarManager?.remove(typeof msg.cid === 'string' ? msg.cid : '');
      break;
    case 'err': {
      presence.setError(typeof msg.code === 'string' ? msg.code : 'unknown', msg);
      break;
    }
  }
});
conn.addEventListener('status', (e) => {
  presence.setStatus(/** @type {CustomEvent<'up'|'down'|'connecting'>} */ (e).detail);
});

/** @type {import('./avatar/avatar.js').AvatarManager | null} */
let avatarManager = null;
conn.addEventListener('binary', (e) => {
  avatarManager?.handleBinary(/** @type {CustomEvent<ArrayBuffer>} */ (e).detail);
});

/** @param {Record<string, unknown>} msg */
function act(msg) {
  if (msg) conn.send(msg);
}

const tools = new Tools(view, store, (m) => act(m), uid, salt);
tools.attach(overlayCanvas);

/** @type {import('./ui/metrics-card.js').MetricsCard | null} */
let metricsCard = null;

/** @returns {Promise<import('./ui/metrics-card.js').MetricsCard>} */
function loadMetricsCard() {
  if (!metricsCard) {
    return import('./ui/metrics-card.js').then(({ MetricsCard }) => {
      metricsCard = new MetricsCard(conn, store);
      return metricsCard;
    });
  }
  return Promise.resolve(metricsCard);
}

/** @type {Promise<import('./avatar/avatar.js').AvatarManager> | null} */
let avatarManagerPromise = null;

/** Loads the avatar module (MediaPipe etc.) only on first use. */
function loadAvatarManager() {
  if (!avatarManagerPromise) {
    avatarManagerPromise = import('./avatar/avatar.js').then(({ AvatarManager, avatarConfigFromURL }) => {
      const cfg = avatarConfigFromURL(new URLSearchParams(location.search));
      const mgr = new AvatarManager(conn, cfg);
      mgr.myUid = uid;
      avatarManager = mgr;
      return mgr;
    });
  }
  return avatarManagerPromise;
}

new Toolbar(store, {
  undo: () => act(store.undo()),
  redo: () => act(store.redo()),
  clear: () => {
    store.localClear();
    act({ v: 1, t: 'clear' });
  },
  stats: () => {
    loadMetricsCard().then((card) => {
      card.toggle();
      document.getElementById('act-stats')?.setAttribute('aria-pressed', String(card.visible));
    });
  },
  avatar: () => {
    const btn = document.getElementById('act-avatar');
    loadAvatarManager()
      .then((mgr) => mgr.toggle())
      .then((on) => btn?.setAttribute('aria-pressed', String(on)))
      .catch((err) => {
        console.warn('[low-net] avatar unavailable:', err?.name || err);
        presence.setError('camera', { code: 'camera' });
        btn?.setAttribute('aria-pressed', 'false');
      });
  },
}, (tool) => {
  tools.tool = tool;
});

// Ambient readout in the status bar; costs one textContent write per second.
{
  const readout = document.getElementById('net-readout');
  if (readout) {
    setInterval(() => {
      const m = conn.metrics.snapshot();
      readout.textContent = m.rtt.samples
        ? `↑ ${(m.rate.upBps / 1024).toFixed(1)} · ↓ ${(m.rate.downBps / 1024).toFixed(1)} kB/s · RTT ${m.rtt.last} ms`
        : 'NETWORK —';
    }, 1000);
  }
}

conn.connect(room, uid);

// Auto-open the card when explicitly requested via query param.
if (new URLSearchParams(location.search).has('debug')) {
  loadMetricsCard().then((card) => card.show()).catch(() => {});
}
