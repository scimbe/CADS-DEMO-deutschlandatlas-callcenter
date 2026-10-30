// Text helpers shared by TTS, bridging and the pipeline glue. Pure functions, no I/O.

// Strip bracketed IPA-pronunciation spans (e.g. "Hannover [haˈnoːfɐ]") that raw Wikipedia extracts
// put after a name — a TTS voice would read them out as garbage. Prose and numbers are untouched.
export function stripPronunciation(text) {
  return String(text || '')
    .replace(/[\[(（][^\[\]()（）]*[ˈˌːˑ‿˥˦˧˨˩][^\[\]()（）]*[\])）]/gu, '')   // bracketed span with an IPA stress/length/tone mark
    .replace(/[\[(（][^\[\]()（）]*\b(?:IPA|Aussprache|Lautschrift|phonetisch)\b[^\[\]()（）]*[\])）]/gi, '')
    .replace(/\/[^/\n]{1,60}?[ˈˌːˑ‿][^/\n]{0,60}?\//gu, '')          // slash-delimited phonemic notation /haˈnoːfɐ/
    .replace(/,?\s*\b(?:Aussprache|Lautschrift)\b\s*:?\s*(?=[,.;:]|\s|$)/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// German gender-inclusive double-underscore notation ("Ausländer__innen") and underscore-grouped
// numbers ("100_000") are written conventions, never meant to be SPOKEN. Merge the halves.
export function stripGenderNotation(text) {
  return String(text || '')
    .replace(/(\p{L})_{1,2}(\p{L})/gu, '$1$2')
    .replace(/(\d)_(\d)/g, '$1$2');
}

/** Everything that is about to be spoken passes here exactly once (invariant I10). */
export function ttsSafe(text) { return stripGenderNotation(stripPronunciation(text)); }

/** The capitalised place name after in/für/von/zu/über in a German question, or null. */
export function placeFromQuery(q) {
  const m = String(q || '').match(/\b(?:in|für|von|zu|über)\s+([A-ZÄÖÜ][\wäöüß.-]+(?:\s[A-ZÄÖÜ][\wäöüß.-]+)?)/);
  return m ? m[1].replace(/[.?!,;:]+$/, '').trim() : null;
}

/** Normalised key for a place name (case/umlaut/whitespace-insensitive). */
export function placeKey(p) {
  return String(p || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Sentence split that does not chop German ordinal-date abbreviations ("31. Dezember") mid-fact,
// and only splits where the next sentence really starts with a capital letter or a quote.
export function splitSentences(text) {
  return String(text || '').split(/(?<!\d[.!?])(?<=[.!?])\s+(?=[A-ZÄÖÜ"„])/).map((s) => s.trim()).filter(Boolean);
}

/** Large German kreisfreie Städte — every Deutschlandatlas indicator has a value for each, so a
 *  place swap of an already-answered question is answerable by construction. */
export const BIG_CITIES = ['Hamburg', 'München', 'Köln', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Leipzig',
  'Dresden', 'Hannover', 'Nürnberg', 'Bremen', 'Dortmund', 'Essen', 'Bochum', 'Rostock', 'Kiel', 'Berlin'];

/** Follow-ups built by swapping the place in a query that already resolved to real data. */
export function swapCityFollowups(query, place, n) {
  const p = (place || '').trim();
  if (!p || !query.includes(p)) return [];
  const out = [];
  for (const c of BIG_CITIES) {
    if (out.length >= n) break;
    if (c === p || p.includes(c) || c.includes(p)) continue;
    out.push(query.replace(p, c));
  }
  return out;
}

/** Sentences for speech with a SHORT first chunk: a long first sentence is split at the first comma /
 *  semicolon / " und " after ~25 characters, so the first audio is ready sooner (synthesis time grows
 *  with length). Later sentences stay whole. */
export function speechChunks(text, maxFirst = 70) {
  const sents = splitSentences(text);
  if (!sents.length) return sents;
  const first = sents[0];
  if (first.length > maxFirst) {
    const m = first.slice(24).search(/[,;:]\s|\sund\s/);
    if (m >= 0) {
      const cut = 24 + m + 1;
      const a = first.slice(0, cut).trim().replace(/[,;:]$/, ''), b = first.slice(cut).trim().replace(/^und\s+/, '');
      if (a.length >= 20 && b.length >= 12) return [a + '.', b, ...sents.slice(1)];
    }
  }
  return sents;
}

/** Spoken/API text hygiene: no control characters (they break strict JSON consumers that re-echo bodies
 *  through a shell), line breaks become spaces. */
export function cleanSpoken(text) {
  return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/,\s*(?:der\s+)?Freie[nr]?\s+(?:und\s+)?Hansestadt\s*,?/g, '')   // official name, unreadable when spoken
    .replace(/\s{2,}/g, ' ').trim();
}
