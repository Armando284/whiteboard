'use strict';

/**
 * Phase 6 experiment: avatar bandwidth sweep (Hz × deadband).
 *
 * Deterministic — synthetic gesture profiles, seeded PRNG, no camera needed.
 * Real-world numbers land in phase 9; this pins the wire-cost curve of the
 * pipeline itself.
 *
 * Usage: node tests/bench-avatar.mjs
 */

import { FRAME_BYTES, encodeAvatarFrame } from '../public/js/avatar/codec.js';
import { PoseThrottle } from '../public/js/avatar/optimize.js';

const DURATION_S = 30;

/** mulberry32 — tiny seeded PRNG so every run is identical. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const zeroShapes = () => new Array(8).fill(0);

/**
 * @param {number} t seconds
 * @param {() => number} rand
 */
function idle(t, rand) {
  const blink = blinkPulse(t, rand.seed);
  return { yaw: n(t * 0.3) * 0.02, pitch: n(t * 0.23) * 0.015, roll: n(t * 0.11) * 0.01,
    shapes: [0.01, 0, 0, 0, 0, blink, blink, 0] };
}

/**
 * @param {number} t
 * @param {number} seed
 */
function talk(t, rand) {
  void rand;
  const jaw = Math.max(0, Math.sin(t * Math.PI * 2 * 2.7)) * 0.55 + 0.05; // ~2.7 Hz syllables
  const smile = 0.15 + 0.1 * Math.sin(t * 0.9);
  const blink = blinkPulse(t);
  return { yaw: n(t * 0.8) * 0.08, pitch: n(t * 1.1) * 0.05, roll: n(t * 0.5) * 0.04,
    shapes: [jaw, smile, smile * 0.95, 0.05, 0.05, blink, blink, jaw * 0.2] };
}

/**
 * @param {number} t
 */
function animated(t) {
  const yaw = Math.sin(t * Math.PI * 2 / 6) * 0.9; // slow full head sweeps ±~72°
  const brow = 0.3 + 0.25 * Math.sin(t * Math.PI * 2 / 3);
  const pucker = Math.max(0, Math.sin(t * Math.PI * 2 / 4)) * 0.6;
  const jaw = Math.max(0, Math.sin(t * Math.PI * 2 * 2.2)) * 0.5;
  const blink = blinkPulse(t * 1.3);
  return { yaw, pitch: Math.sin(t * Math.PI / 4) * 0.15, roll: yaw * 0.2,
    shapes: [jaw, 0.4, 0.38, brow, brow * 0.9, blink, blink, pucker] };
}

/** Smooth pseudo-noise in [-1, 1]. @param {number} x */
const n = (x) => Math.sin(x * 12.9898) * 0.5 + Math.sin(x * 78.233) * 0.5;

/** Deterministic blink train: ~every 3.2 s, 120 ms wide. @param {number} t */
function blinkPulse(t) {
  const period = 3.2;
  const phase = (t % period) - 0.05;
  return phase >= 0 && phase <= 0.12 ? 1 : 0;
}

const PROFILES = { idle, talk, animated };

const HZ_STEPS = [4, 6, 8, 10, 12, 15, 20];
// eps pairs as fractions of each axis range: [epsShape, epsAngle]
const DEADBANDS = [
  ['none', 0, 0],
  ['light', 0.015, 0.025],
  ['default', 0.03, 0.05],
  ['heavy', 0.06, 0.10],
];

/**
 * Runs one profile through the real throttle+codec at a given config and
 * returns average wire bytes per second over DURATION_S.
 * @param {(t: number, rand: any) => any} profile
 * @param {number} hz
 * @param {number} epsShape
 * @param {number} epsAngle
 */
function measure(profile, hz, epsShape, epsAngle) {
  const rand = rng(42);
  const throttle = new PoseThrottle({ epsShape, epsAngle });
  let bytes = 0;
  const stepMs = 1000 / hz;
  for (let ms = 0; ms <= DURATION_S * 1000; ms += stepMs) {
    const pose = profile(ms / 1000, rand);
    if (throttle.consider(pose, ms).action === 'send') {
      encodeAvatarFrame(pose); // exercise the encoder for parity with runtime
      bytes += FRAME_BYTES;
    }
  }
  return bytes / DURATION_S;
}

console.log(`Avatar bandwidth sweep — ${DURATION_S}s synthetic sessions, ${FRAME_BYTES} B frames\n`);
for (const [name, fn] of Object.entries(PROFILES)) {
  console.log(`### ${name}\n`);
  console.log('| Hz | ' + DEADBANDS.map(([label]) => label).join(' | ') + ' |');
  console.log('|---:|' + DEADBANDS.map(() => '---:').join('|') + '|');
  for (const hz of HZ_STEPS) {
    const cells = DEADBANDS.map(([, es, ea]) => measure(fn, hz, es, ea).toFixed(0));
    console.log(`| ${hz} | ${cells.join(' | ')} |`);
  }
  console.log('');
}
