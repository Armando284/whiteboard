'use strict';

/**
 * AvatarManager — Low-Net phase 5 prototype.
 *
 * Pipeline: camera → MediaPipe FaceLandmarker (lazy, ~3.7 MB model) →
 * pose {yaw,pitch,roll,8 blendshapes} → 13 B binary frame → WS relay →
 * peers interpolate & draw vector faces.
 *
 * Everything here loads on demand: the module itself is dynamically imported
 * on the first toolbar toggle, so users who never open their camera pay
 * neither bytes nor memory for it.
 */

import {
  SHAPE_COUNT,
  SHAPE_NAMES,
  encodeAvatarFrame,
  parseRelayFrame,
} from './codec.js';
import { PoseThrottle } from './optimize.js';
import { envelope } from '../net/protocol.js';

const TRACK_HZ = 12;
const SMOOTH_RATE = 18; // higher = snappier interpolation
const REMOTE_TTL_MS = 5000;

/**
 * Experiment knobs via query string (phase 6):
 *   ?avhz=8   → tracking/send rate, clamped to [2, 30]
 *   ?avdb=0.1 → deadband as fraction of each axis range; 0 disables suppression
 * @param {URLSearchParams} params
 */
export function avatarConfigFromURL(params) {
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(params.get(v));
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const db = clamp('avdb', 0, 1, NaN);
  return {
    hz: clamp('avhz', 2, 30, TRACK_HZ),
    // Angle range is ±80° ≈ 2.79 rad; epsAngle expressed on the same 0..1 scale.
    epsShape: Number.isNaN(db) ? undefined : db,
    epsAngle: Number.isNaN(db) ? undefined : db,
  };
}

const MEDIAPIPE_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * @typedef {{
 *   seq: number,
 *   yaw: number, pitch: number, roll: number,
 *   shapes: number[],
 * }} PoseFrame
 */

/** @returns {HTMLVideoElement} offscreen video feeding the landmarker */
function makeVideoEl() {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.style.display = 'none';
  document.body.appendChild(video);
  return video;
}

/**
 * Camera + FaceLandmarker loop emitting quantized poses at `hz`.
 */
class FaceTracker {
  /**
   * @param {number} hz
   */
  constructor(hz = TRACK_HZ) {
    this.hz = hz;
    /** @type {(pose: PoseFrame) => void} */
    this.onPose = () => {};
    this.seq = 0;
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {HTMLVideoElement | null} */
    this.video = null;
    /** @type {any} */
    this.landmarker = null;
    /** @type {number | null} */
    this.rafId = null;
    this.lastSent = 0;
    this.running = false;
  }

  /**
   * @param {'up'|'down'} [fallbackDelegate]
   */
  async start(fallbackDelegate) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('camera API unavailable (insecure context — use https:// or localhost)');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: 'user' },
      audio: false,
    });
    this.video = makeVideoEl();
    this.video.srcObject = this.stream;
    await this.video.play();

    // Explicit ESM entry: the package ROOT resolves to vision_bundle.cjs
    // (CommonJS), which browsers cannot import — this burned us once.
    const vision = await import(/* webpackIgnore: true */ `${MEDIAPIPE_CDN}/vision_bundle.mjs`);
    const fileset = await vision.FilesetResolver.forVisionTasks(`${MEDIAPIPE_CDN}/wasm`);
    try {
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: fallbackDelegate || 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    } catch (err) {
      if (!fallbackDelegate) return this.start('CPU'); // GPU-less devices
      throw err;
    }

    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.remove();
      this.video = null;
    }
    this.landmarker?.close?.();
    this.landmarker = null;
  }

  _loop() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    if (now - this.lastSent < 1000 / TRACK_HZ) return;
    if (!this.video?.videoWidth) return;
    const result = this.landmarker.detectForVideo(this.video, now);
    if (now - this.lastSent < 1000 / this.hz) return; // detect() took the budget
    this.lastSent = now;

    const pose = this._extract(result);
    if (pose) this.onPose(pose);
  }

  /**
   * @param {any} result
   * @returns {PoseFrame | null}
   */
  _extract(result) {
    const faces = result?.faceBlendshapes?.length ?? 0;
    if (!faces) return null;
    const byName = new Map(
      (result.faceBlendshapes[0].categories || []).map((/** @type {any} */ c) => [c.categoryName, c.score]),
    );
    const shapes = SHAPE_NAMES.map((name) => byName.get(name) ?? 0);

    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    const m = result.facialTransformationMatrixes?.[0]?.data;
    if (m && m.length === 16) {
      // Column-major; basis elements r{row}{col} live at m[col*4+row].
      const cl = (v) => Math.max(-1, Math.min(1, v));
      yaw = Math.asin(cl(m[8]));
      pitch = Math.atan2(-m[9], -m[10]);
      roll = Math.atan2(-m[4], m[0]);
    }
    return { seq: this.seq++ & 255, yaw, pitch, roll, shapes };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const CARD_W = 116;
const CARD_H = 148;
const INK = '#00171f';

/** @typedef {{ yaw:number, pitch:number, roll:number, shapes:number[] }} Smooth */

/**
 * @param {Smooth} cur
 * @param {PoseFrame} target
 * @param {number} dt seconds
 */
function stepToward(cur, target, dt) {
  const k = 1 - Math.exp(-dt * SMOOTH_RATE);
  cur.yaw += (target.yaw - cur.yaw) * k;
  cur.pitch += (target.pitch - cur.pitch) * k;
  cur.roll += (target.roll - cur.roll) * k;
  for (let i = 0; i < SHAPE_COUNT; i++) {
    cur.shapes[i] += ((target.shapes[i] ?? 0) - cur.shapes[i]) * k;
  }
}

/**
 * Draws one stylized face driven by the pose.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx center x
 * @param {number} cy center y
 * @param {number} r face radius
 * @param {Smooth} s
 */
function drawFace(ctx, cx, cy, r, s) {
  const [jaw, smileL, smileR, browL, browR, blinkL, blinkR, pucker] = s.shapes;
  const smile = (smileL + smileR) / 2;

  ctx.save();
  ctx.translate(cx, cy);
  // Head rotation: roll spins, yaw/pitch skew feature offsets.
  ctx.rotate(s.roll);

  // Head
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();

  const ex = r * 0.38 + s.yaw * r * 0.25; // horizontal eye shift by yaw
  const ey = -r * 0.22 + s.pitch * r * 0.3;
  const er = r * 0.11;

  // Eyes (blink squashes vertically)
  for (const side of [-1, 1]) {
    const blink = side < 0 ? blinkL : blinkR;
    ctx.beginPath();
    ctx.ellipse(side * ex, ey, er, Math.max(er * (1 - blink), 0.6), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Brows rise with browOuterUp
  for (const side of [-1, 1]) {
    const brow = side < 0 ? browL : browR;
    const by = ey - er - r * 0.12 - brow * r * 0.16;
    ctx.beginPath();
    ctx.moveTo(side * ex - er * 1.4, by);
    ctx.lineTo(side * ex + er * 1.4, by);
    ctx.stroke();
  }

  // Mouth: jaw opens, smile curves corners up, pucker narrows
  const mw = r * (0.52 - pucker * 0.28);
  const mh = r * (0.06 + jaw * 0.42);
  const my = r * 0.34;
  ctx.beginPath();
  ctx.ellipse(0, my, mw, mh / 2 + mh / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  if (jaw > 0.05) {
    ctx.beginPath();
    ctx.ellipse(0, my, mw * 0.7, mh * 0.55, 0, 0, Math.PI * 2);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  // Smile ticks
  if (smile > 0.15) {
    ctx.beginPath();
    ctx.moveTo(-mw - 4, my - mh * 0.4 - smile * 5);
    ctx.lineTo(-mw, my - smile * 6);
    ctx.moveTo(mw + 4, my - mh * 0.4 - smile * 5);
    ctx.lineTo(mw, my - smile * 6);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} label
 * @param {number} cx
 * @param {number} w
 */
function drawLabel(ctx, label, cx, w) {
  ctx.font = '10px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#003459';
  ctx.fillText(label.toUpperCase(), cx, CARD_H - 8);
  void w;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class AvatarManager {
  /**
   * @param {import('../net/connection.js').Connection} conn
   * @param {{ onStateChange?: (active: boolean) => void,
   *          hz?: number, epsShape?: number, epsAngle?: number }} [opts]
   */
  constructor(conn, opts = {}) {
    this.conn = conn;
    this.onStateChange = opts.onStateChange || (() => {});
    this.tracker = new FaceTracker(opts.hz);
    this.throttle = new PoseThrottle({
      epsShape: opts.epsShape,
      epsAngle: opts.epsAngle,
    });
    /** @type {Map<string, string>} cid → uid labels */
    this.uidByCid = new Map();
    this.myUid = '';
    this.active = false;
    /** @type {'idle'|'loading'|'on'|'error'} */
    this.state = 'idle';

    this.canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('avatar-stage'));
    this.dock = /** @type {HTMLElement} */ (document.getElementById('avatar-dock'));
    this.ctx = /** @type {CanvasRenderingContext2D} */ (this.canvas.getContext('2d'));

    /** @type {Smooth} */
    this.local = { yaw: 0, pitch: 0, roll: 0, shapes: new Array(SHAPE_COUNT).fill(0) };
    /** @type {Map<string, { target: PoseFrame, cur: Smooth, seen: number }>} */
    this.remotes = new Map();
    /** @type {number | null} */
    this.rafId = null;
    this.lastFrame = 0;
    this.gcTimer = /** @type {number | undefined} */ (undefined);

    this.tracker.onPose = (pose) => {
      if (this.throttle.consider(pose, performance.now()).action === 'send') {
        this.conn.sendBinary(encodeAvatarFrame(pose));
      }
      // Local preview always follows the tracker; suppression only saves wire.
      Object.assign(this.local, { yaw: pose.yaw, pitch: pose.pitch, roll: pose.roll });
      for (let i = 0; i < SHAPE_COUNT; i++) this.local.shapes[i] = pose.shapes[i];
    };
  }

  /**
   * Toggles the avatar. Resolves true when left ON.
   * @returns {Promise<boolean>}
   */
  async toggle() {
    if (this.active) {
      this._teardown();
      return false;
    }
    if (this.state === 'loading') return this.active;
    this.state = 'loading';
    try {
      await this.tracker.start();
      this.active = true;
      this.state = 'on';
      this.dock.hidden = false;
      this._startLoop();
      this.onStateChange(true);
    } catch (err) {
      this.state = 'error';
      this.tracker.stop();
      throw err;
    }
    return true;
  }

  _teardown() {
    this.active = false;
    this.state = 'idle';
    this.tracker.stop();
    this.conn.send(envelope('avatar_off'));
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    clearInterval(this.gcTimer);
    this.dock.hidden = true;
    this.onStateChange(false);
  }

  /**
   * @param {ArrayBuffer} buf
   */
  handleBinary(buf) {
    const parsed = parseRelayFrame(buf);
    if (!parsed) return;
    const entry = this.remotes.get(parsed.cid);
    if (entry) {
      entry.target = parsed.pose;
      entry.seen = performance.now();
    } else {
      this.remotes.set(parsed.cid, {
        target: parsed.pose,
        cur: { yaw: 0, pitch: 0, roll: 0, shapes: new Array(SHAPE_COUNT).fill(0) },
        seen: performance.now(),
      });
    }
    if (!this.active) this._startLoop(); // viewers without cameras still render
  }

  /** Peer turned their avatar off. */
  remove(cid) {
    this.remotes.delete(cid);
  }

  /**
   * Presence sync: refresh labels and drop avatars of departed peers.
   * @param {{cid:string, uid:string}[]} members
   */
  syncMembers(members) {
    const alive = new Set(members.map((m) => m.cid));
    for (const cid of [...this.remotes.keys()]) {
      if (!alive.has(cid)) this.remotes.delete(cid);
    }
    this.uidByCid.clear();
    for (const m of members) this.uidByCid.set(m.cid, m.uid);
  }

  _startLoop() {
    if (this.rafId !== null) return;
    this.lastFrame = performance.now();
    this.gcTimer = /** @type {any} */ (setInterval(() => {
      const now = performance.now();
      for (const [cid, e] of this.remotes) {
        if (now - e.seen > REMOTE_TTL_MS) this.remotes.delete(cid);
      }
    }, 2000));
    const loop = () => {
      if (!this.active && this.remotes.size === 0) {
        this.rafId = null;
        clearInterval(this.gcTimer);
        this.dock.hidden = true;
        return;
      }
      this.rafId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this._draw(dt);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /**
   * @param {number} dt
   */
  _draw(dt) {
    const dpr = window.devicePixelRatio || 1;
    const count = (this.active ? 1 : 0) + this.remotes.size;
    const cssW = Math.max(1, count * CARD_W);
    if (this.canvas.width !== Math.round(cssW * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(CARD_H * dpr);
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${CARD_H}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, CARD_H);

    let i = 0;
    if (this.active) {
      drawFace(ctx, i * CARD_W + CARD_W / 2, 62, 40, this.local);
      drawLabel(ctx, this.myUid || 'you', i * CARD_W + CARD_W / 2, CARD_W);
      i += 1;
    }
    for (const [cid, e] of this.remotes) {
      stepToward(e.cur, e.target, dt);
      drawFace(ctx, i * CARD_W + CARD_W / 2, 62, 40, e.cur);
      drawLabel(ctx, this.uidByCid.get(cid) || cid, i * CARD_W + CARD_W / 2, CARD_W);
      i += 1;
    }
  }
}
