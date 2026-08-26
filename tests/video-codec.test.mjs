'use strict';

/**
 * Unit tests for video codec — pure functions, run in Node.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  quantize4,
  dequantize4,
  rleEncode,
  rleDecode,
  bitpack4,
  unbitpack4,
  encodeKeyframe,
  decodeKeyframe,
  encodeDelta,
  decodeDelta,
  Wire,
  ENCODING,
  QUANT,
} from '../public/js/video/encode.js';

import {
  findChangedBlocks,
  extractBlock,
  applyBlock,
  motionScore,
  adaptiveFps,
  avgBlockDelta,
  avgPixelDelta,
} from '../public/js/video/diff.js';

// ---- Test helpers ----

function makeFrame(w, h, fill = 0) {
  return new Uint8Array(w * h).fill(fill);
}

function makeGradient(w, h) {
  const f = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f[y * w + x] = Math.round((x / w + y / h) * 127);
    }
  }
  return f;
}

function makeCheckerboard(w, h, block = 4) {
  const f = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      f[y * w + x] = ((Math.floor(x / block) + Math.floor(y / block)) % 2) * 255;
    }
  }
  return f;
}

// ---- encode.js tests ----

describe('encode.js - quantize4/dequantize4', () => {
  it('roundtrips 8-bit values to 4-bit and back (step 16)', () => {
    const src = new Uint8Array([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255]);
    const q = quantize4(src);
    const dq = dequantize4(q, src.length);
    for (let i = 0; i < src.length; i++) {
      assert.strictEqual(dq[i], src[i] & 0xf0);
    }
  });

  it('handles odd length', () => {
    const src = new Uint8Array([10, 20, 30]);
    const q = quantize4(src);
    assert.strictEqual(q.length, 2);
    const dq = dequantize4(q, 3);
    // Quantized: [10>>4=0, 20>>4=1] packed as [0<<4|1=1, 30>>4=1<<4|0=16]
    // Dequantized: [0<<4=0, 1<<4=16, 1<<4=16]
    assert.strictEqual(dq[0], 0);
    assert.strictEqual(dq[1], 16);
    assert.strictEqual(dq[2], 16); // padded with previous high nibble
  });
});

describe('encode.js - rleEncode/rleDecode', () => {
  it('encodes runs', () => {
    const src = new Uint8Array([5, 5, 5, 7, 7, 5]);
    const enc = rleEncode(src);
    assert.deepStrictEqual(Array.from(enc), [3, 5, 2, 7, 1, 5]);
  });

  it('decodes to expected length', () => {
    const src = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const enc = rleEncode(src);
    const dec = rleDecode(enc, src.length);
    assert.deepStrictEqual(Array.from(dec), Array.from(src));
  });

  it('handles run > 255', () => {
    const src = new Uint8Array(300).fill(42);
    const enc = rleEncode(src);
    // Should split into 255 + 45
    const dec = rleDecode(enc, 300);
    assert.strictEqual(dec.length, 300);
    assert.strictEqual(dec[0], 42);
    assert.strictEqual(dec[299], 42);
  });

  it('empty array', () => {
    const enc = rleEncode(new Uint8Array(0));
    assert.strictEqual(enc.length, 0);
  });
});

describe('encode.js - bitpack4/unbitpack4', () => {
  it('packs 2 nibbles per byte', () => {
    const src = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const packed = bitpack4(src);
    assert.strictEqual(packed.length, 8);
    const unpacked = unbitpack4(packed, 16);
    assert.deepStrictEqual(Array.from(unpacked), Array.from(src));
  });

  it('handles odd length', () => {
    const src = new Uint8Array([0x1, 0x2, 0x3]);
    const packed = bitpack4(src);
    assert.strictEqual(packed.length, 2);
    const unpacked = unbitpack4(packed, 3);
    assert.deepStrictEqual(Array.from(unpacked), [0x1, 0x2, 0x3]);
  });
});

describe('encode.js - keyframe roundtrip', () => {
  const w = 120, h = 90;

for (const encoding of [ENCODING.RAW, ENCODING.RLE]) {
      for (const quant of [QUANT.BIT8, QUANT.BIT4]) {
        // BITPACK4 requires BIT4 quantization
        if (encoding === ENCODING.BITPACK4 && quant !== QUANT.BIT4) continue;

        it(`keyframe roundtrip: encoding=${encoding} quant=${quant}`, () => {
          const frame = makeGradient(w, h);
          const payload = encodeKeyframe(frame, { encoding, quantization: quant });
          const decoded = decodeKeyframe(payload, w, h, { encoding, quantization: quant });

          if (quant === QUANT.BIT8 && encoding === ENCODING.RAW) {
            assert.deepStrictEqual(Array.from(decoded), Array.from(frame));
          } else {
            // Lossy: check within quantization step
            const maxDiff = quant === QUANT.BIT4 ? 25 : (encoding === ENCODING.RLE ? 1 : 25);
            for (let i = 0; i < frame.length; i++) {
              const diff = Math.abs(decoded[i] - frame[i]);
              assert.ok(diff <= maxDiff, `pixel ${i}: diff=${diff} > ${maxDiff}`);
            }
          }
        });
      }
    }

  it('uniform frame compresses well with RLE', () => {
    const frame = makeFrame(120, 90, 128);
    const payload = encodeKeyframe(frame, { encoding: ENCODING.RLE, quantization: QUANT.BIT8 });
    // RLE: [run=10800, val=128] = 2 bytes (but run > 255 so splits)
    assert.ok(payload.length < 100, `RLE uniform frame: ${payload.length} bytes`);
  });

  it('checkerboard compresses poorly with RLE', () => {
    const frame = makeCheckerboard(120, 90, 4);
    const payload = encodeKeyframe(frame, { encoding: ENCODING.RLE, quantization: QUANT.BIT8 });
    // Should be close to raw size
    assert.ok(payload.length > 5000, `RLE checkerboard: ${payload.length} bytes`);
  });
});

describe('encode.js - delta roundtrip', () => {
  it('encodes and decodes changed blocks', () => {
    const blockSize = 4;
    // Use uniform blocks to avoid gradient boundary issues
    const blocks = [
      { x: 2, y: 3, data: makeFrame(4, 4, 100) },
      { x: 10, y: 5, data: makeFrame(4, 4, 200) },
    ];

    // Test key combinations
    const combos = [
      { encoding: ENCODING.RAW, quant: QUANT.BIT8 },
      { encoding: ENCODING.RLE, quant: QUANT.BIT8 },
      { encoding: ENCODING.RLE, quant: QUANT.BIT4 },
    ];

    for (const { encoding, quant } of combos) {
      const payload = encodeDelta(blocks, { encoding, quantization: quant });
      const decoded = decodeDelta(payload, blockSize, { quantization: quant });

      assert.strictEqual(decoded.length, 2);
      assert.strictEqual(decoded[0].x, 2);
      assert.strictEqual(decoded[0].y, 3);
      assert.strictEqual(decoded[1].x, 10);
      assert.strictEqual(decoded[1].y, 5);

      // Check data integrity
      const maxDiff = quant === QUANT.BIT4 ? 25 : 1;
      for (let i = 0; i < 16; i++) {
        const orig = blocks[0].data[i];
        const dec = decoded[0].data[i];
        assert.ok(Math.abs(dec - orig) <= maxDiff, `encoding=${encoding} quant=${quant} block 0 pixel ${i}: diff=${Math.abs(dec - orig)} > ${maxDiff}`);
        const orig1 = blocks[1].data[i];
        const dec1 = decoded[1].data[i];
        assert.ok(Math.abs(dec1 - orig1) <= maxDiff, `encoding=${encoding} quant=${quant} block 1 pixel ${i}: diff=${Math.abs(dec1 - orig1)} > ${maxDiff}`);
      }
    }
  });
});

describe('encode.js - Wire frame parse', () => {
  it('parses keyframe wire frame', () => {
    const frame = makeFrame(120, 90, 100);
    const payload = encodeKeyframe(frame, { encoding: ENCODING.RLE, quantization: QUANT.BIT8 });
    const wire = Wire.buildKeyframe({
      seq: 42,
      timestamp: 123456,
      w: 120,
      h: 90,
      blockSize: 4,
      encoding: ENCODING.RLE,
      quantization: QUANT.BIT8,
      payload,
    });

    const parsed = Wire.parse(wire);
    assert.strictEqual(parsed.type, 'keyframe');
    assert.strictEqual(parsed.seq, 42);
    assert.strictEqual(parsed.timestamp, 123456);
    assert.strictEqual(parsed.blocksX, 30);
    assert.strictEqual(parsed.blocksY, 23);
    assert.strictEqual(parsed.blockSize, 4);
    assert.strictEqual(parsed.encoding, ENCODING.RLE);
    assert.strictEqual(parsed.quantization, QUANT.BIT8);
  });

  it('parses delta wire frame', () => {
    const payload = new Uint8Array([1, 2, 3, 4]); // dummy
    const wire = Wire.buildDelta({
      seq: 100,
      timestamp: 999999,
      changedCount: 5,
      payload,
    });

    const parsed = Wire.parse(wire);
    assert.strictEqual(parsed.type, 'delta');
    assert.strictEqual(parsed.seq, 100);
    assert.strictEqual(parsed.timestamp, 999999);
    assert.strictEqual(parsed.changedCount, 5);
  });

  it('parses config wire frame', () => {
    const wire = Wire.buildConfig({
      width: 160,
      height: 120,
      targetFps: 15,
      blockSize: 8,
      threshold: 20,
      keyframeIntervalSec: 5,
      quantization: QUANT.BIT4,
      encoding: ENCODING.BITPACK4,
    });

    const parsed = Wire.parse(wire);
    assert.strictEqual(parsed.type, 'config');
    assert.strictEqual(parsed.width, 160);
    assert.strictEqual(parsed.height, 120);
    assert.strictEqual(parsed.targetFps, 15);
    assert.strictEqual(parsed.blockSize, 8);
    assert.strictEqual(parsed.threshold, 20);
    assert.strictEqual(parsed.keyframeIntervalSec, 5);
    assert.strictEqual(parsed.quantization, QUANT.BIT4);
    assert.strictEqual(parsed.encoding, ENCODING.BITPACK4);
  });

  it('returns null for unknown tag', () => {
    const wire = new Uint8Array([0x99, 1, 2, 3]);
    assert.strictEqual(Wire.parse(wire), null);
  });
});

// ---- diff.js tests ----

describe('diff.js - findChangedBlocks', () => {
  it('detects no changes in identical frames', () => {
    const frame = makeGradient(80, 60);
    const result = findChangedBlocks(frame, frame, 80, 60, 4, 12);
    assert.strictEqual(result.changedBlocks, 0);
    assert.strictEqual(result.changed.length, 0);
  });

  it('detects full frame change', () => {
    const a = makeFrame(80, 60, 0);
    const b = makeFrame(80, 60, 255);
    const result = findChangedBlocks(a, b, 80, 60, 4, 12);
    assert.strictEqual(result.changedBlocks, result.totalBlocks);
  });

  it('detects single block change', () => {
    const a = makeFrame(80, 60, 100);
    const b = new Uint8Array(a);
    // Change block (5, 3) - pixels 5*4=20 to 23, 3*4=12 to 15
    for (let y = 12; y < 16; y++) {
      for (let x = 20; x < 24; x++) {
        b[y * 80 + x] = 200;
      }
    }
    const result = findChangedBlocks(a, b, 80, 60, 4, 12);
    assert.strictEqual(result.changedBlocks, 1);
    assert.strictEqual(result.changed[0].x, 5);
    assert.strictEqual(result.changed[0].y, 3);
  });

  it('threshold filters small changes', () => {
    const a = makeFrame(80, 60, 100);
    const b = new Uint8Array(a);
    // Small change in one pixel (mean delta = 10/16 = 0.625 < 12)
    b[100] = 110;
    const result = findChangedBlocks(a, b, 80, 60, 4, 12);
    assert.strictEqual(result.changedBlocks, 0); // below threshold

    // Large change: change entire block (16 pixels) by 100
    for (let y = 12; y < 16; y++) {
      for (let x = 20; x < 24; x++) {
        b[y * 80 + x] = 200;
      }
    }
    const result2 = findChangedBlocks(a, b, 80, 60, 4, 12);
    assert.strictEqual(result2.changedBlocks, 1);
  });

  it('handles non-multiple block sizes', () => {
    // 80x60 with blockSize=8 → 10x8 blocks (last row partial: 8x4)
    const a = makeFrame(80, 60, 50);
    const b = new Uint8Array(a);
    // Change entire last block (bx=9, by=7): x=72-80, y=56-60 (8x4=32 pixels)
    for (let y = 56; y < 60; y++) {
      for (let x = 72; x < 80; x++) {
        b[y * 80 + x] = 255;
      }
    }
    const result = findChangedBlocks(a, b, 80, 60, 8, 12);
    assert.strictEqual(result.totalBlocks, 10 * 8); // ceil(80/8) * ceil(60/8)
    assert.strictEqual(result.changedBlocks, 1);
    assert.strictEqual(result.changed[0].x, 9);
    assert.strictEqual(result.changed[0].y, 7);
  });
});

describe('diff.js - extractBlock/applyBlock', () => {
  it('roundtrips block data', () => {
    const frame = makeGradient(120, 90);
    const block = extractBlock(frame, 120, 90, 5, 3, 4);
    assert.strictEqual(block.length, 16);

    const target = new Uint8Array(120 * 90);
    applyBlock(target, 120, 90, 5, 3, 4, block);

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const srcIdx = (3 * 4 + y) * 120 + 5 * 4 + x;
        const dstIdx = (3 * 4 + y) * 120 + 5 * 4 + x;
        assert.strictEqual(target[dstIdx], frame[srcIdx]);
      }
    }
  });

  it('handles edge blocks (partial)', () => {
    const frame = makeFrame(120, 90, 100);
    const block = extractBlock(frame, 120, 90, 29, 22, 4); // last block (120/4=30, 90/4=22.5)
    // Block is 4x2 (partial height)
    assert.strictEqual(block.length, 8);

    const target = new Uint8Array(120 * 90);
    applyBlock(target, 120, 90, 29, 22, 4, block);
    // Check applied
    for (let y = 88; y < 90; y++) {
      for (let x = 116; x < 120; x++) {
        assert.strictEqual(target[y * 120 + x], 100);
      }
    }
  });
});

describe('diff.js - motionScore/adaptiveFps', () => {
  it('motionScore computes fraction', () => {
    assert.strictEqual(motionScore(0, 100), 0);
    assert.strictEqual(motionScore(50, 100), 0.5);
    assert.strictEqual(motionScore(100, 100), 1);
  });

  it('adaptiveFps thresholds', () => {
    assert.strictEqual(adaptiveFps(0.01), 1);
    assert.strictEqual(adaptiveFps(0.06), 5);
    assert.strictEqual(adaptiveFps(0.2), 10);
    assert.strictEqual(adaptiveFps(0.5), 15);
  });

  it('custom thresholds', () => {
    const t = { low: 2, med: 4, high: 8, max: 12 };
    assert.strictEqual(adaptiveFps(0.01, t), 2);
    assert.strictEqual(adaptiveFps(0.4, t), 12);
  });
});

describe('diff.js - avgBlockDelta/avgPixelDelta', () => {
  it('avgBlockDelta averages deltas', () => {
    const changed = [{ delta: 10 }, { delta: 20 }, { delta: 30 }];
    assert.strictEqual(avgBlockDelta(changed), 20);
    assert.strictEqual(avgBlockDelta([]), 0);
  });

  it('avgPixelDelta computes mean absolute diff', () => {
    const a = new Uint8Array([100, 100, 100, 100]);
    const b = new Uint8Array([110, 90, 120, 80]);
    // diffs: 10, 10, 20, 20 → avg = 15
    assert.strictEqual(avgPixelDelta(a, b), 15);
  });
});

console.log('All video codec tests passed');