// node --test tests/gui — bridging pools + N1 fact store, in stub mode (no engine, no network).
process.env.CC_STUB = '1';
process.env.CC_TTS_STUB = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as bridging from '../../gui/lib/bridging.mjs';
import { TTS_DIR } from '../../gui/lib/tts.mjs';
import { ttsSafe, placeFromQuery, splitSentences, swapCityFollowups } from '../../gui/lib/text.mjs';
import { OPENER_KIND, BRIDGE_KIND } from '../../gui/dialog-fsm.mjs';

test('text sanitizer: IPA and gender notation never reach TTS', () => {
  assert.equal(ttsSafe('Hannover [haˈnoːfɐ] ist groß.'), 'Hannover ist groß.');
  assert.equal(ttsSafe('Ausländer__innen je 100_000 Einwohner__innen'), 'Ausländerinnen je 100000 Einwohnerinnen');
  assert.equal(ttsSafe('München (bairisch Minga) 2023'), 'München (bairisch Minga) 2023');
});
test('sentence split keeps German ordinal dates together', () => {
  const s = splitSentences('Mit 251.842 Einwohnern (31. Dezember 2025) ist sie die größte Stadt. Kiel liegt an der Ostsee.');
  assert.equal(s.length, 2); assert.ok(s[0].includes('31. Dezember 2025)'));
});
test('placeFromQuery + swapCityFollowups', () => {
  assert.equal(placeFromQuery('Wie hoch ist die Arbeitslosenquote in Kiel?'), 'Kiel');
  assert.equal(placeFromQuery('Wie hoch ist der Ausländeranteil in Frankfurt am Main?'), 'Frankfurt');
  const sw = swapCityFollowups('Wie hoch ist die Arbeitslosenquote in Kiel?', 'Kiel', 2);
  assert.equal(sw.length, 2); assert.ok(sw[0].includes('Hamburg'));
});

test('prewarm fills every pool with stub clips; pool clips rotate per caller', async () => {
  await bridging.prewarm({ onIncomplete: () => {} });
  const st = bridging.poolStats();
  assert.equal(st.greeting, bridging.GREETINGS.length);
  assert.equal(st.gap, bridging.GAP_TEXTS.length);
  assert.equal(st.f1, bridging.F1_FACTS.length);
  const a = bridging.fromPool('gap', 'u1'), b = bridging.fromPool('gap', 'u1'), c = bridging.fromPool('gap', 'u2');
  assert.notEqual(a.text, b.text); assert.equal(a.text, c.text);
  assert.ok(existsSync(join(TTS_DIR, a.audioUrl.replace('/tts/', ''))));
});

test('openers: pool kinds instant; context bridge is templated from the previous slots (no LLM)', async () => {
  const intro = await bridging.opener(OPENER_KIND.SERVICE_INTRO, {}, 'u1');
  assert.ok(intro.audioUrl && intro.text);
  const cb = await bridging.opener(OPENER_KIND.CONTEXT_BRIDGE, { lastPlace: 'Kiel', lastIndicator: 'Arbeitslosenquote' }, 'u1');
  assert.ok(cb.text.includes('Kiel')); assert.ok(cb.audioUrl);
  const neutral = await bridging.opener(OPENER_KIND.CONTEXT_BRIDGE, {}, 'u1');
  assert.ok(bridging.NEUTRAL_BRIDGES.includes(neutral.text));
});

test('verstehen echo is cached by text', async () => {
  const v1 = await bridging.verstehen('Wie hoch ist die Arbeitslosenquote in Kiel?', 'u9');
  assert.equal(v1.kind, BRIDGE_KIND.VERSTEHEN); assert.ok(v1.audioUrl);
});

test('N1: takeFact before any production → F1 generic; after produceFact → the real place fact, once per caller', async () => {
  const f0 = bridging.takeFact('Kiel', 'c1');
  assert.equal(f0.kind, BRIDGE_KIND.FACT); assert.ok(bridging.F1_FACTS.includes(f0.text)); assert.equal(f0.url, null);
  await bridging.produceFact('Kiel', 'system');
  assert.equal(bridging.factStats().prepared, 1);
  const f1 = bridging.takeFact('Kiel', 'c1');
  assert.ok(f1.text.startsWith('Wussten Sie schon, zu Kiel')); assert.ok(f1.url); assert.ok(f1.audioUrl);
  const f2 = bridging.takeFact('Kiel', 'c1');        // same caller: never the same fact twice → F1
  assert.notEqual(f2.audioUrl, f1.audioUrl);
  const f3 = bridging.takeFact('Kiel', 'c2');        // another caller may hear it
  assert.equal(f3.audioUrl, f1.audioUrl);
  await bridging.produceFact('Hamburg', 'system');
  // a question about Lübeck never gets another place's fact (it sounded random): F1 generic instead
  const f4 = bridging.takeFact('Lübeck', 'c3');
  assert.ok(bridging.F1_FACTS.includes(f4.text)); assert.equal(f4.place, null);
  // only a question WITHOUT a place may take the freshest prepared fact
  const f5 = bridging.takeFact('', 'c3');
  assert.ok(f5.text.includes('Hamburg'));
});

test('inviteText derives a closed question from a validated suggestion', () => {
  const t = bridging.inviteText('Wie hoch ist die Arbeitslosenquote in Lübeck?', 'u1');
  assert.ok(t.includes('wie hoch die Arbeitslosenquote in Lübeck ist'));
  assert.ok(/\?$|\.$/.test(t));
});

test('inviteText moves a "gibt es" to the end wherever it stood in the question', () => {
  const t = bridging.inviteText('Wie viele Hausärzte gibt es je 100.000 Einwohner in Hamburg?', 'u7');
  assert.ok(t.includes('wie viele Hausärzte je 100.000 Einwohner es in Hamburg gibt'), t);
  assert.ok(!t.includes('gibt es je'), t);
  const t2 = bridging.inviteText('Wie viele Ladepunkte gibt es in Kiel?', 'u7');
  assert.ok(t2.includes('wie viele Ladepunkte es in Kiel gibt'), t2);
});
