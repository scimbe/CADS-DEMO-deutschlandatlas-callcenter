// Deutschlandatlas Callcenter — interactive service GUI backend (guided dialog + speculation).
//
// Serves the caller GUI and bridges it to the REAL pipeline (scripts/n8n_workflow_runtime.mjs:
// catalog match -> live Deutschlandatlas query -> grounded phrasing), plus Thorsten TTS via the
// CADS-Tunnel audio_generation channel.
//
// Two-phase dialog:
//   POST /understand {query} -> a fast LLM "understand" step returns {precise, clarify,
//        best_guess, options}. It ALSO fires the full pipeline for best_guess in the background
//        (speculative) and caches the result, so a confirming user gets an instant answer.
//   POST /answer {query}     -> the grounded answer (served from the speculation cache when the
//        query was already speculated, otherwise computed now). /ask is a back-compat alias.
//
// Env: PORT (8791); LITELLM_BASE_URL/API_KEY/DEFAULT_MODEL; CC_TTS=1 + CT_AGENT_BIN + CT_RELAY_ENV
//      + CT_AUDIO_CHANNEL_ID for spoken answers.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const PORT = parseInt(process.env.PORT || '8791', 10);
const RUNTIME = join(REPO_ROOT, 'scripts', 'n8n_workflow_runtime.mjs');

// Compact list of the indicators the dataset can actually answer — injected into the
// understand/follow-up prompts so suggested questions are always answerable (deduped by topic).
let CATALOG_SUMMARY = '';
try {
  const cat = JSON.parse(readFileSync(join(REPO_ROOT, 'catalog.json'), 'utf8'));
  const rows = cat.rows || Object.values(cat).find(Array.isArray) || [];
  const seen = new Set(), lines = [];
  for (const r of rows) {
    if (r.kind !== 'indicator') continue;
    const desc = (r.snippet || '').replace(/\s+/g, ' ').replace(/,?\s*(im Jahr|in\s*_?)?\s*\d{4}.*$/i, '').trim();
    const k = desc.slice(0, 45).toLowerCase();
    if (desc.length < 12 || seen.has(k)) continue;
    seen.add(k); lines.push('- ' + desc.slice(0, 95));
  }
  CATALOG_SUMMARY = lines.join('\n');
} catch {}

function runPipeline(query) {
  return new Promise((resolve) => {
    const p = spawn('node', [RUNTIME, '--query', query], { cwd: REPO_ROOT, env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      let final = null;
      const lines = out.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) { try { final = JSON.parse(lines[i]); break; } catch {} }
      resolve({ ok: code === 0 && final != null, final, code, err: err.slice(-600) });
    });
  });
}

// Make text TTS-safe: strip bracketed IPA-pronunciation spans (e.g. "Hannover [haˈnoːfɐ]") that raw
// Wikipedia extracts put after a name — Piper would read them out as garbage. Prose/numbers untouched.
function stripPronunciation(text) {
  return String(text || '')
    .replace(/[\[(（][^\[\]()（）]*[ˈˌːˑ‿˥˦˧˨˩][^\[\]()（）]*[\])）]/gu, '')   // bracketed span with an IPA stress/length/tone mark
    .replace(/[\[(（][^\[\]()（）]*\b(?:IPA|Aussprache|Lautschrift|phonetisch)\b[^\[\]()（）]*[\])）]/gi, '')   // bracketed pronunciation label
    .replace(/\/[^/\n]{1,60}?[ˈˌːˑ‿][^/\n]{0,60}?\//gu, '')          // slash-delimited phonemic notation /haˈnoːfɐ/
    .replace(/,?\s*\b(?:Aussprache|Lautschrift)\b\s*:?\s*(?=[,.;:]|\s|$)/gi, ' ')   // orphaned "Aussprache:" left after IPA removal — you never say the pronunciation guide
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')                                 // tidy space left before punctuation
    .replace(/\(\s*\)/g, '')                                         // drop any empty () left behind
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Self-contained local TTS via Piper (used on the durable host; no ct-agent channel/grant needed).
// Writes a WAV under a capped temp dir and returns a same-origin /tts/<id>.wav path.
const TTS_DIR = join(tmpdir(), 'cc-tts');
let ttsSeq = 0;
function pruneTtsDir(keep = 100) {
  try {
    const files = readdirSync(TTS_DIR).filter((f) => f.endsWith('.wav'))
      .map((f) => ({ f, t: statSync(join(TTS_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) { try { unlinkSync(join(TTS_DIR, f)); } catch {} }
  } catch {}
}
function ttsLocalPiper(text) {
  return new Promise((resolve) => {
    try { mkdirSync(TTS_DIR, { recursive: true }); } catch {}
    const id = process.pid + '-' + (ttsSeq++);
    const wav = join(TTS_DIR, id + '.wav');
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(process.env.CC_PIPER_BIN, ['--model', process.env.CC_PIPER_MODEL, '--output_file', wav], { env: process.env });
      p.stdin.on('error', () => {});
      p.stdin.end(text);
      p.on('close', (code) => { pruneTtsDir(); fin(code === 0 && existsSync(wav) ? '/tts/' + id + '.wav' : null); });
      p.on('error', () => fin(null));
    } catch { fin(null); }
  });
}

function ttsSpeak(text, voice = 'primary') {
  text = stripPronunciation(text);
  if (process.env.CC_TTS !== '1') return Promise.resolve(null);
  if (process.env.CC_PIPER_BIN && process.env.CC_PIPER_MODEL) return ttsLocalPiper(text);   // local Piper (durable host) — no channel
  const CT = process.env.CT_AGENT_BIN, RELAY = process.env.CT_RELAY_ENV, CH = process.env.CT_AUDIO_CHANNEL_ID;
  if (!CT || !RELAY || !CH) return Promise.resolve(null);
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text, voice });
    const p = spawn('bash', ['-c',
      `set -a; source "$CT_RELAY_ENV"; set +a; printf '%s' '${payload.replace(/'/g, "'\\''")}' | ` +
      `CT_CHANNEL_ROLE=initiate CT_CHANNEL_CALL_SERVICE=audio_generation CT_CHANNEL_CALL_PERSISTENT=0 CT_CHANNEL_RELAY_ONLY=1 ` +
      `CT_CHANNEL_ID="${CH}" CT_CHANNEL_GRANT="$CT_CHANNEL_GRANT_2E" CT_CHANNEL_HOLDER_KEY="$CT_CHANNEL_HOLDER_KEY" CT_CHANNEL_NOISE_KEY="$CT_CHANNEL_NOISE_KEY" ` +
      `CT_CHANNEL_FRONT_DOOR=bunsenbrenner.org:443 CT_CHANNEL_FRONT_DOOR_CERT="$CT_CHANNEL_FRONT_DOOR_CERT" CT_CHANNEL_FRONT_DOOR_ONLY=1 ` +
      `CT_CHANNEL_BROKER=bunsenbrenner.org:4435 CT_CHANNEL_RELAY=bunsenbrenner.org:4436 "$CT_AGENT_BIN" channel 2>/dev/null | tail -1`],
      { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const url = (out.trim().split('\n').pop() || '').trim(); resolve(/^https:\/\//.test(url) ? url : null); });
    p.on('error', () => resolve(null));
  });
}
const proxied = (u) => (u ? (u.startsWith('/') ? u : '/audio?u=' + encodeURIComponent(u)) : null);

// Wait-time filler clips are *.wav (gitignored) so they never ship in a deploy. When local Piper
// is available, synthesize them from a phrase list on startup — so the feature is self-contained
// and never a missing-file dependency (which previously 404'd; the route now degrades gracefully).
const FILLER_PHRASES = [
  'Einen kleinen Moment bitte, ich sehe für Sie in den Daten nach.',
  'Ich frage gerade die Deutschlandatlas-Datenbank ab.',
  'Das dauert nur einen kurzen Augenblick.',
  'Ich hole die aktuellen Zahlen für Sie heraus.',
  'Gleich habe ich das Ergebnis für Sie.',
  'Ich prüfe die passende Tabelle im Datensatz.',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function synthOnce(f, text) {
  return new Promise((res) => {
    try {
      const p = spawn(process.env.CC_PIPER_BIN, ['--model', process.env.CC_PIPER_MODEL, '--output_file', f], { env: process.env });
      p.stdin.on('error', () => {}); p.stdin.end(text);
      p.on('close', (code) => res(code === 0 && existsSync(f) && statSync(f).size > 0));
      p.on('error', () => res(false));
    } catch { res(false); }
  });
}

async function ensureFillers() {
  if (!process.env.CC_PIPER_BIN || !process.env.CC_PIPER_MODEL) return;   // only the self-contained Piper deploy
  const dir = join(__dir, 'fillers');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  let made = 0;
  for (let i = 0; i < FILLER_PHRASES.length; i++) {
    const f = join(dir, `filler${i + 1}.wav`);
    if (existsSync(f)) continue;
    // Verify the child actually produced a non-empty file before counting it as done and
    // moving on -- a transient Piper failure (seen live: a truncated 0-byte file, apparently
    // from resource contention on this host's constrained cpuset after several back-to-back
    // model loads, most often on the last phrase in the sequence) otherwise passes
    // existsSync() forever after, permanently serving a broken/empty clip with no retry.
    // Retry a few times with a short cooldown before giving up on a given phrase, and pause
    // briefly between phrases so the previous invocation's threads/memory are fully released.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0) await sleep(1500);
      ok = await synthOnce(f, stripPronunciation(FILLER_PHRASES[i]));
    }
    if (ok) made++; else { try { unlinkSync(f); } catch {} }
    await sleep(500);
  }
  if (made) console.log(`fillers: synthesized ${made} Thorsten wait-clip(s) via Piper`);
}

// --- server-side speech-to-text via local whisper.cpp (no browser cloud dependency) ---
let sttSeq = 0;
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args); let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err })); p.on('error', () => resolve({ code: -1, out, err }));
  });
}
async function transcribe(buf) {
  const model = process.env.CC_WHISPER_MODEL, cli = process.env.CC_WHISPER_CLI || 'whisper-cli';
  if (!model || !buf || !buf.length) return '';
  const base = join(tmpdir(), 'cc-stt-' + process.pid + '-' + (sttSeq++));
  const inp = base + '.in', wav = base + '.wav';
  try {
    await writeFile(inp, buf);
    if ((await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inp, '-ar', '16000', '-ac', '1', wav, '-y'])).code !== 0) return '';
    const w = await run(cli, ['-m', model, '-l', 'de', '-nt', '-f', wav]);
    return (w.out || '').replace(/\[[0-9:.\s>\-]+\]/g, '').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
  finally { rm(inp, { force: true }).catch(() => {}); rm(wav, { force: true }).catch(() => {}); }
}

// --- optional, VERBATIM Wikipedia fun fact for the place, fetched IN PARALLEL with the atlas ---
function placeFromQuery(q) {
  const m = (q || '').match(/\b(?:in|für|von|zu|über)\s+([A-ZÄÖÜ][\wäöüß.-]+(?:\s[A-ZÄÖÜ][\wäöüß.-]+)?)/);
  return m ? m[1].replace(/[.?!,;:]+$/, '').trim() : null;
}

// Large German Kreisfreie Städte -- every Deutschlandatlas indicator has a value for each of them,
// so "same question, other city" is GUARANTEED answerable when the original question just was.
const BIG_CITIES = ['Hamburg', 'München', 'Köln', 'Frankfurt', 'Stuttgart', 'Düsseldorf', 'Leipzig',
  'Dresden', 'Hannover', 'Nürnberg', 'Bremen', 'Dortmund', 'Essen', 'Bochum', 'Rostock', 'Kiel', 'Berlin'];
// Build follow-ups by swapping the place in a query that already resolved to real data -> always answerable.
function swapCityFollowups(query, place, n) {
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

// Turn a (validated, answerable) suggestion into a fully-formulated spoken invite question.
function deriveInvite(q) {
  const s = (q || '').trim().replace(/\?+$/, '');
  const m = s.match(/^wie\s+hoch\s+ist\s+(.+?)\s+in\s+(.+)$/i);
  if (m) return `Möchten Sie auch wissen, wie hoch ${m[1]} in ${m[2]} ist?`;
  const m2 = s.match(/^wie\s+viele?\s+(.+?)\s+(?:gibt es\s+)?in\s+(.+)$/i);
  if (m2) return `Möchten Sie auch wissen, wie viele ${m2[1]} es in ${m2[2]} gibt?`;
  return `Möchten Sie auch wissen: ${s}?`;
}
const WIKI_UA = { accept: 'application/json', 'user-agent': 'CADS-Demo-Callcenter/1.0 (https://bunsenbrenner.org)' };
const factRotation = new Map();   // title -> next sentence offset, so repeats/similar places don't say the same thing
async function wikiFunFact(place) {
  if (!place) return null;
  try {
    const sres = await fetch('https://de.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(place), { headers: WIKI_UA });
    if (!sres.ok) return null;
    const sj = await sres.json();
    if (sj.type === 'disambiguation' || !sj.extract) return null;
    const title = sj.title || place;
    const url = sj.content_urls?.desktop?.page || ('https://de.wikipedia.org/wiki/' + encodeURIComponent(place));
    // fuller plain-text extract (all sections) for VARIETY — not just the always-identical lead
    let sentences = [];
    try {
      const fres = await fetch('https://de.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&redirects=1&format=json&titles=' + encodeURIComponent(title), { headers: WIKI_UA });
      const fj = await fres.json();
      const full = Object.values(fj?.query?.pages || {})[0]?.extract || sj.extract;
      sentences = full.split(/(?<=[.!?])\s+/).map((s) => s.trim())
        .filter((s) => s.length >= 40 && s.length <= 240 && /[a-zäöü]/i.test(s) && !s.includes('=='));
    } catch { /* fall back to the summary below */ }
    if (!sentences.length) sentences = sj.extract.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 25);
    if (!sentences.length) return null;
    const off = factRotation.get(title) || 0; factRotation.set(title, off + 1);
    const idx = off % sentences.length;
    const one = sentences[idx];
    // pair with the next sentence when the picked one is short, for a fuller fact
    const text = (one.length < 120 && idx + 1 < sentences.length) ? (one + ' ' + sentences[idx + 1]).slice(0, 300) : one.slice(0, 300);
    if (text.length < 20) return null;
    return { text, title, url };
  } catch { return null; }
}

// --- speculation cache: query -> Promise<{ok,answer,meta,audioUrl,funfact,err}> ---
const specCache = new Map();
// Persistent reuse cache (RAG-style): a query that already ran and produced grounded data is reused
// (skips the whole ArcGIS pipeline + narration), so a known request replays instantly. The fun fact is
// deliberately NOT cached here — it stays fresh/varied per turn (see /context). TTL is the "nothing changed" proxy.
const Q_CACHE = join(tmpdir(), 'cc-qcache');
const Q_TTL_MS = 12 * 3600 * 1000;
const qKey = (q) => Buffer.from(String(q || '').trim().toLowerCase().replace(/\s+/g, ' ')).toString('base64url').slice(0, 120);
function diskGet(q) {
  try { const f = join(Q_CACHE, qKey(q) + '.json'); if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, 'utf8')); return (j && (Date.now() - (j.ts || 0)) < Q_TTL_MS) ? j : null; } catch { return null; }
}
function diskPut(q, obj) { try { mkdirSync(Q_CACHE, { recursive: true }); writeFileSync(join(Q_CACHE, qKey(q) + '.json'), JSON.stringify({ ...obj, ts: Date.now() })); } catch {} }

function answerFor(query) {
  const key = (query || '').trim();
  if (!key) return Promise.resolve({ ok: false, answer: null, meta: null, audioUrl: null, err: 'empty' });
  if (specCache.has(key)) return specCache.get(key);
  const promise = (async () => {
    let answer, meta, ok, err = null, reused = false;
    const cached = diskGet(key);
    if (cached && cached.answer && cached.meta) {           // reuse: same request ran before, data unchanged within TTL
      answer = cached.answer; meta = cached.meta; ok = true; reused = true;
    } else {
      const r = await runPipeline(key);
      const rawAnswer = r.final?.text || r.final?.answer || null;
      meta = r.final?.meta || null; ok = r.ok; err = r.ok ? null : (r.err || 'pipeline failed');
      answer = rawAnswer ? await narrate(rawAnswer, 'answer') : null;   // narrative style, number-guarded
      if (ok && answer && meta && meta.table && meta.has_real_data !== false) diskPut(key, { answer, meta });
    }
    let au = null; if (answer) { try { au = await ttsSpeak(answer, 'primary'); } catch {} }
    return { ok, answer, meta, audioUrl: proxied(au), reused, err };
  })();
  specCache.set(key, promise);
  // cache only successes in memory: drop failed/empty runs so transient flakiness can be retried
  promise.then((r) => { if (!r || !r.ok || !(r.meta && r.meta.table && r.meta.has_real_data !== false)) specCache.delete(key); },
    () => specCache.delete(key));
  if (specCache.size > 80) specCache.delete(specCache.keys().next().value);
  return promise;
}

// Part 1 "Verstehen": a short spoken confirmation of the understood question (varied lead-in).
const VERSTEHEN_LEADINS = ['Verstanden — Ihre Frage lautet', 'Alles klar, Sie möchten wissen', 'Gut, Sie fragen', 'Ich habe verstanden — Sie möchten wissen', 'In Ordnung, Ihre Frage ist'];
let verstehenRot = 0;
function verstehenText(query) {
  const q = String(query || '').trim();
  return VERSTEHEN_LEADINS[(verstehenRot++) % VERSTEHEN_LEADINS.length] + ': ' + q;
}

// Part 2 "Überbrücken": a short bridge — first turn introduces the service (varied), later turns
// loosely reference the previous interaction. Prepared in advance by the client so it plays instantly.
const SERVICE_INTROS = [
  'Willkommen beim Deutschlandatlas-Sprach-Callcenter. Ich beantworte Ihre Fragen zu Regionaldaten in Deutschland — immer geerdet auf echten, live abgefragten Zahlen.',
  'Schön, dass Sie da sind. Dies ist das Deutschlandatlas-Sprach-Callcenter: Fragen Sie mich zu Kriminalität, Bildung, Beschäftigung oder Wohnen in Ihrer Region.',
  'Hier spricht das Deutschlandatlas-Callcenter. Ich hole für Sie echte Regionaldaten aus dem Deutschlandatlas — nichts erfunden, alles direkt aus der Quelle.',
  'Guten Tag, willkommen beim Sprach-Callcenter zum Deutschlandatlas. Stellen Sie mir Ihre Frage zu einem Ort in Deutschland, ich sehe für Sie in den echten Daten nach.',
];
let introRot = 0;
async function introBridge(context) {
  const last = context && context.lastQuery;
  let text;
  if (last) {
    const u = await llmJSON(
      'Formuliere EINEN sehr kurzen, freundlichen deutschen Überleitungssatz für ein Callcenter, der lose an die zuletzt beantwortete Frage anknüpft und zur nächsten überleitet. Variiere die Formulierung, kein Aussprache-Hinweis. Antworte NUR als striktes JSON: {"text": "..."}',
      'Zuletzt beantwortet: ' + String(last).slice(0, 200));
    text = (u && typeof u.text === 'string' && u.text.trim()) ? u.text.trim() : 'Kommen wir zu Ihrer nächsten Frage.';
  } else {
    text = SERVICE_INTROS[(introRot++) % SERVICE_INTROS.length];
  }
  return stripPronunciation(text);
}

async function llmJSON(system, user) {
  const base = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LITELLM_API_KEY, model = process.env.LITELLM_DEFAULT_MODEL || 'local-devstral-small2';
  try {
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 400, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    const j = await resp.json();
    return JSON.parse(j.choices?.[0]?.message?.content || '{}');
  } catch { return {}; }
}

// Rephrase into a more narrative / spoken German style WITHOUT changing facts.
// Numbers are the falsification risk: if any number from the source is missing in the output, keep the original.
async function narrate(text, mode) {
  const srcT = (text || '').trim();
  if (srcT.length < 12) return srcT;
  const base = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LITELLM_API_KEY, model = process.env.LITELLM_DEFAULT_MODEL || 'local-devstral-small2';
  const sys = mode === 'funfact'
    ? 'Formuliere den folgenden Wikipedia-Auszug in einen kurzen, unterhaltsamen, gesprochenen deutschen Sprechtext um (maximal 2 Sätze). Behalte JEDE Zahl, JEDEN Namen und JEDEN Fakt exakt bei; erfinde NICHTS und verfälsche nichts. Nur der Stil wird lockerer und erzählender, der Inhalt bleibt gleich. Antworte NUR mit dem umformulierten Text, ohne Anführungszeichen, ohne Vorrede.'
    : 'Formuliere die folgende Datenauskunft in flüssigen, leicht erzählenden deutschen Sprechtext um (1 bis 3 Sätze, nicht nur kurze Hauptsätze aneinanderreihen). Behalte JEDE Zahl, JEDEN Orts- und Eigennamen und JEDEN Fakt exakt bei; erfinde NICHTS hinzu. Antworte NUR mit dem umformulierten Text, ohne Anführungszeichen, ohne Vorrede.';
  try {
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0.4, max_tokens: 260,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: srcT }] }),
    });
    const j = await resp.json();
    let out = (j.choices?.[0]?.message?.content || '').trim().replace(/^["'»“]+|["'«”]+$/g, '').trim();
    if (!out || out.length < 10 || out.length > srcT.length * 3 + 120) return srcT;   // sanity bounds
    const nums = (srcT.match(/\d[\d.,]*/g) || []).map((n) => n.replace(/[.,]+$/, ''));  // grounding guard
    for (const n of nums) { if (!out.includes(n)) return srcT; }
    return out;
  } catch { return srcT; }
}

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
  '{"kind": "neu" | "anschluss",  // Klassifikation der neuen Eingabe',
  ' "precise": boolean,   // true nur wenn (nach Auflösung) genau EIN Indikator UND ein Ort eindeutig sind',
  ' "clarify": string,    // EINE kurze, freundliche deutsche Rückfrage, die zur sauberen Anfrage führt (leer wenn precise=true)',
  ' "best_guess": string, // die vollständige, AUFGELÖSTE konkrete Frage als deutscher Fragesatz (Indikator + Ort); IMMER gesetzt',
  ' "options": [string],  // 2-3 konkrete alternative Fragesätze zur Auswahl (je Indikator + Ort)',
  ' "slots": {"ort": string|null, "indikator": string|null}}  // die für best_guess erkannten Slots (Ort, Indikator)',
  'Fehlt der Ort auch nach Auflösung, frage gezielt nach dem Ort. Ist das Thema unklar, biete die naheliegendsten Indikatoren an.',
].join('\n');

// Rasa pattern_clarification: if we just asked a clarifying question, the user's next turn is
// resolved AGAINST that pending question FIRST (short-circuit), not run through general new/follow-up NLU.
const CLARIFY_SYS = [
  'Du bist die Dialogführung eines deutschen Sprach-Callcenters für Deutschlandatlas-Regionaldaten.',
  'Das System hat SOEBEN eine Rückfrage gestellt. Der Nutzer ANTWORTET nun darauf. Deine Aufgabe:',
  'die Antwort mit der ursprünglich unklaren Eingabe und den angebotenen Optionen zu EINER',
  'vollständigen, eigenständigen deutschen Frage (genau ein Indikator + ein Ort) auflösen.',
  'Wählt die Antwort klar eine Option / den best_guess, oder liefert sie den fehlenden Ort bzw.',
  'Indikator, dann precise=true. Bleibt es unklar, precise=false und stelle EINE erneute Rückfrage.',
  'Der Nutzer darf in seiner Antwort auch umschwenken (anderer Indikator UND/ODER Ort) — dann folge dem.',
  'best_guess ist IMMER ein VOLLSTÄNDIGER deutscher Fragesatz mit BEIDEM: Indikator UND Ort',
  '(z.B. "Wie hoch ist die Arbeitslosenquote in Hamburg?"), niemals nur der Indikatorname.',
  'slots.ort und slots.indikator müssen zu best_guess passen.',
  'Antworte NUR mit striktem JSON: {"precise": boolean, "clarify": string, "best_guess": string,',
  ' "options": [string], "slots": {"ort": string|null, "indikator": string|null}}',
].join('\n');

// Build a compact multi-turn memory string from the conversation history (most recent last).
function memoryBlock(context) {
  if (!context) return '';
  const hist = Array.isArray(context.history) ? context.history.slice(-4) : [];
  const lines = [];
  hist.forEach((h, i) => {
    if (!h || !h.q) return;
    const a = h.answer ? ' → ' + String(h.answer).slice(0, 160) : '';
    lines.push(`  ${i + 1}. Frage: "${h.q}"${h.place ? ' [Ort: ' + h.place + ']' : ''}${a}`);
  });
  // fall back to the single last turn if no structured history was sent
  if (!lines.length && context.lastQuery) {
    lines.push(`  1. Frage: "${context.lastQuery}"` + (context.lastAnswer ? ' → ' + String(context.lastAnswer).slice(0, 160) : ''));
  }
  if (!lines.length) return '';
  return 'GEDÄCHTNIS (bisherige Turns, ältester zuerst, neuester zuletzt):\n' + lines.join('\n')
    + '\nDer letzte Turn ist der Bezugspunkt für Anschlüsse.\n\n';
}

function normSlots(s) {
  const o = s && typeof s === 'object' ? s : {};
  return { ort: o.ort ? String(o.ort) : null, indikator: o.indikator ? String(o.indikator) : null };
}

// Which already-filled slots got OVERWRITTEN (not just newly filled) vs the previous turn's slots.
// A change to an already-set slot is a mini topic-pivot signal (per DST) rather than a silent merge.
function overwrittenSlots(prev, next) {
  const p = normSlots(prev), n = normSlots(next), out = [];
  for (const k of ['ort', 'indikator']) if (p[k] && n[k] && p[k] !== n[k]) out.push(k);
  return out;
}

async function understand(query, context) {
  const catalog = CATALOG_SUMMARY
    ? '\n\nVERFÜGBARE INDIKATOREN — best_guess und options MÜSSEN sich mit einem davon beantworten lassen:\n' + CATALOG_SUMMARY : '';
  const pending = context && context.pending;
  let u, kind;
  if (pending && (pending.clarify || (pending.options && pending.options.length) || pending.best_guess)) {
    // case (c): the user is answering the clarifying question we just asked -> short-circuit to resolution
    const ask = 'Unsere Rückfrage war: "' + (pending.clarify || '') + '"\n'
      + 'Angebotene Optionen: ' + JSON.stringify((pending.options || []).concat(pending.best_guess ? [pending.best_guess] : [])) + '\n'
      + 'Ursprüngliche, unklare Eingabe des Nutzers: "' + (pending.original || '') + '"\n'
      + 'Antwort des Nutzers jetzt: "' + query + '"';
    u = await llmJSON(CLARIFY_SYS + catalog, ask);
    kind = 'klarstellung';
  } else {
    u = await llmJSON(UNDERSTAND_SYS + catalog, memoryBlock(context) + 'Neue Eingabe: ' + query);
    kind = (u.kind === 'anschluss' || u.kind === 'neu') ? u.kind : 'neu';
  }
  const slots = normSlots(u.slots);
  return {
    kind,
    precise: !!u.precise,
    clarify: (u.clarify || '').toString(),
    best_guess: (u.best_guess || query).toString(),
    options: Array.isArray(u.options) ? u.options.filter((x) => typeof x === 'string').slice(0, 3) : [],
    slots,
    overwritten_slots: overwrittenSlots(context && context.slots, slots),
  };
}

const FOLLOWUP_SYS = [
  'Du bist ein deutsches Sprach-Callcenter für Deutschlandatlas-Regionaldaten und führst ein',
  'LAUFENDES Gespräch fort (kein neuer Kontakt). Der Anrufer hat gerade eine Antwort erhalten.',
  'Biete IMMER passende Anschlussfragen an. WICHTIG: Jede vorgeschlagene Anschlussfrage MUSS sich',
  'mit den vorhandenen Daten TATSÄCHLICH beantworten lassen. Bevorzuge deshalb genau diese beiden',
  'sicheren Muster:',
  '  (A) DERSELBE Indikator wie gerade eben, aber für eine andere vergleichbare Stadt/einen Kreis',
  '      (gerade "Arbeitslosenquote Kiel" -> "... in Lübeck?" / "... in Flensburg?").',
  '  (B) ein ANDERER, in der Liste unten aufgeführter Indikator für DENSELBEN Ort.',
  'Erfinde KEINE Kennzahlen, die es in der Liste nicht gibt, und frage NICHT nach absoluten Zahlen,',
  'wenn nur Quoten/Anteile vorliegen. Antworte NUR mit striktem JSON, ohne Erklärung:',
  '{"invite": string,        // eine EINZELNE, VOLLSTÄNDIG AUSFORMULIERTE gesprochene Anschlussfrage,',
  '                          // die an das Gespräch anknüpft. NIEMALS bei "zum Beispiel" oder ":" aufhören.',
  '                          // z.B. "Möchten Sie auch wissen, wie hoch die Arbeitslosenquote in Lübeck ist?"',
  ' "suggestions": [string]} // 3-5 konkrete Anschlussfragen als vollständige deutsche Fragesätze,',
  '                          //   jede nach Muster (A) oder (B), jede sicher aus den Daten beantwortbar.',
].join('\n');
async function followup(query, answer) {
  const sys = FOLLOWUP_SYS + (CATALOG_SUMMARY
    ? '\n\nVERFÜGBARE INDIKATOREN — schlage NUR Fragen vor, die sich mit einem davon beantworten lassen:\n' + CATALOG_SUMMARY : '');
  const u = await llmJSON(sys, 'Beantwortete Frage: ' + query + '\nGegebene Antwort: ' + (answer || ''));
  return {
    invite: (u.invite || 'Möchten Sie noch etwas wissen?').toString(),
    suggestions: Array.isArray(u.suggestions) ? u.suggestions.filter((x) => typeof x === 'string').slice(0, 5) : [],
  };
}

// keep ONLY the suggestions the pipeline can actually answer with real data.
// No raw fallback -- an unvalidated (possibly unanswerable) suggestion must never be shown.
// Whatever validates within the budget is returned; the rest are dropped (caller has a guaranteed set to fall back on).
async function validateSuggestions(suggestions, want = 3, timeoutMs = 20000) {
  if (!suggestions.length) return [];
  const good = [];
  const checks = suggestions.map((s) => answerFor(s)
    .then((r) => { if (r && r.ok && r.meta && r.meta.has_real_data !== false && r.meta.table) good.push(s); })
    .catch(() => {}));
  const timeout = new Promise((res) => setTimeout(res, timeoutMs));
  await Promise.race([Promise.all(checks), timeout]);   // take whatever validated by the deadline
  return good.slice(0, want);
}

async function readBody(req) { let b = ''; for await (const c of req) b += c; try { return JSON.parse(b); } catch { return {}; } }
const jsonRes = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try { const buf = await readFile(join(__dir, 'index.html')); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(buf); }
    catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (req.method === 'POST' && req.url === '/understand') {
    const b = await readBody(req);
    const query = (b.query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const u = await understand(query, b.context);
    answerFor(u.best_guess);                       // fire speculation in the background
    let clarifyAudioUrl = null;
    if (!u.precise && u.clarify) { try { clarifyAudioUrl = proxied(await ttsSpeak(u.clarify, 'primary')); } catch {} }
    return jsonRes(res, 200, { ...u, clarifyAudioUrl });
  }
  if (req.method === 'POST' && req.url === '/stt') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = await transcribe(Buffer.concat(chunks));
    return jsonRes(res, 200, { text });
  }
  if (req.method === 'POST' && req.url === '/context') {
    // fast, pre-answer parts (no ArcGIS pipeline): part 1 "Verstehen" (confirm the question) + part 3
    // "Wussten Sie schon" (a VARIED, fresh Wikipedia fact). Filled into the ordered speech queue on the client.
    const b = await readBody(req);
    const q = (b.query || '').toString().slice(0, 300);
    const place = placeFromQuery(q) || q;
    const vtext = stripPronunciation(verstehenText(q));
    let vau = null, funfact = null;
    const ff = await wikiFunFact(place);
    let ftext = null, fau = null;
    if (ff && ff.text) ftext = stripPronunciation(await narrate(ff.text, 'funfact'));
    await Promise.all([
      ttsSpeak(vtext, 'primary').then((u) => { vau = u; }, () => {}),
      ftext ? ttsSpeak(ftext, 'primary').then((u) => { fau = u; }, () => {}) : Promise.resolve(),
    ]);
    if (ff && ftext) funfact = { ...ff, text: ftext, audioUrl: proxied(fau) };
    return jsonRes(res, 200, { verstehen: { text: vtext, audioUrl: proxied(vau) }, funfact });
  }
  if (req.method === 'POST' && req.url === '/intro') {
    // part 2 "Überbrücken" — prepared in advance by the client (first turn: service intro; later: bridge)
    const b = await readBody(req);
    const text = await introBridge(b.context || {});
    let au = null; try { au = await ttsSpeak(text, 'primary'); } catch {}
    return jsonRes(res, 200, { text, audioUrl: proxied(au) });
  }
  if (req.method === 'POST' && (req.url === '/answer' || req.url === '/ask')) {
    const query = ((await readBody(req)).query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const r = await answerFor(query);
    // warm follow-up candidates in the background so /followup can validate them from cache (some cities have no data)
    if (r.ok && r.meta && r.meta.table && r.meta.has_real_data !== false) {
      const place = placeFromQuery(query) || r.meta.place_name_requested || r.meta.place_resolved || '';
      swapCityFollowups(query, place, 6).forEach((s) => { answerFor(s); });   // fire-and-forget speculation
    }
    return jsonRes(res, r.ok ? 200 : 502, { query, ...r });
  }
  if (req.method === 'POST' && req.url === '/followup') {
    const b = await readBody(req);
    const query = (b.query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const f = await followup(query, (b.answer || '').toString().slice(0, 600));
    const cur = await answerFor(query);   // cached from the answer just delivered
    const curHasData = !!(cur && cur.ok && cur.meta && cur.meta.table && cur.meta.has_real_data !== false);
    const place = placeFromQuery(query) || (cur && cur.meta && (cur.meta.place_name_requested || cur.meta.place_resolved)) || '';
    // Candidates: same-question place swaps (warmed during /answer) + LLM variety. NONE is trusted blindly --
    // the pipeline genuinely has no data for some cities, so every candidate is validated against a live run.
    const swaps = curHasData ? swapCityFollowups(query, place, 6) : [];
    const seen = new Set([query]); const candidates = [];
    for (const s of [...swaps, ...f.suggestions]) { if (s && !seen.has(s)) { seen.add(s); candidates.push(s); } }
    candidates.forEach((s) => answerFor(s));   // warm (swaps are mostly cache hits from /answer already)
    const validated = await validateSuggestions(candidates, 3, 35000);   // ONLY answerable ones survive
    // spoken invite must also be answerable -> derive it from a validated suggestion (fall back to a safe generic)
    const inviteText = validated.length ? deriveInvite(validated[0])
      : 'Möchten Sie noch etwas aus dem Deutschlandatlas wissen?';
    let inviteAudioUrl = null;
    try { inviteAudioUrl = proxied(await ttsSpeak(inviteText, 'primary')); } catch {}
    return jsonRes(res, 200, { invite: inviteText, suggestions: validated, inviteAudioUrl });
  }
  if (req.method === 'GET' && /^\/fillers\/filler[1-9]\.wav$/.test(req.url)) {
    try { const buf = await readFile(join(__dir, req.url.replace(/^\//, ''))); res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=3600' }); res.end(buf); }
    catch { res.writeHead(404); res.end('no filler'); }
    return;
  }
  if (req.method === 'GET' && /^\/tts\/[\w.-]+\.wav$/.test(req.url)) {
    try { const buf = await readFile(join(TTS_DIR, req.url.replace('/tts/', ''))); res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }); res.end(buf); }
    catch { res.writeHead(404); res.end('no tts'); }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/audio?')) {
    try {
      const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('bunsenbrenner.org')) { res.writeHead(400); res.end('bad url'); return; }
      const up = await fetch(u);
      if (!up.ok) { res.writeHead(502); res.end('upstream ' + up.status); return; }
      res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/wav', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch { res.writeHead(500); res.end('proxy err'); }
    return;
  }
  res.writeHead(404); res.end('not found');
});
const HOST = process.env.CC_HOST || '127.0.0.1';   // default local-only; set CC_HOST=0.0.0.0 in a container fronted by a tunnel
server.listen(PORT, HOST, () => console.log(`callcenter GUI on http://${HOST}:${PORT}`));
ensureFillers().catch(() => {});   // self-contained wait-clips (no-op if already present or no Piper)

// A single bad request (e.g. a missing static asset hit by two writeHead calls, see the
// 2026-08-31 fillers/ 404 incident that crash-looped every caller until fixed at the source)
// must never take down the whole shared process for durable unattended hosting -- log and keep
// serving everyone else instead of letting Node's default uncaught-exception behavior exit.
process.on('uncaughtException', (err) => console.error('uncaughtException (server kept running):', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection (server kept running):', err));
