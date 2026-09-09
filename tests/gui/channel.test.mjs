// ChannelClient against the fake persistent ct-agent (tests/gui/fake-ct-agent.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ChannelClient, parseEnvelope, channelCommand } from '../../gui/lib/channel.mjs';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fake-ct-agent.mjs');
const fake = (envs = '') => () => `${envs} node "${FAKE}"`;
const pid = (s) => (s.match(/pid=(\d+)/) || [])[1];

test('parseEnvelope: ok/error envelopes, non-envelope lines ignored', () => {
  assert.deepEqual(parseEnvelope('{"ok":true,"output":"https://x/y.wav"}'), { ok: true, output: 'https://x/y.wav' });
  assert.deepEqual(parseEnvelope('{"ok":false,"error":"boom"}'), { ok: false, error: 'boom' });
  assert.equal(parseEnvelope('diag: something'), null);
  assert.equal(parseEnvelope('{"no":"ok field"}'), null);
  assert.equal(parseEnvelope(''), null);
});

test('channelCommand: persistent by default, one-shot on request, service slug and env references in place', () => {
  const c = channelCommand('speech_to_text', { env: { CT_AUDIO_CHANNEL_ID: 'chan-1' } });
  assert.ok(c.includes('CT_CHANNEL_CALL_SERVICE=speech_to_text'));
  assert.ok(c.includes('CT_CHANNEL_CALL_PERSISTENT=1'));
  assert.ok(c.includes('CT_CHANNEL_ID="chan-1"'));
  assert.ok(c.includes('"$CT_AGENT_BIN" channel'));
  assert.ok(channelCommand('audio_generation', { persistent: false, env: {} }).includes('CT_CHANNEL_CALL_PERSISTENT=0'));
});

test('one held process answers many calls in order — no respawn per call', async () => {
  const c = new ChannelClient('t', { size: 1, command: fake(), timeoutMs: 2000 });
  const a = await c.call({ text: 'eins' });
  const b = await c.call({ text: 'zwei' });
  const d = await c.call('{"text":"drei"}');
  assert.ok(a.startsWith('echo#1:eins'), a); assert.ok(b.startsWith('echo#2:zwei'), b); assert.ok(d.startsWith('echo#3:drei'), d);
  assert.equal(pid(a), pid(b)); assert.equal(pid(b), pid(d));
  assert.equal(c.status().spawns, 1);
  c.close();
});

test('concurrent calls queue on one process and spread over a pool of two', async () => {
  const one = new ChannelClient('t', { size: 1, command: fake('FAKE_DELAY_MS=60'), timeoutMs: 2000 });
  const t0 = Date.now();
  const r1 = await Promise.all([one.call({ text: 'a' }), one.call({ text: 'b' }), one.call({ text: 'c' })]);
  assert.ok(r1.every(Boolean)); assert.equal(new Set(r1.map(pid)).size, 1, 'one process served all three');
  assert.ok(Date.now() - t0 >= 150, 'serialized on one process');
  one.close();
  const two = new ChannelClient('t', { size: 2, command: fake('FAKE_DELAY_MS=60'), timeoutMs: 2000 });
  const r2 = await Promise.all([two.call({ text: 'a' }), two.call({ text: 'b' })]);
  assert.equal(new Set(r2.map(pid)).size, 2, 'two processes for two parallel calls');
  assert.equal(two.status().spawns, 2);
  two.close();
});

test('a failed call resolves null, the process is replaced, the next call works', async () => {
  const c = new ChannelClient('t', { size: 1, command: fake('FAKE_FAIL_ON=bad'), timeoutMs: 2000 });
  const ok1 = await c.call({ text: 'fine' });
  const bad = await c.call({ text: 'bad one' });
  const ok2 = await c.call({ text: 'fine again' });
  assert.ok(ok1 && ok2); assert.equal(bad, null);
  assert.notEqual(pid(ok1), pid(ok2), 'the failed process was replaced');
  assert.equal(c.status().deaths, 1);
  c.close();
});

test('a hung call times out to null and the worker is dropped; later calls still work', async () => {
  const c = new ChannelClient('t', { size: 1, command: fake('FAKE_HANG_ON=hang'), timeoutMs: 150 });
  const t0 = Date.now();
  const r = await c.call({ text: 'hang here' });
  assert.equal(r, null); assert.ok(Date.now() - t0 >= 140 && Date.now() - t0 < 1500);
  const ok = await c.call({ text: 'after' }, 2000);
  assert.ok(ok && ok.includes('after'));
  c.close();
});

test('a process that dies at start backs off instead of spawn-storming; a healthy one resets', async () => {
  const c = new ChannelClient('t', { size: 1, command: fake('FAKE_DIE_AT_START=1'), timeoutMs: 1000 });
  const t0 = Date.now();
  const rs = await Promise.all([c.call({ text: 'x' }), c.call({ text: 'y' })]);
  assert.deepEqual(rs, [null, null]);
  assert.ok(c.nextSpawnAt > t0, 'backoff armed after near-instant deaths');
  assert.ok(c.status().spawns <= 3, 'no spawn storm: ' + c.status().spawns);
  c.close();
});

test('non-envelope diagnostic lines on stdout are ignored', async () => {
  const c = new ChannelClient('t', { size: 1, command: fake('FAKE_NOISE=1'), timeoutMs: 2000 });
  const r = await c.call({ text: 'noisy' });
  assert.ok(r && r.startsWith('echo#1:noisy'), r);
  c.close();
});

test('a payload with a newline is refused (one call = one line)', async () => {
  const c = new ChannelClient('t', { size: 1, command: fake(), timeoutMs: 2000 });
  assert.equal(await c.call('line one\nline two'), null);
  assert.equal(c.status().spawns, 0);
  c.close();
});

test('tts.mjs speaks over the held channel: one process, many clips, URL handed back', async () => {
  // A wrapper that ignores ct-agent's argv/env and runs the fake in persistent mode with URL output.
  const { writeFileSync, mkdtempSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'cc-chan-'));
  const bin = join(dir, 'fake-ct-agent.sh'); const relayEnv = join(dir, 'relay.env');
  writeFileSync(bin, `#!/bin/bash\nFAKE_URL=1 exec node "${FAKE}"\n`); chmodSync(bin, 0o755); writeFileSync(relayEnv, '# empty\n');
  Object.assign(process.env, { CT_AGENT_BIN: bin, CT_RELAY_ENV: relayEnv, CT_AUDIO_CHANNEL_ID: 'test-chan', CC_TTS: '1', CC_CHANNEL_MODE: 'persistent' });
  delete process.env.CC_TTS_STUB; delete process.env.CC_PIPER_BIN;
  const { ttsSpeak } = await import('../../gui/lib/tts.mjs');
  const { channelStats, closeChannels } = await import('../../gui/lib/channel.mjs');
  const urls = await Promise.all(['Guten Tag.', 'Ich habe verstanden.', 'Wussten Sie schon?'].map((t) => ttsSpeak(t, { priority: false, userKey: 'u1' })));
  assert.ok(urls.every((u) => u && /clip-\d+\.wav$/.test(u)), JSON.stringify(urls));
  const st = channelStats().find((c) => c.service === 'audio_generation');
  assert.ok(st, 'a held audio_generation client exists');
  assert.equal(st.spawns, 1, 'ONE process for three clips'); assert.equal(st.ok, 3);
  closeChannels();
});
