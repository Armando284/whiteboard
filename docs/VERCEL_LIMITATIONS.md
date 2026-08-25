# Vercel Limitations & Deployment Notes

> **Status:** Phase 1 — Audit deliverable.
> **Date of research:** 2026-08-24. Facts below were checked against live Vercel documentation on this date; sources listed per item.
> **Purpose:** decide — with evidence, not folklore — whether Vercel can host the Low-Net MVP at $0, and design around its hard edges.

Every claim in this document is classified:

```text
DOCUMENTED  → stated by official Vercel documentation/changelog (source linked)
OBSERVED    → seen in this repo / production behavior reported by the owner
ASSUMPTION  → reasonable expectation, NOT verified; must be measured before trusting
```

---

## 1. Current deployment (as observed)

| Fact | Class | Notes |
|---|---|---|
| The app is deployed on Vercel and WebSockets work in production | **OBSERVED** (owner report) | Owner states deployment scripts launch `server.js` directly |
| The repo contains **no `vercel.json` and no `api/` directory** | **OBSERVED** (repo inspection) | The exact wiring that makes `server.js` run as a WebSocket-capable function is **not captured in the repository** |
| Git history shows the project originally targeted Glitch.com | **OBSERVED** (commit `69e36b5`) | `/ping` keep-alive endpoint is a leftover from that era |

> ⚠️ **Action item (early Phase 2):** capture how the current deployment is configured (dashboard build settings, region, Fluid status) into this document. A clean re-deploy from this clone must be reproducible; today that is not guaranteed.

## 2. Platform facts relevant to Low-Net

| # | Fact | Class | Source |
|---|---|---|---|
| F1 | Fluid compute is enabled by default for new projects since Apr 23, 2025 | DOCUMENTED | vercel.com/docs/fluid-compute |
| F2 | Native WebSocket support in Node.js Functions (requires Fluid compute); public beta shipped June 2026. Python functions followed (July 2026). Older docs/pages saying "WebSockets are not supported" are superseded | DOCUMENTED | vercel.com/docs/limits#websockets; changelog "WebSocket support is now available"; community thread (Nov 2025) reflects pre-beta state |
| F3 | Function max duration: **Hobby default = max = 300 s**; Pro/Enterprise up to 800 s (GA), 1800 s extended beta | DOCUMENTED | vercel.com/docs/functions/configuring-functions/duration |
| F4 | An accepted WebSocket connection is **pinned to the instance** that took the upgrade, for the function's maximum duration. Future connections are **not guaranteed to land on the same instance** | DOCUMENTED | Vercel KB: do-vercel-serverless-functions-support-websocket-connections |
| F5 | There is **no built-in cross-instance broadcast**: connections held by different instances cannot message each other through the platform; Vercel recommends an external store for fan-out/presence across instances | DOCUMENTED | same KB article |
| F6 | Active CPU pricing bills active processing time; idle socket time is billed at a lower memory-only rate (not per-socket flat fees) | DOCUMENTED | changelog "Higher defaults and limits… Fluid compute" (Jun 2025), usage-and-pricing docs |
| F7 | Concurrency autoscaling up to ~30k concurrent executions (Hobby/Pro) | DOCUMENTED | functions limits docs |
| F8 | Cold-start latency variance when instances spin down/up exists but magnitude is workload-dependent | ASSUMPTION | to be measured in Phase 9 |
| F9 | Hobby included quotas are sufficient for an experiment-scale realtime app (few concurrent rooms) | ASSUMPTION | monitor usage after Phase 2 goes live |
| F10 | Static assets (HTML/CSS/JS) served via Vercel CDN are effectively free and fast | DOCUMENTED | platform docs (static/CDN included on Hobby) |

## 3. What this means for Low-Net

### 3.1 The 300-second ceiling is THE constraint (F3)
On Hobby every WS connection is terminated at ≤300 s. Therefore:
- Reconnect + resync must be a **first-class, routine path** in the protocol (Phase 4), not an error handler. Design assumption: any client may be disconnected at any moment; committed state must survive via snapshot/replay.
- Client keeps its identity and local draft work across reconnects (sessionStorage).
- If churn ever becomes painful, Pro raises it to 800 s — out of scope while targeting $0.

### 3.2 Room split risk (F4/F5)
Two users of the same room can end up on different instances after a reconnect and would not see each other (no cross-instance fan-out). Mitigations for MVP:
- Presence mismatch detection → client forces reconnect attempts (instances are usually warm and reused, so re-pinning to the populated instance is likely — **ASSUMPTION**, verify empirically).
- Document explicitly: single-instance room consistency is best-effort during the experiment.

### 3.3 State volatility
Room state lives in process memory (`Map<roomId, Room>` proposed). Instance restart/deploy wipes it. Accepted experimental scope; snapshot-on-reconnect limits damage. No external DB by design decision D7.

### 3.4 Cost model fits $0 (F6/F9/F10)
Idle sockets are cheap under Active CPU pricing; our traffic profile (tiny semantic events, media going P2P via WebRTC and never through functions) keeps active CPU minimal. WebRTC media does not touch Vercel at all — only signaling rides the WS.

### 3.5 What we deliberately do NOT get from the platform
Presence, fan-out guarantees, delivery guarantees beyond a single pinned connection, persistent storage. All handled application-side or accepted as limitations.

## 4. Verification checklist (to close during Phase 2)

- [ ] Record actual dashboard settings (framework preset, build command, install command, output dir) of the working production project.
- [ ] Confirm Fluid compute status for the project (required for WS).
- [ ] Measure real connection lifetime in production (expect forced close near 300 s on Hobby).
- [ ] Empirically test re-pinning behavior after forced disconnects (does the same room land together?).
- [ ] Capture cold-start latency distribution for first connect.
- [ ] Update §1 and §2 classifications OBSERVED/ASSUMPTION → confirmed numbers.

## 5. Verdict

**Stay on Vercel for the MVP.** The documented constraints (300 s connection ceiling, pinning without cross-instance fan-out, volatile memory state) are real but all are absorbable by protocol design (resync-as-normal-path) rather than infrastructure changes. No migration is justified by evidence gathered so far.

---

### Sources
- Configuring Maximum Duration for Vercel Functions — https://vercel.com/docs/functions/configuring-functions/duration (page dated 2026-07-01)
- Fluid compute — https://vercel.com/docs/fluid-compute
- Vercel Limits (WebSockets section) — https://vercel.com/docs/limits#websockets
- KB: Do Vercel serverless functions support WebSocket connections? — https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections
- Changelog: Higher defaults and limits for Functions running Fluid compute (Jun 2025) — https://vercel.com/changelog/higher-defaults-and-limits-for-vercel-functions-running-fluid-compute
- Changelog: WebSocket support for Python Functions (Jul 2026) — https://vercel.com/changelog/websocket-support-is-now-available-for-python-functions
