'use strict';

/**
 * Avatar appearance data + vector rendering.
 *
 * Wire format — 3 packed bytes (uint8 × 3):
 *
 *   byte 0  [hairStyle:4][hairColor:4]
 *   byte 1  [eyes:4     ][brows:4    ]
 *   byte 2  [nose:4     ][mouth:4    ]
 *
 * @module looks
 */

/* ── constants ─────────────────────────────────────────────────────── */

export const PACKED_BYTES = 3;

/** Number of distinct trait values per nibble (max index). */
export const TRAIT_MAX = { hairStyle: 5, hairColor: 15, eyes: 3, brows: 3, nose: 3, mouth: 3 };

/** 16-slot hair colour palette (indexed 0–15). */
export const HAIR_COLORS = [
  /*0*/ '#1A1A1A', /*1*/ '#3E2723', /*2*/ '#6D4C41', /*3*/ '#8D6E63',
  /*4*/ '#FF8F00', /*5*/ '#FFD54F', /*6*/ '#C62828', /*7*/ '#4A148C',
  /*8*/ '#0D47A1', /*9*/ '#1B5E20', /*A*/ '#BDBDBD', /*B*/ '#F5F5F5',
  /*C*/ '#FF4081', /*D*/ '#00E676', /*E*/ '#FF6D00', /*F*/ '#7C4DFF',
];

/** Labels shown in the avatar studio sidebar (one per slot). */
export const HAIR_STYLE_NAMES = ['Bald', 'Short', 'Spiky', 'Curly', 'Long', 'Bun'];
export const FEATURE_NAMES = {
  eyes:  ['Dots', 'Happy', 'Wide', 'Sleepy'],
  brows: ['Neutral', 'Raised', 'Angry', 'Worried'],
  nose:  ['Dot', 'Line', 'Triangle', 'L'],
  mouth: ['Smile', 'Neutral', 'Open', 'Smirk'],
};

/* ── default / helpers ─────────────────────────────────────────────── */

const DEFAULT = Object.freeze({
  hairStyle: 1,
  hairColor: 0,
  eyes: 0,
  brows: 0,
  nose: 0,
  mouth: 0,
});

/** Deep-copy + clamp a single trait to its valid range. */
function clampTrait(name, val) {
  const max = TRAIT_MAX[name];
  return max !== undefined ? (Math.round(val) & (max > 15 ? 15 : max)) & 0x0f : 0;
}

export function defaultAppearance() {
  return { ...DEFAULT };
}

export function cloneAppearance(src) {
  return { ...src };
}

export function clampAppearance(raw) {
  const a = raw || {};
  return {
    hairStyle: clampTrait('hairStyle', a.hairStyle ?? DEFAULT.hairStyle),
    hairColor: clampTrait('hairColor', a.hairColor ?? DEFAULT.hairColor),
    eyes:      clampTrait('eyes',      a.eyes      ?? DEFAULT.eyes),
    brows:     clampTrait('brows',     a.brows     ?? DEFAULT.brows),
    nose:      clampTrait('nose',      a.nose      ?? DEFAULT.nose),
    mouth:     clampTrait('mouth',     a.mouth     ?? DEFAULT.mouth),
  };
}

/* ── pack / unpack (wire ↔ object) ────────────────────────────────── */

/** @param {Appearance} app @returns {Uint8Array} 3 bytes */
export function pack(app) {
  const a = clampAppearance(app);
  return new Uint8Array([
    ((a.hairStyle & 0x0f) << 4) | (a.hairColor & 0x0f),
    ((a.eyes      & 0x0f) << 4) | (a.brows     & 0x0f),
    ((a.nose      & 0x0f) << 4) | (a.mouth     & 0x0f),
  ]);
}

/** @param {ArrayBuffer|Uint8Array} buf @returns {Appearance} */
export function unpack(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < PACKED_BYTES) return { ...DEFAULT };
  return clampAppearance({
    hairStyle: (u8[0] >>> 4) & 0x0f,
    hairColor: u8[0] & 0x0f,
    eyes:      (u8[1] >>> 4) & 0x0f,
    brows:     u8[1] & 0x0f,
    nose:      (u8[2] >>> 4) & 0x0f,
    mouth:     u8[2] & 0x0f,
  });
}

/* ── canvas rendering ──────────────────────────────────────────────── */

const INK = '#222';

function dot(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function arc(ctx, cx, cy, rx, ry, start, end, ccw) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, start, end, ccw);
  ctx.stroke();
}

/* ── hair styles ───────────────────────────────────────────────────── */

function drawHair(ctx, cx, cy, r, style, color) {
  if (style === 0) return; // bald
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = r * 0.07;
  ctx.lineCap = 'round';

  const top = cy - r;
  switch (style) {
    case 1: { // short — flat cap
      ctx.beginPath();
      ctx.ellipse(cx, top, r * 0.95, r * 0.35, 0, Math.PI, 0);
      ctx.fill();
      break;
    }
    case 2: { // spiky — 5 triangles
      const spikes = 5;
      const halfAngle = Math.PI / spikes;
      for (let i = 0; i < spikes; i++) {
        const baseAngle = -Math.PI + i * Math.PI / spikes;
        const tipAngle = baseAngle + halfAngle;
        const tipR = r * 1.25;
        ctx.beginPath();
        ctx.moveTo(cx + r * 0.85 * Math.cos(baseAngle), top + r * 0.15 + r * 0.35 * Math.sin(baseAngle));
        ctx.lineTo(cx + tipR * Math.cos(tipAngle), top - r * 0.3 + r * 0.2 * Math.sin(tipAngle));
        ctx.lineTo(cx + r * 0.85 * Math.cos(baseAngle + 2 * halfAngle), top + r * 0.15 + r * 0.35 * Math.sin(baseAngle + 2 * halfAngle));
        ctx.fill();
      }
      break;
    }
    case 3: { // curly — small circles along top arc
      const count = 7;
      for (let i = 0; i < count; i++) {
        const a = -Math.PI * 0.9 + i * Math.PI * 0.8 / (count - 1);
        const cr = r * 0.18;
        const px = cx + (r + cr * 0.3) * Math.cos(a);
        const py = top + r * 0.05 + (r + cr * 0.3) * Math.sin(a);
        ctx.beginPath();
        ctx.arc(px, py, cr, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 4: { // long — two flowing paths down the sides
      ctx.lineWidth = r * 0.22;
      ctx.lineCap = 'round';
      [-1, 1].forEach((side) => {
        const sx = cx + side * r * 0.7;
        ctx.beginPath();
        ctx.moveTo(sx, top + r * 0.15);
        ctx.quadraticCurveTo(sx + side * r * 0.1, top + r * 0.6, sx - side * r * 0.05, top + r * 1.35);
        ctx.stroke();
      });
      break;
    }
    case 5: { // bun — small filled circle sitting on top of head
      ctx.beginPath();
      ctx.arc(cx, top - r * 0.25, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      // small connection band
      ctx.fillRect(cx - r * 0.08, top - r * 0.05, r * 0.16, r * 0.2);
      break;
    }
  }
}

/* ── facial features ───────────────────────────────────────────────── */

function drawEyes(ctx, cx, cy, r, variant) {
  ctx.fillStyle = INK;
  const eyeY = cy - r * 0.08;
  const eyeX = r * 0.25;
  const eyeR = r * 0.09;
  switch (variant) {
    case 0: // dots
      dot(ctx, cx - eyeX, eyeY, eyeR);
      dot(ctx, cx + eyeX, eyeY, eyeR);
      break;
    case 1: { // happy — upward arcs
      ctx.lineWidth = r * 0.06;
      ctx.strokeStyle = INK;
      [-1, 1].forEach((s) => {
        arc(ctx, cx + s * eyeX, eyeY, eyeR * 1.2, eyeR * 0.9, Math.PI * 1.15, Math.PI * 1.85, false);
      });
      break;
    }
    case 2: { // wide — larger circles + pupil
      const bigR = eyeR * 1.6;
      [-1, 1].forEach((s) => {
        ctx.beginPath();
        ctx.arc(cx + s * eyeX, eyeY, bigR, 0, Math.PI * 2);
        ctx.stroke();
        dot(ctx, cx + s * eyeX, eyeY, bigR * 0.4);
      });
      break;
    }
    case 3: { // sleepy — horizontal dashes
      ctx.strokeStyle = INK;
      ctx.lineWidth = r * 0.06;
      ctx.lineCap = 'round';
      [-1, 1].forEach((s) => {
        line(ctx, cx + s * eyeX - eyeR * 1.1, eyeY, cx + s * eyeX + eyeR * 1.1, eyeY);
      });
      break;
    }
  }
}

function drawBrows(ctx, cx, cy, r, variant) {
  ctx.strokeStyle = INK;
  ctx.lineWidth = r * 0.055;
  ctx.lineCap = 'round';
  const browY = cy - r * 0.3;
  const browX = r * 0.25;
  const browLen = r * 0.14;
  const halfLen = browLen * 0.5;
  switch (variant) {
    case 0: // neutral
      [-1, 1].forEach((s) => line(ctx, cx + s * browX - halfLen, browY, cx + s * browX + halfLen, browY));
      break;
    case 1: // raised — slight upward arc
      ctx.lineWidth = r * 0.05;
      [-1, 1].forEach((s) => {
        arc(ctx, cx + s * browX, browY + r * 0.03, halfLen, r * 0.05, Math.PI * 1.1, Math.PI * 1.9, false);
      });
      break;
    case 2: // angry — inner-down slant
      [-1, 1].forEach((s) => {
        line(ctx, cx + s * browX - s * halfLen, browY - r * 0.04, cx + s * browX + s * halfLen, browY + r * 0.04);
      });
      break;
    case 3: // worried — outer-down slant
      [-1, 1].forEach((s) => {
        line(ctx, cx + s * browX - s * halfLen, browY + r * 0.04, cx + s * browX + s * halfLen, browY - r * 0.04);
      });
      break;
  }
}

function drawNose(ctx, cx, cy, r, variant) {
  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineWidth = r * 0.05;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const ny = cy + r * 0.08;
  switch (variant) {
    case 0: // dot
      dot(ctx, cx, ny, r * 0.06);
      break;
    case 1: // line
      line(ctx, cx, ny - r * 0.06, cx, ny + r * 0.06);
      break;
    case 2: { // triangle
      const tr = r * 0.08;
      ctx.beginPath();
      ctx.moveTo(cx, ny + tr);
      ctx.lineTo(cx - tr, ny - tr * 0.5);
      ctx.lineTo(cx + tr, ny - tr * 0.5);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 3: // L-shape
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.06, ny - r * 0.06);
      ctx.lineTo(cx - r * 0.06, ny + r * 0.04);
      ctx.lineTo(cx + r * 0.06, ny + r * 0.04);
      ctx.stroke();
      break;
  }
}

function drawMouth(ctx, cx, cy, r, variant) {
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = r * 0.06;
  ctx.lineCap = 'round';
  const my = cy + r * 0.28;
  const mw = r * 0.18;
  switch (variant) {
    case 0: // smile
      arc(ctx, cx, my - r * 0.03, mw, r * 0.08, Math.PI * 0.15, Math.PI * 0.85, false);
      break;
    case 1: // neutral — flat line
      line(ctx, cx - mw, my, cx + mw, my);
      break;
    case 2: { // open — small ellipse
      const ry = r * 0.06;
      ctx.beginPath();
      ctx.ellipse(cx, my, mw * 0.75, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 3: // smirk — asymmetric arc
      ctx.beginPath();
      ctx.ellipse(cx + mw * 0.25, my, mw * 0.8, r * 0.07, 0, Math.PI * 0.2, Math.PI * 0.8, false);
      ctx.stroke();
      break;
  }
}

/* ── main render entry point ───────────────────────────────────────── */

/**
 * Draw a complete avatar head from packed appearance + smoothPose angle.
 * Compatible with existing drawFace call sites (app defaults to DEFAULT).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx   centre x
 * @param {number} cy   centre y
 * @param {number} r    head radius (from tracker bbox)
 * @param {{ angle?: number, mouthOpen?: number }} smoothPose
 * @param {Appearance} [app]  appearance; defaults to DEFAULT
 */
export function drawFace(ctx, cx, cy, r, smoothPose, app) {
  const a = app || DEFAULT;
  const hairColor = HAIR_COLORS[a.hairColor & 0x0f] || INK;

  // Head circle — warm skin tone
  ctx.fillStyle = '#FFCBA4';
  ctx.strokeStyle = INK;
  ctx.lineWidth = r * 0.06;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Hair (background layer)
  drawHair(ctx, cx, cy, r, a.hairStyle, hairColor);

  // Facial features (ink layer)
  drawEyes(ctx, cx, cy, r, a.eyes);
  drawBrows(ctx, cx, cy, r, a.brows);
  drawNose(ctx, cx, cy, r, a.nose);
  drawMouth(ctx, cx, cy, r, a.mouth);

  // Smooth-pose tilt
  if (smoothPose?.angle) {
    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = INK;
    const tiltX = Math.sin(smoothPose.angle) * r * 0.04;
    dot(ctx, cx + tiltX, cy + r * 0.02, r * 0.5);
    ctx.restore();
  }
}
