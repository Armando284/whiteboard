'use strict';

/**
 * Avatar wire codec — Low-Net phase 5 + appearance (post-phase-9).
 *
 * Pure binary format, Node-testable, no browser dependencies.
 *
 * Pose sender frame (tag 0x01):
 *   [0]  0x01
 *   [1]  seq      uint8   rolling counter
 *   [2]  yaw      int8    quantized to ±80°
 *   [3]  pitch    int8
 *   [4]  roll     int8
 *   [5..12]       uint8×8 blendshapes, 0..255 maps 0..1
 *
 * Appearance config frame (tag 0x03):
 *   [0]  0x03
 *   [1]  byte0    [hairStyle:4][hairColor:4]
 *   [2]  byte1    [eyes:4     ][brows:4]
 *   [3]  byte2    [nose:4     ][mouth:4]
 *
 * Relay frame (tag 0x02) — server prepends sender's cid, then the full
 * inner frame (including its original tag byte):
 *   [0]  0x02
 *   [1]  cidLen   uint8
 *   [2..]         cid ASCII bytes
 *   [2+cidLen..]  full inner frame (tag + payload)
 */

export const TAG_AVATAR = 0x01;
export const TAG_AVATAR_RELAY = 0x02;
export const TAG_AVATAR_CONFIG = 0x03;

export const SHAPE_COUNT = 8;
export const FRAME_BYTES = 13; // 0x01 + seq + 3 angles + 8 shapes
export const CONFIG_FRAME_BYTES = 4; // 0x03 + 3 packed appearance bytes
export const MAX_RELAY_BYTES = 68;

/** Blendshape order on the wire. MediaPipe names. */
export const SHAPE_NAMES = /** @type {const} */ ([
  'jawOpen',
  'mouthSmileLeft',
  'mouthSmileRight',
  'browOuterUpLeft',
  'browOuterUpRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'mouthPucker',
]);

export const ANGLE_MAX_RAD = (80 * Math.PI) / 180;
const ANGLE_SCALE = 127 / ANGLE_MAX_RAD;

/**
 * @param {number} v
 * @param {number} min
 * @param {number} max
 */
function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/**
 * @param {number} rad
 * @returns {number}
 */
function encodeAngle(rad) {
  if (!Number.isFinite(rad)) return 0;
  return Math.round(clamp(rad, -ANGLE_MAX_RAD, ANGLE_MAX_RAD) * ANGLE_SCALE);
}

/**
 * @param {number} q
 * @returns {number}
 */
function decodeAngle(q) {
  return q / ANGLE_SCALE;
}

/**
 * @typedef {{
 *   seq: number,
 *   yaw: number, pitch: number, roll: number,
 *   shapes: number[],
 * }} PoseFrame
 */

/**
 * Encodes a sender frame. `poses` values are clamped/quantized defensively.
 * @param {PoseFrame} pose
 * @returns {Uint8Array}
 */
export function encodeAvatarFrame(pose) {
  const out = new Uint8Array(FRAME_BYTES);
  out[0] = TAG_AVATAR;
  out[1] = clamp(Math.round(pose.seq) & 255, 0, 255);
  out[2] = encodeAngle(pose.yaw) & 255;
  out[3] = encodeAngle(pose.pitch) & 255;
  out[4] = encodeAngle(pose.roll) & 255;
  for (let i = 0; i < SHAPE_COUNT; i++) {
    const v = pose.shapes && Number.isFinite(pose.shapes[i]) ? pose.shapes[i] : 0;
    out[5 + i] = Math.round(clamp(v, 0, 1) * 255);
  }
  return out;
}

/**
 * Decodes the payload of a sender frame (starting at the 0x01 tag).
 * Returns null for anything malformed.
 * @param {Uint8Array | ArrayBuffer} buf
 * @returns {PoseFrame | null}
 */
export function decodeAvatarFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < FRAME_BYTES || u8[0] !== TAG_AVATAR) return null;
  const shapes = new Array(SHAPE_COUNT);
  for (let i = 0; i < SHAPE_COUNT; i++) shapes[i] = u8[5 + i] / 255;
  return {
    seq: u8[1],
    yaw: decodeAngle(/** @type {number} */ (u8[2] << 24 >> 24)),
    pitch: decodeAngle(/** @type {number} */ (u8[3] << 24 >> 24)),
    roll: decodeAngle(/** @type {number} */ (u8[4] << 24 >> 24)),
    shapes,
  };
}

/**
 * Server-side: wraps a validated sender/config frame with the sender's cid.
 * The full inner frame (including its original tag byte) is preserved.
 * @param {string} cid
 * @param {Uint8Array | Buffer} innerFrame full frame incl. tag (0x01 or 0x03)
 * @returns {Uint8Array | null} relay frame, or null when input is invalid
 */
export function buildRelayFrame(cid, innerFrame) {
  if (!innerFrame) return null;
  const tag = innerFrame[0];
  if (tag !== TAG_AVATAR && tag !== TAG_AVATAR_CONFIG) return null;
  const expectedLen = tag === TAG_AVATAR ? FRAME_BYTES : CONFIG_FRAME_BYTES;
  if (innerFrame.length < expectedLen) return null;
  if (!cid || cid.length === 0 || cid.length > 255) return null;
  const enc = new TextEncoder();
  const cidBytes = enc.encode(cid);
  const out = new Uint8Array(2 + cidBytes.length + innerFrame.length);
  out[0] = TAG_AVATAR_RELAY;
  out[1] = cidBytes.length;
  out.set(cidBytes, 2);
  out.set(innerFrame instanceof Uint8Array ? innerFrame : new Uint8Array(innerFrame), 2 + cidBytes.length);
  return out;
}

/**
 * Client-side: splits a relay frame into sender cid + inner content.
 * For tag 0x01 pose frames returns { type:'pose', cid, pose }.
 * For tag 0x03 config frames returns { type:'config', cid, app: Uint8Array(3) }.
 * @param {Uint8Array | ArrayBuffer} buf
 * @returns {{ type: string, cid: string, pose?: PoseFrame, app?: Uint8Array } | null}
 */
export function parseRelayFrame(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 3 || u8[0] !== TAG_AVATAR_RELAY) return null;
  const cidLen = u8[1];
  if (cidLen === 0) return null;
  const cidStart = 2;
  const frameStart = cidStart + cidLen;
  if (frameStart >= u8.length) return null;
  const cid = new TextDecoder().decode(u8.subarray(cidStart, frameStart));
  const innerTag = u8[frameStart];

  if (innerTag === TAG_AVATAR) {
    if (u8.length < frameStart + FRAME_BYTES) return null;
    const frame = new Uint8Array(FRAME_BYTES);
    frame.set(u8.subarray(frameStart, frameStart + FRAME_BYTES));
    const pose = decodeAvatarFrame(frame);
    return pose ? { type: 'pose', cid, pose } : null;
  }

  if (innerTag === TAG_AVATAR_CONFIG) {
    if (u8.length < frameStart + CONFIG_FRAME_BYTES) return null;
    return { type: 'config', cid, app: new Uint8Array(u8.subarray(frameStart + 1, frameStart + CONFIG_FRAME_BYTES)) };
  }

  return null;
}
