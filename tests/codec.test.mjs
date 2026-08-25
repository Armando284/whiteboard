'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TAG_AVATAR,
  TAG_AVATAR_RELAY,
  SHAPE_COUNT,
  SHAPE_NAMES,
  FRAME_BYTES,
  ANGLE_MAX_RAD,
  encodeAvatarFrame,
  decodeAvatarFrame,
  buildRelayFrame,
  parseRelayFrame,
} from '../public/js/avatar/codec.js';
import { poseGap, PoseThrottle } from '../public/js/avatar/optimize.js';

test('avatar frame is exactly FRAME_BYTES and roundtrips', () => {
  const pose = {
    seq: 42,
    yaw: 0.3, pitch: -0.2, roll: 0.1,
    shapes: [0.9, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  };
  const enc = encodeAvatarFrame(pose);
  assert.equal(enc.length, FRAME_BYTES);
  assert.equal(enc[0], TAG_AVATAR);

  const dec = decodeAvatarFrame(enc);
  assert.ok(dec);
  assert.equal(dec.seq, 42);
  for (let i = 0; i < SHAPE_COUNT; i++) {
    assert.ok(Math.abs(dec.shapes[i] - pose.shapes[i]) < 0.005, `shape ${i}`);
  }
  // Angle quantization error at ±80° range is ~0.63° ≈ 0.011 rad.
  assert.ok(Math.abs(dec.yaw - pose.yaw) < 0.02);
  assert.ok(Math.abs(dec.pitch - pose.pitch) < 0.02);
  assert.ok(Math.abs(dec.roll - pose.roll) < 0.02);
});

test('angles clamp to ±80° and survive the int8 boundary', () => {
  const enc = encodeAvatarFrame({ seq: 0, yaw: 99, pitch: -99, roll: Math.PI, shapes: [] });
  const dec = decodeAvatarFrame(enc);
  assert.ok(Math.abs(dec.yaw) <= ANGLE_MAX_RAD + 1e-9);
  assert.ok(Math.abs(dec.pitch) <= ANGLE_MAX_RAD + 1e-9);
  assert.ok(Math.abs(dec.roll) <= ANGLE_MAX_RAD + 1e-9);
  // int8 roundtrip: encoded byte must decode back through sign handling
  assert.equal(enc[2], 127); // clamped max
  assert.ok(dec.pitch < 0); // negative survived
});

test('shapes clamp to [0,1]; non-finite becomes 0', () => {
  const enc = encodeAvatarFrame({
    seq: 0, yaw: 0, pitch: 0, roll: 0,
    shapes: [-1, 2, NaN, Infinity, -Infinity, 0.5, 1, 0],
  });
  const dec = /** @type {any} */ (decodeAvatarFrame(enc));
  assert.deepEqual(dec.shapes.map((/** @type {number} */ v) => Math.round(v * 1000)), [
    0, 1000, 0, 0, 0, 502, 1000, 0,
  ]);
});

test('decode rejects garbage', () => {
  assert.equal(decodeAvatarFrame(new Uint8Array(4)), null);
  assert.equal(decodeAvatarFrame(new Uint8Array(FRAME_BYTES).fill(0x7f)), null); // wrong tag
  assert.equal(parseRelayFrame(new Uint8Array(3)), null);
});

test('relay frame wraps cid and decodes back', () => {
  const sender = encodeAvatarFrame({
    seq: 7, yaw: -0.4, pitch: 0.15, roll: 0,
    shapes: [0.25, 0, 0, 0, 0, 1, 0, 0],
  });
  const relay = buildRelayFrame('c123', sender);
  assert.ok(relay);
  assert.equal(relay[0], TAG_AVATAR_RELAY);
  assert.ok(relay.length <= 64);

  const parsed = parseRelayFrame(relay);
  assert.ok(parsed);
  assert.equal(parsed.cid, 'c123');
  assert.equal(parsed.pose.seq, 7);
  assert.ok(Math.abs(parsed.pose.yaw + 0.4) < 0.02);
  assert.equal(parsed.pose.shapes[5], 1);
});

test('buildRelayFrame rejects invalid input', () => {
  const ok = encodeAvatarFrame({ seq: 1, yaw: 0, pitch: 0, roll: 0, shapes: [] });
  assert.equal(buildRelayFrame('', ok), null);
  assert.equal(buildRelayFrame('c'.repeat(256), ok), null);
  assert.equal(buildRelayFrame('c1', new Uint8Array([0x05, ...new Array(20).fill(0)])), null);
  assert.equal(parseRelayFrame(ok), null, 'sender frames are not relay frames');
});

test('SHAPE_NAMES has exactly SHAPE_COUNT entries', () => {
  assert.equal(SHAPE_NAMES.length, SHAPE_COUNT);
});

// ---------------------------------------------------------------------------
// PoseThrottle (phase 6: deadband + keepalive)
// ---------------------------------------------------------------------------

/** @returns {any} */
const flatPose = () => ({ yaw: 0, pitch: 0, roll: 0, shapes: new Array(SHAPE_COUNT).fill(0) });

test('throttle: first pose always sends; sub-deadband changes suppressed', () => {
  const t = new PoseThrottle({ epsShape: 0.05, epsAngle: 0.05 });
  assert.equal(t.consider(flatPose(), 0).action, 'send');

  const tiny = { ...flatPose(), yaw: 0.01, shapes: [0.02, ...new Array(SHAPE_COUNT - 1).fill(0)] };
  assert.equal(t.consider(tiny, 50).action, 'suppress');

  const big = { ...flatPose(), shapes: [0.5, ...new Array(SHAPE_COUNT - 1).fill(0)] };
  const v = t.consider(big, 60);
  assert.deepEqual([v.action, v.reason], ['send', 'change']);

  // Returning to rest is itself a change vs the NEW baseline → sent.
  const back = t.consider(flatPose(), 70);
  assert.deepEqual([back.action, back.reason], ['send', 'change']);
  // Staying at rest → suppressed.
  assert.equal(t.consider(flatPose(), 80).action, 'suppress');
});

test('throttle: angle deadband is independent of shapes', () => {
  const t = new PoseThrottle({ epsShape: 0.5, epsAngle: 0.02 });
  t.consider(flatPose(), 0);
  const nod = { ...flatPose(), pitch: 0.03 };
  assert.equal(t.consider(nod, 10).reason, 'change');
});

test('throttle: keepalive fires before receivers TTL drops the sprite', () => {
  const t = new PoseThrottle({ epsShape: 0.9, epsAngle: 0.9, keepaliveMs: 400 });
  assert.equal(t.consider(flatPose(), 0).reason, 'change');
  for (let now = 100; now <= 390; now += 10) {
    assert.equal(t.consider(flatPose(), now).action, 'suppress', `t=${now}`);
  }
  const ka = t.consider(flatPose(), 400);
  assert.deepEqual([ka.action, ka.reason], ['send', 'keepalive']);
  assert.equal(t.consider(flatPose(), 410).action, 'suppress');
});

test('throttle: zero deadband disables suppression entirely', () => {
  const t = new PoseThrottle({ epsShape: 0, epsAngle: 0 });
  t.consider(flatPose(), 0);
  for (let now = 10; now <= 100; now += 10) {
    assert.equal(t.consider(flatPose(), now).action, 'send', `t=${now}`);
  }
});

test('poseGap reports max delta per axis group', () => {
  const a = flatPose();
  const b = { yaw: 0.2, pitch: -0.05, roll: 0, shapes: [0, 0, 0, 0, 0, 0, 0.7, 0] };
  const g = poseGap(a, b);
  assert.equal(g.angle, 0.2);
  assert.equal(g.shape, 0.7);
});
