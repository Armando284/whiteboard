'use strict';

/**
 * VideoManager — orchestrates capture → diff → encode → send, and receive → decode → render.
 * Handles adaptive FPS, keyframe scheduling, debug config.
 */

import { getCameraStream, createCaptureVideo, attachStream, captureFrame, stopStream } from './capture.js';
import { findChangedBlocks, extractBlock, motionScore, adaptiveFps, avgBlockDelta, avgPixelDelta } from './diff.js';
import { encodeKeyframe, encodeDelta, Wire, ENCODING, QUANT } from './encode.js';
import { VideoDecoder } from './decode.js';

const DEFAULT_CONFIG = {
  width: 120,
  height: 90,
  targetFps: 10,
  blockSize: 4,
  threshold: 12,
  keyframeIntervalSec: 2,
  quantization: QUANT.BIT8,
  encoding: ENCODING.RLE,
  adaptiveFps: true,
};

export class VideoManager {
  /**
   * @param {{
   *   conn: import('../net/connection.js').Connection,
   *   onLocalFrame: (frame: Uint8Array, meta: any) => void,
   *   onRemoteFrame: (frame: Uint8Array, meta: any) => void,
   *   onStats: (stats: any) => void,
   *   onError: (err: Error) => void,
   *   config?: Partial<typeof DEFAULT_CONFIG>
   * }} opts
   */
  constructor(opts) {
    this.conn = opts.conn;
    this.onLocalFrame = opts.onLocalFrame;
    this.onRemoteFrame = opts.onRemoteFrame;
    this.onStats = opts.onStats;
    this.onError = opts.onError || console.warn;

    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.active = false;

    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {HTMLVideoElement|null} */
    this.video = null;
    /** @type {Uint8Array|null} */
    this.prevFrame = null;
    /** @type {number} */
    this.frameSeq = 0;
    /** @type {number} */
    this.lastKeyframeTime = 0;
    /** @type {number} */
    this.lastFrameTime = 0;
    /** @type {number} */
    this.captureInterval = 0;

    // Metrics
    this.metrics = {
      framesCaptured: 0,
      framesSent: 0,
      framesSkipped: 0,
      keyframesSent: 0,
      deltaFramesSent: 0,
      totalBlocks: 0,
      changedBlocks: 0,
      rawBytes: 0,
      compressedBytes: 0,
      wireBytes: 0,
      cpuTime: 0,
      motionScore: 0,
      avgBlockDelta: 0,
      avgPixelDelta: 0,
    };

    // Decoder for incoming
    this.decoder = new VideoDecoder({
      width: this.config.width,
      height: this.config.height,
      blockSize: this.config.blockSize,
      onFrame: (frame, meta) => this.onRemoteFrame(frame, meta),
      onKeyframeRequest: (seq) => this._requestKeyframe(seq),
      onError: (err) => this.onError(err),
    });

    // Bind binary handler
    this._boundHandleBinary = this._handleBinary.bind(this);
    this.conn.addEventListener('binary', this._boundHandleBinary);
  }

  /** Start camera capture and processing loop. */
  async start() {
    if (this.active) return;
    try {
      this.stream = await getCameraStream({
        width: 320,
        height: 240,
        facingMode: 'user',
      });
      this.video = createCaptureVideo();
      await attachStream(this.video, this.stream);
      this.active = true;
      this._loop();
    } catch (e) {
      this.onError(e);
      throw e;
    }
  }

  /** Stop capture and cleanup. */
  stop() {
    this.active = false;
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = 0;
    }
    stopStream(this.stream);
    this.stream = null;
    if (this.video) {
      this.video.remove();
      this.video = null;
    }
    this.prevFrame = null;
    this.conn.removeEventListener('binary', this._boundHandleBinary);
  }

  /** Update config (resolution, FPS, etc.) — forces keyframe. */
  setConfig(partial) {
    const oldWidth = this.config.width;
    const oldHeight = this.config.height;
    const oldBlockSize = this.config.blockSize;

    this.config = { ...this.config, ...partial };

    // If resolution or block size changed, need new keyframe and decoder reset
    if (this.config.width !== oldWidth ||
        this.config.height !== oldHeight ||
        this.config.blockSize !== oldBlockSize) {
      this._sendConfig();
      this._scheduleKeyframe();
      this.decoder = new VideoDecoder({
        width: this.config.width,
        height: this.config.height,
        blockSize: this.config.blockSize,
        onFrame: (frame, meta) => this.onRemoteFrame(frame, meta),
        onKeyframeRequest: (seq) => this._requestKeyframe(seq),
        onError: (err) => this.onError(err),
      });
    }
  }

  /** Get current config for debug panel. */
  getConfig() {
    return { ...this.config };
  }

  /** Get current metrics snapshot. */
  getMetrics() {
    return { ...this.metrics };
  }

  /** Main capture/encode loop. */
  _loop() {
    if (!this.active) return;

    const interval = 1000 / this.config.targetFps;
    this.captureInterval = setInterval(() => this._captureAndSend(), interval);
    // Initial immediate capture
    this._captureAndSend();
  }

  async _captureAndSend() {
    if (!this.active || !this.video) return;

    const t0 = performance.now();

    try {
      const frame = await captureFrame(this.video, this.config.width, this.config.height);
      this.metrics.framesCaptured++;

      // Compute diff
      const { changed, totalBlocks, changedBlocks } = this.prevFrame
        ? findChangedBlocks(this.prevFrame, frame, this.config.width, this.config.height, this.config.blockSize, this.config.threshold)
        : { changed: [], totalBlocks: 0, changedBlocks: 0 };

      const blocksX = Math.ceil(this.config.width / this.config.blockSize);
      const blocksY = Math.ceil(this.config.height / this.config.blockSize);
      this.metrics.totalBlocks = blocksX * blocksY;
      this.metrics.changedBlocks = changedBlocks;
      this.metrics.motionScore = motionScore(changedBlocks, this.metrics.totalBlocks);
      this.metrics.avgBlockDelta = avgBlockDelta(changed);
      this.metrics.avgPixelDelta = this.prevFrame ? avgPixelDelta(this.prevFrame, frame) : 0;

      // Adaptive FPS
      if (this.config.adaptiveFps && this.prevFrame) {
        const newFps = adaptiveFps(this.metrics.motionScore);
        if (newFps !== this.config.targetFps) {
          this.config.targetFps = newFps;
          if (this.captureInterval) {
            clearInterval(this.captureInterval);
            this._loop();
          }
        }
      }

      // Decide keyframe vs delta
      const now = Date.now();
      const timeSinceKeyframe = now - this.lastKeyframeTime;
      const forceKeyframe = this.prevFrame === null ||
                           timeSinceKeyframe >= this.config.keyframeIntervalSec * 1000 ||
                           changedBlocks / this.metrics.totalBlocks > 0.5; // major scene change

      let payload;
      let isKeyframe;

      if (forceKeyframe) {
        payload = encodeKeyframe(frame, {
          encoding: this.config.encoding,
          quantization: this.config.quantization,
        });
        isKeyframe = true;
        this.metrics.keyframesSent++;
      } else if (changed.length > 0) {
        const blocks = changed.map(c => ({
          x: c.x,
          y: c.y,
          data: extractBlock(frame, this.config.width, this.config.height, c.x, c.y, this.config.blockSize),
        }));
        payload = encodeDelta(blocks, {
          encoding: this.config.encoding,
          quantization: this.config.quantization,
        });
        isKeyframe = false;
        this.metrics.deltaFramesSent++;
      } else {
        // No changes — skip frame (keepalive handled by keyframe interval)
        this.metrics.framesSkipped++;
        this.prevFrame = frame;
        this._updateStats(t0);
        return;
      }

      // Send
      const wire = isKeyframe
        ? Wire.buildKeyframe({
            seq: this.frameSeq,
            timestamp: performance.now(),
            w: this.config.width,
            h: this.config.height,
            blockSize: this.config.blockSize,
            encoding: this.config.encoding,
            quantization: this.config.quantization,
            payload,
          })
        : Wire.buildDelta({
            seq: this.frameSeq,
            timestamp: performance.now(),
            changedCount: changed.length,
            payload,
          });

      this.metrics.rawBytes += frame.length;
      this.metrics.compressedBytes += payload.length;
      this.metrics.wireBytes += wire.length;

      const sent = this.conn.sendBinary(wire);
      if (sent) {
        this.metrics.framesSent++;
        this.frameSeq = (this.frameSeq + 1) & 0xffff;
        if (isKeyframe) this.lastKeyframeTime = now;
      }

      this.prevFrame = frame;
      this.onLocalFrame(frame, { seq: this.frameSeq, isKeyframe, changedBlocks });
      this._updateStats(t0);

    } catch (e) {
      this.onError(e);
    }
  }

  /** Send config frame to peers. */
  _sendConfig() {
    const wire = Wire.buildConfig({
      width: this.config.width,
      height: this.config.height,
      targetFps: this.config.targetFps,
      blockSize: this.config.blockSize,
      threshold: this.config.threshold,
      keyframeIntervalSec: this.config.keyframeIntervalSec,
      quantization: this.config.quantization,
      encoding: this.config.encoding,
    });
    this.conn.sendBinary(wire);
  }

  /** Force a keyframe on next capture. */
  _scheduleKeyframe() {
    this.lastKeyframeTime = 0;
  }

  /** Handle incoming binary frames from peers. */
  _handleBinary(e) {
    const buf = e.detail;
    if (buf instanceof ArrayBuffer) {
      this.decoder.receive(new Uint8Array(buf));
    }
  }

  /** Request keyframe from sender (via server relay). */
  _requestKeyframe(seq) {
    const wire = new Uint8Array([Wire.TAG_KEYFRAME_REQ, (seq >> 8) & 0xff, seq & 0xff]);
    this.conn.sendBinary(wire);
  }

  _updateStats(captureStart) {
    this.metrics.cpuTime = performance.now() - captureStart;
    this.lastFrameTime = Date.now();

    // Periodic stats emission
    if (this.metrics.framesCaptured % 30 === 0) {
      this._emitStats();
    }
  }

  _emitStats() {
    const now = Date.now();
    const elapsed = (now - (this._statsStart || now)) / 1000;
    const upBps = elapsed > 0 ? (this.metrics.wireBytes * 8) / elapsed : 0;

    this.onStats({
      ...this.metrics,
      resolution: `${this.config.width}×${this.config.height}`,
      targetFps: this.config.targetFps,
      actualFps: elapsed > 0 ? this.metrics.framesSent / elapsed : 0,
      bitrateKbps: upBps / 1000,
      keyframeIntervalSec: this.config.keyframeIntervalSec,
    });
  }
}