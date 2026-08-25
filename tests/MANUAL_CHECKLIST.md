# Manual test checklist (browser matrix)

Automated protocol tests: `npm test` (server logic, convergence, caps, fuzzing).
The scenarios below need a real browser pair (two tabs = two identities).

Start: `npm start`, open `http://localhost:3000/#testroom` in two tabs/windows.

## Whiteboard

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Concurrent drawing | A drags continuously; B commits strokes during A's drag | Neither loses anything; both converge to the same drawing |
| 2 | Live preview | A draws slowly | B sees A's stroke appear live at reduced opacity, then solid on commit |
| 3 | Erase while other draws | B erases strokes while A is mid-drag | A's in-progress stroke survives; committed targets disappear everywhere |
| 4 | Erase whole-stroke | Erase path crossing a stroke | Entire stroke disappears immediately (local preview), then for peers |
| 5 | Clear while other draws | B presses Clear while A draws | A's current stroke survives and commits after the clear; canvas wipes |
| 6 | Undo/Redo | Each user undoes/redoes own ops | Only own ops affected; peers see inverse ops; buttons disable at stack ends |
| 7 | Refresh | Reload tab mid-session | Same ID chip reappears; fresh snapshot loads; no duplicate-ID artifacts |
| 8 | Disconnect | DevTools → Offline for ~5 s while drawing | Status shows OFFLINE; strokes drawn offline queue; on Online they flush and resync |
| 9 | Reconnect storm | Toggle offline/online rapidly | Backoff with jitter; no duplicate presence chips after settling |
| 10 | Late joiner | Third window joins after several ops | Receives full snapshot matching others' views |
| 11 | Room isolation | Two different hash rooms open side by side | No cross-room traffic; presence lists are independent |

## Avatar (Phase 5)

Requires a webcam and camera permission. First activation downloads the
MediaPipe runtime + model (~4–8 MB from CDN) — expect a slow first toggle on
throttled networks; afterwards it is HTTP-cached.

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Enable avatar | Click the person-in-frame toolbar button; allow camera | Button stays highlighted; dock appears bottom-left with your face card, labeled with your YOU chip |
| 2 | Remote face | Enable in both tabs | Each tab shows the other's face labeled with their uid |
| 3 | Head pose | Yaw / pitch / roll your head slowly | Remote face features shift horizontally, vertically, rotate — smoothly (interpolated), no jumping |
| 4 | Expressions | Open mouth, smile, raise brows, blink, pucker lips | Jaw opens mouth, smile adds corner ticks, brows rise, eyes squash shut, pucker narrows mouth |
| 5 | Toggle off | Click the button again | Own card disappears locally AND instantly in the peer's dock (`avatar_off`) |
| 6 | Dirty exit | Close/refresh a tab with avatar on | Peer removes that face within ≤5 s (TTL) |
| 7 | Camera denied | Deny permission on prompt | Status bar shows `ERR camera`; board still fully usable; button not stuck active |
| 8 | No face in frame | Cover camera or step away | No frames sent (Avatar traffic flatlines); remote face freezes on last pose until TTL |
| 9 | Bandwidth budget | Open stats card with both avatars on | "Avatar traffic" climbs ≈150–160 B/s per active avatar; board/control rows unaffected |
| 10 | Model download once | Reload page, re-enable avatar | Second load starts tracking quickly (model cached), no re-download spike in Network tab |
| 11 | Board coexistence | Draw while avatars are on | Drawing latency/rendering unaffected; strokes keep converging as usual |
| 12 | Experiment knobs | Reload with `?avhz=4&avdb=0.06`, enable avatar | Tracking visibly choppier; stats card "Avatar traffic" drops towards the `BANDWIDTH_AVATAR.md` table values; idle cost stays ≈37 B/s |

## Edge cases

- [ ] Draw a single click (dot) → visible locally and remotely
- [ ] Eraser over empty canvas → no errors, no empty ops sent
- [ ] Keyboard: P/E switch tools; Ctrl+Z / Ctrl+Shift+Z history
- [ ] Mobile viewport: toolbar fits one row; drawing doesn't scroll page
- [ ] Server restart while tabs open → tabs reconnect to fresh room state (documented ephemeral behavior)

## Known MVP limitations (by design)

- Whole-stroke erasing (no segment splitting yet)
- Monochrome ink only
- Room state is volatile across server restarts/deployments
- On Vercel Hobby, connections are force-cycled every ≤300 s — reconnect+resync is the normal path (see `docs/VERCEL_LIMITATIONS.md`)
