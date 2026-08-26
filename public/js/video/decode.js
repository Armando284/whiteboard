'use strict';

/**
 * Video frame decoder — reconstructs frames from keyframes + deltas.
 * Handles sequence gaps, out-of-order delivery, keyframe requests.
 */

import { decodeKeyframe, decodeDelta, Wire, ENCODING, QUANT } from './encode.js';

const MAX_OOO_BUFFER = 3;
const GAP_KEYFRAME_THRESHOLD = 5; // seq gap > this → request keyframe
const KEYFRAME_TIMEOUT_MS = 2000; // no keyframe for this long → request

/**
 * @typedef {{seq:number, timestamp:number, frame:Uint8Array, isKeyframe:boolean}} DecodedFrame
 */

export class VideoDecoder {
  /**
   * @param {{
   *   width: number,
   *   height: number,
   *   blockSize: number,
   *   onFrame: (frame: Uint8Array, meta: {seq:number, timestamp:number, isKeyframe:boolean}) => void,
   *   onKeyframeRequest: (seq: number) => void,
   *   onError: (err: Error) => void
   * }} opts
   */
  constructor(opts) {
    this.width = opts.width;
    this.height = opts.height;
    this.blockSize = opts.blockSize;
    this.onFrame = opts.onFrame;
    this.onKeyframeRequest = opts.onKeyframeRequest;
    this.onError = opts.onError || (() => {});

    /** @type {Uint8Array|null} */
    this.currentFrame = null;
    /** @type {number} */
    this.expectedSeq = 0;
    /** @type {Map<number, Uint8Array>} */
    this.oooBuffer = new Map();
    /** @type {number|null} */
    this.lastKeyframeSeq = null;
    /** @type {number} */
    this.lastFrameTime = 0;
    /** @type {Object} */
    this.config = {
      encoding: ENCODING.RLE,
      quantization: QUANT.BIT8,
      keyframeIntervalSec: 2,
    };
  }

  /**
   * Process incoming wire frame.
   * @param {Uint8Array} buf
   */
  receive(buf) {
    const parsed = Wire.parse(buf);
    if (!parsed) {
      this.onError(new Error('Invalid video frame'));
      return;
    }

    switch (parsed.type) {
      case 'config':
        this.config = parsed;
        break;
      case 'keyframe':
        this._handleKeyframe(parsed);
        break;
      case 'delta':
        this._handleDelta(parsed);
        break;
    }
  }

  _handleKeyframe(parsed) {
    try {
      const frame = decodeKeyframe(parsed.payload, this.width, this.height, {
        encoding: parsed.encoding,
        quantization: parsed.quantization,
      });

      this.currentFrame = frame;
      this.lastKeyframeSeq = parsed.seq;
      this.expectedSeq = (parsed.seq + 1) & 0xffff;
      this.lastFrameTime = parsed.timestamp;
      this._flushOoo();

      this.onFrame(frame, {
        seq: parsed.seq,
        timestamp: parsed.timestamp,
        isKeyframe: true,
      });
    } catch (e) {
      this.onError(e);
    }
  }

  _handleDelta(parsed) {
    if (this.currentFrame === null) {
      // No keyframe yet — buffer or request
      if (this.oooBuffer.size < MAX_OOO_BUFFER) {
        this.oooBuffer.set(parsed.seq, parsed.payload);
      }
      this._maybeRequestKeyframe(parsed.seq);
      return;
    }

    const seq = parsed.seq;
    const gap = (seq - this.expectedSeq) & 0xffff;

    if (gap === 0) {
      // In order
      this._applyDelta(parsed);
      this.expectedSeq = (seq + 1) & 0xffff;
      this._flushOoo();
    } else if (gap > 0 && gap < MAX_OOO_BUFFER) {
      // Future frame — buffer
      this.oooBuffer.set(seq, parsed.payload);
      this._maybeRequestKeyframe(seq);
    } else if (gap > GAP_KEYFRAME_THRESHOLD) {
      // Large gap — request keyframe
      this._requestKeyframe(seq);
    }
    // else: stale/duplicate, ignore
  }

  _applyDelta(parsed) {
    try {
      const blocks = decodeDelta(parsed.payload, this.blockSize, {
        quantization: this.config.quantization,
      });

      for (const block of blocks) {
        const bx = block.x;
        const by = block.y;
        const startX = bx * this.blockSize;
        const startY = by * this.blockSize;
        const endX = Math.min(startX + this.blockSize, this.width);
        const endY = Math.min(startY + this.blockSize, this.height);
        const blockW = endX - startX;

        let j = 0;
        for (let y = startY; y < endY; y++) {
          const base = y * this.width + startX;
          this.currentFrame.set(block.data.subarray(j, j + blockW), base);
          j += blockW;
        }
      }

      this.onFrame(this.currentFrame, {
        seq: parsed.seq,
        timestamp: parsed.timestamp,
        isKeyframe: false,
      });
    } catch (e) {
      this.onError(e);
      this._requestKeyframe(parsed.seq);
    }
  }

  _flushOoo() {
    while (this.oooBuffer.has(this.expectedSeq)) {
      const payload = this.oooBuffer.get(this.expectedSeq);
      this.oooBuffer.delete(this.expectedSeq);
      this._applyDelta({
        seq: this.expectedSeq,
        timestamp: Date.now(),
        payload,
      });
      this.expectedSeq = (this.expectedSeq + 1) & 0xffff;
    }
  }

  _maybeRequestKeyframe(receivedSeq) {
    const now = Date.now();
    if (this.lastKeyframeSeq === null) {
      if (now - this.lastFrameTime > KEYFRAME_TIMEOUT_MS) {
        this._requestKeyframe(receivedSeq);
      }
    } else if (this.lastFrameTime && now - this.lastFrameTime > this.config.keyframeIntervalSec * 1000 * 2) {
      this._requestKeyframe(receivedSeq);
    }
  }

  _requestKeyframe(receivedSeq) {
    this.onKeyframeRequest(receivedSeq);
    this.lastFrameTime = Date.now();
  }

  /**
   * Get current reconstructed frame (for rendering).
   * @returns {Uint8Array|null}
   */
  getFrame() {
    return this.currentFrame;
  }

  /**
   * Reset decoder state (on config change or explicit request).
   */
  reset() {
    this.currentFrame = null;
    this.expectedSeq = 0;
    this.oooBuffer.clear();
    this.lastKeyframeSeq = null;
    this.lastFrameTime = 0;
  }
}