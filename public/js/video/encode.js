'use strict';

/**
 * Quantization, compression, and frame encoding — pure functions.
 * Supports: 8-bit raw, 4-bit packed, RLE, bitpack4 (2px/byte).
 */

const ENCODING = {
  RAW: 0,
  RLE: 1,
  BITPACK4: 2,
};

const QUANT = {
  BIT8: 0,
  BIT4: 1,
};

/**
 * Quantize 8-bit values to 4-bit (0-15).
 * @param {Uint8Array} src
 * @returns {Uint8Array} half length (packed 2 per byte)
 */
export function quantize4(src) {
  const out = new Uint8Array(Math.ceil(src.length / 2));
  for (let i = 0; i < src.length; i += 2) {
    const hi = (src[i] >> 4) & 0x0f;
    const lo = i + 1 < src.length ? (src[i + 1] >> 4) & 0x0f : 0;
    out[i >> 1] = (hi << 4) | lo;
  }
  return out;
}

/**
 * Dequantize 4-bit packed to 8-bit (0-240 step 16).
 * @param {Uint8Array} src
 * @param {number} length - output length
 * @returns {Uint8Array}
 */
export function dequantize4(src, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const packed = src[i >> 1];
    const val = (i & 1) ? (packed & 0x0f) : (packed >> 4);
    out[i] = val << 4;
  }
  return out;
}

/**
 * Run-length encode Uint8Array.
 * @param {Uint8Array} src
 * @returns {Uint8Array} [runLen, value, runLen, value...] runLen 1-255
 */
export function rleEncode(src) {
  if (!src.length) return new Uint8Array(0);
  const out = [];
  let run = 1;
  let prev = src[0];

  for (let i = 1; i < src.length; i++) {
    const v = src[i];
    if (v === prev && run < 255) {
      run++;
    } else {
      out.push(run, prev);
      run = 1;
      prev = v;
    }
  }
  out.push(run, prev);
  return new Uint8Array(out);
}

/**
 * Run-length decode.
 * @param {Uint8Array} src
 * @param {number} expectedLen - expected output length
 * @returns {Uint8Array}
 */
export function rleDecode(src, expectedLen) {
  const out = new Uint8Array(expectedLen);
  let j = 0;
  for (let i = 0; i < src.length; i += 2) {
    const run = src[i];
    const val = src[i + 1];
    const end = Math.min(j + run, expectedLen);
    out.fill(val, j, end);
    j = end;
    if (j >= expectedLen) break;
  }
  return out;
}

/**
 * Bitpack 4-bit values: 2 pixels per byte (already quantized to 0-15).
 * @param {Uint8Array} src4 - 4-bit values (0-15)
 * @returns {Uint8Array} half length
 */
export function bitpack4(src4) {
  const out = new Uint8Array(Math.ceil(src4.length / 2));
  for (let i = 0; i < src4.length; i += 2) {
    const hi = src4[i] & 0x0f;
    const lo = i + 1 < src4.length ? src4[i + 1] & 0x0f : 0;
    out[i >> 1] = (hi << 4) | lo;
  }
  return out;
}

/**
 * Unpack bitpack4 to 4-bit values.
 * @param {Uint8Array} src
 * @param {number} length
 * @returns {Uint8Array}
 */
export function unbitpack4(src, length) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const packed = src[i >> 1];
    out[i] = (i & 1) ? (packed & 0x0f) : (packed >> 4);
  }
  return out;
}

/**
 * Encode full frame (keyframe).
 * @param {Uint8Array} frame - W×H grayscale 0-255
 * @param {{encoding: number, quantization: number}} opts
 * @returns {Uint8Array} encoded payload
 */
export function encodeKeyframe(frame, opts = {}) {
  const { encoding = ENCODING.RLE, quantization = QUANT.BIT8 } = opts;
  let data = frame;

  if (quantization === QUANT.BIT4) {
    data = quantize4(frame);
  }

  if (encoding === ENCODING.RLE) {
    data = rleEncode(data);
  } else if (encoding === ENCODING.BITPACK4) {
    if (quantization !== QUANT.BIT4) {
      data = quantize4(frame);
    }
    data = bitpack4(data);
  }
  // RAW: no further encoding

  return data;
}

/**
 * Decode keyframe payload to full frame.
 * @param {Uint8Array} payload
 * @param {number} w - frame width
 * @param {number} h - frame height
 * @param {{encoding: number, quantization: number}} opts
 * @returns {Uint8Array} W×H grayscale 0-255
 */
export function decodeKeyframe(payload, w, h, opts = {}) {
  const { encoding = ENCODING.RLE, quantization = QUANT.BIT8 } = opts;
  const pixelCount = w * h;
  let data = payload;

  if (encoding === ENCODING.RLE) {
    const q = quantization === QUANT.BIT4 ? Math.ceil(pixelCount / 2) : pixelCount;
    data = rleDecode(payload, q);
  } else if (encoding === ENCODING.BITPACK4) {
    data = unbitpack4(payload, pixelCount);
  }
  // RAW: data is already the pixel array

  if (quantization === QUANT.BIT4) {
    data = dequantize4(data, pixelCount);
  }

  return data;
}

/**
 * Encode changed blocks for delta frame.
 * @param {Array<{x:number, y:number, data:Uint8Array}>} blocks - each data is blockW×blockH
 * @param {{encoding: number, quantization: number}} opts
 * @returns {Uint8Array} concatenated block entries
 */
export function encodeDelta(blocks, opts = {}) {
  const { encoding = ENCODING.RLE, quantization = QUANT.BIT8 } = opts;
  const parts = [];

  for (const block of blocks) {
    let data = block.data;

    if (quantization === QUANT.BIT4) {
      data = quantize4(data);
    }
    if (encoding === ENCODING.RLE) {
      data = rleEncode(data);
    } else if (encoding === ENCODING.BITPACK4) {
      if (quantization !== QUANT.BIT4) data = quantize4(block.data);
      data = bitpack4(data);
    }

    // Block header: x(1) y(1) encoding(1) len(2)
    const header = new Uint8Array(5);
    header[0] = block.x;
    header[1] = block.y;
    header[2] = encoding;
    const len = data.length;
    header[3] = (len >> 8) & 0xff;
    header[4] = len & 0xff;

    parts.push(header, data);
  }

  // Concat
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Decode delta payload to block array.
 * @param {Uint8Array} payload
 * @param {number} blockSize
 * @param {{quantization: number}} opts
 * @returns {Array<{x:number, y:number, data:Uint8Array}>}
 */
export function decodeDelta(payload, blockSize, opts = {}) {
  const { quantization = QUANT.BIT8 } = opts;
  const blocks = [];
  let i = 0;

  while (i < payload.length) {
    if (i + 5 > payload.length) break;
    const x = payload[i];
    const y = payload[i + 1];
    const encoding = payload[i + 2];
    const len = (payload[i + 3] << 8) | payload[i + 4];
    i += 5;

    if (i + len > payload.length) break;
    const data = payload.subarray(i, i + len);
    i += len;

    let decoded;
    if (encoding === ENCODING.RLE) {
      const blockPixels = blockSize * blockSize;
      const q = quantization === QUANT.BIT4 ? Math.ceil(blockPixels / 2) : blockPixels;
      decoded = rleDecode(data, q);
    } else if (encoding === ENCODING.BITPACK4) {
      decoded = unbitpack4(data, blockSize * blockSize);
    } else {
      decoded = data; // RAW
    }

    if (quantization === QUANT.BIT4) {
      decoded = dequantize4(decoded, blockSize * blockSize);
    }

    blocks.push({ x, y, data: decoded });
  }

  return blocks;
}

/**
 * Build wire frame (keyframe or delta) with protocol headers.
 * See VIDEO_PROTOCOL.md for wire format.
 */
export const Wire = {
  TAG_KEYFRAME: 0x10,
  TAG_DELTA: 0x11,
  TAG_CONFIG: 0x12,
  TAG_KEYFRAME_REQ: 0x13,

  /**
   * @param {Object} params
   * @param {number} params.seq
   * @param {number} params.timestamp
   * @param {number} params.w
   * @param {number} params.h
   * @param {number} params.blockSize
   * @param {number} params.encoding
   * @param {number} params.quantization
   * @param {Uint8Array} params.payload
   */
  buildKeyframe({ seq, timestamp, w, h, blockSize, encoding, quantization, payload }) {
    const blocksX = Math.ceil(w / blockSize);
    const blocksY = Math.ceil(h / blockSize);
    const header = new Uint8Array(14);
    header[0] = this.TAG_KEYFRAME;
    header[1] = (seq >> 8) & 0xff;
    header[2] = seq & 0xff;
    header[3] = (timestamp >> 24) & 0xff;
    header[4] = (timestamp >> 16) & 0xff;
    header[5] = (timestamp >> 8) & 0xff;
    header[6] = timestamp & 0xff;
    header[7] = blocksX;
    header[8] = blocksY;
    header[9] = blockSize;
    header[10] = encoding;
    header[11] = quantization;
    header[12] = (payload.length >> 8) & 0xff;
    header[13] = payload.length & 0xff;
    return concat(header, payload);
  },

  /**
   * @param {Object} params
   * @param {number} params.seq
   * @param {number} params.timestamp
   * @param {number} params.changedCount
   * @param {Uint8Array} params.payload - encoded blocks
   */
  buildDelta({ seq, timestamp, changedCount, payload }) {
    const header = new Uint8Array(9);
    header[0] = this.TAG_DELTA;
    header[1] = (seq >> 8) & 0xff;
    header[2] = seq & 0xff;
    header[3] = (timestamp >> 24) & 0xff;
    header[4] = (timestamp >> 16) & 0xff;
    header[5] = (timestamp >> 8) & 0xff;
    header[6] = timestamp & 0xff;
    header[7] = (changedCount >> 8) & 0xff;
    header[8] = changedCount & 0xff;
    return concat(header, payload);
  },

  buildConfig({ width, height, targetFps, blockSize, threshold, keyframeIntervalSec, quantization, encoding }) {
    const payload = new Uint8Array(8);
    payload[0] = width;
    payload[1] = height;
    payload[2] = targetFps;
    payload[3] = blockSize;
    payload[4] = threshold;
    payload[5] = keyframeIntervalSec;
    payload[6] = quantization;
    payload[7] = encoding;
    const header = new Uint8Array(1);
    header[0] = this.TAG_CONFIG;
    return concat(header, payload);
  },

  parse(buf) {
    if (!buf || buf.length < 1) return null;
    const tag = buf[0];
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    switch (tag) {
      case this.TAG_KEYFRAME: {
        if (buf.length < 14) return null;
        const payloadLen = (view.getUint8(12) << 8) | view.getUint8(13);
        const payload = buf.subarray(14, 14 + payloadLen);
        return {
          type: 'keyframe',
          seq: view.getUint16(1),
          timestamp: view.getUint32(3),
          blocksX: view.getUint8(7),
          blocksY: view.getUint8(8),
          blockSize: view.getUint8(9),
          encoding: view.getUint8(10),
          quantization: view.getUint8(11),
          payload,
        };
      }
      case this.TAG_DELTA: {
        if (buf.length < 9) return null;
        const payload = buf.subarray(9);
        return {
          type: 'delta',
          seq: view.getUint16(1),
          timestamp: view.getUint32(3),
          changedCount: view.getUint16(7),
          payload,
        };
      }
      case this.TAG_CONFIG: {
        if (buf.length < 9) return null;
        return {
          type: 'config',
          width: view.getUint8(1),
          height: view.getUint8(2),
          targetFps: view.getUint8(3),
          blockSize: view.getUint8(4),
          threshold: view.getUint8(5),
          keyframeIntervalSec: view.getUint8(6),
          quantization: view.getUint8(7),
          encoding: view.getUint8(8),
        };
      }
      default:
        return null;
    }
  },
};

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { ENCODING, QUANT };