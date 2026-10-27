import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteQuery } from '../../gui/lib/concepts.mjs';

test('Einwohner / Dichte / Durchschnittsalter map explicitly to the closest real indicator, saying so', () => {
  for (const q of ['Wie viele Einwohner hat Bremen?', 'Wie hoch ist die Bevölkerungsdichte in Essen?']) {
    const r = rewriteQuery(q); assert.match(r.query, /Anteil der 65-Jährigen/); assert.match(r.prefix, /keine absolute Einwohnerzahl|absolute Einwohnerzahl/);
  }
  assert.match(rewriteQuery('Wie hoch ist das Durchschnittsalter in Leipzig?').query, /in Leipzig\?$/);
});
test('generic Ärzte -> Hausärzte je 100.000; real Hausärzte question is untouched', () => {
  assert.match(rewriteQuery('Wie viele Ärzte gibt es in München?').query, /Hausärzte gibt es je 100\.000 Einwohner in München/);
  const q = 'Wie viele Hausärzte gibt es je 100.000 Einwohner in Berlin?'; assert.deepEqual(rewriteQuery(q), { query: q, prefix: '' });
});
test('Bundesland -> Landeshauptstadt with an explicit notice; city-states stay', () => {
  const r = rewriteQuery('Wie hoch ist die Arbeitslosenquote in Bayern?');
  assert.match(r.query, /in München\?$/); assert.match(r.prefix, /Bundesland Bayern.*München/);
  assert.equal(rewriteQuery('Wie hoch ist die Arbeitslosenquote in Hamburg?').prefix, '');
});
test('questions the catalog answers literally are not rewritten', () => {
  for (const q of ['Wie hoch ist die Arbeitslosenquote in Kiel?', 'Steuereinnahmekraft je Einwohner in Köln', 'Wie hoch ist der Ausländeranteil in Frankfurt?'])
    assert.equal(rewriteQuery(q).prefix, '');
});

import { speechChunks } from '../../gui/lib/text.mjs';
test('speechChunks: a long first sentence gets a short first chunk; short ones stay whole', () => {
  const c = speechChunks('Die Arbeitslosenquote in Hamburg, der Freien und Hansestadt, liegt im Jahr 2022 bei 6,8 Prozent. Das ist ein Wert.');
  assert.ok(c[0].length < 45, c[0]); assert.equal(c.length, 3);
  assert.deepEqual(speechChunks('In Kiel sind es 8,5 Prozent.'), ['In Kiel sind es 8,5 Prozent.']);
});
