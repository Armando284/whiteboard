# NETWORK_PROTOCOL.md — Low-Net Wire Protocol v1

Status: **implemented** (server enforced since Phase 4).
Transport: WebSocket (JSON text frames). Binary frames are reserved for future avatar/audio payloads.

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

## 8. Evolution rules

- Adding new op types or optional fields = still v1 (unknown types/fields ignored).
- Changing semantics of existing fields or removing fields = v2, negotiated via `hello`/`err{version}`.
- Binary frames (avatar pose chunks, later possibly binary board snapshots) will start with a 1-byte type tag; JSON text frames remain the control plane.
