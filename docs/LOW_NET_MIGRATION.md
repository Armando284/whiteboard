# LOW-NET Migration: Avatar → Ultra-Low-Bandwidth Camera

**Status:** Audit phase — no code changed yet
**Date:** 2026-08-25
**Based on:** `docs/LOW_NET_ARCHITECTURE.md` (implemented phases 1–9), live codebase inspection

---

## 1. CURRENT ARCHITECTURE (AS AUDITED)

### 1.1 Stack Summary

| Component | Implementation |
|---|---|
| **Runtime** | Node.js 24, Express 4.18, `ws` 8.16 |
| **Frontend** | Vanilla JS, ES modules, zero build step, zero framework deps |
| **Deployment** | Vercel Fluid compute (WebSocket support), `server.js` as default export |
| **Tests** | Node `--test` suite: 8 integration + unit tests |
| **Initial payload** | ~15 kB (HTML + CSS + JS + inline SVG icons), no external fonts/images |

### 1.2 Room & WebSocket System

**Server** (`server.js`):
- In-memory `Map<roomId, Room>` — ephemeral, dies on process restart
- Room state: `gen` (generation), `seq` (monotonic per-room), `strokes` (Map), `members` (Map)
- Max 16 members/room, 2000 strokes FIFO, 4096 pts/stroke
- Protocol version gate (`v === 1`), strict sanitizers on all inputs
- Binary relay for avatar frames (tag `0x02` prepended with sender CID)
- WebRTC signaling relay (`rtc`, `rtc_ice`) — server never parses SDP
- Heartbeat: WS ping every 30 s, 1 missed pong → terminate
- Reconnect: exponential backoff (500→8000 ms) + jitter

**Client** (`public/js/net/connection.js`):
- `Connection` class extends `EventTarget`
- Hello handshake → `init` snapshot baseline
- Outbox queue (max 256) flushed after hello on reconnect
- Seq tracking for gap detection → metrics `lostOps`
- RTT probe every 5 s via app-level ping/pong
- Binary frames dispatched separately from JSON

### 1.3 Avatar System (Phase 5–6)

**Pipeline:**
```
Camera (320×240) → MediaPipe FaceLandmarker (WASM, lazy-loaded ~3.7 MB model)
  → 16 blendshapes + 3 angles (yaw/pitch/roll)
  → Quantized to 13-byte binary frame (0x01 + seq + 3×int8 angles + 8×uint8 shapes)
  → PoseThrottle (deadband + keepalive every 400 ms)
  → WebSocket binary send
```

**Wire format** (see `NETWORK_PROTOCOL.md` §8):
- Sender frame: 13 B @ up to 12 Hz default
- Relay frame: server prepends CID, preserves inner tag
- Config frame: 4 B (appearance packed in 3 nibbles)

**Measured bandwidth** (`BANDWIDTH_AVATAR.md`):
| Profile | 12 Hz default | 12 Hz heavy |
|---|---|---|
| Idle (blinks only) | ~37 B/s | ~37 B/s |
| Talking | ~127 B/s | ~108 B/s |
| Animated | ~152 B/s | ~128 B/s |

**Key files:**
- `public/js/avatar/avatar.js` — `FaceTracker` + `AvatarManager` (render, interpolation, dock UI)
- `public/js/avatar/codec.js` — pure encode/decode/relay, Node-testable
- `public/js/avatar/optimize.js` — `PoseThrottle` (deadband policy)
- `public/js/avatar/looks.js` — appearance pack/unpack + vector renderer
- `public/js/ui/avatar-studio.js` — sidebar configurator (lazy-loaded)

### 1.4 Whiteboard System (Phases 2–3)

**State model** (`public/js/whiteboard/store.js`):
- Committed strokes: append-only `Map<id, {id, pts}>`
- Hidden set: live erase preview
- Transient map: remote in-progress strokes (throttled ~11 Hz progress chunks)
- Undo/redo stacks per user (inverse ops broadcast)
- Generation counter on `clear` — prevents stale resurrection

**Rendering** (`public/js/whiteboard/render.js`):
- Base canvas: committed strokes (incremental draw, full repaint only on remove/reset)
- Overlay canvas: local active stroke + remote transient strokes
- Local in-progress stroke lives in render layer ONLY — network never touches it

**Tools** (`public/js/whiteboard/tools.js`):
- Pencil: samples pointer path, streams `progress` chunks, commits on pointer-up
- Eraser: whole-stroke hit-test, live hide preview, batch `erase` op on pointer-up
- Pointer Events unified (mouse/touch/pen), coalesced events supported

### 1.5 Metrics (Phase 3)

**`public/js/net/metrics.js`** — pure accounting, no DOM:
- Per-category bytes: `control`, `presence`, `board`, `avatar`
- Rolling 60×1 s buckets → current/peak/avg rates
- RTT EMA (α=0.2), reconnect count, lost ops, uptime
- `Connection` meters every frame (UTF-8 wire length)

**`public/js/ui/metrics-card.js`** — dynamic import on first open:
- Right-side card: status, room, RTT, msg/s, rates, totals by category
- Audio P2P row (fed by `AudioLink.getStats()` deltas)
- Download JSON report

### 1.6 Audio (Phase 7)

**`public/js/audio/audiolink.js`**:
- Mesh P2P: one `RTCPeerConnection` per remote `audio_on` peer
- STUN only (`stun.l.google.com:19302`), no TURN
- Opus mono, SDP munged to `maxaveragebitrate=12000;usedtx=1;stereo=0`
- Glare-free: lexicographically larger CID creates offer
- `getStats()` polling every 5 s → metrics card "Audio P2P" row
- Signaling rides WS (~6 kB/pair once), media never touches server

### 1.7 Network Simulator (Phase 8)

**`public/js/net/netsim.js`** — client-side WS shim (`?net=30k&netlat=150...`):
- Token bucket up/down independently
- Fixed latency + jitter, random loss (seeded PRNG)
- Periodic forced disconnects
- `Connection` accepts `socketFactory` injection for zero-impact integration

### 1.8 UI Layout (Current)

```
┌─────────────────────────────────────────────────────┐
│ LOW-NET                         ROOM A7K9            │
├─────────────────────────────────────────────────────┤
│ ✏️ 🗑️ ↶ ↷ 🗑  👤 ⚙️ 🎤 📊                           │
├─────────────────────────────────────────────────────┤
│                                                     │
│                  WHITEBOARD (800×600)               │
│                                                     │
│                  [avatar dock: fixed bottom-left]   │
│                                                     │
├─────────────────────────────────────────────────────┤
│ ● CONNECTED    NETWORK — ↑ 1.2 ↓ 0.8 kB/s · RTT 45ms │
└─────────────────────────────────────────────────────┘
```

- Whiteboard is the visual center (maximized, centered)
- Avatar dock: fixed bottom-left, shows local + remote avatars horizontally
- Toolbar: pencil, eraser, undo, redo, clear, avatar toggle, avatar config, audio, stats
- Metrics card: right-side overlay (dynamic import)
- Avatar studio: left-side sidebar (dynamic import)

---

## 2. NEW ARCHITECTURE: CAMERA-DIFFERENTIAL VIDEO

### 2.1 Conceptual Shift

| Old (Whiteboard-first) | New (Camera-first) |
|---|---|
| Whiteboard = primary visual | Remote camera = primary visual (75–85% screen) |
| Avatar = small dock | Camera preview = dominant element |
| Whiteboard tools = main toolbar | Controls = compact bottom bar (mic, cam, notes, net, ⚙) |
| Notes = whiteboard | Notes = sidebar/drawer (15–25% desktop, drawer mobile) |

### 2.2 Target UI Layout

**Desktop:**
```
┌──────────────────────────────────────────────────────┐
│ LOW-NET                         ROOM A7K9             │
├──────────────────────────────────────┬───────────────┤
│                                      │               │
│                                      │   NOTES       │
│                                      │               │
│             REMOTE VIDEO             │   WHITEBOARD  │
│         (object-fit: contain)        │   (sidebar)   │
│                                      │               │
│                                      │               │
│                                      │               │
│                                      │               │
│                               ┌──────┴──────┐       │
│                               │ LOCAL CAM   │       │
│                               │  160×120    │       │
│                               └─────────────┘       │
├──────────────────────────────────────┴───────────────┤
│  🎤  📹  📝  📊  ⚙                                    │
└──────────────────────────────────────────────────────┘
```

**Mobile:**
- Video fills screen
- Notes = bottom drawer / slide-over panel
- Controls = bottom compact bar

### 2.3 Camera Pipeline (Client-Side Only)

```
Camera
  ↓
Capture frame (requestVideoFrameCallback or rAF)
  ↓
Resize to preset (80×60 / 120×90 / 160×120)
  ↓
Grayscale (or 4-bit luminance)
  ↓
Frame difference vs previous
  ↓
Block-based change detection (4×4 or 8×8 blocks)
  ↓
Threshold → changed blocks only
  ↓
Quantization (8-bit → 4-bit optional)
  ↓
Compression (RLE / delta / bit-pack)
  ↓
Binary WebSocket (keyframe + delta frames)
```

**Key principles:**
- NO full JPEG frames continuously
- NO server transcoding
- NO raw camera stream on wire
- Keyframe interval: 1–10 s (measured)
- Sequence numbers for gap detection
- Out-of-order buffer (small, simple)

### 2.4 Video Protocol (Binary)

**Keyframe (full frame):**
```
[0x10] [seq:u16] [timestamp:u32] [w:u8] [h:u8] [blocksX:u8] [blocksY:u8] [payload...]
```

**Delta frame:**
```
[0x11] [seq:u16] [timestamp:u32] [changedBlocks:u16] [block{ x:u8 y:u8 data:Uint8Array }...]
```

**Config/control:**
```
[0x12] [config...]  // resolution, fps, blockSize, threshold
```

Investigate overhead: JSON vs ArrayBuffer vs binary WS. JSON allowed for v1 prototype.

### 2.5 Adaptive Behavior

| Signal | Action |
|---|---|
| High motion (changedBlocks/total > 0.3) | 10–15 FPS |
| Medium motion | 5 FPS |
| Low motion | 2 FPS |
| No motion | 1 FPS (keepalive) |
| Bandwidth pressure (metrics) | Reduce resolution preset |

**Motion score:** `changedBlocks / totalBlocks` — exposed in debug panel.

---

## 3. COMPONENT REUSE ANALYSIS

### 3.1 FULLY REUSABLE (Minimal/No Changes)

| Component | Path | Reason |
|---|---|---|
| WebSocket connection | `public/js/net/connection.js` | Handles hello, reconnect, outbox, binary dispatch, metrics — generic |
| Network metrics | `public/js/net/metrics.js` | Per-category accounting extensible to "video" category |
| Network simulator | `public/js/net/netsim.js` | Token bucket shim works for any binary traffic |
| Protocol envelope | `public/js/net/protocol.js` | Version gate, JSON envelope — extend for video types |
| Server room logic | `server.js` (Room, Member, broadcast) | Presence, join/leave, binary relay — add video frame types |
| AudioLink | `public/js/audio/audiolink.js` | Unchanged — WebRTC P2P separate from video |
| Whiteboard store | `public/js/whiteboard/store.js` | Stroke log, undo/redo, generation — keep for Notes |
| Whiteboard render | `public/js/whiteboard/render.js` | Layered canvas — reuse for Notes sidebar |
| Whiteboard tools | `public/js/whiteboard/tools.js` | Pencil/eraser — reuse for Notes |
| Identity | `public/js/net/identity.js` | UID/salt generation — unchanged |
| PresenceBar | `public/js/ui/presence.js` | Room/UID chips, connection dot — keep in top bar |
| MetricsCard | `public/js/ui/metrics-card.js` | Add video metrics rows, keep download JSON |

### 3.2 MODERATE MODIFICATIONS

| Component | Changes Needed |
|---|---|
| `server.js` | Add video frame relay (binary tag 0x10/0x11/0x12), keyframe tracking per member, rate limits |
| `public/js/net/connection.js` | Add video category to metrics, handle binary video frames dispatch |
| `public/js/net/metrics.js` | Add `video` category, new snapshot fields (resolution, fps, blocks, bitrate) |
| `public/js/ui/metrics-card.js` | Add video section: resolution, FPS target/actual, keyframes, deltas, blocks, raw/compressed/net bitrate |
| `public/js/ui/toolbar.js` | Replace avatar/audio buttons with new compact controls (mic, cam, notes, net, settings) |
| `public/index.html` | Restructure layout: video container + notes sidebar + bottom bar |
| `public/style.css` | New layout: video-dominant, sidebar, drawer mobile, compact bottom bar |

### 3.3 NEW COMPONENTS (To Create)

| Component | Path | Description |
|---|---|---|
| Camera capture + processing | `public/js/video/capture.js` | `getUserMedia`, resize, grayscale, frame callback |
| Frame differencing | `public/js/video/diff.js` | Block-based diff, threshold, changed block detection |
| Quantization + encoding | `public/js/video/encode.js` | 8/4-bit quantization, RLE/delta/bit-pack, keyframe/delta logic |
| Decoder + renderer | `public/js/video/decode.js` | Reconstruct frame from keyframe + deltas, handle seq gaps, OOO buffer |
| Video manager | `public/js/video/manager.js` | Orchestrates pipeline, adaptive FPS/resolution, debug config |
| Video UI | `public/js/ui/video.js` | Remote video element (object-fit: contain), local preview overlay |
| Debug panel | `public/js/ui/debug-panel.js` | Resolution/FPS/block/threshold selectors + live metrics |
| Notes sidebar/drawer | `public/js/ui/notes.js` | Whiteboard embedded in sidebar (desktop) or drawer (mobile) |

### 3.4 PRESERVED AS EXPERIMENTAL/FALLBACK

| Component | Path | Role in New Architecture |
|---|---|---|
| AvatarManager | `public/js/avatar/avatar.js` | **Keep** — "Avatar Semantic Mode" for comparison |
| Avatar codec | `public/js/avatar/codec.js` | Keep — baseline for bandwidth comparison |
| Avatar studio | `public/js/ui/avatar-studio.js` | Keep — accessible via debug panel |
| FaceTracker | `public/js/avatar/avatar.js` | Keep — loads lazily only when Avatar mode enabled |

**Debug mode toggle:**
```
VIDEO MODE:  ○ Camera Differential   ○ Avatar Semantic
```
Shows side-by-side bandwidth: "Camera: 34 kbps | Avatar: 127 B/s"

---

## 4. COMPONENTS TO ELIMINATE / DEPRECATE

| Component | Action | Rationale |
|---|---|---|
| Avatar dock (fixed bottom-left) | Remove from default UI | Replaced by local camera preview in video area |
| Avatar toolbar button (👤) | Replace with Camera toggle (📹) | Camera is now primary |
| Full-screen whiteboard as center | Demote to sidebar/drawer | Notes are secondary tool |
| `avatar_off` message type | Keep for backward compat | Peers may still run old code briefly |

**Note:** No deletion of avatar *code* — only UI demotion. The avatar pipeline remains loadable for comparison.

---

## 5. DEPENDENCY & BUNDLE ANALYSIS

### 5.1 Current Initial Load (Measured)

| Asset | Size | Notes |
|---|---|---|
| `index.html` | ~3 kB | Inline SVG icons |
| `style.css` | ~4 kB | No external fonts |
| `main.js` | ~8 kB | Imports net/connection, store, render, tools, toolbar, presence |
| **Lazy-loaded (on demand)** | | |
| `metrics-card.js` | ~6 kB | Only when stats opened / `?debug=1` |
| `avatar/avatar.js` | ~12 kB | Only when avatar toggled |
| `avatar/codec.js` | ~4 kB | With avatar |
| `avatar/looks.js` | ~8 kB | With avatar |
| `avatar/optimize.js` | ~2 kB | With avatar |
| `avatar-studio.js` | ~5 kB | When configure clicked |
| `audiolink.js` | ~8 kB | When audio toggled |
| **MediaPipe (on avatar enable)** | ~3.7 MB + WASM | CDN (`jsdelivr`), cached, user-triggered |

**Total initial JS:** ~8 kB (gzipped ~2.5 kB) — excellent for low-bandwidth.

### 5.2 New Video Pipeline Dependencies

**Target: Zero new external dependencies.**
- All video processing: Canvas 2D API, `ImageData`, `Uint8Array` — browser native
- Compression: Custom RLE/delta/bit-pack — pure JS
- Optional future: OffscreenCanvas, Web Workers, WASM — only if CPU proves insufficient

**New initial load cost:** ~0 (video modules lazy-loaded on camera enable, like avatar).

---

## 6. RISKS

| Risk | Severity | Mitigation |
|---|---|---|
| **CPU on mobile** — block diff + encode at 10–15 FPS may exceed budget | High | Start with 80×60 @ 5 FPS; measure `performance.now()` per frame; add OffscreenCanvas + Worker only if needed |
| **Dynamic backgrounds** (TV, window, people) → high changedBlocks → bitrate spike | High | Measure first (motion score metric); document; future: background segmentation (MediaPipe Selfie) only if data demands |
| **Keyframe loss** → visual corruption until next keyframe | Medium | Short keyframe interval (1–2 s default); seq gap detection → request keyframe (optional) |
| **Out-of-order frames** → decoder complexity | Medium | Small reorder buffer (hold 2–3 frames); drop stale; simple |
| **WebSocket binary overhead** (framing, masking) | Low | Measure raw vs wire; if significant, investigate binary WS extensions |
| **Vercel 300 s disconnect** → keyframe loss on reconnect | Medium | Resync = new keyframe on hello; already standard path |
| **Camera permission denied** → app must still work | Medium | Graceful fallback: show "Camera unavailable", keep Notes + Avatar + Audio |
| **Audio + video sync** | Low | Separate pipelines (WebRTC vs WS); no sync attempt in MVP |
| **Initial load regression** | Low | Video modules lazy-loaded; measure bundle before/after |

---

## 7. MIGRATION PLAN (Incremental)

### Phase A: Audit & Scaffolding (This Document)
- ✅ Document current architecture
- ✅ Define new architecture
- ✅ Create `docs/LOW_NET_MIGRATION.md`
- Create `docs/VIDEO_PROTOCOL.md` (wire format spec)
- Create `docs/BANDWIDTH_EXPERIMENTS.md` (template for measurements)

### Phase B: Camera Pipeline Core (No UI Yet)
1. **`public/js/video/capture.js`** — `getUserMedia` → resize → grayscale → `ImageData` frames
2. **`public/js/video/diff.js`** — block diff (configurable block size), threshold, changed blocks
3. **`public/js/video/encode.js`** — keyframe (full), delta (changed blocks), quantization, simple RLE
4. **`public/js/video/decode.js`** — reconstruct, seq tracking, OOO buffer, keyframe reset
5. **`public/js/video/manager.js`** — orchestrates, adaptive FPS, exposes debug config
6. **Unit tests** — `tests/video-codec.test.mjs`: roundtrip, keyframe/delta, seq gaps, corruption

### Phase C: Network Integration
1. **Server** — add video binary relay (tags 0x10/0x11/0x12), per-member keyframe timer, rate limit
2. **Connection** — add `video` metric category, dispatch video binary frames
3. **Metrics** — extend snapshot with video fields (see §20 in requirements)
4. **Protocol doc** — update `NETWORK_PROTOCOL.md` with video frame types

### Phase D: UI — Video-First Layout
1. **`public/index.html`** — restructure: video container + notes sidebar + bottom bar
2. **`public/style.css`** — new layout, video-dominant, responsive sidebar/drawer
3. **`public/js/ui/video.js`** — remote `<video>`/`<canvas>` renderer (object-fit: contain), local preview overlay
4. **`public/js/ui/debug-panel.js`** — resolution/FPS/block/threshold controls + live metrics
5. **`public/js/ui/notes.js`** — embed whiteboard in sidebar (desktop) / drawer (mobile)
5. **Toolbar** — replace with compact: 🎤 📹 📝 📊 ⚙

### Phase E: Avatar Preservation & Comparison
1. Keep avatar code unchanged
2. Add debug toggle: "Video Mode: Camera Differential / Avatar Semantic"
3. Metrics card shows both bandwidths side-by-side
4. Document comparison in `BANDWIDTH_EXPERIMENTS.md`

### Phase F: Experimentation & Measurement
1. **Test matrix** (per requirements §35):
   - Resolutions: 80×60, 120×90, 160×120
   - FPS: 1, 5, 10, 15
   - Block sizes: 2×2, 4×4, 8×8
   - Thresholds: multiple
2. Record: avg bitrate, peak bitrate, visual quality (subjective), CPU, memory
3. Test under `?net=20k&netlat=200&netloss=5` (simulated 20 kbps)
4. Test real: throttle to 120/80/50/30/20 kbps

### Phase G: Polish & Documentation
1. `docs/VIDEO_PROTOCOL.md` — final wire format
2. `docs/BANDWIDTH_EXPERIMENTS.md` — real measurements table
3. `docs/PERFORMANCE.md` — CPU, memory, load times
4. Update `README.md` with new concept

---

## 8. FILE LAYOUT (Post-Migration)

```
/home/armando/trabajo/freelance/whiteboard/
├── server.js
├── package.json
├── public/
│   ├── index.html
│   ├── style.css
│   └── js/
│       ├── main.js
│       ├── net/
│       │   ├── connection.js
│       │   ├── protocol.js
│       │   ├── metrics.js
│       │   ├── netsim.js
│       │   └── identity.js
│       ├── whiteboard/         → renamed to notes/
│       │   ├── store.js
│       │   ├── render.js
│       │   └── tools.js
│       ├── video/              ← NEW
│       │   ├── capture.js
│       │   ├── diff.js
│       │   ├── encode.js
│       │   ├── decode.js
│       │   └── manager.js
│       ├── avatar/             ← PRESERVED (experimental)
│       │   ├── avatar.js
│       │   ├── codec.js
│       │   ├── looks.js
│       │   └── optimize.js
│       ├── audio/
│       │   └── audiolink.js
│       └── ui/
│           ├── toolbar.js
│           ├── presence.js
│           ├── metrics-card.js
│           ├── avatar-studio.js
│           ├── video.js        ← NEW
│           ├── debug-panel.js  ← NEW
│           └── notes.js        ← NEW (wraps whiteboard)
├── tests/
│   ├── video-codec.test.mjs    ← NEW
│   ├── bench-video.mjs         ← NEW
│   └── ...existing tests
└── docs/
    ├── LOW_NET_MIGRATION.md    ← THIS FILE
    ├── VIDEO_PROTOCOL.md       ← NEW
    ├── BANDWIDTH_EXPERIMENTS.md ← NEW
    ├── PERFORMANCE.md          ← NEW
    ├── LOW_NET_ARCHITECTURE.md
    ├── NETWORK_PROTOCOL.md
    ├── BANDWIDTH_REPORT.md
    ├── BANDWIDTH_AVATAR.md
    ├── BANDWIDTH_AUDIO.md
    └── VERCEL_LIMITATIONS.md
```

---

## 9. SUCCESS CRITERIA (From Requirements §43)

1. ✅ Room entry immediate (already true)
2. 🔲 Video/camera is visual focus (new layout)
3. 🔲 Whiteboard → Notes sidebar/drawer
4. 🔲 Camera processed locally (new pipeline)
5. 🔲 Resolution reduction (80×60 / 120×90 / 160×120 presets)
6. 🔲 FPS reduction (1/5/10/15 presets + adaptive)
7. 🔲 Block-based change detection
8. 🔲 Send only changed blocks
9. 🔲 Keyframe + delta frames
10. 🔲 Compact binary payloads
11. 🔲 Exact bitrate measurement (metrics)
12. ✅ Avatar preserved as experimental mode
13. ✅ WebSocket remains data channel
14. ✅ Audio separate (WebRTC)
15. ✅ Deployable on Vercel (no infra changes)
16. ✅ No external services
17. 🔲 Testable at 20–120 kbps (netsim + real throttle)
18. ✅ Initial load stays tiny (lazy-load video modules)

---

## 10. MEASUREMENT TEMPLATE (for `BANDWIDTH_EXPERIMENTS.md`)

```markdown
## Experiment: 2026-08-XX

Config:
- Resolution: 120×90
- FPS target: 10
- Block size: 4×4
- Threshold: 12 (0-255 grayscale)
- Keyframe interval: 2 s
- Quantization: 8-bit grayscale
- Compression: RLE per block

Results (60 s session, 2 participants, moderate motion):
| Metric | Value |
|---|---|
| Avg changed blocks/frame | 32 / 675 (4.7%) |
| Keyframes sent | 30 |
| Delta frames sent | 570 |
| Raw payload | 52 KB/s |
| Compressed payload | 8 KB/s |
| Wire bitrate (WS) | 64 kbps |
| CPU (mobile Chrome) | 18% |
| Memory | 12 MB |
| Visual quality | Recognizable face, mouth movement visible |

Notes:
- Background TV caused spikes to 120 kbps
- 4-bit quantization reduced compressed to 5 KB/s but artifacts visible
```

---

## 11. GUIDING PRINCIPLE

> **This project does not merely "make low-res video."**
>
> It experiments with a new video representation:
>
> ```
> Traditional:    pixels → pixels → pixels → pixels
> Low-Net:        initial state + what changed + what changed + what changed
> ```
>
> **Primary metric:**
> ```
> PERCEIVED HUMAN PRESENCE
> ────────────────────────
>      BANDWIDTH USED
> ```
>
> Not minimal bytes — best human experience per reasonable byte.

---

## 12. NEXT IMMEDIATE ACTION

**Start Phase B:** Create `public/js/video/capture.js` with:
- `getUserMedia({video: {width: 160, height: 120, facingMode: 'user'}})`
- `requestVideoFrameCallback` (or rAF fallback) → `ImageData`
- Resize to target preset via `drawImage` on OffscreenCanvas
- Grayscale conversion: `Y = 0.299R + 0.587G + 0.114B` → `Uint8Array`
- Export pure function: `captureFrame(video, targetW, targetH) → Uint8Array`

Then `diff.js`, `encode.js`, `decode.js` as pure functions — testable in Node.