// Runtime AI-provider switch (gui/lib/providers/config.mjs) — setProvider() is what the token-gated
// POST /admin/providers route (server.mjs) calls to flip local/cloudflare without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProviders, setProvider, usesNonEuProvider, providerSummary } from '../../gui/lib/providers/config.mjs';

test('setProvider rejects an unknown service or provider value', () => {
  assert.equal(setProvider('bogus', 'local').ok, false);
  assert.equal(setProvider('llm', 'bogus').ok, false);
  assert.equal(setProvider('llm', 'bogus').ok, false);
});

test('setProvider switches a service and reports whether it actually changed', () => {
  setProvider('llm', 'local');
  assert.equal(getProviders().llm, 'local');
  const r1 = setProvider('llm', 'cloudflare');
  assert.deepEqual(r1, { ok: true, changed: true });
  assert.equal(getProviders().llm, 'cloudflare');
  const r2 = setProvider('llm', 'cloudflare');
  assert.deepEqual(r2, { ok: true, changed: false });
  setProvider('llm', 'local');   // leave clean for the next test
});

test('usesNonEuProvider() is true iff ANY of llm/tts/stt is cloudflare', () => {
  setProvider('llm', 'local'); setProvider('tts', 'local'); setProvider('stt', 'local');
  assert.equal(usesNonEuProvider(), false);
  setProvider('tts', 'cloudflare');
  assert.equal(usesNonEuProvider(), true);
  setProvider('tts', 'local');
  assert.equal(usesNonEuProvider(), false);
});

test('providerSummary() mirrors getProviders() plus the derived gdprNotice flag', () => {
  setProvider('stt', 'cloudflare');
  const s = providerSummary();
  assert.deepEqual(s, { ...getProviders(), gdprNotice: true });
  assert.equal(s.gdprNotice, usesNonEuProvider());
  setProvider('stt', 'local');   // leave clean
});
