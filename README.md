# 🎨 Low-Net Whiteboard

Real-time collaborative whiteboard designed for **extremely low-bandwidth connections** (~120 kbps). Part of the **Low-Net** experiment: transmitting semantic events instead of pixels, video, or raw state.

---

## How it works

The board synchronizes **stroke events**, not bitmaps:

```text
Client draws        → local in-progress stroke (overlay layer, never touched by network)
                    → progress points streamed at ~11 Hz (live preview for peers)
                    → full stroke committed on pointer-up (~1000× less traffic than a snapshot)
Server              → validates + relays ops, keeps committed state per room
Other clients       → append to their committed log and render incrementally
```

- **Concurrent drawing is loss-free**: committed strokes are an append-only log; a remote update can never overwrite your work in progress.
- **Tools**: pencil, eraser (whole-stroke hit-testing), undo/redo (per-user), clear (explicit generation-bumped event).
- **Rooms**: URL hash (`/#myroom`), ephemeral in-memory state, snapshot on join/reconnect.
- **Identity**: temporary 4-char ID per tab (e.g. `A7K9`), no accounts.
- **Reconnect**: exponential backoff; on resume the server sends a fresh `init` snapshot.

## Stack

| Component  | Technology                          |
|------------|-------------------------------------|
| Frontend   | Vanilla JS (ES modules) + Canvas    |
| Backend    | Node.js + Express + `ws`            |
| Protocol   | JSON envelopes (`v`, `t`, payload)  |
| Deployment | Vercel (see `docs/VERCEL_LIMITATIONS.md`) |

No build step. No frontend dependencies.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # with --watch
npm test           # integration tests (node:test + ws)
node tests/smoke.mjs   # manual smoke probe (server must be running on :3999)
```

The status bar shows a compact live readout (`↑↓ kB/s · RTT`). Click the pulse icon in the toolbar (or append `?debug=1` to the URL) for the full network stats card: bytes by category, msg/s, RTT, reconnects, FPS.

## Documentation

- [`docs/LOW_NET_ARCHITECTURE.md`](docs/LOW_NET_ARCHITECTURE.md) — audit, proposed architecture, decisions, roadmap
- [`docs/VERCEL_LIMITATIONS.md`](docs/VERCEL_LIMITATIONS.md) — platform limits, classified documented/observed/assumption

## License

MIT © [Armando Peña](https://armandodev.vercel.app)
