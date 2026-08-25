'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** Loads index.html into jsdom with browser shims, then runs the real main.js. */
let bootN = 0;
async function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');  const dom = new JSDOM(html, {
    url: 'http://localhost:3000/#uitest',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    beforeParse(window) {
      // Canvas 2D stub: recording context, no real pixels in Node.
      const makeCtx = () => ({
        lineWidth: 2, lineCap: 'round', lineJoin: 'round',
        strokeStyle: '', fillStyle: '', globalAlpha: 1,
        save() {}, restore() {}, setTransform() {}, clearRect() {},
        beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {},
      });
      window.HTMLCanvasElement.prototype.getContext = function () {
        this._ctx = this._ctx || makeCtx();
        return this._ctx;
      };
      class FakeResizeObserver {
        observe() {}
        disconnect() {}
      }
      window.ResizeObserver = FakeResizeObserver;
      // WebSocket that connects to nothing (main.js opens one on boot).
      window.WebSocket = class {
        constructor() {
          this.readyState = 1; // OPEN so sends are attempted
          this.send = () => {};
          this.close = () => {};
        }
      };
    },
  });

  // Expose jsdom's window objects as Node globals for the app modules.
  // (performance stays native: jsdom's own Performance.now recurses here.)
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.ResizeObserver = dom.window.ResizeObserver;
  globalThis.HTMLCanvasElement = dom.window.HTMLCanvasElement;

  // Track intervals so tests can stop them (main.js starts a 1 s readout).
  const pending = new Set();
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const realClearInterval = globalThis.clearInterval.bind(globalThis);
  globalThis.setInterval = (fn, ms) => {
    const id = realSetInterval(fn, ms);
    pending.add(id);
    return id;
  };

  // Swallow rAF frames: the UI assertions don't need repaints and a pending
  // frame would keep the Node event loop alive after the test finishes.
  const rafSink = [];
  const realRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => {
    rafSink.push(cb);
    return rafSink.length;
  };

  await import(`../public/js/main.js?t=${++bootN}`);

  globalThis.setInterval = realSetInterval;
  if (realRaf) globalThis.requestAnimationFrame = realRaf;
  else delete globalThis.requestAnimationFrame;

  return {
    dom,
    cleanup() {
      for (const id of pending) realClearInterval(id);
      pending.clear();
      rafSink.length = 0;
      // Shuts down jsdom's internal clocks for this window.
      dom.window.close();
    },
  };
}

function click(win, el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
}

test('ui: clicking a tool button selects and marks it', async () => {
  const { dom, cleanup } = await boot();
  const doc = dom.window.document;

  try {
    const pencil = doc.getElementById('tool-pencil');
    const eraser = doc.getElementById('tool-eraser');

    // Initial state: pencil is the default active tool.
    assert.equal(pencil.classList.contains('active'), true, 'pencil starts marked as active');

    click(dom.window, eraser);
    assert.equal(eraser.classList.contains('active'), true, 'eraser must be marked after a click');
    assert.equal(pencil.classList.contains('active'), false);
    assert.equal(doc.body.dataset.tool, 'eraser', 'body data-tool follows the selection');

    click(dom.window, pencil);
    assert.equal(pencil.classList.contains('active'), true);
    assert.equal(eraser.classList.contains('active'), false);
    assert.equal(doc.body.dataset.tool, 'pencil');
  } finally {
    cleanup();
  }
});

test('ui: keyboard shortcut keeps buttons in sync with clicks', async () => {
  const { dom, cleanup } = await boot();
  const doc = dom.window.document;
  try {
    const eraser = doc.getElementById('tool-eraser');

    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    assert.equal(eraser.classList.contains('active'), true);
    assert.equal(doc.body.dataset.tool, 'eraser');

    doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    assert.equal(eraser.classList.contains('active'), false);
    assert.equal(doc.body.dataset.tool, 'pencil');
  } finally {
    cleanup();
  }
});

test('ui: media buttons surface explicit errors when media APIs are absent', async () => {
  const { dom, cleanup } = await boot();
  const doc = dom.window.document;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const avatarBtn = doc.getElementById('act-avatar');
    const audioBtn = doc.getElementById('act-audio');
    const label = doc.getElementById('conn-label');

    // No camera API in jsdom → the guard must fire a visible, detailed error.
    // The button lights up optimistically on click, then reverts on failure.
    click(dom.window, avatarBtn);
    assert.equal(avatarBtn.classList.contains('active'), true, 'optimistic highlight');
    await new Promise((r) => setTimeout(r, 5));
    assert.match(label.textContent, /ERR camera/);
    assert.equal(avatarBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(avatarBtn.classList.contains('active'), false, 'highlight reverted');
    assert.ok(
      warns.some((w) => w.includes('avatar unavailable') && w.includes('camera API')),
      `expected detailed avatar warn, got: ${warns.join(' | ')}`,
    );

    click(dom.window, audioBtn);
    assert.equal(audioBtn.classList.contains('active'), true, 'optimistic highlight');
    await new Promise((r) => setTimeout(r, 5));
    assert.match(label.textContent, /ERR mic/);
    assert.equal(audioBtn.classList.contains('active'), false);
    assert.ok(warns.some((w) => w.includes('audio unavailable')), warns.join(' | '));
  } finally {
    console.warn = origWarn;
    cleanup();
  }
});
