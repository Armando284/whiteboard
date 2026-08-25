# Phase 2 — Manual test checklist (browser matrix)

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
