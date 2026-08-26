# Bandwidth Experiments — Low-Net Camera-Differential Video

**Status:** Template — fill in as experiments run
**Companion:** `VIDEO_PROTOCOL.md`, `LOW_NET_MIGRATION.md`, `BANDWIDTH_AVATAR.md`

---

## Experiment Template

Copy this section for each experiment:

```markdown
## Experiment: YYYY-MM-DD — [Short Description]

**Config:**
- Resolution: ___×___
- Target FPS: ___
- Block size: ___×___
- Threshold: ___ (0-255)
- Quantization: 8-bit / 4-bit
- Encoding: Raw / RLE / Bitpack4
- Keyframe interval: ___ s
- Adaptive FPS: on / off

**Conditions:**
- Network: [real throttle / netsim `?net=___`]
- Participants: ___ (local + ___ remote)
- Scene: [talking head / movement / static / busy background]
- Lighting: [good / dim / backlit]
- Duration: ___ s

**Results (from metrics card + manual observation):**

| Metric | Value |
|---|---|
| Avg changed blocks/frame | ___ / ___ (___%) |
| Keyframes sent | ___ |
| Delta frames sent | ___ |
| Frames captured | ___ |
| Frames sent | ___ |
| Frames skipped (below threshold) | ___ |
| Raw payload | ___ KB/s |
| Compressed payload | ___ KB/s |
| Wire bitrate (WS) | ___ kbps |
| Avg bitrate | ___ kbps |
| Peak bitrate | ___ kbps |
| CPU (device) | ___% |
| Memory | ___ MB |
| Motion score (avg) | ___ |
| Avg block delta | ___ |
| Avg pixel delta | ___ |

**Visual Quality Assessment:**
- Face recognizable: ☐ Yes ☐ Partial ☐ No
- Mouth movement visible: ☐ Yes ☐ Partial ☐ No
- Eye movement visible: ☐ Yes ☐ Partial ☐ No
- Head pose readable: ☐ Yes ☐ Partial ☐ No
- Gestures interpretable: ☐ Yes ☐ Partial ☐ No
- Artifacts: [none / blocky / ghosting / flicker / other]

**Notes:**
[Observations, anomalies, background interference, etc.]
```

---

## Planned Test Matrix

| Resolution | FPS | Block | Threshold | Quant | Encoding | Keyframe | Notes |
|---|---|---|---|---|---|---|---|
| 80×60 | 1 | 4×4 | 12 | 8bit | RLE | 2s | Baseline minimum |
| 80×60 | 5 | 4×4 | 12 | 8bit | RLE | 2s | |
| 80×60 | 10 | 4×4 | 12 | 8bit | RLE | 2s | |
| 80×60 | 15 | 4×4 | 12 | 8bit | RLE | 2s | |
| 120×90 | 1 | 4×4 | 12 | 8bit | RLE | 2s | |
| 120×90 | 5 | 4×4 | 12 | 8bit | RLE | 2s | Primary target |
| 120×90 | 10 | 4×4 | 12 | 8bit | RLE | 2s | Primary target |
| 120×90 | 15 | 4×4 | 12 | 8bit | RLE | 2s | |
| 160×120 | 5 | 4×4 | 12 | 8bit | RLE | 2s | |
| 160×120 | 10 | 4×4 | 12 | 8bit | RLE | 2s | |
| 120×90 | 10 | 2×2 | 12 | 8bit | RLE | 2s | More blocks |
| 120×90 | 10 | 8×8 | 12 | 8bit | RLE | 2s | Fewer blocks |
| 120×90 | 10 | 4×4 | 6 | 8bit | RLE | 2s | More sensitive |
| 120×90 | 10 | 4×4 | 24 | 8bit | RLE | 2s | Less sensitive |
| 120×90 | 10 | 4×4 | 12 | 4bit | RLE | 2s | Half payload |
| 120×90 | 10 | 4×4 | 12 | 8bit | Bitpack4 | 2s | 2px/byte |
| 120×90 | 10 | 4×4 | 12 | 8bit | Raw | 2s | No compression |

**Network conditions to test each config:**
- `?net=120k` (target)
- `?net=80k`
- `?net=50k`
- `?net=30k`
- `?net=20k`
- `?net=20k&netlat=200&netloss=5` (adverse)

**Scene variations:**
- Talking head (minimal motion)
- Head movement (yaw/pitch/roll)
- Hand gestures near face
- Busy background (TV, window, people)
- Dim lighting
- Backlit (silhouette)

---

## Results Log

### 2026-08-25 — Initial Baseline (TODO: Run experiments)

| Config | Net | Bitrate | Quality | CPU | Notes |
|---|---|---|---|---|---|
| 120×90, 10fps, 4×4, thresh=12, 8bit, RLE, 2s | 120k | | | | |
| 120×90, 10fps, 4×4, thresh=12, 8bit, RLE, 2s | 80k | | | | |
| 120×90, 10fps, 4×4, thresh=12, 8bit, RLE, 2s | 50k | | | | |
| 120×90, 10fps, 4×4, thresh=12, 8bit, RLE, 2s | 30k | | | | |
| 120×90, 10fps, 4×4, thresh=12, 8bit, RLE, 2s | 20k | | | | |
| 80×60, 10fps, 4×4, thresh=12, 8bit, RLE, 2s | 20k | | | | |
| 120×90, 5fps, 4×4, thresh=12, 8bit, RLE, 2s | 20k | | | | |
| 120×90, 10fps, 4×4, thresh=12, 4bit, RLE, 2s | 20k | | | | |

---

## Comparison: Camera-Differential vs Avatar

| Mode | Bitrate (idle) | Bitrate (talking) | Bitrate (animated) | Visual |
|---|---|---|---|---|
| Avatar (12Hz, default) | 37 B/s | 127 B/s | 152 B/s | Stylized face |
| Camera 80×60@1fps | | | | |
| Camera 80×60@5fps | | | | |
| Camera 80×60@10fps | | | | |
| Camera 120×90@1fps | | | | |
| Camera 120×90@5fps | | | | |
| Camera 120×90@10fps | | | | |
| Camera 160×120@5fps | | | | |
| Camera 160×120@10fps | | | | |

**Target:** Camera mode at ≤50 kbps with recognizable human presence.

---

## Adverse Condition Tests

| Condition | Config | Result | Mitigation |
|---|---|---|---|
| Busy background (TV) | | | |
| Backlit / silhouette | | | |
| Rapid movement | | | |
| Packet loss 5% | | | |
| Latency 300ms | | | |
| Forced disconnect + reconnect | | | |
| Mobile CPU (low-end) | | | |
| Battery saver mode | | | |

---

## Key Findings (Update as Discovered)

1. **[Finding]** — [Evidence]
2. **[Finding]** — [Evidence]
3. **[Finding]** — [Evidence]

---

## Decision Log

| Date | Decision | Rationale | Experiment Ref |
|---|---|---|---|
| | | | |