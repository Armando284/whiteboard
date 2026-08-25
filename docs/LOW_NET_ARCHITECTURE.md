# Low-Net Architecture

> **Status:** Phase 1 — Audit deliverable. No code has been changed yet.
> **Date:** 2026-08-24
> **Companion docs:** [`VERCEL_LIMITATIONS.md`](./VERCEL_LIMITATIONS.md) (platform limits, classified as documented / observed / assumption), `NETWORK_PROTOCOL.md` and `BANDWIDTH_REPORT.md` (to be produced in later phases).

---

## 0. Hypothesis

> It is possible to sustain a useful collaborative visual communication experience over extremely slow and unstable connections (~120 kbps) by transmitting primarily **semantic information and events** instead of conventional video.

Bandwidth is the scarcest resource of this project. Every design decision must answer: how many bytes does this add? Can it be computed locally? Sent as an event? As a delta? Quantized? Avoided entirely?

**Units convention used throughout these documents:** `kB` = 1000 bytes, `kbps` = kilobits per second (1000 bits/s). 120 kbps ≈ 15 kB/s.

---

## 1. Current architecture (as audited)

### 1.1 Stack

| Component | Reality |
|---|---|
| Framework | None. Vanilla JS frontend, no build step |
| Backend | Node.js 24 + Express 4.18 + `ws` 8.16 (`server.js`, ~100 lines) |
| Frontend files | `public/index.html` (~3 kB), `public/app.js` (~8 kB), `public/style.css` (~4 kB) |
| Fonts / images / frameworks | None (icons are inline SVG). Initial transfer is tiny — excellent Low-Net baseline |
| Tests | None |
| Deployment | Vercel, running `server.js` (see VERCEL_LIMITATIONS.md; exact wiring pending verification) |

### 1.2 How synchronization works today

The whiteboard is **not stroke-based**. It is a **1-bit-per-pixel bitmap** of a fixed 800×600 canvas, synchronized by full-state overwrite:

```text
Client draws        → paints pixels into its local Uint8Array (60,000 bytes)
                    → debounced 300 ms (app.js scheduleSend)
                    → sends its ENTIRE 60 kB bitmap
Server              → OVERWRITES its entire buffer with the received one ("Overwrite (no OR)", server.js)
                    → RLE-compresses the whole canvas
                    → broadcasts the compressed FULL canvas to every other client
Clients             → decompress and re-render all 480,000 px via createImageData/putImageData
```

There are no stroke events, no semantic serialization, no conflict resolution. The implicit conflict policy is *last-write-wins over the entire bitmap*.

Presence is a bare client count sent as a text frame (`ws.send(wss.clients.size)`); there is no identity, no rooms, no persistence beyond process memory.

### 1.3 Bandwidth profile of the current model

- One drawing burst uploads up to **60 kB** (RLE worst case: 120 kB on alternating-pixel patterns).
- At 120 kbps (≈15 kB/s), a single snapshot takes ~4 s to upload one way.
- Two users drawing actively demands roughly ~1.6 Mbps in aggregate — **an order of magnitude above the target link**.
- The README's "low-bandwidth" claim only holds for near-empty canvases.

---

## 2. Root cause: concurrent stroke loss (the critical bug)

Reproducible sequence:

1. User A draws → new pixels exist **only in A's local buffer** (inside the debounce window or just after it).
2. User B sends their 60 kB snapshot → server state becomes B's bitmap, which does not contain A's newest pixels.
3. Server broadcasts B's bitmap to everyone, including A.
4. A's handler runs `canvasView.set(decompressed); redrawCanvas()` (`public/app.js`) → **A's entire local state is clobbered**, destroying the in-progress stroke.

This is structural, not incidental:

- There is no separation between **committed state** and **in-progress local work**.
- There is no merge operation (not even a bitmap OR).
- Any remote update destroys unsynced local work.
- Even single-user sessions have races: pixels drawn during the debounce window can be wiped by the round-trip of the user's own older snapshot.
- A "clear" can be resurrected by stale snapshots still in flight (there is no generation counter).

---

## 3. Problem inventory

### Critical
| # | Problem | Consequence for Low-Net |
|---|---|---|
| C1 | Concurrent stroke loss (§2) | Unusable collaborative editing |
| C2 | Full-bitmap sync model | Incompatible with 120 kbps; makes localized eraser and undo impossible by design |
| C3 | No rooms, identity, protocol versioning or sequence numbers | Blocks multi-party MVP, metrics and evolution |

### Major
- Channel multiplexing by `typeof e.data === 'string'` — fragile once JSON control messages coexist with binary frames.
- Fixed 2 s reconnect with no backoff and no state resync (only the initial snapshot).
- `redrawCanvas()` rebuilds a 1.92 MB ImageData on every pointer move — mobile jank now, intolerable once an avatar animates at 30–60 fps.
- UA-sniffing mobile detection with duplicated touch vs pointer code paths.
- "Eraser" exists only as clear-all; concepts conflated.

### Minor
- README describes non-existent features (Apple Pencil pressure, 6-byte points) — stale documentation.
- Implicit protocol detail: client count arrives as a text frame because `ws` stringifies numbers.
- `/ping` keep-alive endpoint inherited from the Glitch era.

### What is worth keeping
- Tiny payload, zero frontend dependencies, zero build step.
- Heartbeat ping every 30 s (good NAT-keepalive hygiene).
- Reconnect skeleton (to be hardened, not discarded).
- The RLE codec (correct even for runs >255; reusable for snapshots).
- Overall smallness and clarity of both sides.

---

## 4. Proposed architecture

### 4.1 Core principle: semantic events instead of pixels

Synchronize **stroke events**, not bitmaps:

```text
{ v: 1, t: "stroke", seq: 42, ts: …, uid: "A7K9", id: "<strokeId>", pts: [x0,y0,x1,y1,…] }
```

A typical short stroke is ~40–80 bytes vs 60,000 bytes today — up to ~1000× less traffic per action, and it unlocks eraser, undo and safe concurrency.

### 4.2 State model (fixes C1 by construction)

```text
COMMITTED STROKES      append-only ordered log — shared source of truth
LOCAL ACTIVE STROKE    the stroke being drawn right now — lives in an overlay,
                       is NEVER touched by network updates
REMOTE TRANSIENT       live point streams from other users' in-progress strokes,
STROKES                throttled (~10 Hz), rendered on overlay, finalized on commit
```

Remote updates only append/reconcile committed entries; they can never destroy local in-progress work. Late joiners and reconnecting clients receive an RLE-compressed snapshot of the committed log (reusing the existing codec).

### 4.3 Rendering layers

```text
base canvas     committed strokes (incremental draw; full repaint only on resync)
overlay canvas  active local stroke + remote transient strokes
```

Eliminates the per-move full redraw and its jank; also leaves headroom for avatar animation.

### 4.4 Tools

- **Pencil:** appends points, commits stroke on pointer-up.
- **Eraser (real):** hit-tests the eraser path against existing strokes; MVP erases whole strokes (predictable, cheap); segment splitting only if it stays simple. Emits erase events referencing stroke ids.
- **Clear Canvas:** explicit event carrying a **generation counter** so stale in-flight messages cannot resurrect content.
- **Undo/Redo:** per-user stack over that user's own operations (add-stroke / erase / clear); inverse ops are broadcast.

### 4.5 Identity & rooms

- **Identity:** short client-generated ID (e.g. `A7K9`), kept in `sessionStorage`, displayed above each avatar/session. Isolated behind a small identity module so real auth can be added later without touching the core.
- **Rooms:** identified via URL (`/#ROOMID`); server keeps `Map<roomId, Room>` in memory: members, committed log, generation counter. Ephemeral — dies with the instance; acceptable for an experiment, mitigated by client-side resync. Soft participant cap (fan-out cost is O(N)).
- **Reconnect/resync as a first-class path:** see §5.1 — on Vercel Hobby, connections die at ≤300 s by platform design, so resync must be routine, not exceptional.

### 4.6 Protocol v1 (summary; full spec in NETWORK_PROTOCOL.md)

- Envelope fields on every message: `protocolVersion`, message `type`, `seq`, `ts`.
- **JSON text frames** for `control`, `presence`, `whiteboard` (simple, debuggable); measure overhead before considering MessagePack/CBOR.
- **Binary packed frames** only for high-frequency `avatar` state.
- Explicit reliability classes per category (§5.1).

### 4.7 Avatar pipeline (video replacement)

```text
Camera (local only)
  ↓
MediaPipe Face Landmarker (WASM/WebGL, fully client-side; lazy-loaded, optional)
  ↓ 52 ARKit-compatible blendshapes + facial transformation matrix (head pose)
extract ~10 meaningful parameters
  ↓ quantize to Uint8 (0–255 ⇒ 0.0–1.0)
compact binary packet (~16–20 B) + seq/ts
  ↓ WebSocket
remote decode → interpolation buffer → avatar render (own original artwork)
```

- Raw landmarks (478 × xyz) are **never** transmitted; camera frames never leave the device (see §7 Privacy).
- Target rate 10–15 Hz with change thresholds; keyframe (full state) every few seconds + deltas between them, so loss/degrade self-heals without retransmit logic.
- Receiver-side interpolation buffer makes 10–15 Hz look smooth at display framerate.
- **Load strategy:** the model bundle (`face_landmarker.task` float16 ≈ **3.76 MB** verified, plus several MB of WASM runtime — exact size to be measured at integration) is fetched **only when the user explicitly enables the avatar**, after entering the room, with visible progress ("Loading face tracking…") and aggressive caching. The room and whiteboard remain fully usable without it. At 15 kB/s this download takes minutes — this is accepted and made optional-by-design.

### 4.8 Audio

- WebRTC + Opus, peer-to-peer; our WebSocket carries signaling/control only. Audio media never traverses the WS or Vercel functions.
- Voice at Opus low modes ≈ 6–24 kbps; actual bitrate measured via `RTCPeerConnection.getStats()` deltas (no invented numbers in reports).
- TURN will be needed for some NAT combinations (research deferred to Phase 7); graceful degradation: avatar-only mode still works since avatars ride the WS.

### 4.9 Metrics infrastructure (Phase 3)

- Single wrapper around WS send/receive counting **real payload bytes per category**: `WHITEBOARD | AVATAR | AUDIO | CONTROL | CHAT | OTHER`.
- Per-second buckets → current / average / peak bitrate; RTT via control ping/pong every ~5 s; reconnect count; uptime; sequence-gap detection stats.
- Debug panel toggled by `?debug=1` (and/or keyboard shortcut), clearly separated from normal UI.

### 4.10 Network simulator (Phase 8)

Dev-only shim around `WebSocket` implementing token-bucket bandwidth throttling, added latency, random loss (with seq tracking so loss effects become visible), jitter, forced disconnects. Reproducible scenarios: 120/80/50/30/20/10 kbps. OS-level tools (netem/clumsy) documented as alternatives but not required.

### 4.11 Target UI

```text
┌─────────────────────────────────────────────────────┐
│ LOW-NET                         ROOM: A7K9          │
├─────────────────────────────────────────────────────┤
│  [avatar A7K9]   [avatar B2X1]   …                  │
│  ┌───────────────────────────────────────────────┐  │
│  │                  CANVAS                       │  │
│  └───────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│ ✏ ⌫ ↶ ↷ 🗑              🎤  Network: 31 kbps       │
└─────────────────────────────────────────────────────┘
```

Top compact toolbar (pencil, eraser, undo, redo, clear), canvas maximized, bottom status bar with mic toggle and total bitrate. Monochrome strokes for the MVP (matches the 1-bit aesthetic and minimizes bytes; color index optional later).

### 4.12 Proposed file layout (evolution, not rewrite)

```text
/
├── server.js            # adapted into Vercel-compatible entry (verify deployment wiring first)
├── public/
│   ├── index.html / style.css
│   └── js/
│       ├── main.js
│       ├── net/{connection,protocol,metrics,simulator}.js
│       ├── whiteboard/{store,render,tools}.js
│       ├── avatar/{tracker,avatar,interp}.js
│       └── ui/{toolbar,presence,debugPanel}.js
└── docs/
```

Vanilla JS + JSDoc types throughout; no build step (decision D3).

---

## 5. Reliability model

| Category | Transport class | Loss behavior |
|---|---|---|
| Whiteboard | Reliable, ordered (WS/TCP native) | Must never lose committed strokes; ops idempotent by stroke id |
| Avatar | Loss-tolerant | Drop stale packets, rely on periodic full keyframes; never request retransmits |
| Control/presence | Reliable; presence eventually consistent | Presence heals via periodic refresh |
| Audio | WebRTC/Opus own stack (FEC/jitter buffer built-in) | Out of scope for WS |

Honesty note: WebSockets run over TCP, so "packet loss" manifests as latency spikes or disconnects rather than missing messages. Sequence numbers therefore serve statistics, simulator fidelity and future transports — they are cheap and worth having from day one.

---

## 6. Bandwidth budget (targets to be verified by measurement — none of these are claims)

| Component | Design target | Notes |
|---|---|---|
| Whiteboard events | ~0.5–5 kbps (two active users) | Event sizes measured in Phase 2/3 |
| Avatar | ~1.6–2 kbps per user @10 Hz | 16–20 B packets + framing |
| Audio | 8–24 kbps | Measured via getStats in Phase 7 |
| Control | <0.5 kbps | Ping/pong, presence refresh |
| **Total** | **30–50 kbps goal; stretch ~20 kbps** | The MVP's purpose is to answer this question with numbers |

---

## 7. Privacy commitments

- Camera processing is 100% local. Raw frames, screenshots and face images are **never** transmitted to the server or peers.
- The server receives only quantized avatar parameters.
- This document is the canonical statement of that commitment; the implementation must preserve it.

---

## 8. Technical decisions & rationale

| # | Decision | Rationale |
|---|---|---|
| D1 | Semantic stroke events replace bitmap sync | Fixes C1/C2 structurally; enables eraser/undo; ~1000× traffic reduction |
| D2 | Layered rendering (base + overlay) | Kills full-frame redraw jank; isolates in-progress work |
| D3 | Stay vanilla JS + JSDoc, zero build step | Coherent with project ethos; types where they matter (protocol/binary layouts); TS migration possible later |
| D4 | MediaPipe Face Landmarker, lazy-loaded and optional | Best-in-class client-side blendshapes; heavy asset made user-triggered + cached |
| D5 | Blendshape subset, Uint8-quantized, binary frames, delta + keyframes | 478 landmarks are unnecessary; ~10 params suffice for convincing animation |
| D6 | Audio via WebRTC P2P only; WS strictly signaling/control/data | Keeps media bytes off the constrained path and off Vercel billing |
| D7 | Ephemeral in-memory rooms, no external DB | $0, zero infra; resync-on-reconnect absorbs volatility; documented limitation |
| D8 | Metrics-first development | Every optimization decision gated on measured bytes, not intuition |
| D9 | JSON envelope now; binary only for avatar | Simplicity first; overhead measured before any codec swap |

## Alternatives considered

- **Keep bitmap sync, add dirty-rect deltas:** reduces bandwidth but leaves eraser/undo/concurrency broken; rejected as the primary model (RLE bitmap retained only for snapshots).
- **CRDTs (Yjs/Automerge):** designed for rich text-document merging; overkill for append-only stroke logs; extra weight.
- **MessagePack/CBOR/custom binary everywhere:** premature; JSON overhead will be measured first.
- **Migrate off Vercel (Cloudflare/Ably/Pusher…):** contradicts constraints; current platform supports the MVP within documented limits (see VERCEL_LIMITATIONS.md).
- **External services (Redis, Auth, analytics, SaaS):** explicitly out of scope.

---

## 9. Risks & mitigations

| Risk | Class | Mitigation |
|---|---|---|
| Connection hard-killed at ≤300 s (Hobby max duration) | Documented | Resync protocol as normal path (Phase 4); tolerate churn gracefully |
| Room split across instances after reconnect (no cross-instance fan-out) | Documented | Detect via presence mismatch + retry loop; documented as hard limit |
| In-memory room state lost on instance restart/deploy | Documented+observed | Snapshot-on-reconnect; accept data loss as experimental scope |
| Face model too slow to load at 120 kbps | Verified size | Optional feature, explicit user action, cache immutable, CDN option |
| WebRTC fails on restrictive NATs without TURN | Assumed % | Graceful degradation to avatar-only; TURN research in Phase 7 |
| Deployment wiring of `server.js` on Vercel undocumented in repo | Observed | Verify against dashboard/logs early in Phase 2; capture in VERCEL_LIMITATIONS.md |

---

## 10. Incremental plan

| Phase | Scope | Deliverable |
|---|---|---|
| 1 ✅ | Audit (this document) | LOW_NET_ARCHITECTURE.md, VERCEL_LIMITATIONS.md |
| 2 ✅ | Whiteboard hardening: stroke-event refactor, layered render, eraser, undo/redo, clear-as-event, compact top toolbar | Working concurrent-safe board |
| 3 ✅ | Metrics: NetworkMetrics accounting (bytes by category, msg/s rates, RTT EMA), toolbar button + right-side card (auto-opens with `?debug=1`) | Measurement before optimization |
| 4 ✅ | Protocol v1: server-side version gate, per-room seq + client gap detection, err surfacing, NETWORK_PROTOCOL.md | Documented, enforced wire contract |
| 5 ✅ | Avatar prototype (camera→tracking→quantize→binary→WS→interpolation→render) | Playable avatar |
| 6 ✅ | Avatar optimization: deadband suppression + keepalives, Hz/deadband knobs (`?avhz`/`?avdb`), deterministic sweep bench | Measured avatar bandwidth curve (`BANDWIDTH_AVATAR.md`) |
| 7 ✅ | Audio prototype: WebRTC mesh (STUN, cid tie-break), Opus mono ≈12 kbps via SDP munge + setParameters, getStats metering ("Audio P2P" row) | Measured audio bitrate (`BANDWIDTH_AUDIO.md`; real-world numbers in phase 9) |
| 8 ✅ | Network simulator: client-side WS shim with token-bucket up/down, latency±jitter, seeded loss, forced cuts (`?net=30k&netlat=150&netjit=80&netloss=2&netcut=20`) | Reproducible dev harness |
| 9 | Real-world test ~120 kbps | BANDWIDTH_REPORT.md with real numbers |

Each phase closes with its test matrix (concurrent users, disconnect/reconnect/refresh; avatar edge cases incl. no-face/camera-denied; simulated bandwidth tiers).

### Phase 2 implementation notes

- Server rewritten: per-room state (`Map<roomId, Room>`), ops `hello/init/join/presence/stroke/unstroke/erase/restore/clear/progress/ping`, strict wire sanitizers, caps (16 members, 2000 strokes FIFO, 4096 pts), heartbeat with pong tracking. The RLE bitmap codec was retired (snapshots are JSON stroke lists; RLE may return for binary snapshots later).
- Client restructured into ES modules (`js/net`, `js/whiteboard`, `js/ui`) — still zero build step, zero frontend deps.
- Local in-progress stroke lives in the render layer only; remote updates touch committed state exclusively → concurrent loss is impossible by construction.
- Eraser = whole-stroke hit-testing with live hide-preview batched into one op on pointer-up.
- Undo/redo are per-user stacks over own ops; inverses broadcast as regular wire ops.
- Clear is explicit and generation-bumped; server echoes canonical gen to everyone including sender.
- Rooms + temporary identity landed early (they were prerequisites for stroke attribution and undo semantics).
- Verification: 8 integration tests (`npm test`) incl. a regression test for the original bug + fuzz inputs (which caught and fixed a real sanitizer hole: JSON `[null,null]` coords); live smoke probe (`node tests/smoke.mjs`); manual browser matrix in `tests/MANUAL_CHECKLIST.md`.

### Phase 3 implementation notes

- `public/js/net/metrics.js`: pure accounting (no DOM) — per-category byte totals (control/presence/board), rolling 60×1 s buckets for current/peak rates, uptime-normalized averages, RTT EMA (α=0.2), reconnect counter. Unit-tested in Node.
- `Connection` meters every frame (UTF-8 wire length, not code units); consumes `ping/pong` at the transport layer so control chatter never reaches the app; probes RTT every 5 s while open. Also hardened: superseded sockets now detach handlers before reconnect to prevent duplicate backoff loops.
- `public/js/ui/metrics-card.js`: card on the right side, opened with the pulse-icon toolbar button (and auto-opened via `?debug=1`); loads via **dynamic import on first open** — the default page pays zero bytes for instrumentation UI. Shows status/room/uid, RTT last+EMA, msg/s and B/s (current/peak, up/down), totals and board-vs-control split, store counts, outbox depth, reconnects, FPS. The status bar also carries an always-on compact readout (`↑↓ kB/s · RTT`).

### Phase 4 implementation notes

- Server enforces `v === 1`: wrong-version frames get `err{code:"version"}` and are dropped; a wrong-version `hello` also closes the socket.
- Per-room monotonic `seq` added to state ops (stroke/unstroke/erase/restore/clear); `init` carries the baseline. Client counts gaps into `Lost ops` metrics; baseline resets each session so reconnect-resync stays the standard recovery.
- Client surfaces server errors in the status bar (ROOM FULL / VERSION MISMATCH).
- Full wire contract documented in [`NETWORK_PROTOCOL.md`](NETWORK_PROTOCOL.md).

## Success criteria

Not "a pretty avatar" or "WebRTC works", but:

> Two people enter a room, see each other as locally-animated avatars, talk by voice when available, draw simultaneously without losing strokes, and can read exactly how many kbps each component consumes — demonstrating with numbers whether the concept holds at 120 kbps.
