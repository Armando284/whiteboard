'use strict';

import { Connection } from './net/connection.js';
import { NetSim } from './net/netsim.js';
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

// Phase 8: optional client-side network simulation (?net=30k&netlat=150...).
const urlParams = new URLSearchParams(location.search);
const simOptions = NetSim.optionsFromURL(urlParams);
/** @type {NetSim | null} */
let netSim = null;
if (simOptions) {
  netSim = new NetSim(simOptions);
  console.info('[low-net] netsim:', NetSim.describe(simOptions));
}

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

const conn = new Connection(null, netSim ? (url) => netSim.wrap(new WebSocket(url)) : undefined);
/** Our server-assigned cid, learned from the init frame. */
let myCid = '';
conn.addEventListener('message', (e) => {
  const msg = /** @type {CustomEvent<Record<string, unknown>>} */ (e).detail;
  switch (msg.t) {
    case 'init':
      if (typeof msg.you === 'string') myCid = msg.you;
      store.applyRemote(msg);
      // Re-announce an active mic after (re)connect so peers can dial us.
      if (audioLink?.enabled) conn.send({ v: 1, t: 'audio_on' });
      break;
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
    case 'audio_on':
    case 'audio_off':
    case 'rtc':
    case 'rtc_ice':
      audioLink?.handleControl(msg);
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

/** @type {import('./audio/audiolink.js').AudioLink | null} */
let audioLink = null;

/** Lazily constructs the audio link; needs our cid from the init frame. */
function loadAudioLink() {
  if (!audioLink) {
    return import('./audio/audiolink.js').then(({ AudioLink }) => {
      const link = new AudioLink(conn, { myCid, onStats: (s) => metricsCard?.setAudioStats(s) });
      audioLink = link;
      return link;
    });
  }
  return Promise.resolve(audioLink);
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
  audio: () => {
    const btn = document.getElementById('act-audio');
    loadAudioLink()
      .then(async (link) => {
        if (link.enabled) {
          link.disable();
          return false;
        }
        await link.enable();
        return true;
      })
      .then((on) => btn?.setAttribute('aria-pressed', String(on)))
      .catch((err) => {
        console.warn('[low-net] audio unavailable:', err?.name || err);
        presence.setError('mic', { code: 'mic' });
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
    if (netSim && simOptions) {
      readout.textContent = NetSim.describe(simOptions);
      readout.title = 'Network simulator active — traffic is artificially throttled';
    }
    setInterval(() => {
      const m = conn.metrics.snapshot();
      readout.textContent = m.rtt.samples
        ? `${netSim ? `${NetSim.describe(simOptions)} · ` : ''}↑ ${(m.rate.upBps / 1024).toFixed(1)} · ↓ ${(m.rate.downBps / 1024).toFixed(1)} kB/s · RTT ${m.rtt.last} ms`
        : netSim
          ? NetSim.describe(simOptions)
          : 'NETWORK —';
    }, 1000);
  }
}

conn.connect(room, uid);

// Auto-open the card when explicitly requested via query param.
if (new URLSearchParams(location.search).has('debug')) {
  loadMetricsCard().then((card) => card.show()).catch(() => {});
}
