# Audio bandwidth (phase 7)

WebRTC audio prototype: what the pipeline costs, which knobs are pinned, and
how to read the real number in the browser. Real-world measurements under
throttled networks are collected in phase 9 (`BANDWIDTH_REPORT.md`); this
document fixes the configuration under test and the expected envelope.

## Pipeline

- Mesh P2P (`RTCPeerConnection` per remote audio-on peer), STUN only
  (`stun:stun.l.google.com:19302`). TURN is deferred (see
  `LOW_NET_ARCHITECTURE.md` §4.8) — some restrictive NATs will fall back to
  avatar-only mode by design.
- Codec **Opus**, mono, configured three ways so at least one sticks per
  browser:
  1. SDP munging on offer/answer: `stereo=0;maxaveragebitrate=12000;usedtx=1`
     (FEC stays on — it is the cheap insurance for lossy links).
  2. `RTCRtpSender.setParameters({encodings:[{maxBitrate:12000}]})`.
  3. getStats verification of what actually went out.
- Signaling rides the room WS (~6 kB per peer pair, once).

## Expected wire cost (per speaking peer)

| Regime | Bitrate | Source |
|---|---|---|
| Talking, FEC on | ≈12–16 kbps | maxaveragebitrate cap + Opus overhead |
| Silence, DTX active | <1 kbps (comfort noise frames) | usedtx=1 |
| Muted track (browser-level) | ~0 kbps | no RTP produced |

Budget check @120 kbps uplink: one voice stream ≈ **0.08–0.13 %** of the
uplink; even a 8-person full mesh (7 inbound + 1 outbound) totals ≈1.3 Mbps
aggregate downlink — fine for broadband, but the *outbound* side stays a
single ≈12–16 kbps stream regardless of mesh size (each sender encodes once).
That asymmetry is the reason mesh audio is viable here while mesh video is not.

## Reading the real number

The stats card shows an "Audio P2P" row fed by `getStats()` every 5 s:

```
Audio P2P    12.3↑ 11.8↓ kbps · 84 ms
```

- `↑` = sum of `outbound-rtp.bytesSent` deltas across all live peer
  connections ÷ elapsed time.
- `↓` = same over `inbound-rtp.bytesReceived`.
- RTT from the connected `candidate-pair.currentRoundTripTime`.

Sanity expectations when testing manually:
1. Right after connect: both counters near 0 until someone speaks (DTX).
2. While speaking continuously: `↑` settles near the 12–16 kbps band. If it
   reads ≈24–32 kbps, the SDP munge did not apply — check that both sides ran
   the munged answer (`chrome://webrtc-internals` shows negotiated fmtp).
3. Silence for >10 s: `↑` should decay towards ≈1 kbps (DTX). If it doesn't,
   `usedtx=1` was stripped somewhere.

## Known prototype gaps (by design)

- Late joiners don't learn existing `audio_on` state until the next toggle
  (presence does not carry audio state yet).
- Simultaneous enable/disable races resolve via the cid tie-break rule; there
  is no perfect-negotiation rollback machinery.
- No TURN: symmetric-NAT pairs will fail ICE and stay avatar-only.
