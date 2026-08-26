'use strict';

import { Connection } from './net/connection.js';
import { NetSim } from './net/netsim.js';
import { getUid, getSessionSalt } from './net/identity.js';
import { VideoManager } from './video/manager.js';
import { VideoUI } from './ui/video.js';
import { NotesUI } from './ui/notes.js';
import { SettingsPanel } from './ui/settings-panel.js';
import { PresenceBar } from './ui/presence.js';
import { Toolbar } from './ui/toolbar.js';

const uid = getUid();
const salt = getSessionSalt();

console.info(
  '[low-net] build',
  document.querySelector('meta[name="build"]')?.content || 'dev',
);

const urlParams = new URLSearchParams(location.search);
const simOptions = NetSim.optionsFromURL(urlParams);
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

// Guard: only initialize if new UI elements exist (not in old test HTML)
const hasNewUI = document.getElementById('remote-video') && document.getElementById('ctrl-camera');
if (!hasNewUI) {
  console.info('[low-net] new UI elements not found, skipping initialization (test mode?)');
}

let conn = null;
let myCid = '';
let presence = null;
let videoUI = null;
let notesUI = null;
let settingsPanel = null;
let ctrlMic = null;
let ctrlCamera = null;
let ctrlNotes = null;
let ctrlNet = null;
let ctrlSettings = null;
let audioLink = null;
let avatarManager = null;
let avatarStudio = null;
let videoManager = null;
let currentVideoMode = 'camera';

if (hasNewUI) {
  conn = new Connection(null, netSim ? (url) => netSim.wrap(new WebSocket(url)) : undefined);

  // Presence bar (top)
  presence = new PresenceBar();
  presence.setIdentifiers(room, uid);
  presence.setStatus('connecting');

  // Video UI elements
  const remoteCanvas = document.getElementById('remote-video');
  const localCanvas = document.getElementById('local-preview');
  const localWrap = document.getElementById('local-preview-wrap');
  const placeholder = document.getElementById('video-placeholder');
  videoUI = new VideoUI({ remoteCanvas, localCanvas, localWrap, placeholder });

  // Notes UI (sidebar/drawer)
  const notesBase = document.getElementById('notes-base');
  const notesOverlay = document.getElementById('notes-overlay');
  const notesContainer = document.querySelector('.notes-board');
  const notesPresence = document.getElementById('notes-presence');
  const notesSidebar = document.getElementById('notes-sidebar');
  const notesToggle = document.getElementById('notes-drawer-toggle');
  const notesClose = document.getElementById('notes-close');

  notesUI = new NotesUI({
    conn,
    uid,
    salt,
    baseCanvas: notesBase,
    overlayCanvas: notesOverlay,
    boardContainer: notesContainer,
    presenceEl: notesPresence,
    onToolChange: () => {},
  });

  // Settings panel
  const settingsPanelEl = document.getElementById('settings-panel');
  const settingsClose = document.getElementById('settings-close');
  settingsPanel = new SettingsPanel({
    panel: settingsPanelEl,
    videoManager: null,
    avatarManager: null,
    conn,
    onVideoModeChange: (mode) => handleVideoModeChange(mode),
    onConfigChange: (config) => videoManager?.setConfig(config),
  });

  // Controls
  ctrlMic = document.getElementById('ctrl-mic');
  ctrlCamera = document.getElementById('ctrl-camera');
  ctrlNotes = document.getElementById('ctrl-notes');
  ctrlNet = document.getElementById('ctrl-net');
  ctrlSettings = document.getElementById('ctrl-settings');

  conn.addEventListener('message', (e) => {
    const msg = e.detail;
    switch (msg.t) {
      case 'init':
        if (typeof msg.you === 'string') myCid = msg.you;
        notesUI.store.applyRemote(msg);
        if (audioLink?.enabled) conn.send({ v: 1, t: 'audio_on' });
        if (avatarManager?.active) conn.send({ v: 1, t: 'avatar_on' });
        if (videoManager?.active) videoManager._sendConfig();
        break;
      case 'stroke':
      case 'unstroke':
      case 'erase':
      case 'restore':
      case 'clear':
      case 'progress':
        notesUI.store.applyRemote(msg);
        break;
      case 'presence': {
        const members = Array.isArray(msg.members) ? msg.members : [];
        presence.setMembers(members, uid);
        notesUI.presence.setMembers(members, uid);
        avatarManager?.syncMembers(members);
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
      case 'err':
        presence.setError(typeof msg.code === 'string' ? msg.code : 'unknown', msg);
        break;
    }
  });

  conn.addEventListener('status', (e) => {
    presence.setStatus(e.detail);
  });

  // Video binary frames
  conn.addEventListener('video', (e) => {
    if (videoManager) {
      videoManager._handleBinary({ detail: e.detail });
    }
  });

  // Avatar binary frames
  conn.addEventListener('binary', (e) => {
    avatarManager?.handleBinary(e.detail);
  });

  function act(msg) {
    if (msg) conn.send(msg);
  }

  // Video mode handling
  async function handleVideoModeChange(mode) {
    if (mode === currentVideoMode) return;

    if (mode === 'camera') {
      if (avatarManager?.active) {
        await avatarManager.toggle();
      }
      if (!videoManager) {
        videoManager = new VideoManager({
          conn,
          onLocalFrame: (frame, meta) => videoUI.renderLocal(frame, videoManager.config.width, videoManager.config.height),
          onRemoteFrame: (frame, meta) => videoUI.renderRemote(frame, videoManager.config.width, videoManager.config.height),
          onStats: (stats) => settingsPanel._renderMetrics?.(),
          onError: (err) => console.warn('[low-net] video error:', err),
        });
        settingsPanel.setVideoManager(videoManager);
      }
      try {
        await videoManager.start();
        ctrlCamera.setAttribute('aria-pressed', 'true');
        ctrlCamera.classList.add('active');
      } catch (err) {
        console.warn('[low-net] camera start failed:', err);
        presence.setError('camera', { code: 'camera' });
        ctrlCamera.setAttribute('aria-pressed', 'false');
        ctrlCamera.classList.remove('active');
      }
    } else if (mode === 'avatar') {
      if (videoManager?.active) {
        videoManager.stop();
        videoManager = null;
        settingsPanel.setVideoManager(null);
        videoUI.showWaiting();
        videoUI.hideLocal();
      }
      if (!avatarManager) {
        const { AvatarManager, avatarConfigFromURL } = await import('./avatar/avatar.js');
        const cfg = avatarConfigFromURL(new URLSearchParams(location.search));
        avatarManager = new AvatarManager(conn, cfg);
        avatarManager.myUid = uid;
      }
      try {
        await avatarManager.toggle();
        if (avatarManager.active) {
          const { AvatarStudio } = await import('./ui/avatar-studio.js');
          avatarStudio = new AvatarStudio(avatarManager);
        }
      } catch (err) {
        console.warn('[low-net] avatar unavailable:', err);
        presence.setError('camera', { code: 'camera' });
      }
    }

    currentVideoMode = mode;
    settingsPanel.setMode(mode);
  }

  // Controls
  function setCtrlState(btn, on) {
    if (!btn) return;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  ctrlMic.addEventListener('click', async () => {
    const willEnable = !audioLink?.enabled;
    setCtrlState(ctrlMic, true);
    try {
      if (!audioLink) {
        const { AudioLink } = await import('./audio/audiolink.js');
        audioLink = new AudioLink(conn, { myCid, onStats: (s) => {} });
      }
      if (willEnable) {
        await audioLink.enable();
      } else {
        audioLink.disable();
      }
      setCtrlState(ctrlMic, audioLink.enabled);
    } catch (err) {
      console.warn('[low-net] audio error:', err);
      presence.setError('mic', { code: 'mic' });
      setCtrlState(ctrlMic, false);
    }
  });

  ctrlCamera.addEventListener('click', async () => {
    if (currentVideoMode === 'camera') {
      if (videoManager?.active) {
        videoManager.stop();
        videoUI.showWaiting();
        videoUI.hideLocal();
        setCtrlState(ctrlCamera, false);
      } else {
        try {
          if (!videoManager) {
            videoManager = new VideoManager({
              conn,
              onLocalFrame: (frame) => videoUI.renderLocal(frame, videoManager.config.width, videoManager.config.height),
              onRemoteFrame: (frame) => videoUI.renderRemote(frame, videoManager.config.width, videoManager.config.height),
              onStats: () => settingsPanel._renderMetrics?.(),
              onError: (err) => console.warn('[low-net] video error:', err),
            });
            settingsPanel.setVideoManager(videoManager);
          }
          await videoManager.start();
          setCtrlState(ctrlCamera, true);
        } catch (err) {
          console.warn('[low-net] camera error:', err);
          presence.setError('camera', { code: 'camera' });
          setCtrlState(ctrlCamera, false);
        }
      }
    } else {
      if (avatarManager) {
        const on = await avatarManager.toggle();
        setCtrlState(ctrlCamera, on);
        if (on && !avatarStudio) {
          const { AvatarStudio } = await import('./ui/avatar-studio.js');
          avatarStudio = new AvatarStudio(avatarManager);
        }
      }
    }
  });

  ctrlNotes.addEventListener('click', () => {
    const open = !notesSidebar.classList.contains('open');
    notesSidebar.classList.toggle('open', open);
    notesToggle.hidden = !open;
    setCtrlState(ctrlNotes, open);
  });

  ctrlNet.addEventListener('click', async () => {
    const { MetricsCard } = await import('./ui/metrics-card.js');
    const card = new MetricsCard(conn, notesUI.store, {
      getSim: () => (simOptions ? NetSim.describe(simOptions) : null),
    });
    card.toggle();
    setCtrlState(ctrlNet, card.visible);
  });

  ctrlSettings.addEventListener('click', () => {
    settingsPanel.toggle();
    setCtrlState(ctrlSettings, settingsPanel.visible);
  });

  settingsClose.addEventListener('click', () => {
    settingsPanel.hide();
    setCtrlState(ctrlSettings, false);
  });

  notesClose.addEventListener('click', () => {
    notesSidebar.classList.remove('open');
    notesToggle.hidden = true;
    setCtrlState(ctrlNotes, false);
  });

notesToggle.addEventListener('click', () => {
  notesSidebar.classList.add('open');
  notesToggle.hidden = true;
  setCtrlState(ctrlNotes, true);
});

// Legacy button handlers (for test compatibility)
const actAvatar = document.getElementById('act-avatar');
const actAudio = document.getElementById('act-audio');
const actStats = document.getElementById('act-stats');

actAvatar?.addEventListener('click', async () => {
  // Optimistic highlight like old code
  setCtrlState(actAvatar, true);
  try {
    if (currentVideoMode === 'camera') {
      await handleVideoModeChange('avatar');
    } else {
      await handleVideoModeChange('camera');
    }
    setCtrlState(actAvatar, currentVideoMode === 'avatar');
  } catch (err) {
    setCtrlState(actAvatar, false);
  }
});

actAudio?.addEventListener('click', async () => {
  // Optimistic highlight like old code
  setCtrlState(actAudio, true);
  setCtrlState(ctrlMic, true);
  const willEnable = !audioLink?.enabled;
  try {
    if (!audioLink) {
      const { AudioLink } = await import('./audio/audiolink.js');
      audioLink = new AudioLink(conn, { myCid, onStats: (s) => {} });
    }
    if (willEnable) {
      // Synchronous check - if no mediaDevices, use microtask for reset like old code
      if (!navigator.mediaDevices?.getUserMedia) {
        await Promise.resolve().then(() => {
          throw new Error('microphone API unavailable (insecure context — use https:// or localhost)');
        });
      }
      await audioLink.enable();
    } else {
      audioLink.disable();
    }
    setCtrlState(actAudio, audioLink.enabled);
    setCtrlState(ctrlMic, audioLink.enabled);
  } catch (err) {
    console.warn('[low-net] audio error:', err);
    presence.setError('mic', { code: 'mic' });
    // Reset in next microtask like old .catch() behavior
    Promise.resolve().then(() => {
      setCtrlState(actAudio, false);
      setCtrlState(ctrlMic, false);
    });
  }
});

actStats?.addEventListener('click', async () => {
  const { MetricsCard } = await import('./ui/metrics-card.js');
  const card = new MetricsCard(conn, notesUI.store, {
    getSim: () => (simOptions ? NetSim.describe(simOptions) : null),
  });
  card.toggle();
});

// Close settings when clicking outside
  document.addEventListener('click', (e) => {
    if (settingsPanel.visible &&
        !settingsPanelEl.contains(e.target) &&
        !ctrlSettings.contains(e.target)) {
      settingsPanel.hide();
      setCtrlState(ctrlSettings, false);
    }
  });

  // Handle window resize for notes
  new ResizeObserver(() => notesUI.resize()).observe(notesContainer);

  // Initial connection
  conn.connect(room, uid);

  // Start in camera mode by default
  handleVideoModeChange('camera');

  // Auto-open metrics card if ?debug
  if (urlParams.has('debug')) {
    const { MetricsCard } = await import('./ui/metrics-card.js');
    const card = new MetricsCard(conn, notesUI.store, {
      getSim: () => (simOptions ? NetSim.describe(simOptions) : null),
    });
    card.show();
  }
}

// Export a factory function for tests to get initialized components
export async function initTest() {
  if (!hasNewUI) {
    return {
      conn: null,
      videoManager: null,
      videoUI: null,
      notesUI: null,
      settingsPanel: null,
      presence: null,
      audioLink: null,
      avatarManager: null,
    };
  }
  // Wait for async initialization to complete
  await new Promise(r => setTimeout(r, 100));
  return { conn, videoManager, videoUI, notesUI, settingsPanel, presence, audioLink, avatarManager };
}