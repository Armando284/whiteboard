'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal browser shims (same approach as render.test.mjs).
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
globalThis.document = { addEventListener: () => {} };

function flushFrames() {
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) cb(performance.now());
}

function makeCtx() {
  const ctx = { lineWidth: 2 };
  for (const m of ['save', 'restore', 'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill']) {
    ctx[m] = () => {};
  }
  ctx.setTransform = () => {};
  return ctx;
}

/** Synthetic event target capturing listeners, like a DOM canvas. */
function makeSurface() {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  return {
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    setPointerCapture() {},
    /** @param {string} type @param {Record<string, unknown>} props */
    fire(type, props) {
      for (const fn of handlers.get(type) || []) {
        fn({
          button: 0,
          pointerId: 1,
          preventDefault: () => {},
          currentTarget: this,
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
          getCoalescedEvents: undefined,
          ...props,
        });
      }
    },
  };
}

async function setup() {
  const [{ createStore }, { BoardView }, { distPointToSegment }] = await Promise.all([
    import('../public/js/whiteboard/store.js'),
    import('../public/js/whiteboard/render.js'),
    import('../public/js/whiteboard/store.js').then((m) => ({ distPointToSegment: m.distPointToSegment })),
  ]);
  void distPointToSegment;

  const store = createStore();
  const container = {
    style: {},
    parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) },
  };
  const makeCanvas = () => ({
    width: 0,
    height: 0,
    style: {},
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  const view = new BoardView(container, makeCanvas(), makeCanvas(), store);
  flushFrames();

  const surface = makeSurface();
  /** @type {Record<string, unknown>[]} */
  const sent = [];
  const { Tools } = await import('../public/js/whiteboard/tools.js');
  const tools = new Tools(view, store, (msg) => sent.push(msg), 'AAAA', 'ZZ');
  tools.attach(surface);

  return { store, view, surface, sent, tools };
}

test('eraser e2e: drag across a stroke hides it live and commits the erase op', async () => {
  const { store, surface, sent, tools } = await setup();
  tools.tool = 'eraser';
  store.localAddStroke('t1', [100, 100, 300, 300]);
  flushFrames();
  assert.equal(store.strokes.size, 1);

  // Pointer down right on the stroke path.
  surface.fire('pointerdown', { clientX: 102, clientY: 104 });

  // Live preview: stroke must be hidden immediately, before any pointer-up.
  assert.equal(store.hidden.has('t1'), true, 'stroke must hide during live erase');

  // Drag along the path.
  surface.fire('pointermove', { clientX: 120, clientY: 122 });

  // Release: op must be broadcast and state must drop the stroke.
  surface.fire('pointerup', {});
  flushFrames();

  const eraseOps = sent.filter((m) => m.t === 'erase');
  assert.equal(eraseOps.length, 1, 'exactly one erase op on release');
  assert.deepEqual(eraseOps[0].ids, ['t1']);
  assert.equal(store.strokes.has('t1'), false, 'stroke must leave committed state');
  assert.equal(store.hidden.has('t1'), false, 'preview bookkeeping cleaned up');
});

test('eraser e2e: dragging over empty space sends nothing', async () => {
  const { store, surface, sent, tools } = await setup();
  tools.tool = 'eraser';
  store.localAddStroke('far', [700, 500, 750, 550]);
  flushFrames();

  surface.fire('pointerdown', { clientX: 50, clientY: 50 });
  surface.fire('pointermove', { clientX: 60, clientY: 60 });
  surface.fire('pointerup', {});

  assert.equal(sent.filter((m) => m.t === 'erase').length, 0, 'no erase op without hits');
  assert.equal(store.strokes.has('far'), true, 'untouched stroke survives');
  assert.equal(store.hidden.size, 0);
});

test('eraser e2e: cancelling restores hidden strokes without ops', async () => {
  const { store, surface, sent, tools } = await setup();
  tools.tool = 'eraser';
  store.localAddStroke('c1', [200, 200, 260, 260]);
  flushFrames();

  surface.fire('pointerdown', { clientX: 202, clientY: 202 });
  assert.equal(store.hidden.has('c1'), true);

  surface.fire('pointercancel', {});
  assert.equal(store.hidden.has('c1'), false, 'cancel rolls back preview');
  assert.equal(store.strokes.has('c1'), true, 'stroke restored');
  assert.equal(sent.filter((m) => m.t === 'erase').length, 0);
});

test('hit-test geometry: segment distance is exact', async () => {
  const { distPointToSegment } = await import('../public/js/whiteboard/store.js');
  // Point 10 units above the middle of a horizontal segment.
  assert.ok(Math.abs(distPointToSegment(150, 110, 100, 100, 200, 100) - 10) < 1e-9);
  // Point lying on the segment -> zero.
  assert.equal(distPointToSegment(110, 100, 100, 100, 200, 100), 0);
  // Beyond the endpoint clamps to the tip.
  assert.ok(Math.abs(distPointToSegment(210, 100, 100, 100, 200, 100) - 10) < 1e-9);
});
