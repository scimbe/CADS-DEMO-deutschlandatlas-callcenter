// Answer first, ask second: a caller who names a place and a topic gets a number, not a question.
// The model likes to ask "which exact indicator?" even when one fits well enough; the question is
// only kept when no real data exists for its best guess. Pure + deterministic (no LLM, no I/O).
import { placeFromQuery } from './text.mjs';

// Greeting, thanks and goodbye are not data questions: no model call, no Atlas query.
const GREETING = /^(hallo|hi|hey|moin|servus|guten (tag|morgen|abend)|grüß gott)[\s,.!]*$/i;
const THANKS = /^(vielen |herzlichen )?dank(e)?\b|^das war('?s| alles)\b/i;
const GOODBYE = /^(tschüss|tschüs|auf wieder(sehen|hören)|ciao|bye)\b/i;

export function socialReply(query) {
  const q = String(query || '').trim();
  if (GOODBYE.test(q)) return 'Auf Wiederhören!';
  if (THANKS.test(q)) return 'Gern geschehen. Sie können jederzeit weiterfragen.';
  if (GREETING.test(q)) return 'Guten Tag! Nennen Sie mir ein Thema und einen Ort, zum Beispiel die Arbeitslosenquote in Leipzig.';
  return null;
}

// "Wie ist die Lage in Bremen?" names a place but no topic: any indicator would be a random pick.
const NO_TOPIC = /^(wie|was)\s+(ist|sieht|läuft|geht|gibt)\s+(es\s+)?(denn\s+)?(die\s+|der\s+|das\s+)?(lage|situation|stimmung|leben|los|aus|so)\b/i;

/** The place of the turn, from the model's slots or the text. */
export const turnPlace = (u, query) => (u.slots && u.slots.ort) || placeFromQuery(u.best_guess) || placeFromQuery(query) || null;

/** The best guess as a question that names the place (the model sometimes returns the bare indicator). */
export function answerableGuess(u, query) {
  const place = turnPlace(u, query);
  const guess = String(u.best_guess || query || '').trim();
  if (!place || guess.toLowerCase().includes(place.toLowerCase())) return guess;
  return `${guess.replace(/[?.!]+$/, '')} in ${place}?`;
}

/** Worth trying the data before asking back? Needs a place and an actual topic. */
export function worthAnswering(u, query) {
  if (u.precise || !turnPlace(u, query)) return false;
  return !NO_TOPIC.test(String(query || '').trim());
}

/** The line to say when the model has nothing to ask either (e.g. the weather): never stay silent. */
export const OUT_OF_SCOPE = 'Dazu habe ich keine Daten. Ich kenne Regionaldaten zu Arbeit, Wohnen, Gesundheit, Bildung und Umwelt. Nennen Sie mir ein Thema und einen Ort.';
