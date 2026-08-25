'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims so BoardView can run under Node.
let rafQueue = [];

globalThis.requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.window = { devicePixelRatio: 1 };

function makeCtx() {
  const ctx = {
    calls: [],
    lineWidth: 2,
  };
  for (const m of ['save', 'restore', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill']) {
    ctx[m] = (...args) => ctx.calls.push([m, args]);
    if (m === 'clearRect') {
      ctx[m] = (...args) => {
        ctx.calls.push(['clearRect', args]);
        ctx.clearRects = (ctx.clearRects || 0) + 1;
      };
    }
  }
  ctx.setTransform = () => {};
  return ctx;
}

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ width: 800, height: 600 }),
  };
}

function flushFrames() {
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) cb(performance.now());
}

test.beforeEach(() => {
  rafQueue = [];
});

async function setup() {
  const [{ createStore }, { BoardView }] = await Promise.all([
    import('../public/js/whiteboard/store.js'),
    import('../public/js/whiteboard/render.js'),
  ]);
  const store = createStore();
  const container = {
    style: {},
    parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
  };
  const baseCanvas = makeCanvas();
  const overlayCanvas = makeCanvas();
  baseCanvas.getContext = () => makeCtx();
  overlayCanvas.getContext = () => makeCtx();

  const view = new BoardView(container, baseCanvas, overlayCanvas, store);
  // Initial resize schedules a frame; drain it so tests start clean.
  flushFrames();
  assert.equal(rafQueue.length, 0);
  view.bctx.clearRects = 0;

  return { store, view };
}

test('regression: erasing a stroke schedules a repaint immediately', async () => {
  const { store } = await setup();
  store.localAddStroke('a', [10, 10, 50, 50]);
  flushFrames(); // initial 'add' paint settles

  store.localErase(['a']);
  assert.ok(rafQueue.length > 0, 'localErase must schedule a repaint frame');
  flushFrames();
});

test('regression: live erase preview schedules a repaint per hide', async () => {
  const { store } = await setup();
  store.localAddStroke('a', [10, 10, 50, 50]);
  flushFrames();

  store.previewHide('a');
  assert.ok(rafQueue.length > 0, 'previewHide must schedule a repaint frame');
  flushFrames();
});

test('regression: clear schedules a full repaint without touching the canvas', async () => {
  const { store, view } = await setup();
  store.localAddStroke('a', [10, 10, 50, 50]);
  flushFrames();

  const before = view.bctx.clearRects;
  store.localClear();
  assert.ok(rafQueue.length > 0, 'localClear must schedule a repaint frame');
  flushFrames();
  assert.ok(view.bctx.clearRects > before, 'base canvas must be cleared by the scheduled frame');
});

test('regression: remote ops arriving while idle are painted without local input', async () => {
  const { store, view } = await setup();

  // Committed adds paint synchronously (incremental draw, no rAF needed).
  store.applyRemote({ t: 'stroke', id: 'peer.1.1', pts: [20, 20, 80, 80] });
  assert.ok(
    view.bctx.calls.some(([m]) => m === 'moveTo'),
    'remote stroke must be painted onto the base layer',
  );

  // Removals need a scheduled full repaint.
  store.applyRemote({ t: 'erase', ids: ['peer.1.1'] });
  assert.ok(rafQueue.length > 0, 'remote erase must schedule a repaint frame');
  flushFrames();
});
