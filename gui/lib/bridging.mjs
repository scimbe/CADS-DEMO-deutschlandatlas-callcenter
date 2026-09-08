// Bridging material — everything the voice says that is NOT the Atlas answer. The design rule
// (dialog-fsm.mjs I4/I5/I6): every wait is bridged from PREPARED clips. Two kinds of preparation:
//
//   * POOLS, warmed once at boot (idempotent, self-healing): greetings, service intros,
//     topic-acks, continuation-acks, neutral bridges, generic GAP phrases, and F1 — generic
//     Atlas/Bunsenbrenner facts that stand in when no place-linked fact is prepared.
//   * N1 FACTS, produced in the BACKGROUND right after an answer (and at session start for the
//     example places): one real, place-linked Wikipedia sentence, narrated in a fixed register,
//     synthesized at low priority, stored per place. The NEXT round's "Wussten Sie schon" comes
//     from here — never fetched live while a caller waits.
//
// Dynamic (short, low-priority, cached by text): the VERSTEHEN echo of the resolved question, and
// the CONTEXT_BRIDGE opener templated from the previous turn's place/indicator (no LLM call).
import { ttsSpeak, proxied, protectClip, unprotectClip } from './tts.mjs';
import { rotate, rotFor } from './limiter.mjs';
import { placeKey, ttsSafe } from './text.mjs';
import { narrate, wikiFunFact } from './llm.mjs';
import { OPENER_KIND, BRIDGE_KIND } from '../dialog-fsm.mjs';

// --- prepared pools (texts) ---------------------------------------------------------------------
export const GREETINGS = [
  'Willkommen — schön, dass Sie da sind. Stellen Sie mir einfach Ihre Frage.',
  'Hallo und willkommen beim Deutschlandatlas-Callcenter. Fragen Sie mich, wann immer Sie bereit sind.',
  'Guten Tag — schön, dass Sie reinschauen. Tippen Sie Ihre Frage ein, ich höre zu.',
  'Willkommen. Ich bin bereit — nennen Sie mir einfach einen Ort und eine Kennzahl.',
  'Schön, dass Sie da sind. Fragen Sie mich gern etwas zu den Regionaldaten in Deutschland.',
];
export const SERVICE_INTROS = [
  'Willkommen beim Deutschlandatlas-Sprach-Callcenter. Übrigens: dies ist eine Demo auf dem Bunsenbrenner-Marktplatz — jede Antwort ist auf echten, live abgefragten Zahlen geerdet, nichts wird erfunden.',
  'Schön, dass Sie da sind. Gut zu wissen: Ich laufe als Bunsenbrenner-Demo über einen abgesicherten Tunnel, und das Sprachmodell dahinter arbeitet DSGVO-konform in Deutschland.',
  'Hier spricht das Deutschlandatlas-Callcenter. Kleiner Hinweis vorweg: die Zahlen kommen direkt aus dem offiziellen Deutschlandatlas, und wenn ich zu etwas keine Daten habe, sage ich das ehrlich, statt zu raten.',
  'Guten Tag, willkommen beim Sprach-Callcenter zum Deutschlandatlas. Ein Tipp: Sie können mich ganz natürlich fragen, etwa nach der Arbeitslosenquote oder dem Ausländeranteil eines Ortes — ich sehe dann live in den echten Daten nach.',
  'Willkommen. Dies ist eine von mehreren Bunsenbrenner-Demos, die zeigen, wie sich KI faktentreu einsetzen lässt — hier für Regionaldaten aus dem Deutschlandatlas. Nennen Sie mir einfach einen Ort und eine Kennzahl.',
  'Schön, dass Sie reinschauen. Damit Sie wissen, womit Sie es zu tun haben: Ich verbinde ein Sprachmodell mit der echten Deutschlandatlas-Datenbank und prüfe jede genannte Zahl gegen die Quelle.',
];
export const TOPIC_ACKS = [
  'Oh, eine ganz neue Richtung — auch das schaue ich Ihnen gerne nach.',
  'Interessante neue Frage — sehr gern, dazu sehe ich für Sie in den Daten nach.',
  'Ein anderes Thema, kein Problem — einen Moment, ich hole die passenden Zahlen.',
  'Auch eine spannende Frage — kommen wir gleich dazu.',
  'Gerne, ganz frisch gefragt — ich schaue direkt für Sie nach.',
  'Wechseln wir das Thema — mache ich gern, ich prüfe das eben.',
];
export const CONTINUATIONS = [
  'Sehr gern, das sehe ich sofort nach.',
  'Gut, bleiben wir dabei — einen Augenblick.',
  'Alles klar, ich hole die Zahl dazu.',
  'Gerne, das schaue ich mir gleich an.',
  'Prima, dann machen wir genau da weiter.',
];
export const NEUTRAL_BRIDGES = [
  'Kommen wir zu Ihrer nächsten Frage.',
  'Gerne sehe ich für Sie weiter nach.',
  'Bleiben wir gleich dran — einen Moment, ich schaue nach.',
  'Sehr gern — ich prüfe das eben für Sie.',
  'Gut, dann schauen wir uns das gemeinsam an.',
  'Einen Augenblick, ich hole die passenden Zahlen.',
];
// Templated context bridge: {ind} / {ort} come from the previous turn's resolved slots. No LLM.
export const CONTEXT_BRIDGE_TEMPLATES = [
  'Nach dem Thema {ind} in {ort} schauen wir jetzt gleich weiter.',
  'Gerade ging es um das Thema {ind} in {ort} — jetzt sehe ich nach Ihrer nächsten Frage.',
  'Bleiben wir im Fluss: nach {ort} kommt jetzt Ihre neue Frage dran, einen Moment.',
  'Gut, von {ort} aus geht es weiter — ich hole die nächsten Zahlen.',
  'Alles klar, nach dem Thema {ind} in {ort} prüfe ich jetzt das Nächste für Sie.',
];
export const GAP_TEXTS = [
  'Einen Moment — ich schaue die aktuellen Zahlen im Deutschlandatlas für Sie nach.',
  'Ich frage die passenden Regionaldaten gerade live ab, einen kurzen Augenblick.',
  'Alles klar — ich hole die Werte aus dem Deutschlandatlas, gleich habe ich sie.',
  'Ich sehe in der Datenbank nach, die aktuellen Daten kommen gleich.',
  'Lassen Sie mich das kurz für Sie nachschlagen, einen Augenblick.',
  'Ich hole Ihre Zahl gerade aus dem Atlas — gleich bin ich da.',
  'Gerne — ich suche die passenden Daten heraus, gleich habe ich Ihre Antwort.',
  'Einen kleinen Moment, ich prüfe das eben im Deutschlandatlas für Sie.',
  'Noch einen Augenblick Geduld, es dauert nicht mehr lange.',
  'Fast geschafft — ich stelle Ihre Antwort gerade zusammen.',
  'Die Abfrage läuft noch, damit Sie einen wirklich aktuellen Wert bekommen und keine Schätzung.',
  'Kleiner Moment noch, dann kann ich Ihnen die genaue Zahl nennen.',
  'Ich bin noch dabei — bei manchen Tabellen dauert die Live-Abfrage etwas länger.',
  'Danke für Ihre Geduld, gleich ist es soweit.',
];
// F1: generic, always-true facts about the service/data — the "Wussten Sie schon" stand-in when
// no place-linked N1 fact is prepared yet (typically only the very first turn of a cold process).
export const F1_FACTS = [
  'Wussten Sie schon: der Deutschlandatlas bündelt über hundert Indikatoren zu ganz Deutschland, von Beschäftigung über Wohnen bis Infrastruktur.',
  'Wussten Sie schon: Ihre Werte kommen live aus dem echten Deutschlandatlas, nichts Vorgefertigtes, sondern der aktuelle Stand direkt aus der Quelle.',
  'Wussten Sie schon: die Regionaldaten laufen Ende-zu-Ende-verschlüsselt über den Tunnel, sodass niemand außer Ihnen die Frage mitliest.',
  'Wussten Sie schon: der Atlas deckt jeden Landkreis in Deutschland ab, deshalb gibt es für Ihren Ort einen ganz konkreten Wert.',
  'Wussten Sie schon: der Deutschlandatlas wird laufend aktualisiert, Sie bekommen also den aktuellen Stand und keine alte Momentaufnahme.',
  'Wussten Sie schon: für die meisten Kennzahlen reichen die Werte bis auf die Kreisebene hinunter.',
  'Wussten Sie schon: diese Zahlen kommen aus dem offiziellen Deutschlandatlas des Bundes, nicht aus einer Schätzung.',
  'Wussten Sie schon: der Atlas vergleicht Regionen quer durch Deutschland — Beschäftigung, Bildung, Gesundheit, Umwelt und mehr.',
];
export const VERSTEHEN_LEADINS = ['Verstanden — Ihre Frage lautet', 'Alles klar, Sie möchten wissen', 'Gut, Sie fragen', 'Ich habe verstanden — Sie möchten wissen', 'In Ordnung, Ihre Frage ist', 'Notiert — Sie interessiert', 'Gerne — Sie fragen also', 'Habe ich — Sie möchten erfahren', 'Klar, es geht Ihnen um', 'Ich sehe, Sie wollen wissen'];
export const INVITE_LEADS_PARSED = [
  'Bleiben wir gleich dran: soll ich Ihnen auch sagen, {core}?',
  'Da wir schon dabei sind — ich schaue direkt weiter: möchten Sie wissen, {core}?',
  'Ich führe Sie nahtlos weiter: interessiert Sie auch, {core}?',
  'Wenn Sie mögen, gehe ich gleich einen Schritt weiter: soll ich nachsehen, {core}?',
  'Passend dazu hätte ich noch etwas: möchten Sie auch erfahren, {core}?',
  'Und weil es sich anbietet — sagen Sie einfach ja, dann verrate ich Ihnen, {core}.',
];
export const INVITE_LEADS_RAW = [
  'Bleiben wir gleich dran: möchten Sie auch wissen: {s}?',
  'Ich führe Sie direkt weiter — soll ich nachsehen: {s}?',
  'Passend dazu: interessiert Sie auch: {s}?',
];

// --- pools of prepared clips ---------------------------------------------------------------------
// pool name -> [{ text, audioUrl }] ; warmed by prewarm(); every clip is protected from pruning.
const pools = { greeting: [], service_intro: [], topic_ack: [], continuation: [], neutral: [], gap: [], f1: [] };
const POOL_TEXTS = { greeting: GREETINGS, service_intro: SERVICE_INTROS, topic_ack: TOPIC_ACKS, continuation: CONTINUATIONS, neutral: NEUTRAL_BRIDGES, gap: GAP_TEXTS, f1: F1_FACTS };
const POOL_COUNTER = { greeting: 'greet', service_intro: 'intro', topic_ack: 'ack', continuation: 'cont', neutral: 'bridge', gap: 'gap', f1: 'f1' };

/** Next prepared clip of `pool` for this caller (rotating). Falls back to text-only (audioUrl
 *  null → the client skips it silently) only while the boot warm-up hasn't reached it yet. */
export function fromPool(pool, userKey) {
  const clips = pools[pool];
  if (clips.length) return rotate(userKey, POOL_COUNTER[pool], clips);
  return { text: rotate(userKey, POOL_COUNTER[pool], POOL_TEXTS[pool]), audioUrl: null };
}

let prewarming = false;
async function warmPool(name) {
  let fail = 0;
  for (const text of POOL_TEXTS[name]) {
    if (pools[name].some((c) => c.text === text)) continue;   // idempotent, retry-safe
    try {
      const au = await ttsSpeak(text, { priority: false, userKey: 'system' });
      if (au) { protectClip(au); pools[name].push({ text, audioUrl: proxied(au) }); } else fail++;
    } catch { fail++; }
  }
  return fail;
}
/** Self-healing boot warm-up: fill every pool; if anything stayed incomplete (TTS slow/failing at
 *  boot), log loudly and retry every 120 s until full. Serialised by the TTS limiter itself. */
export async function prewarm({ onIncomplete } = {}) {
  if (prewarming) return; prewarming = true;
  try { for (const name of ['greeting', 'service_intro', 'gap', 'continuation', 'topic_ack', 'neutral', 'f1']) await warmPool(name); }
  catch (e) { console.error('[prewarm] cycle error:', e && e.message); }
  finally { prewarming = false; }
  const missing = Object.keys(pools).filter((n) => pools[n].length < POOL_TEXTS[n].length);
  if (!missing.length) console.log('[prewarm] all pools warm: ' + Object.entries(pools).map(([k, v]) => `${k}=${v.length}`).join(' '));
  else {
    console.error(`[prewarm] INCOMPLETE ${missing.map((n) => `${n}=${pools[n].length}/${POOL_TEXTS[n].length}`).join(' ')} — TTS likely slow/failing; retrying in 120s`);
    if (onIncomplete) onIncomplete(); else setTimeout(() => prewarm(), 120000);
  }
}
export const poolStats = () => Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length]));

// --- small cache for dynamic, text-keyed clips (verstehen echoes, context bridges) --------------
const dynCache = new Map();  // text -> { url: Promise<string|null>, ts }
const DYN_TTL_MS = 5 * 60 * 1000, DYN_MAX = 64;
function dynamicClip(text, userKey) {
  const key = ttsSafe(text);
  const hit = dynCache.get(key);
  if (hit && Date.now() - hit.ts < DYN_TTL_MS) return hit.url;
  const url = ttsSpeak(key, { priority: false, userKey }).then(proxied).catch(() => null);
  dynCache.set(key, { url, ts: Date.now() });
  while (dynCache.size > DYN_MAX) dynCache.delete(dynCache.keys().next().value);
  return url;
}

// --- openers -----------------------------------------------------------------------------------
/** The OPENER for an utterance (invariant I3). `context` = { turnCount, pivot, continued,
 *  lastPlace, lastIndicator }. Pool kinds return instantly; a context bridge with slots is a
 *  templated dynamic clip (usually prefetched by the client right after the previous answer). */
export async function opener(kind, context = {}, userKey = 'anon') {
  if (kind === OPENER_KIND.SERVICE_INTRO) return { kind, ...fromPool('service_intro', userKey) };
  if (kind === OPENER_KIND.TOPIC_ACK) return { kind, ...fromPool('topic_ack', userKey) };
  if (kind === OPENER_KIND.CONTINUATION) return { kind, ...fromPool('continuation', userKey) };
  const ort = (context.lastPlace || '').trim(), ind = (context.lastIndicator || '').trim();
  if (ort) {
    const tpl = rotate(userKey, 'bridge', ind ? CONTEXT_BRIDGE_TEMPLATES : CONTEXT_BRIDGE_TEMPLATES.filter((t) => !t.includes('{ind}')));
    const text = tpl.replace('{ind}', ind).replace('{ort}', ort).replace(/\s{2,}/g, ' ');
    return { kind, text, audioUrl: await dynamicClip(text, userKey) };
  }
  return { kind, ...fromPool('neutral', userKey) };
}

/** VERSTEHEN echo of the resolved question (dynamic, short, cached by text). */
export async function verstehen(query, userKey = 'anon') {
  const text = rotate(userKey, 'verstehen', VERSTEHEN_LEADINS) + ': ' + String(query || '').trim();
  return { kind: BRIDGE_KIND.VERSTEHEN, text, audioUrl: await dynamicClip(text, userKey) };
}

/** Active lead-in to the next answerable question, derived from a VALIDATED suggestion. */
export function inviteText(q, userKey = 'anon') {
  const s = (q || '').trim().replace(/\?+$/, '');
  let core = null;
  const m = s.match(/^wie\s+hoch\s+ist\s+(.+?)\s+in\s+(.+)$/i);
  if (m) core = `wie hoch ${m[1]} in ${m[2]} ist`;
  if (!core) { const m2 = s.match(/^wie\s+viele?\s+(.+?)\s+(?:gibt es\s+)?in\s+(.+)$/i); if (m2) core = `wie viele ${m2[1]} es in ${m2[2]} gibt`; }
  return core ? rotate(userKey, 'invite', INVITE_LEADS_PARSED).replace('{core}', core) : rotate(userKey, 'invite', INVITE_LEADS_RAW).replace('{s}', s);
}

// --- N1: place-linked facts produced after an answer for the NEXT round ----------------------
const N1_MAX = 24, N1_TTL_MS = 45 * 60 * 1000;
const n1 = new Map();        // placeKey -> { place, text, title, url, audioUrl, ts }
const n1InFlight = new Set();
function n1Prune() {
  const cutoff = Date.now() - N1_TTL_MS;
  for (const [k, v] of n1) if (v.ts < cutoff) { unprotectClip(v.audioUrl); n1.delete(k); }
  while (n1.size > N1_MAX) { const k = n1.keys().next().value; unprotectClip(n1.get(k).audioUrl); n1.delete(k); }
}
/** Produce (in the background, low priority) a "Wussten Sie schon" clip for `place`. Idempotent. */
export async function produceFact(place, userKey = 'system') {
  const key = placeKey(place);
  if (!key || n1.has(key) || n1InFlight.has(key)) return;
  n1InFlight.add(key);
  try {
    const ff = await wikiFunFact(place);
    if (!ff || !ff.text) return;
    const narrated = await narrate(ff.text, 'funfact');
    const text = 'Wussten Sie schon, zu ' + (ff.title || place) + ': ' + narrated;
    const au = await ttsSpeak(text, { priority: false, userKey });
    if (!au) return;
    protectClip(au);
    n1.set(key, { place: ff.title || place, text, title: ff.title, url: ff.url, audioUrl: proxied(au), ts: Date.now() });
    n1Prune();
  } catch {} finally { n1InFlight.delete(key); }
}
/** The prepared fact for this caller's wait: the fact for THIS question's place, else an F1
 *  generic fact about the service/data. A fact about some other place is never spoken into a
 *  question about this one (it sounded random to the caller); only a question WITHOUT a place may
 *  take the freshest prepared fact. Never fetches anything live (I4). */
export function takeFact(place, userKey = 'anon') {
  n1Prune();
  const heard = rotFor(userKey).heardFacts;
  const pick = (entry) => { heard.add(entry.audioUrl); return { kind: BRIDGE_KIND.FACT, text: entry.text, audioUrl: entry.audioUrl, title: entry.title, url: entry.url, place: entry.place }; };
  const key = placeKey(place);
  const same = key ? n1.get(key) : null;
  if (same && !heard.has(same.audioUrl)) return pick(same);
  if (!key) {
    const others = [...n1.values()].filter((e) => !heard.has(e.audioUrl)).sort((a, b) => b.ts - a.ts);
    if (others.length) return pick(others[0]);
  }
  const f1 = fromPool('f1', userKey);
  return { kind: BRIDGE_KIND.FACT, text: f1.text, audioUrl: f1.audioUrl, title: null, url: null, place: null };
}
export const factStats = () => ({ prepared: n1.size, inFlight: n1InFlight.size, places: [...n1.values()].map((e) => e.place) });

/** Next GAP clip (prepared pool). */
export function gap(userKey = 'anon') { return { kind: BRIDGE_KIND.GAP, ...fromPool('gap', userKey) }; }
