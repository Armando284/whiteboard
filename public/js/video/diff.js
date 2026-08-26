'use strict';

/**
 * Block-based frame differencing — pure functions, no DOM deps.
 * Divides frame into blocks, computes per-block change metric.
 */

const DEFAULT_BLOCK_SIZE = 4;
const DEFAULT_THRESHOLD = 12; // 0-255 grayscale delta

/**
 * Compute mean absolute difference for one block.
 * @param {Uint8Array} prev - previous frame (W×H)
 * @param {Uint8Array} curr - current frame (W×H)
 * @param {number} w - frame width
 * @param {number} h - frame height
 * @param {number} bx - block X index
 * @param {number} by - block Y index
 * @param {number} blockSize - pixels per block side
 * @returns {number} mean absolute delta 0-255
 */
function blockDelta(prev, curr, w, h, bx, by, blockSize) {
  const startX = bx * blockSize;
  const startY = by * blockSize;
  const endX = Math.min(startX + blockSize, w);
  const endY = Math.min(startY + blockSize, h);

  let sum = 0;
  let count = 0;
  for (let y = startY; y < endY; y++) {
    const base = y * w;
    for (let x = startX; x < endX; x++) {
      const i = base + x;
      sum += Math.abs(curr[i] - prev[i]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Find changed blocks between two frames.
 * @param {Uint8Array} prev - previous frame (W×H)
 * @param {Uint8Array} curr - current frame (W×H)
 * @param {number} w - frame width
 * @param {number} h - frame height
 * @param {number} blockSize - pixels per block side (2, 4, 8)
 * @param {number} threshold - mean delta threshold 0-255
 * @returns {{changed: Array<{x:number, y:number, delta:number}>, totalBlocks: number, changedBlocks: number}}
 */
export function findChangedBlocks(prev, curr, w, h, blockSize = DEFAULT_BLOCK_SIZE, threshold = DEFAULT_THRESHOLD) {
  const blocksX = Math.ceil(w / blockSize);
  const blocksY = Math.ceil(h / blockSize);
  const changed = [];

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const delta = blockDelta(prev, curr, w, h, bx, by, blockSize);
      if (delta >= threshold) {
        changed.push({ x: bx, y: by, delta });
      }
    }
  }

  return {
    changed,
    totalBlocks: blocksX * blocksY,
    changedBlocks: changed.length,
  };
}

/**
 * Extract block pixel data from frame.
 * @param {Uint8Array} frame - full frame (W×H)
 * @param {number} w - frame width
 * @param {number} h - frame height
 * @param {number} bx - block X
 * @param {number} by - block Y
 * @param {number} blockSize - block size
 * @returns {Uint8Array} block pixels (blockW × blockH)
 */
export function extractBlock(frame, w, h, bx, by, blockSize) {
  const startX = bx * blockSize;
  const startY = by * blockSize;
  const endX = Math.min(startX + blockSize, w);
  const endY = Math.min(startY + blockSize, h);
  const blockW = endX - startX;
  const blockH = endY - startY;
  const out = new Uint8Array(blockW * blockH);

  let j = 0;
  for (let y = startY; y < endY; y++) {
    const base = y * w + startX;
    out.set(frame.subarray(base, base + blockW), j);
    j += blockW;
  }
  return out;
}

/**
 * Apply block data to frame (for decoder).
 * @param {Uint8Array} frame - target frame (W×H) mutated
 * @param {number} w - frame width
 * @param {number} h - frame height
 * @param {number} bx - block X
 * @param {number} by - block Y
 * @param {number} blockSize - block size
 * @param {Uint8Array} blockData - block pixels
 */
export function applyBlock(frame, w, h, bx, by, blockSize, blockData) {
  const startX = bx * blockSize;
  const startY = by * blockSize;
  const endX = Math.min(startX + blockSize, w);
  const endY = Math.min(startY + blockSize, h);
  const blockW = endX - startX;

  let j = 0;
  for (let y = startY; y < endY; y++) {
    const base = y * w + startX;
    frame.set(blockData.subarray(j, j + blockW), base);
    j += blockW;
  }
}

/**
 * Compute motion score (fraction of changed blocks).
 * @param {number} changedBlocks
 * @param {number} totalBlocks
 * @returns {number} 0-1
 */
export function motionScore(changedBlocks, totalBlocks) {
  return totalBlocks > 0 ? changedBlocks / totalBlocks : 0;
}

/**
 * Compute average block delta across changed blocks.
 * @param {Array<{delta:number}>} changed
 * @returns {number}
 */
export function avgBlockDelta(changed) {
  if (!changed.length) return 0;
  let sum = 0;
  for (const c of changed) sum += c.delta;
  return sum / changed.length;
}

/**
 * Compute average pixel delta across entire frame.
 * @param {Uint8Array} prev
 * @param {Uint8Array} curr
 * @returns {number}
 */
export function avgPixelDelta(prev, curr) {
  let sum = 0;
  for (let i = 0; i < prev.length; i++) {
    sum += Math.abs(curr[i] - prev[i]);
  }
  return prev.length > 0 ? sum / prev.length : 0;
}

/**
 * Decide target FPS based on motion score (adaptive).
 * @param {number} score - motion score 0-1
 * @param {{low?: number, med?: number, high?: number, max?: number}} [thresholds]
 * @returns {number} target FPS
 */
export function adaptiveFps(score, thresholds = {}) {
  const { low = 1, med = 5, high = 10, max = 15 } = thresholds;
  if (score > 0.3) return max;
  if (score > 0.15) return high;
  if (score > 0.05) return med;
  return low;
}