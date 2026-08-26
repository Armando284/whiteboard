'use strict';

/**
 * Camera capture & preprocessing — pure functions, no DOM deps in core logic.
 * Exports testable functions + a tiny DOM adapter for browser use.
 */

const DEFAULT_WIDTH = 120;
const DEFAULT_HEIGHT = 90;

/**
 * Luma coefficients (BT.601)
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} 0-255
 */
function luma(r, g, b) {
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

/**
 * Convert RGB ImageData to grayscale Uint8Array.
 * @param {ImageData} img
 * @returns {Uint8Array} length = width * height, values 0-255
 */
export function toGrayscale(img) {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  let j = 0;
  for (let i = 0; i < data.length; i += 4) {
    out[j++] = luma(data[i], data[i + 1], data[i + 2]);
  }
  return out;
}

/**
 * Downscale + grayscale in one pass using bilinear sampling.
 * Faster than drawImage + separate grayscale pass.
 * @param {ImageData} src
 * @param {number} dstW
 * @param {number} dstH
 * @returns {Uint8Array} length = dstW * dstH
 */
export function resizeAndGrayscale(src, dstW, dstH) {
  const { data, width: srcW, height: srcH } = src;
  const out = new Uint8Array(dstW * dstH);

  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let y = 0; y < dstH; y++) {
    const srcY = (y + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(srcH - 1, Math.ceil(srcY));
    const wy = srcY - y0;

    for (let x = 0; x < dstW; x++) {
      const srcX = (x + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(srcW - 1, Math.ceil(srcX));
      const wx = srcX - x0;

      const i00 = (y0 * srcW + x0) * 4;
      const i01 = (y0 * srcW + x1) * 4;
      const i10 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const r = (1 - wx) * (1 - wy) * data[i00] +
                wx * (1 - wy) * data[i01] +
                (1 - wx) * wy * data[i10] +
                wx * wy * data[i11];
      const g = (1 - wx) * (1 - wy) * data[i00 + 1] +
                wx * (1 - wy) * data[i01 + 1] +
                (1 - wx) * wy * data[i10 + 1] +
                wx * wy * data[i11 + 1];
      const b = (1 - wx) * (1 - wy) * data[i00 + 2] +
                wx * (1 - wy) * data[i01 + 2] +
                (1 - wx) * wy * data[i10 + 2] +
                wx * wy * data[i11 + 2];

      out[y * dstW + x] = luma(r, g, b);
    }
  }
  return out;
}

/**
 * Capture a frame from HTMLVideoElement, return grayscale Uint8Array at target size.
 * Uses OffscreenCanvas if available (non-blocking), falls back to onscreen canvas.
 * @param {HTMLVideoElement} video
 * @param {number} targetW
 * @param {number} targetH
 * @returns {Promise<Uint8Array>}
 */
export async function captureFrame(video, targetW = DEFAULT_WIDTH, targetH = DEFAULT_HEIGHT) {
  if (!video || video.readyState < 2) {
    throw new Error('Video not ready');
  }

  const useOffscreen = typeof OffscreenCanvas !== 'undefined';
  const canvas = useOffscreen
    ? new OffscreenCanvas(targetW, targetH)
    : createFallbackCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(video, 0, 0, targetW, targetH);
  const img = ctx.getImageData(0, 0, targetW, targetH);

  if (useOffscreen) {
    // OffscreenCanvas getImageData returns ImageData directly
    return resizeAndGrayscale(img, targetW, targetH);
  }

  // Fallback: canvas already at target size, just grayscale
  return toGrayscale(img);
}

let fallbackCanvas = null;
function createFallbackCanvas(w, h) {
  if (!fallbackCanvas) {
    fallbackCanvas = document.createElement('canvas');
    fallbackCanvas.style.display = 'none';
    document.body.appendChild(fallbackCanvas);
  }
  fallbackCanvas.width = w;
  fallbackCanvas.height = h;
  return fallbackCanvas;
}

/**
 * Request camera access with specific constraints.
 * @param {{width?: number, height?: number, facingMode?: 'user'|'environment'}} constraints
 * @returns {Promise<MediaStream>}
 */
export async function getCameraStream(constraints = {}) {
  const { width = 320, height = 240, facingMode = 'user' } = constraints;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not available (insecure context?)');
  }
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: width }, height: { ideal: height }, facingMode },
    audio: false,
  });
}

/**
 * Attach stream to video element and wait for playing.
 * @param {HTMLVideoElement} video
 * @param {MediaStream} stream
 * @returns {Promise<void>}
 */
export function attachStream(video, stream) {
  return new Promise((resolve, reject) => {
    video.srcObject = stream;
    video.onloadeddata = () => {
      video.play().then(resolve).catch(reject);
    };
    video.onerror = reject;
  });
}

/**
 * Create a hidden video element for capture.
 * @returns {HTMLVideoElement}
 */
export function createCaptureVideo() {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.style.display = 'none';
  document.body.appendChild(video);
  return video;
}

/**
 * Stop all tracks in a stream.
 * @param {MediaStream} stream
 */
export function stopStream(stream) {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
}