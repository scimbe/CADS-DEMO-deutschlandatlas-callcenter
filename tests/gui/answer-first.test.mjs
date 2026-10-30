import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socialReply, worthAnswering, answerableGuess, turnPlace } from '../../gui/lib/answer-first.mjs';

const u = (o) => ({ precise: false, best_guess: '', slots: { ort: null, indikator: null }, ...o });

test('greeting, thanks and goodbye get a reply without a data question', () => {
  for (const q of ['Hallo', 'Guten Tag!', 'Danke, das war alles', 'Vielen Dank', 'Tschüss']) assert.ok(socialReply(q), q);
  for (const q of ['Hallo, wie hoch ist die Miete in Kiel?', 'Wie hoch ist die Arbeitslosenquote in Kiel?']) assert.equal(socialReply(q), null, q);
});
test('a place and a topic are worth answering, however broad the topic', () => {
  for (const q of ['Wie ist die Breitbandversorgung in Kiel?', 'Wie viele Einwohner hat die Stadt Berlin?', 'Wie steht es um die Krankenhäuser in Essen?'])
    assert.equal(worthAnswering(u({ best_guess: q, slots: { ort: 'Kiel', indikator: null } }), q), true, q);
});
test('no place, no topic or an already precise turn are not', () => {
  assert.equal(worthAnswering(u({ best_guess: 'Wie ist das Wetter morgen?' }), 'Wie ist das Wetter morgen?'), false);
  assert.equal(worthAnswering(u({ best_guess: 'Wie ist die Lage in Bremen?', slots: { ort: 'Bremen' } }), 'Wie ist die Lage in Bremen?'), false);
  assert.equal(worthAnswering(u({ precise: true, slots: { ort: 'Kiel' } }), 'x'), false);
});
test('the best guess always names the place', () => {
  const v = u({ best_guess: 'Anteil der betreuten Kinder unter 3 Jahren', slots: { ort: 'Rostock' } });
  assert.equal(answerableGuess(v, 'Gibt es in Rostock genug Kitaplätze?'), 'Anteil der betreuten Kinder unter 3 Jahren in Rostock?');
  assert.equal(answerableGuess(u({ best_guess: 'Wie hoch ist die Miete in Kiel?', slots: { ort: 'Kiel' } }), 'x'), 'Wie hoch ist die Miete in Kiel?');
  assert.equal(turnPlace(u({ best_guess: 'Wie hoch ist die Miete in Kiel?' }), 'x'), 'Kiel');
});
test('official city-state names are not read out', async () => {
  const { cleanSpoken } = await import('../../gui/lib/text.mjs');
  assert.equal(cleanSpoken('In Hamburg, der Freie und Hansestadt, liegen die Mieten bei 11 Euro.'), 'In Hamburg liegen die Mieten bei 11 Euro.');
  assert.equal(cleanSpoken('Die Quote in Bremen, Freie Hansestadt, liegt bei 9 Prozent.'), 'Die Quote in Bremen liegt bei 9 Prozent.');
});
