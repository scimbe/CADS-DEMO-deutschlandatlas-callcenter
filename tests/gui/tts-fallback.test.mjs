// node --test tests/gui — the "never silent, never slow" guarantees: channel circuit breaker,
// dead-clip detection, and the browser-voice fallback per sentence.
process.env.CC_STUB = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, Dialog } from '../../gui/dialog-client.mjs';
import { probeChannelClip, localizeChannelClip, channelFailed, channelOk, channelUsable, channelBreaker } from '../../gui/lib/tts.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function fakeAudio() {
  const a = { src: '', paused: true, ended: false, currentTime: 0, muted: false, log: [] };
  a.load = () => { setTimeout(() => a.oncanplaythrough && a.oncanplaythrough(), 1); };
  a.play = () => { a.paused = false; a.currentTime = 0.01; a.log.push(a.src); setTimeout(() => { a.paused = true; a.onended && a.onended(); }, 10); return Promise.resolve(); };
  a.pause = () => {};
  return a;
}
const settle = async (p) => { for (let i = 0; i < 200; i++) { if (!p.busy && !p.queue.some((it) => !it.played && it.ready)) return; await tick(5); } };

test('a channel clip on an unreachable host is rejected (null), never returned as a dead URL', async () => {
  const dead = () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  assert.equal(await localizeChannelClip('https://site-x.bunsenbrenner.org/audio/a.wav', dead), null);
  assert.equal(await localizeChannelClip('https://x/a.wav', async () => ({ ok: false, status: 502 })), null);
  assert.equal(await localizeChannelClip('https://x/a.wav', async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })), null);
});

test('circuit breaker opens on failure, skips the channel during cooldown, closes on success', () => {
  channelOk(); assert.equal(channelUsable(), true);
  channelFailed(); assert.equal(channelUsable(), false); assert.equal(channelBreaker.failures, 1);
  channelBreaker.downUntil = Date.now() - 1;         // cooldown elapsed -> the next call probes again
  assert.equal(channelUsable(), true);
  channelOk(); assert.equal(channelBreaker.failures, 0);
});

test('Player speaks fallbackText with the browser voice when a slot has no audio', async () => {
  const spoken = [], a = fakeAudio();
  const p = new Player(a, { speak: async (t) => { spoken.push(t); } });
  const s = p.enqueue('answer', { fallbackText: 'In Kiel 5,1 Prozent.' }); p.fill(s, null);
  await settle(p);
  assert.deepEqual(spoken, ['In Kiel 5,1 Prozent.']); assert.deepEqual(a.log, []);
});

function dlg({ speakFn, sentences }) {
  const spoken = [], a = fakeAudio(), calls = [];
  const player = new Player(a, { speak: async (t) => { spoken.push(t); } });
  const api = { speak: async (t, b) => { calls.push(t); return speakFn(t); } };
  const d = new Dialog({ player, api, ui: {}, firstSentenceBudgetMs: 50 });
  return { d, spoken, a, calls, player };
}

test('first sentence has no audio in time -> browser speaks the WHOLE answer, no further server calls', async () => {
  const { d, spoken, a, calls, player } = dlg({ speakFn: async () => ({ audioUrl: null }) });
  d._speakAnswer(['Satz eins.', 'Satz zwei.']);
  await tick(30); await settle(player);
  assert.deepEqual(spoken, ['Satz eins.', 'Satz zwei.']); assert.deepEqual(a.log, []); assert.deepEqual(calls, ['Satz eins.']);
});

test('server audio ready -> every sentence is played as audio, in order, first one immediately', async () => {
  const { d, spoken, a, player } = dlg({ speakFn: async (t) => ({ audioUrl: '/' + t.replace(/\W/g, '') + '.wav' }) });
  d._speakAnswer(['Satz eins.', 'Satz zwei.']);
  await tick(30); await settle(player);
  assert.deepEqual(a.log, ['/Satzeins.wav', '/Satzzwei.wav']); assert.deepEqual(spoken, []);
});

test('probeChannelClip: reachable clip host -> true; reset / 404 / empty -> false (server never downloads the clip)', async () => {
  const ok = async (u, o) => { assert.equal(o.headers.range, 'bytes=0-1023'); return { status: 206, arrayBuffer: async () => new Uint8Array(10).buffer }; };
  assert.equal(await probeChannelClip('https://x/a.wav', ok), true);
  assert.equal(await probeChannelClip('https://x/a.wav', async () => ({ status: 404, arrayBuffer: async () => new ArrayBuffer(0) })), false);
  assert.equal(await probeChannelClip('https://x/a.wav', async () => { throw new TypeError('fetch failed'); }), false);
  assert.equal(await probeChannelClip('https://x/a.wav', async () => ({ status: 200, arrayBuffer: async () => new ArrayBuffer(0) })), false);
});

test('a clip that fails to load is spoken by the browser voice instead of being skipped', async () => {
  const spoken = [], a = fakeAudio();
  a.load = () => { setTimeout(() => a.onerror && a.onerror(new Error('404')), 1); };
  const p = new Player(a, { speak: async (t) => { spoken.push(t); } });
  const s = p.enqueue('answer', { fallbackText: 'Satz.' }); p.fill(s, 'https://dead/a.wav');
  await settle(p); await tick(20);
  assert.deepEqual(spoken, ['Satz.']);
});
