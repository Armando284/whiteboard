'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { mungeOpusSdp } from '../public/js/audio/audiolink.js';

test('mungeOpusSdp pins opus to mono 12 kbps with DTX, leaves others untouched', () => {
  const sdp = [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 0',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:0 PCMU/8000',
    'a=fmtp:0 something=1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=rtpmap:96 VP8/90000',
    'a=fmtp:96 x-google-start-bitrate=1000',
    '',
  ].join('\r\n');

  const out = mungeOpusSdp(sdp);
  const opus = out.split('\r\n').find((l) => l.startsWith('a=fmtp:111'));
  assert.ok(opus);
  assert.match(opus, /minptime=10;useinbandfec=1/); // original params preserved
  assert.match(opus, /;stereo=0;/);
  assert.match(opus, /;maxaveragebitrate=12000;/);
  assert.match(opus, /;usedtx=1$/);

  // Non-opus audio and video fmtp lines are untouched.
  assert.match(out, /^a=fmtp:0 something=1\r?$/m);
  assert.match(out, /x-google-start-bitrate=1000/);
});

test('mungeOpusSdp replaces stale knobs instead of duplicating them', () => {
  const once = mungeOpusSdp(
    'a=rtpmap:111 opus/48000/2\r\n' +
      'a=fmtp:111 useinbandfec=1;stereo=1;maxaveragebitrate=32000;usedtx=0\r\n',
  );
  const twice = mungeOpusSdp(once);
  assert.equal((twice.match(/maxaveragebitrate/g) || []).length, 1);
  assert.equal((twice.match(/stereo=/g) || []).length, 1);
  assert.match(twice, /maxaveragebitrate=12000/);
});

test('mungeOpusSdp is a no-op without opus lines', () => {
  const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n';
  assert.equal(mungeOpusSdp(sdp), sdp);
});
