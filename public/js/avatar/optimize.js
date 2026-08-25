'use strict';

import { SHAPE_COUNT } from './codec.js';

/**
 * Send-side policy (phase 6): suppress poses whose change is below a
 * deadband, but emit keepalives so receivers' TTL never drops a live
 * avatar. Pure + clock-injected → experiments are deterministic.
 */

const DEFAULT_EPS_SHAPE = 0.03; // fraction of the 0..1 shape range
const DEFAULT_EPS_ANGLE = 0.05; // fraction of the ±80° angle range
export const KEEPALIVE_MS = 400; // well under the 5 s remote TTL

/**
 * @typedef {{ yaw: number, pitch: number, roll: number, shapes: number[] }} PoseLike
 * @typedef {{ action: 'send'|'suppress', reason?: 'change'|'keepalive' }} ThrottleVerdict
 */

/**
 * Max absolute delta per axis group between two poses.
 * @param {PoseLike} a
 * @param {PoseLike} b
 * @returns {{ angle: number, shape: number }}
 */
export function poseGap(a, b) {
  let angle = Math.abs(a.yaw - b.yaw);
  angle = Math.max(angle, Math.abs(a.pitch - b.pitch));
  angle = Math.max(angle, Math.abs(a.roll - b.roll));
  let shape = 0;
  for (let i = 0; i < SHAPE_COUNT; i++) {
    shape = Math.max(shape, Math.abs((a.shapes[i] ?? 0) - (b.shapes[i] ?? 0)));
  }
  return { angle, shape };
}

export class PoseThrottle {
  /**
   * @param {{ epsShape?: number, epsAngle?: number, keepaliveMs?: number }} [opts]
   */
  constructor(opts = {}) {
    this.epsShape = opts.epsShape ?? DEFAULT_EPS_SHAPE;
    this.epsAngle = opts.epsAngle ?? DEFAULT_EPS_ANGLE;
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
    /** @type {PoseLike | null} last pose actually sent */
    this.baseline = null;
    this.lastSentAt = 0;
  }

  /**
   * Feed one tracked pose; returns whether to put it on the wire.
   * Mutates the internal baseline only on 'send'.
   * @param {PoseLike} pose
   * @param {number} now monotonic ms
   * @returns {ThrottleVerdict}
   */
  consider(pose, now) {
    if (!this.baseline || now - this.lastSentAt >= this.keepaliveMs) {
      const reason = this.baseline ? 'keepalive' : 'change';
      this._sent(pose, now);
      return { action: 'send', reason };
    }
    const gap = poseGap(this.baseline, pose);
    if (gap.angle >= this.epsAngle || gap.shape >= this.epsShape) {
      this._sent(pose, now);
      return { action: 'send', reason: 'change' };
    }
    return { action: 'suppress' };
  }

  /** @private */
  _sent(pose, now) {
    this.baseline = {
      yaw: pose.yaw,
      pitch: pose.pitch,
      roll: pose.roll,
      shapes: [...pose.shapes],
    };
    this.lastSentAt = now;
  }
}
