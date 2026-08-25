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
