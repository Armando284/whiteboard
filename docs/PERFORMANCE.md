# Performance — Low-Net Camera-Differential Video

**Status:** Template — fill in as measurements are taken

---

## 1. Initial Load Performance (Critical for Low-Bandwidth Users)

### Current Baseline (Pre-Migration)

| Asset | Size (raw) | Size (gzipped) | Load Time @ 20 kbps |
|---|---|---|---|
| `index.html` | ~3 kB | ~1 kB | ~0.4 s |
| `style.css` | ~4 kB | ~1.2 kB | ~0.5 s |
| `main.js` | ~8 kB | ~2.5 kB | ~1 s |
| **Total initial** | **~15 kB** | **~4.7 kB** | **~1.9 s** |
| Lazy: `metrics-card.js` | ~6 kB | ~2 kB | on demand |
| Lazy: `avatar/*` | ~26 kB | ~8 kB | on avatar enable |
| Lazy: `audiolink.js` | ~8 kB | ~2.5 kB | on audio enable |
| MediaPipe model | ~3.7 MB | — | **~25 min @ 20 kbps** (user-triggered, cached) |

**Target Post-Migration:** Initial load ≤ 20 kB raw (≤ 6 kB gzipped), video modules lazy-loaded like avatar.

### Measurement Method

```bash
# Chrome DevTools → Network → Disable cache → Throttle to 20 kbps
# Record: DOMContentLoaded, Load, JS parse/exec time
# Lighthouse: Performance score
```

---

## 2. Runtime CPU Performance

### Measurement Points (per frame)

| Stage | Metric | Target |
|---|---|---|
| `captureFrame()` | ms | < 2 ms |
| `resize + grayscale()` | ms | < 3 ms |
| `diffBlocks()` | ms | < 5 ms |
| `encodeBlocks()` | ms | < 4 ms |
| `sendBinary()` | ms | < 1 ms |
| **Total encode path** | **ms** | **< 15 ms** (66 fps budget) |
| `decodeFrame()` | ms | < 3 ms |
| `upscale + render()` | ms | < 4 ms |
| **Total decode path** | **ms** | **< 7 ms** |

### Profiling Method

```javascript
// In video/manager.js
const t0 = performance.now();
// ... capture
const t1 = performance.now();
// ... diff
const t2 = performance.now();
// ... encode
const t3 = performance.now();
// ... send
const t4 = performance.now();

console.log(`capture:${t1-t0} diff:${t2-t1} encode:${t3-t2} send:${t4-t3} total:${t4-t0}`);
```

**Devices to test:**
- Desktop Chrome (baseline)
- Mobile Chrome (Android mid-range, e.g., Snapdragon 7xx)
- Mobile Safari (iOS, iPhone SE / 12 / 15)
- Low-end Android (Go edition, 1-2 GB RAM)

---

## 3. Memory Profile

| Component | Expected | Measured |
|---|---|---|
| Capture canvas (160×120) | ~77 kB | |
| Previous frame buffer | ~77 kB | |
| Current frame buffer | ~77 kB | |
| Block diff buffers | ~20 kB | |
| Encode output buffer | ~16 kB | |
| Decoder frame buffer | ~77 kB | |
| OOO buffer (3 frames) | ~230 kB | |
| **Total video** | **~650 kB** | |
| Whiteboard (existing) | ~2 MB | |
| Avatar (if loaded) | ~5 MB | |
| **Total app** | **< 10 MB** | |

---

## 4. Battery / Power Impact

### Measurement

- Chrome DevTools → Performance → "Capture screenshots" + "Web Vitals"
- Android: `adb shell dumpsys batterystats` before/after 10 min session
- iOS: Xcode Instruments → Energy Log

### Targets

| Scenario | CPU % (avg) | Battery drain / hour |
|---|---|---|
| Idle (camera on, no motion) | < 5% | < 5% |
| Talking (moderate motion) | < 15% | < 10% |
| Active movement | < 25% | < 15% |
| Background (tab hidden) | ~0% (camera off) | negligible |

**Policy:** Stop camera capture when tab hidden (`document.hidden`), resume on visible.

---

## 5. Network Efficiency

### Overhead Breakdown (per frame)

| Layer | Overhead | Notes |
|---|---|---|
| WebSocket framing | 2-14 bytes/frame | Masking (client→server) |
| Protocol tag + seq + ts | 7 bytes | Fixed |
| Keyframe header | 12 bytes | + payload |
| Delta header | 9 bytes | + per-block headers (5 bytes each) |
| **Total per delta (10 blocks)** | ~64 bytes | vs ~660 raw |

### Compression Ratios (Target)

| Content | Raw | RLE | Bitpack4 | Ratio (RLE) |
|---|---|---|---|---|
| Static background | 660 B | ~50 B | 330 B | 13× |
| Talking head | 660 B | ~200 B | 330 B | 3× |
| Active movement | 660 B | ~400 B | 330 B | 1.6× |
| Noise (dim light) | 660 B | ~500 B | 330 B | 1.3× |

---

## 6. Scalability (Per Room)

| Members | Upstream (sender) | Downstream (per peer) | Server relay CPU |
|---|---|---|---|
| 2 | 1× bitrate | 1× bitrate | negligible |
| 4 | 1× bitrate | 3× bitrate | negligible |
| 8 | 1× bitrate | 7× bitrate | low |
| 16 (max) | 1× bitrate | 15× bitrate | moderate |

**Note:** Server does no transcoding — pure binary relay. CPU scales with message rate, not payload size.

---

## 7. Regression Tests (Automated)

### Benchmark Script: `tests/bench-video.mjs`

```javascript
// Run: node tests/bench-video.mjs
// Output: JSON with timings for each stage
// CI: fail if total encode > 15 ms on reference hardware
```

### Test Cases

| Test | Assertion |
|---|---|
| Identical frames | `changedBlocks === 0`, delta payload minimal |
| One changed block | `changedBlocks === 1`, block data correct |
| Full frame change | `changedBlocks === totalBlocks`, keyframe triggered |
| Roundtrip | `decode(encode(frame)) ≈ frame` (within quantization) |
| Seq gap | Decoder requests keyframe after gap > threshold |
| OOO delivery | Frames processed in order despite arrival order |
| Malformed payload | Decoder returns null, no crash |
| Config change mid-stream | New keyframe sent, decoder resets cleanly |

---

## 8. Load Time Budget (Per Requirement §29)

| Phase | Budget | Strategy |
|---|---|---|
| HTML + CSS + main.js | < 2 s @ 20 kbps | Already ~1.9 s |
| Camera enable → first frame | < 3 s | Lazy-load video modules in parallel with getUserMedia |
| Video modules JS | < 20 kB gzipped | Keep pure, no deps |
| First keyframe received | < 5 s @ 20 kbps | Small keyframe (80×60 @ 4×4 RLE ≈ 200 B) |

---

## 9. Memory Leak Detection

### Long-Run Test (30 min)

```javascript
// In console every 60 s:
console.log(performance.memory.usedJSHeapSize / 1024 / 1024, 'MB');
```

**Pass criteria:** Heap growth < 10 MB over 30 min (excluding normal GC variance).

### Common Leak Sources to Audit

- `requestAnimationFrame` not cancelled on stop
- `OffscreenCanvas` not released
- `Uint8Array` buffers accumulated in OOO buffer
- Event listeners not removed on teardown
- `MediaStream` tracks not stopped

---

## 10. Device Compatibility Matrix

| Device | Camera | getUserMedia | OffscreenCanvas | Web Workers | WASM | Notes |
|---|---|---|---|---|---|---|
| Chrome Desktop | ✅ | ✅ | ✅ | ✅ | ✅ | Baseline |
| Firefox Desktop | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Safari Desktop | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Chrome Android | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Firefox Android | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Safari iOS | ✅ | ✅ | ⚠️ | ✅ | ✅ | OffscreenCanvas behind flag |
| Samsung Internet | ✅ | ✅ | ✅ | ✅ | ✅ | |
| Edge | ✅ | ✅ | ✅ | ✅ | ✅ | |

**Fallback:** If OffscreenCanvas unavailable → main thread Canvas (measure CPU).

---

## 11. Performance Checklist (Per Release)

- [ ] Initial load ≤ 20 kB raw
- [ ] Camera enable → first frame < 3 s
- [ ] Encode path < 15 ms/frame (1080p desktop), < 30 ms (mobile)
- [ ] Decode path < 7 ms/frame
- [ ] Memory < 10 MB total
- [ ] No leaks over 30 min
- [ ] Battery drain < 10%/hour (talking)
- [ ] Works at 20 kbps (netsim)
- [ ] Graceful degradation: tab hidden → camera off
- [ ] Graceful degradation: CPU high → drop FPS/resolution

---

## 12. Profiling Artifacts (To Collect)

| Artifact | Location | When |
|---|---|---|
| Chrome trace (encode) | `traces/encode-<config>.json` | Each config |
| Chrome trace (decode) | `traces/decode-<config>.json` | Each config |
| Mobile Safari trace | `traces/ios-<config>.json` | Each config |
| Memory timeline | `traces/memory-30min.json` | Long-run |
| Battery stats | `battery/<device>-<config>.txt` | 10 min sessions |

---

## 13. Current Measurements (Fill In)

| Metric | Desktop Chrome | Mobile Chrome | Mobile Safari | Low-end Android |
|---|---|---|---|---|
| Initial load (20 kbps) | | | | |
| Camera enable latency | | | | |
| Encode time (120×90) | | | | |
| Decode time (120×90) | | | | |
| Memory (steady) | | | | |
| CPU % (talking) | | | | |
| Battery %/hr | | | | |
| Max room size tested | | | | |