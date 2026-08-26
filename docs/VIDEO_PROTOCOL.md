# VIDEO_PROTOCOL.md — Low-Net Camera-Differential Wire Protocol v1

**Status:** Design phase — not yet implemented
**Companion:** `NETWORK_PROTOCOL.md` (control plane), `LOW_NET_MIGRATION.md` (architecture)

---

## 1. Design Principles

1. **Client-side only processing** — server relays, never transcodes
2. **Binary frames over WebSocket** — same transport as avatar (tag-based)
3. **Keyframe + delta** — self-healing without retransmit requests
4. **Sequence numbers** — gap detection, out-of-order handling
5. **Configurable presets** — resolution, FPS, block size, threshold via debug panel
6. **Measurable** — every byte accounted in metrics

---

## 2. Transport

- WebSocket binary frames (`socket.binaryType = 'arraybuffer'`)
- Server validates tag + length, relays to room peers (except sender)
- Rate limit: max 1 keyframe/s per sender, max 30 delta frames/s
- Max frame size: 16 KB (enforced by server + client)

---

## 3. Frame Types (Tag Byte)

| Tag | Name | Direction | Description |
|---|---|---|---|
| `0x10` | `VIDEO_KEYFRAME` | Client→Server→Peers | Full compressed frame |
| `0x11` | `VIDEO_DELTA` | Client→Server→Peers | Changed blocks only |
| `0x12` | `VIDEO_CONFIG` | Client→Server→Peers | Sender capabilities / preset |
| `0x13` | `VIDEO_KEYFRAME_REQ` | Client→Server→Sender | Request keyframe (optional) |
| `0x14` | `VIDEO_ACK` | Peer→Sender | Received seq (optional, for stats) |

**Relay format** (server prepends, like avatar `0x02`):
```
[0x20] [cidLen:u8] [cid:ascii] [innerFrame...]
```
Inner frame preserves original tag (`0x10`, `0x11`, `0x12`).

---

## 4. Keyframe (0x10) — Full Frame

```
Offset  Size  Field
0       1     tag = 0x10
1-2     2     seq (u16, big-endian, wraps at 65535)
3-6     4     timestamp (u32 ms, performance.now() origin)
7       1     widthBlocks (u8)  — e.g., 30 for 120×90 @ 4×4
8       1     heightBlocks (u8) — e.g., 22 for 120×90 @ 4×4
9       1     blockSize (u8)    — 2, 4, or 8
10      1     encoding (u8)     — 0=raw, 1=RLE, 2=bitpack4
11      1     quantization (u8) — 0=8bit, 1=4bit
12      2     payloadLen (u16)
14...   N     payload (Uint8Array)
```

**Payload encoding (per block, row-major):**
- `encoding=0` (raw): `widthBlocks × heightBlocks` bytes (8-bit) or nibbles (4-bit)
- `encoding=1` (RLE): `[runLen:u8][value:u8]...` — runLen 1-255, value 0-255/15
- `encoding=2` (bitpack4): 2 pixels per byte (high nibble, low nibble)

**Keyframe interval:** configurable 1–10 s (default 2 s). Also sent on:
- Stream start
- Resolution/FPS/blockSize change
- Peer request (`0x13`)

---

## 5. Delta Frame (0x11) — Changed Blocks Only

```
Offset  Size  Field
0       1     tag = 0x11
1-2     2     seq (u16)
3-6     4     timestamp (u32 ms)
7-8     2     changedCount (u16)
9...    N     blocks[] (variable)
```

**Per-block entry:**
```
Offset  Size  Field
0       1     blockX (u8)
1       1     blockY (u8)
2       1     encoding (u8)  — same scheme as keyframe
3       2     blockLen (u16)
5...    N     blockData
```

**Change detection:** sender computes `abs(currentBlock - previousBlock)` per pixel, averages over block. If `avgDelta >= threshold`, block is "changed."

**Threshold:** 0-255 (8-bit) or 0-15 (4-bit). Configurable via debug panel.

---

## 6. Config Frame (0x12) — Sender Capabilities

Sent on stream start and when preset changes.

```
Offset  Size  Field
0       1     tag = 0x12
1       1     width (u8)  — 80, 120, 160
2       1     height (u8) — 60, 90, 120
3       1     targetFPS (u8) — 1, 5, 10, 15
4       1     blockSize (u8) — 2, 4, 8
5       1     threshold (u8) — 0-255
6       1     keyframeIntervalSec (u8) — 1-10
7       1     quantization (u8) — 0=8bit, 1=4bit
8       1     encoding (u8) — 0=raw, 1=RLE, 2=bitpack4
```

Peers use this to allocate decode buffers.

---

## 7. Sequence Numbers & Gap Handling

- `seq` increments per frame (keyframe or delta), uint16 wraparound
- Receiver tracks `lastSeq`
- On gap (`seq > lastSeq + 1`):
  - Count `gap = seq - lastSeq - 1` → metrics `videoLostFrames`
  - If missing frames include a keyframe (heuristic: gap > 5 or time since last keyframe > interval×2):
    - Send `VIDEO_KEYFRAME_REQ` (0x13) to sender via server
  - Otherwise: hold out-of-order frames in small buffer (max 3), process when contiguous
- Keyframe resets decoder state — always process immediately

---

## 8. Out-of-Order Buffer

```
Buffer: Map<seq, Frame>  // max 3 entries
On receive frame:
  if seq === expectedSeq:
    process()
    expectedSeq++
    while buffer.has(expectedSeq):
      process(buffer.get(expectedSeq))
      buffer.delete(expectedSeq)
      expectedSeq++
  else if seq > expectedSeq and buffer.size < 3:
    buffer.set(seq, frame)
  else:
    drop (too far ahead or buffer full)
```

Simple, bounded, no complex reassembly.

---

## 9. Decoder State Machine

```
State: WAITING_FOR_KEYFRAME
  On KEYFRAME → decode full → state = DECODING_DELTAS, lastKeyframeSeq = seq

State: DECODING_DELTAS
  On DELTA (seq == expected) → apply to current frame → render
  On DELTA (gap) → buffer or request keyframe
  On KEYFRAME → decode full (reset) → lastKeyframeSeq = seq
  On seq gap > threshold → state = WAITING_FOR_KEYFRAME
```

**Frame reconstruction:**
- Maintain `currentFrame: Uint8Array[widthBlocks × heightBlocks]`
- Keyframe: full overwrite
- Delta: for each changed block, overwrite block region in `currentFrame`
- Render: upscale `currentFrame` to display size (CSS `object-fit: contain`)

---

## 10. Adaptive Behavior (Sender-Side)

**Motion score:** `changedBlocks / totalBlocks` per frame

| Motion Score | Target FPS | Action |
|---|---|---|
| > 0.30 | 15 | High motion |
| 0.15–0.30 | 10 | Default |
| 0.05–0.15 | 5 | Low motion |
| < 0.05 | 1 | Near-static (keepalive) |

**Bandwidth pressure** (from metrics `upBps`):
- If `upBps > target * 0.8` for 5 s → drop preset (160→120→80)
- If `upBps < target * 0.3` for 10 s → raise preset

**Config change** → send new `VIDEO_CONFIG` (0x12) + force keyframe.

---

## 11. Metrics (Extension of `NetworkMetrics`)

Add `video` category. Snapshot includes:

```typescript
video: {
  // Config
  resolution: "120×90",
  targetFPS: 10,
  blockSize: 4,
  threshold: 12,
  quantization: "8bit",
  encoding: "RLE",
  keyframeIntervalSec: 2,

  // Counters
  framesCaptured: 600,
  framesSent: 580,
  framesSkipped: 20,          // below threshold
  keyframesSent: 30,
  deltaFramesSent: 550,
  keyframesReceived: 29,
  deltaFramesReceived: 540,
  seqGaps: 2,
  keyframeRequests: 1,

  // Block stats
  totalBlocksPerFrame: 675,
  avgChangedBlocks: 31.4,
  maxChangedBlocks: 180,
  changedBlockPct: 4.6,

  // Byte accounting
  rawBytesPerSec: 52000,      // uncompressed changed blocks
  compressedBytesPerSec: 8200, // after RLE/bitpack
  wireBytesPerSec: 9100,      // actual WS send (includes framing)
  avgBitrateKbps: 73,
  peakBitrateKbps: 145,

  // Quality
  motionScore: 0.046,
  avgBlockDelta: 18.2,        // 0-255
  avgPixelDelta: 4.1,         // 0-255
}
```

---

## 12. Debug Panel Controls (Live)

```
Resolution:     [80×60] [120×90] [160×120]     (sends VIDEO_CONFIG + keyframe)
FPS:            [1] [5] [10] [15]               (target, adaptive may lower)
Block Size:     [2×2] [4×4] [8×8]               (sends VIDEO_CONFIG + keyframe)
Threshold:      [slider 0-255]                  (live, no keyframe needed)
Quantization:   [8-bit] [4-bit]                 (sends VIDEO_CONFIG + keyframe)
Encoding:       [Raw] [RLE] [Bitpack4]          (sends VIDEO_CONFIG + keyframe)
Keyframe Int:   [1s] [2s] [5s] [10s]            (live)

Live Metrics:
  Bitrate:      ↑ 73 kbps  (avg 68, peak 145)
  FPS:          9.7 / 10
  Blocks:       31/675 changed (4.6%)
  Motion:       0.046
  CPU:          12% (processing)
```

---

## 13. Error Handling

| Error | Detection | Recovery |
|---|---|---|
| Malformed frame (bad tag/len) | Decode returns null | Drop, increment `videoCorruptFrames` |
| Payload too large (>16 KB) | Server validates | Drop, sender gets no ack |
| Decoder OOM | Buffer allocation fails | Reset to WAITING_FOR_KEYFRAME |
| Seq wraparound confusion | `seq` uint16, gap > 32768 = wraparound | Treat as gap, request keyframe |
| Unsupported config | Peer receives unknown encoding/quant | Send `VIDEO_KEYFRAME_REQ`, fallback to raw 8-bit |

---

## 14. Privacy

- Camera frames **never leave the device**
- Only quantized, differenced, compressed block data transmitted
- No facial landmarks, no raw pixels, no audio on this channel
- Server sees only opaque binary blobs (relays blindly)

---

## 15. Example Wire Dump (Hex)

**Keyframe (120×90, 4×4 blocks = 30×22 = 660 blocks, RLE, 8-bit):**
```
10 00 01  00 00 12 34  1E 16 04 01 00  02 94
[RLE payload: 660 bytes raw → ~200 bytes RLE]
```
`0x0001` = seq 1, `0x00001234` = timestamp 4660 ms, `0x1E`=30, `0x16`=22, `0x04`=blockSize 4, `0x01`=RLE, `0x00`=8bit, `0x0294`=660 bytes payload

**Delta (5 changed blocks):**
```
11 00 02  00 00 12 3A  00 05
  0A 05 01 00 02  12 34 56 78 9A
  0F 10 01 00 01  00
  ...
```
`seq=2`, `ts=4666`, `changed=5`, block(10,5) RLE 2 bytes, block(15,16) raw 1 byte...

---

## 16. Versioning

- Protocol version in JSON envelope `v: 1` (unchanged)
- Binary video tags `0x10-0x14` are new in v1 — unknown tags ignored by peers
- Breaking changes to binary format → new tag range (`0x30+`) or `v: 2` envelope

---

## 17. Open Questions (To Resolve in Phase B)

1. **RLE vs bitpack4** — benchmark both on real camera noise
2. **Threshold units** — 8-bit delta (0-255) or normalized (0-1)?
3. **Keyframe request** — server-relayed (adds RTT) or direct P2P? (Start with server)
4. **Block size vs resolution** — 80×60 @ 2×2 = 1200 blocks; 160×120 @ 8×8 = 300 blocks — measure
5. **Chroma** — grayscale first; 4:2:0 subsampled chroma later if needed