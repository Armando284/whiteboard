'use strict';

/**
 * Phase 7 — WebRTC audio prototype.
 *
 * Mesh P2P audio over the existing WS control plane (signaling only rides the
 * server; media is peer-to-peer). Glare-free by construction: when a peer's
 * `audio_on` is seen, only the side with the lexicographically larger cid
 * creates the offer, so both sides agree without negotiation state.
 *
 * Bandwidth stance: Opus mono, FEC on, DTX on silence, target ≈12 kbps
 * (see docs/BANDWIDTH_AUDIO.md). getStats sampling exposes the real number.
 */

const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const TARGET_BPS = 12000;
const STATS_INTERVAL_MS = 5000;

/**
 * Rewrites every Opus fmtp line to our low-rate profile. Pure → unit tested.
 * Opus is identified via its preceding `a=rtpmap:<pt> opus/…` line (fmtp
 * lines never name the codec themselves).
 * @param {string} sdp
 */
export function mungeOpusSdp(sdp) {
  /** @type {Map<string, string>} payload type → codec name */
  const codecs = new Map();
  return sdp
    .split('\r\n')
    .map((line) => {
      const rtpmap = /^a=rtpmap:(\d+) ([^/\r ]+)\//.exec(line);
      if (rtpmap) {
        codecs.set(rtpmap[1], rtpmap[2].toLowerCase());
        return line;
      }
      const fmtp = /^a=fmtp:(\d+) (.+)$/.exec(line);
      if (!fmtp || codecs.get(fmtp[1]) !== 'opus') return line;
      let head = `a=fmtp:${fmtp[1]} ${fmtp[2]}`
        .replace(/;stereo=[^;]+/g, '')
        .replace(/;maxaveragebitrate=[^;]+/g, '')
        .replace(/;usedtx=[^;]+/g, '');
      return `${head};stereo=0;maxaveragebitrate=${TARGET_BPS};usedtx=1`;
    })
    .join('\r\n');
}

export class AudioLink {
  /**
   * @param {import('../net/connection.js').Connection} conn
   * @param {{ myCid: string, onStats?: (s: AudioStats | null) => void }} opts
   */
  constructor(conn, opts) {
    this.conn = conn;
    this.myCid = opts.myCid;
    this.onStats = opts.onStats || (() => {});
    /** @type {Map<string, RTCPeerConnection>} cid → live session */
    this.peers = new Map();
    /** @type {Set<string>} cids known to have audio enabled */
    this.remoteOn = new Set();
    /** @type {MediaStream | null} */
    this.localStream = null;
    /** @type {Map<string, RTCIceCandidateInit[]>} ICE buffered pre-answer */
    this.pendingIce = new Map();
    /** @type {HTMLAudioElement[]} */
    this.audioEls = [];
    this.enabled = false;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.statsTimer = undefined;
    /** @type {{ upBps: number, downBps: number, rttMs: number } | null} */
    this.lastCounters = null;
  }

  async enable() {
    if (this.enabled) return;
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.enabled = true;
    this.conn.send(envelopeMsg('audio_on'));
    // Offer to every peer that is already on (we win ties by cid).
    for (const cid of this.remoteOn) this._maybeOffer(cid);
    this.statsTimer = setInterval(() => this._pollStats(), STATS_INTERVAL_MS);
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    clearInterval(this.statsTimer);
    this.conn.send(envelopeMsg('audio_off'));
    for (const el of this.audioEls) {
      el.srcObject = null;
      el.remove();
    }
    this.audioEls = [];
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.pendingIce.clear();
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    this.lastCounters = null;
    this.onStats(null);
  }

  /**
   * Entry point for every signaling/control frame from main.js.
   * @param {{ t: string, cid?: unknown, from?: unknown, sdp?: unknown, candidate?: unknown }} msg
   */
  handleControl(msg) {
    switch (msg.t) {
      case 'audio_on': {
        const cid = typeof msg.cid === 'string' ? msg.cid : '';
        if (!cid || cid === this.myCid) return;
        this.remoteOn.add(cid);
        this._maybeOffer(cid); // larger cid dials; see class doc
        return;
      }
      case 'audio_off': {
        const cid = typeof msg.cid === 'string' ? msg.cid : '';
        this.remoteOn.delete(cid);
        this._hangUp(cid);
        return;
      }
      case 'rtc': {
        const from = typeof msg.from === 'string' ? msg.from : '';
        const sdp = typeof msg.sdp === 'string' ? msg.sdp : '';
        if (from && sdp) this._onSdp(from, /** @type {any} */ ({ type: 'offer', sdp }));
        return;
      }
      case 'rtc_ice': {
        const from = typeof msg.from === 'string' ? msg.from : '';
        const cand = msg.candidate;
        if (from && cand && typeof cand === 'object') {
          this._onIce(from, /** @type {RTCIceCandidateInit} */ (cand));
        }
        return;
      }
    }
  }

  /**
   * @param {string} cid
   */
  _maybeOffer(cid) {
    if (!this.enabled || this.peers.has(cid)) return;
    if (this.myCid >= cid) return; // only one side dials; answerer waits
    void this._dial(cid);
  }

  /**
   * @param {string} cid
   */
  async _dial(cid) {
    try {
      const pc = this._newPeer(cid);
      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: 'offer', sdp: mungeOpusSdp(offer.sdp) });
      this.conn.send({ v: 1, t: 'rtc', to: cid, sdp: pc.localDescription?.sdp ?? offer.sdp });
    } catch (err) {
      console.warn('[low-net] audio dial failed:', err?.message || err);
      this._hangUp(cid);
    }
  }

  /**
   * @param {string} cid
   * @param {{ type: 'offer' | 'answer', sdp: string }} desc
   */
  async _onSdp(cid, desc) {
    try {
      let pc = this.peers.get(cid);
      if (desc.type === 'offer') {
        if (!pc) pc = this._newPeer(cid);
        await pc.setRemoteDescription({ type: 'offer', sdp: desc.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({ type: 'answer', sdp: mungeOpusSdp(answer.sdp) });
        this.conn.send({ v: 1, t: 'rtc', to: cid, sdp: pc.localDescription?.sdp ?? answer.sdp });
      } else {
        if (!pc) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: desc.sdp });
      }
      // Flush any ICE that arrived early.
      const queued = this.pendingIce.get(cid) || [];
      this.pendingIce.delete(cid);
      for (const c of queued) await pc.addIceCandidate(c);
    } catch (err) {
      console.warn('[low-net] audio sdp failed:', err?.message || err);
    }
  }

  /**
   * @param {string} cid
   * @param {RTCIceCandidateInit} cand
   */
  async _onIce(cid, cand) {
    const pc = this.peers.get(cid);
    if (!pc || !pc.remoteDescription) {
      const q = this.pendingIce.get(cid) || [];
      q.push(cand);
      this.pendingIce.set(cid, q);
      return;
    }
    try {
      await pc.addIceCandidate(cand);
    } catch {
      // stale candidate post-teardown is normal
    }
  }

  /**
   * @param {string} cid
   * @returns {RTCPeerConnection}
   */
  _newPeer(cid) {
    const pc = new RTCPeerConnection(STUN);
    this.peers.set(cid, pc);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.conn.send({ v: 1, t: 'rtc_ice', to: cid, candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.srcObject = ev.streams[0];
      document.body.appendChild(el);
      this.audioEls.push(el);
      el.play().catch(() => {}); // gesture context exists (mic button)
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this._hangUp(cid);
    };

    // Best-effort encoder cap (Chrome honors SDP above; this covers Firefox).
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'audio') continue;
      const p = sender.getParameters();
      p.encodings = [Object.assign({}, p.encodings?.[0], { maxBitrate: TARGET_BPS })];
      sender.setParameters(p).catch(() => {});
    }
    return pc;
  }

  /**
   * @param {string} cid
   */
  _hangUp(cid) {
    const pc = this.peers.get(cid);
    if (pc) {
      pc.close();
      this.peers.delete(cid);
    }
  }

  teardownAll() {
    for (const cid of [...this.peers.keys()]) this._hangUp(cid);
    this.remoteOn.clear();
    this.lastCounters = null;
    this.onStats(null);
  }

  async _pollStats() {
    if (!this.peers.size) {
      this.onStats(null);
      return;
    }
    let bytesSent = 0;
    let bytesRecv = 0;
    let rttMs = NaN;
    for (const pc of this.peers.values()) {
      try {
        const report = await pc.getStats();
        report.forEach((/** @type {any} */ s) => {
          if (s.type === 'outbound-rtp' && s.kind === 'audio') bytesSent += s.bytesSent || 0;
          if (s.type === 'inbound-rtp' && s.kind === 'audio') bytesRecv += s.bytesReceived || 0;
          if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.currentRoundTripTime != null) {
            rttMs = s.currentRoundTripTime * 1000;
          }
        });
      } catch {
        // closed mid-poll
      }
    }
    const now = Date.now();
    const prev = this.lastCounters;
    /** @type {{ upBps: number, downBps: number, rttMs: number }} */
    let snap;
    if (!prev) {
      snap = { upBps: 0, downBps: 0, rttMs };
    } else {
      const dt = (now - prev.at) / 1000;
      snap = {
        upBps: Math.max(0, ((bytesSent - prev.sent) * 8) / dt),
        downBps: Math.max(0, ((bytesRecv - prev.recv) * 8) / dt),
        rttMs,
      };
    }
    this.lastCounters = { sent: bytesSent, recv: bytesRecv, at: now };
    this.onStats(snap);
  }
}

/**
 * Local envelope helper kept tiny to avoid importing protocol.js here.
 * @param {string} t
 */
function envelopeMsg(t) {
  return { v: 1, t };
}
