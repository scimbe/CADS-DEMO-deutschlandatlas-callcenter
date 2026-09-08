// LLM-backed dialogue steps (litellm-proxy, OpenAI-compatible) + the Wikipedia fact source.
import { resolveOffered } from '../dialog-fsm.mjs';
// Every step degrades gracefully (empty object / original text / null) and retries transient
// proxy resets. CC_STUB=1 replaces all of them with deterministic offline stand-ins so the whole
// dialogue can be exercised (tests, offline demo) without a proxy or the network.
import { readFileSync } from 'node:fs';
import { placeFromQuery, stripPronunciation, splitSentences } from './text.mjs';

export const STUB = process.env.CC_STUB === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Compact list of the indicators the dataset can actually answer — injected into the
// understand/follow-up prompts so suggested questions are always answerable.
export function catalogSummary(catalogPath) {
  try {
    const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const rows = cat.rows || Object.values(cat).find(Array.isArray) || [];
    const seen = new Set(), lines = [];
    for (const r of rows) {
      if (r.kind !== 'indicator') continue;
      const desc = (r.snippet || '').replace(/\s+/g, ' ').replace(/,?\s*(im Jahr|in\s*_?)?\s*\d{4}.*$/i, '').trim();
      const k = desc.slice(0, 45).toLowerCase();
      if (desc.length < 12 || seen.has(k)) continue;
      seen.add(k); lines.push('- ' + desc.slice(0, 95));
    }
    return lines.join('\n');
  } catch { return ''; }
}

async function chat(body) {
  const base = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LITELLM_API_KEY, model = process.env.LITELLM_DEFAULT_MODEL || 'local-devstral-small2';
  const RETRIES = 3;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, ...body }),
      });
      if (!resp.ok) { if (resp.status >= 500 && attempt < RETRIES) { await sleep(300 * attempt); continue; } return null; }
      const j = await resp.json();
      return (j.choices?.[0]?.message?.content || '').trim();
    } catch (e) {
      const msg = String((e && e.cause && e.cause.code) || (e && e.message) || e);
      if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|UND_ERR|fetch failed|socket|network|terminated|other side closed/i.test(msg) && attempt < RETRIES) { await sleep(300 * attempt); continue; }
      return null;
    }
  }
  return null;
}
async function llmJSON(system, user) {
  const out = await chat({ temperature: 0, max_tokens: 400, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
  try { return JSON.parse(out || '{}'); } catch { return {}; }
}

// ---------------------------------------------------------------------------------------------
// narrate(): rephrase into spoken German WITHOUT changing facts. Numbers are the falsification
// risk: if any number from the source is missing in the output, the original text is kept.
const NARRATE_SYS = {
  funfact: 'Formuliere den folgenden Wikipedia-Auszug in einen kurzen, sachlich-freundlichen, gesprochenen deutschen Sprechtext um (maximal 2 Sätze), im Ton einer knappen Nachrichtenmeldung — NICHT wie Werbetext oder ein Reiseführer (vermeide Formulierungen wie "lebendige Metropole", "im Herzen von", "ein Muss für..."). Behalte JEDE Zahl, JEDEN Namen und JEDEN Fakt exakt bei; erfinde NICHTS und verfälsche nichts. Antworte NUR mit dem umformulierten Text, ohne Anführungszeichen, ohne Vorrede.',
  answer: 'Formuliere die folgende Datenauskunft in flüssigen, leicht erzählenden deutschen Sprechtext um (1 bis 3 Sätze, nicht nur kurze Hauptsätze aneinanderreihen). Behalte JEDE Zahl, JEDEN Orts- und Eigennamen und JEDEN Fakt exakt bei; erfinde NICHTS hinzu. Antworte NUR mit dem umformulierten Text, ohne Anführungszeichen, ohne Vorrede.',
};
export async function narrate(text, mode) {
  const srcT = (text || '').trim();
  if (srcT.length < 12 || STUB) return srcT;
  const out = (await chat({ temperature: 0.4, max_tokens: 260,
    messages: [{ role: 'system', content: NARRATE_SYS[mode] || NARRATE_SYS.answer }, { role: 'user', content: srcT }] }) || '')
    .replace(/^["'»“]+|["'«”]+$/g, '').trim();
  if (!out || out.length < 10 || out.length > srcT.length * 3 + 120) return srcT;
  const nums = (srcT.match(/\d[\d.,]*/g) || []).map((n) => n.replace(/[.,]+$/, ''));
  for (const n of nums) { if (!out.includes(n)) return srcT; }
  return out;
}

// ---------------------------------------------------------------------------------------------
// understand(): classify + resolve the utterance to ONE clean question (indicator + place).
const UNDERSTAND_SYS = [
  'Du bist die Dialogführung eines deutschen Sprach-Callcenters für Deutschlandatlas-Regionaldaten',
  '(Themen: Kriminalität/Sicherheit, Bildung, Beschäftigung, Wohnen, Bevölkerung, Umwelt, Gesundheit,',
  'Finanzen, Infrastruktur). Der Datensatz liefert pro Ort je einen Indikator, oft als Quote/Anteil',
  'bzw. je 100.000 Einwohner. Deine Aufgabe: den Anrufer mit einer gezielten Rückfrage zu EINER',
  'sauberen Anfrage führen (genau ein Indikator + ein Ort) und die wahrscheinlichste Absicht raten.',
  'Es gibt ein GEDÄCHTNIS der bisherigen Turns. Entscheide zuerst, ob die neue Eingabe eine',
  'NEUE, eigenständige Frage ist ("neu") oder ein ANSCHLUSS an den letzten Turn ("anschluss") —',
  'letzteres bei kurzen/elliptischen Eingaben, die nur einen Teil ändern oder ergänzen',
  '(z.B. "und in Hamburg?" = anderer Ort, selber Indikator; "und die Kriminalität?" = anderer',
  'Indikator, selber Ort; "ja bitte", "und dort?", "wie viele genau?"). Bei "anschluss" MUSST du',
  'die neue Eingabe MIT dem Gedächtnis zu EINER vollständigen, eigenständigen Frage auflösen:',
  'fehlt der Ort, nimm den zuletzt genannten Ort; fehlt der Indikator, nimm den zuletzt genannten',
  'Indikator. Kurze Zusatzinfos beziehen sich immer auf die zuletzt beantwortete Frage.',
  'Antworte NUR mit striktem JSON, ohne Erklärung, ohne Markdown:',
  '{"kind": "neu" | "anschluss",',
  ' "precise": boolean,   // true nur wenn (nach Auflösung) genau EIN Indikator UND ein Ort eindeutig sind',
  ' "clarify": string,    // EINE kurze, freundliche deutsche Rückfrage, die zur sauberen Anfrage führt (leer wenn precise=true)',
  ' "best_guess": string, // die vollständige, AUFGELÖSTE konkrete Frage als deutscher Fragesatz (Indikator + Ort); IMMER gesetzt',
  ' "options": [string],  // 2-3 konkrete alternative Fragesätze zur Auswahl (je Indikator + Ort)',
  ' "slots": {"ort": string|null, "indikator": string|null}}  // die für best_guess erkannten Slots',
  'Fehlt der Ort auch nach Auflösung, frage gezielt nach dem Ort. Ist das Thema unklar, biete die naheliegendsten Indikatoren an.',
].join('\n');
// If we just asked a clarifying question, the next utterance is resolved AGAINST it first.
const CLARIFY_SYS = [
  'Du bist die Dialogführung eines deutschen Sprach-Callcenters für Deutschlandatlas-Regionaldaten.',
  'Das System hat SOEBEN eine Rückfrage gestellt. Der Nutzer ANTWORTET nun darauf. Deine Aufgabe:',
  'die Antwort mit der ursprünglich unklaren Eingabe und den angebotenen Optionen zu EINER',
  'vollständigen, eigenständigen deutschen Frage (genau ein Indikator + ein Ort) auflösen.',
  'Wählt die Antwort klar eine Option / den best_guess, oder liefert sie den fehlenden Ort bzw.',
  'Indikator, dann precise=true. Bleibt es unklar, precise=false und stelle EINE erneute Rückfrage.',
  'Der Nutzer darf in seiner Antwort auch umschwenken (anderer Indikator UND/ODER Ort) — dann folge dem.',
  'best_guess ist IMMER ein VOLLSTÄNDIGER deutscher Fragesatz mit BEIDEM: Indikator UND Ort,',
  'niemals nur der Indikatorname. slots.ort und slots.indikator müssen zu best_guess passen.',
  'Antworte NUR mit striktem JSON: {"precise": boolean, "clarify": string, "best_guess": string,',
  ' "options": [string], "slots": {"ort": string|null, "indikator": string|null}}',
].join('\n');

function memoryBlock(context) {
  if (!context) return '';
  const hist = Array.isArray(context.history) ? context.history.slice(-4) : [];
  const lines = [];
  hist.forEach((h, i) => {
    if (!h || !h.q) return;
    const a = h.answer ? ' → ' + String(h.answer).slice(0, 160) : '';
    lines.push(`  ${i + 1}. Frage: "${h.q}"${h.place ? ' [Ort: ' + h.place + ']' : ''}${a}`);
  });
  if (!lines.length && context.lastQuery) lines.push(`  1. Frage: "${context.lastQuery}"` + (context.lastAnswer ? ' → ' + String(context.lastAnswer).slice(0, 160) : ''));
  if (!lines.length) return '';
  return 'GEDÄCHTNIS (bisherige Turns, ältester zuerst, neuester zuletzt):\n' + lines.join('\n') + '\nDer letzte Turn ist der Bezugspunkt für Anschlüsse.\n\n';
}
export function normSlots(s) {
  const o = s && typeof s === 'object' ? s : {};
  return { ort: o.ort ? String(o.ort) : null, indikator: o.indikator ? String(o.indikator) : null };
}

const STUB_INDICATORS = ['Arbeitslosenquote', 'Ausländeranteil', 'Steuereinnahmekraft', 'Breitbandversorgung', 'Straftatenquote', 'Hausärzte', 'Schulabgänger', 'Ladepunkte', 'Ärzte'];
function stubUnderstand(query, context) {
  const offeredQ = resolveOffered(query, context && context.offered);
  if (offeredQ) { const place = placeFromQuery(offeredQ); const ind = STUB_INDICATORS.find((i) => offeredQ.toLowerCase().includes(i.toLowerCase())) || null;
    return { kind: 'anschluss', precise: true, clarify: '', best_guess: offeredQ, options: [], slots: { ort: place, indikator: ind } }; }
  const pending = context && context.pending;
  const hist = (context && context.history) || [];
  const last = hist[hist.length - 1];
  let q = query.trim();
  let kind = 'neu';
  if (pending) { kind = 'klarstellung'; q = (pending.options || []).find((o) => o.toLowerCase().includes(q.toLowerCase())) || pending.best_guess || q; }
  else if (/^(und|dort|da|ja)\b/i.test(q) && last && last.q) {
    kind = 'anschluss';
    const p = placeFromQuery(q), lp = placeFromQuery(last.q);
    if (p && lp) q = last.q.replace(lp, p);
    else q = last.q;
  }
  const place = placeFromQuery(q);
  const ind = STUB_INDICATORS.find((i) => q.toLowerCase().includes(i.toLowerCase())) || null;
  const precise = !!(place && ind);
  return { kind, precise, clarify: precise ? '' : (place ? 'Welche Kennzahl interessiert Sie für ' + place + '?' : 'Für welchen Ort möchten Sie das wissen?'),
    best_guess: precise ? q : (ind ? 'Wie hoch ist die ' + ind + ' in Kiel?' : 'Wie hoch ist die Arbeitslosenquote in ' + (place || 'Kiel') + '?'),
    options: precise ? [] : ['Wie hoch ist die Arbeitslosenquote in ' + (place || 'Kiel') + '?', 'Wie hoch ist der Ausländeranteil in ' + (place || 'Kiel') + '?'],
    slots: { ort: place, indikator: ind } };
}

export async function understand(query, context, CATALOG_SUMMARY = '') {
  // I11: "Ja" to an open follow-up offer is the offered question — deterministic, no model call
  const offeredQ = resolveOffered(query, context && context.offered);
  if (offeredQ) return { kind: 'anschluss', precise: true, clarify: '', best_guess: offeredQ, options: [], slots: normSlots({ ort: placeFromQuery(offeredQ) }) };
  if (STUB) { await sleep(Number(process.env.CC_STUB_UNDERSTAND_MS) || 1200); return stubUnderstand(query, context); }
  const catalog = CATALOG_SUMMARY ? '\n\nVERFÜGBARE INDIKATOREN — best_guess und options MÜSSEN sich mit einem davon beantworten lassen:\n' + CATALOG_SUMMARY : '';
  const pending = context && context.pending;
  let u, kind;
  if (pending && (pending.clarify || (pending.options && pending.options.length) || pending.best_guess)) {
    const ask = 'Unsere Rückfrage war: "' + (pending.clarify || '') + '"\n'
      + 'Angebotene Optionen: ' + JSON.stringify((pending.options || []).concat(pending.best_guess ? [pending.best_guess] : [])) + '\n'
      + 'Ursprüngliche, unklare Eingabe des Nutzers: "' + (pending.original || '') + '"\n'
      + 'Antwort des Nutzers jetzt: "' + query + '"';
    u = await llmJSON(CLARIFY_SYS + catalog, ask);
    kind = 'klarstellung';
  } else {
    const offered = context && context.offered;
    const offer = offered && offered.suggestions && offered.suggestions.length
      ? 'Offenes Angebot an den Nutzer (unsere letzte Einladung): "' + (offered.invite || '') + '" mit den angebotenen Anschlussfragen ' + JSON.stringify(offered.suggestions) + '. Eine Zustimmung mit Änderung ("ja, aber für Hamburg") meint die erste angebotene Frage mit dieser Änderung.\n'
      : '';
    u = await llmJSON(UNDERSTAND_SYS + catalog, memoryBlock(context) + offer + 'Neue Eingabe: ' + query);
    kind = (u.kind === 'anschluss' || u.kind === 'neu') ? u.kind : 'neu';
  }
  return {
    kind,
    precise: !!u.precise,
    clarify: (u.clarify || '').toString(),
    best_guess: (u.best_guess || query).toString(),
    options: Array.isArray(u.options) ? u.options.filter((x) => typeof x === 'string').slice(0, 3) : [],
    slots: normSlots(u.slots),
  };
}

// ---------------------------------------------------------------------------------------------
// followup(): suggestions that are answerable by construction (same indicator/other place, or a
// listed indicator/same place). Every candidate is still validated against the pipeline later.
const FOLLOWUP_SYS = [
  'Du bist ein deutsches Sprach-Callcenter für Deutschlandatlas-Regionaldaten und führst ein',
  'LAUFENDES Gespräch fort (kein neuer Kontakt). Der Anrufer hat gerade eine Antwort erhalten.',
  'Biete IMMER passende Anschlussfragen an. WICHTIG: Jede vorgeschlagene Anschlussfrage MUSS sich',
  'mit den vorhandenen Daten TATSÄCHLICH beantworten lassen. Bevorzuge deshalb genau diese beiden',
  'sicheren Muster:',
  '  (A) DERSELBE Indikator wie gerade eben, aber für eine andere vergleichbare Stadt/einen Kreis.',
  '  (B) ein ANDERER, in der Liste unten aufgeführter Indikator für DENSELBEN Ort.',
  'Erfinde KEINE Kennzahlen, die es in der Liste nicht gibt, und frage NICHT nach absoluten Zahlen,',
  'wenn nur Quoten/Anteile vorliegen. Antworte NUR mit striktem JSON, ohne Erklärung:',
  '{"suggestions": [string]} // 3-5 konkrete Anschlussfragen als vollständige deutsche Fragesätze,',
  '                          //   jede nach Muster (A) oder (B), jede sicher aus den Daten beantwortbar.',
].join('\n');
export async function followupSuggestions(query, answer, CATALOG_SUMMARY = '') {
  if (STUB) return [];
  const sys = FOLLOWUP_SYS + (CATALOG_SUMMARY ? '\n\nVERFÜGBARE INDIKATOREN — schlage NUR Fragen vor, die sich mit einem davon beantworten lassen:\n' + CATALOG_SUMMARY : '');
  const u = await llmJSON(sys, 'Beantwortete Frage: ' + query + '\nGegebene Antwort: ' + (answer || ''));
  return Array.isArray(u.suggestions) ? u.suggestions.filter((x) => typeof x === 'string').slice(0, 5) : [];
}

// ---------------------------------------------------------------------------------------------
// wikiFunFact(): one REAL sentence (or two) about the place from de.wikipedia — the raw material for
// an N1 "Wussten Sie schon" clip. Rotates through the article so repeats say something new.
const WIKI_UA = { accept: 'application/json', 'user-agent': 'CADS-Demo-Callcenter/1.0 (https://bunsenbrenner.org)' };
const factRotation = new Map();   // title -> next sentence offset
const STUB_FACTS = {
  kiel: 'Kiel ist die Landeshauptstadt von Schleswig-Holstein und hat rund 250.000 Einwohner.',
  hamburg: 'Hamburg ist mit etwa 1,9 Millionen Einwohnern die zweitgrößte Stadt Deutschlands.',
  dresden: 'Dresden liegt an der Elbe und ist die Landeshauptstadt des Freistaates Sachsen.',
};
export async function wikiFunFact(place) {
  if (!place) return null;
  if (STUB) { const t = STUB_FACTS[place.toLowerCase()] || (place + ' ist eine Stadt in Deutschland mit einer langen Geschichte.'); return { text: t, title: place, url: 'https://de.wikipedia.org/wiki/' + encodeURIComponent(place) }; }
  try {
    const sres = await fetch('https://de.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(place), { headers: WIKI_UA });
    if (!sres.ok) return null;
    const sj = await sres.json();
    if (sj.type === 'disambiguation' || !sj.extract) return null;
    const title = sj.title || place;
    const url = sj.content_urls?.desktop?.page || ('https://de.wikipedia.org/wiki/' + encodeURIComponent(place));
    let sentences = [];
    try {
      const fres = await fetch('https://de.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&titles=' + encodeURIComponent(title), { headers: WIKI_UA });
      const fj = await fres.json();
      const full = Object.values(fj?.query?.pages || {})[0]?.extract || sj.extract;
      sentences = splitSentences(stripPronunciation(full)).filter((s) => s.length >= 40 && s.length <= 240 && /[a-zäöü]/i.test(s) && !s.includes('=='));
    } catch {}
    if (!sentences.length) sentences = splitSentences(stripPronunciation(sj.extract)).filter((s) => s.length >= 25);
    if (!sentences.length) return null;
    const off = factRotation.get(title) || 0; factRotation.set(title, off + 1);
    const idx = off % sentences.length;
    const one = sentences[idx];
    const text = (one.length < 120 && idx + 1 < sentences.length) ? (one + ' ' + sentences[idx + 1]).slice(0, 300) : one.slice(0, 300);
    if (text.length < 20) return null;
    return { text, title, url };
  } catch { return null; }
}
