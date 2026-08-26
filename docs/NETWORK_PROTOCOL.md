# NETWORK_PROTOCOL.md — Low-Net Wire Protocol v1

Status: **implemented** (server enforced since Phase 4).
Transport: WebSocket. JSON text frames are the control plane; binary frames carry avatar poses and video frames (see §8, §9).

---

## 1. Envelope

Every JSON frame is an object with exactly two mandatory fields:

```json
{ "v": 1, "t": "<type>", ...payload }
```

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Protocol version. Must be exactly `1`. |
| `t` | string | Op type. Unknown types are ignored by the server. |

**Version gate**: a frame with `v !== 1` is rejected with `err{code:"version", got:<v>}` and *not* applied. A `hello` with a wrong version additionally closes the socket so stale clients fail fast instead of looping.

## 2. Limits (server-enforced, per room unless noted)

| Limit | Value | On violation the op is dropped silently |
|---|---|---|
| Max members | 16 | join refused with `err{code:"room_full"}` |
| Max committed strokes | 2000 | oldest stroke evicted (FIFO) |
| Max points per `stroke` op | 4096 points (8192 numbers) | op dropped |
| Max points per `progress` chunk | 512 points | chunk dropped |
| Max erase batch | 2000 ids | excess ids ignored |
| WS max payload | 64 KB | connection closed by `ws` |
| Hello timeout | 10 s after TCP connect | socket terminated |
| Heartbeat | ws-level ping every 30 s; 1 missed pong → terminate | — |

World coordinates are integers clamped to `800 × 600`.

Sanitizers reject anything non-strict: coordinates must be finite numbers (`null`, strings and `NaN` never coerce), ids must match `[A-Za-z0-9_.:-]{1,80}`, uids `[A-Za-z0-9_-]{1,24}`, rooms `[A-Za-z0-9_-]{1,32}`.

## 3. Sequence numbers (gap detection)

The server keeps a monotonic `seq` counter **per room**.

- Every **state-changing broadcast** carries `seq`: `stroke`, `unstroke`, `erase`, `restore`, `clear`.
- `init` carries the current `seq` as the client's **baseline**.
- Transient/live frames (`progress`, presence, ping/pong) carry no seq.
- State ops are **not echoed to their sender** (except `clear`, which goes to everyone).

Clients track `lastSeq`; on receiving `seq > lastSeq + 1` they count `seq − lastSeq − 1` lost ops into metrics (`Lost ops` in the stats card) — a signal that resync may be needed. `init` re-baselines on every (re)connect, which makes reconnect-after-idle the standard recovery path (see VERCEL_LIMITATIONS.md).

## 4. Client → Server

| `t` | Payload | Notes |
|---|---|---|
| `hello` | `{room, uid}` | Must be first frame. Joins/creates room. |
| `stroke` | `{id, pts}` | Commit full stroke; `pts` flat `[x0,y0,…]`. First id wins. |
| `unstroke` | `{id}` | Remove one stroke (undo of add). |
| `erase` | `{ids[]}` | Batch remove committed strokes. |
| `restore` | `{strokes[]}` | Re-add strokes (undo of erase/clear); existing ids ignored. |
| `clear` | `{}` | Wipes room state; bumps room `gen`. Ignored field: client-sent gen. |
| `progress` | `{id, i, pts}` | Live preview relay only; never stored. `i` = point index offset. |
| `avatar_off` | `{}` | Sender's avatar is off; peers remove its avatar (see §8). |
| `audio_on` / `audio_off` | `{}` | Broadcast; peers start/tear down the audio session with `cid` (see §8.1). |
| `rtc` | `{to, sdp}` | WebRTC offer/answer relayed only to member `to`, stamped `from: sender`. Server never parses SDP. |
| `rtc_ice` | `{to, candidate}` | ICE candidate relay, same targeting/stamping. |
| `ping` | `{ts}` | App-level RTT probe; answered with `pong`. |

## 5. Server → Client

| `t` | Payload | Notes |
|---|---|---|
| `init` | `{you, uid, room, gen, seq, strokes[], members[]}` | Full snapshot on hello/reconnect. |
| `join` | `{cid, uid}` | A member joined (no seq). |
| `presence` | `{members:[{cid,uid}]}` | Full member list after any join/leave. |
| `stroke` | `{seq, id, pts}` | To everyone except sender. |
| `unstroke` | `{seq, id}` | To everyone except sender. |
| `erase` | `{seq, ids[]}` | Only ids that actually existed. Except sender. |
| `restore` | `{seq, strokes[]}` | Sanitized subset actually added. Except sender. |
| `clear` | `{seq, gen}` | Canonical generation; broadcast to all incl. sender. |
| `progress` | `{id, i, pts}` | Relayed verbatim (validated). Except sender. |
| `avatar_off` | `{cid}` | Echoed to peers (except sender) when someone disables their avatar. |
| `audio_on` / `audio_off` | `{cid}` | Broadcast; enables/disables audio sessions with that peer. |
| `rtc` | `{from, sdp}` or `{from, candidate}` on `rtc_ice` | Signaling from another member, relayed verbatim (size-capped). |
| `pong` | `{ts}` | Echo of app-level ping. |
| `err` | `{code, got?}` | See below. |

## 6. Error codes

| Code | Meaning | Client behavior |
|---|---|---|
| `room_full` | 16-member cap reached; socket closing | Status bar shows ROOM FULL; user retries later |
| `version` | Frame `v` unsupported (`got` = received value) | Status bar shows VERSION MISMATCH — RELOAD; hello also closes |

## 7. Lifecycle

```text
connect ── hello ──▶ init(snapshot+baseline) ──▶ live ops …
   ▲                                                │
   └──── reconnect (backoff+jitter) ◀── drop ◀──────┘
             └── hello again → fresh init = resync
```

Reconnection resets the seq baseline; the first `init` restores committed state. Ops drawn while offline sit in a client outbox (max 256) flushed right after `hello`.

## 8. Binary frames (avatar)

Binary WS frames carry avatar pose only (JSON stays the control plane). All
multi-byte values are big-endian. Contract implemented by `public/js/avatar/codec.js`
and mirrored inline in `server.js` (integration tests pin both sides).

**Sender frame — 13 bytes, client → server:**

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | tag `0x01` |
| 1 | 1 | seq (u8, wraps) |
| 2–4 | 3×i8 | yaw, pitch, roll quantized to ±80° (`round(rad·127/80°)`) |
| 5–12 | 8×u8 | blendshapes ×255: jawOpen, mouthSmileLeft, mouthSmileRight, browOuterUpLeft, browOuterUpRight, eyeBlinkLeft, eyeBlinkRight, mouthPucker |

**Relay frame — server → peers:** tag `0x02`, cid length u8, sender cid (ASCII),
then the **full inner frame including its original tag byte** (0x01 pose or 0x03 config).
This lets clients branch on the inner tag without hardcoding 0x01.

Server behavior: requires room membership; exact size + tag validated; rate
limited to one relay per ~33 ms per member; never stored, never echoed to the
sender. Budget: 13 B @ 12 Hz ≈ **156 B/s per active avatar**.

**Appearance config frame — 4 bytes, client → server** (tag `0x03`):

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | tag `0x03` |
| 1 | 1 | byte0: hairStyle(4) + hairColor(4) |
| 2 | 1 | byte1: eyes(4) + brows(4) |
| 3 | 1 | byte2: nose(4) + mouth(4) |

All values are 4-bit nibbles (0–15). See `public/js/avatar/looks.js` for trait tables.
Server persists the 3 payload bytes per member and includes them in `init.cfgs`
(base64 map) so late-joiners render customized avatars immediately. Relayed
with tag `0x02` same envelope (full inner frame preserved). Idempotent — no
rate-limit, re-sent on any local change.

Send-side suppression (phase 6): clients SHOULD suppress poses below a
deadband and emit keepalives at least every ~400 ms so peers' TTLs don't drop
a quiet avatar. Measured effect: idle cost drops to ≈37 B/s (see
`BANDWIDTH_AVATAR.md`); the wire format is unchanged.

Toggling off sends a JSON `avatar_off` so peers can drop the sprite immediately;
a 5 s TTL covers unclean disconnects.

### 8.1 WebRTC audio signaling

Audio media is peer-to-peer; only signaling rides the WS (JSON, §4/§5 above).
The server relays `rtc`/`rtc_ice` frames to the named `to` member untouched
(string SDP ≤16 kB, ICE object ≤2 kB), stamping them with `from`. It never
inspects or stores session state. Glare avoidance is client-side and
deterministic: on `audio_on`, only the peer with the lexicographically larger
cid creates an offer. Signaling bandwidth is negligible (~6 kB per pair setup).

## 9. Binary frames (video)

Binary WS frames carry camera-differential video (keyframes, deltas, config).
All multi-byte values are big-endian. Contract implemented by `public/js/video/encode.js`
(Wire object) and mirrored inline in `server.js`.

### 9.1 Tag definitions

| Tag | Name | Direction | Description |
|---|---|---|---|
| `0x10` | `VIDEO_KEYFRAME` | Client→Server→Peers | Full compressed frame |
| `0x11` | `VIDEO_DELTA` | Client→Server→Peers | Changed blocks only |
| `0x12` | `VIDEO_CONFIG` | Client→Server→Peers | Sender capabilities / preset |
| `0x13` | `VIDEO_KEYFRAME_REQ` | Client→Server→Sender | Request keyframe (optional) |
| `0x20` | `VIDEO_RELAY` | Server→Peers | Relay envelope (prepended by server) |

### 9.2 Keyframe (0x10) — client → server

```
Offset  Size  Field
0       1     tag = 0x10
1-2     2     seq (u16, big-endian, wraps at 65535)
3-6     4     timestamp (u32 ms, performance.now() origin)
7       1     widthBlocks (u8)
8       1     heightBlocks (u8)
9       1     blockSize (u8)    — 2, 4, or 8
10      1     encoding (u8)     — 0=raw, 1=RLE, 2=bitpack4
11      1     quantization (u8) — 0=8bit, 1=4bit
12-13   2     payloadLen (u16)
14...   N     payload (Uint8Array)
```

Payload encoding per block (row-major): raw bytes, RLE `[runLen,value]...`, or bitpack4 (2 nibbles/byte).

### 9.3 Delta frame (0x11) — client → server

```
Offset  Size  Field
0       1     tag = 0x11
1-2     2     seq (u16)
3-6     4     timestamp (u32 ms)
7-8     2     changedCount (u16)
9...    N     blocks[] (variable)
```

Per-block entry:
```
Offset  Size  Field
0       1     blockX (u8)
1       1     blockY (u8)
2       1     encoding (u8)
3-4     2     blockLen (u16)
5...    N     blockData
```

### 9.4 Config frame (0x12) — client → server

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

### 9.5 Relay frame (0x20) — server → peers

Server prepends sender CID to the full inner frame (preserving original tag):

```
Offset  Size  Field
0       1     tag = 0x20
1       1     cidLen (u8)
2..     N     cid (ASCII)
2+N..   M     inner frame (0x10/0x11/0x12/0x13 with full payload)
```

### 9.6 Server behavior

- Requires room membership; tag + basic structure validated; max frame size 16 KB.
- Keyframes rate-limited to one per 500 ms per sender.
- Never stored, never echoed to sender.
- Config frames relayed idempotently (no rate-limit).
- Keyframe requests (0x13) relayed to all peers (sender filters).

### 9.7 Sequence numbers & gap handling

- `seq` increments per frame (keyframe or delta), uint16 wraparound.
- Receiver tracks `lastSeq`; on gap > 5 or missing keyframe → send `VIDEO_KEYFRAME_REQ` (0x13).
- Small out-of-order buffer (max 3 frames) for reordering.
- Keyframe resets decoder state — always processed immediately.

## 10. Evolution rules

- Adding new op types or optional fields = still v1 (unknown types/fields ignored).
- Changing semantics of existing fields or removing fields = v2, negotiated via `hello`/`err{version}`.
- New binary payloads will start with their own 1-byte type tag (0x01/0x02 taken).
