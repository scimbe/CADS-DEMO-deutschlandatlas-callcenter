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
import { readFileSync } from 'node:fs';
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

function ttsSpeak(text, voice = 'primary') {
  if (process.env.CC_TTS !== '1') return Promise.resolve(null);
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
const proxied = (u) => (u ? '/audio?u=' + encodeURIComponent(u) : null);

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
async function wikiFunFact(place) {
  if (!place) return null;
  try {
    const r = await fetch('https://de.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(place),
      { headers: { accept: 'application/json', 'user-agent': 'CADS-Demo-Callcenter/1.0 (https://bunsenbrenner.org)' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.type === 'disambiguation' || !j.extract) return null;
    // first 1-2 sentences, taken VERBATIM from Wikipedia as the source of truth (narrate() later restyles it, number-guarded)
    const text = j.extract.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
    if (text.length < 20) return null;
    return { text, title: j.title || place, url: j.content_urls?.desktop?.page || ('https://de.wikipedia.org/wiki/' + encodeURIComponent(place)) };
  } catch { return null; }
}

// --- speculation cache: query -> Promise<{ok,answer,meta,audioUrl,funfact,err}> ---
const specCache = new Map();
function answerFor(query) {
  const key = (query || '').trim();
  if (!key) return Promise.resolve({ ok: false, answer: null, meta: null, audioUrl: null, funfact: null, err: 'empty' });
  if (specCache.has(key)) return specCache.get(key);
  const promise = (async () => {
    const [r, funfact] = await Promise.all([runPipeline(key), wikiFunFact(placeFromQuery(key))]);  // Wikipedia in parallel
    const rawAnswer = r.final?.text || r.final?.answer || null;
    const meta = r.final?.meta || null;
    // narrative style for the answer + entertaining spoken style for the fun fact -- strictly grounded (number-guarded)
    const [answer, ffText] = await Promise.all([
      rawAnswer ? narrate(rawAnswer, 'answer') : Promise.resolve(null),
      funfact ? narrate(funfact.text, 'funfact') : Promise.resolve(null),
    ]);
    let au = null, ffAu = null;
    await Promise.all([                                              // answer + fun-fact spoken in parallel (both Thorsten)
      answer ? ttsSpeak(answer, 'primary').then((u) => { au = u; }, () => {}) : Promise.resolve(),
      ffText ? ttsSpeak(ffText, 'primary').then((u) => { ffAu = u; }, () => {}) : Promise.resolve(),
    ]);
    const ff = funfact ? { ...funfact, text: ffText || funfact.text, audioUrl: proxied(ffAu) } : null;
    return { ok: r.ok, answer, meta, audioUrl: proxied(au), funfact: ff, err: r.ok ? null : (r.err || 'pipeline failed') };
  })();
  specCache.set(key, promise);
  // cache only successes: drop failed/empty runs so transient pipeline flakiness can be retried (never cached as "no data")
  promise.then((r) => { if (!r || !r.ok || !(r.meta && r.meta.table && r.meta.has_real_data !== false)) specCache.delete(key); },
    () => specCache.delete(key));
  if (specCache.size > 80) specCache.delete(specCache.keys().next().value);   // keep validated follow-ups warm until clicked
  return promise;
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
  'Antworte NUR mit striktem JSON, ohne Erklärung, ohne Markdown:',
  '{"precise": boolean,   // true nur wenn genau EIN Indikator UND ein Ort eindeutig erkennbar sind',
  ' "clarify": string,    // EINE kurze, freundliche deutsche Rückfrage, die zur sauberen Anfrage führt (leer wenn precise=true)',
  ' "best_guess": string, // die wahrscheinlichste konkrete Frage als vollständiger deutscher Fragesatz (Indikator + Ort); IMMER gesetzt',
  ' "options": [string]}  // 2-3 konkrete alternative Fragesätze zur Auswahl (je Indikator + Ort)',
  'Fehlt der Ort, frage gezielt nach dem Ort. Ist das Thema unklar, biete die naheliegendsten Indikatoren an.',
].join('\n');

async function understand(query, context) {
  const sys = UNDERSTAND_SYS + (CATALOG_SUMMARY
    ? '\n\nVERFÜGBARE INDIKATOREN — best_guess und options MÜSSEN sich mit einem davon beantworten lassen:\n' + CATALOG_SUMMARY : '');
  const ctx = context && context.lastQuery
    ? 'Laufendes Gespräch. Vorige Frage: "' + context.lastQuery + '"'
      + (context.lastAnswer ? ('. Vorige Antwort: "' + String(context.lastAnswer).slice(0, 280) + '"') : '')
      + '. Die neue Eingabe kann sich darauf beziehen (nur anderer Ort/Indikator, elliptisch). Löse solche Bezüge zu einer vollständigen Frage auf.\n\n' : '';
  const u = await llmJSON(sys, ctx + 'Neue Eingabe: ' + query);
  return {
    precise: !!u.precise,
    clarify: (u.clarify || '').toString(),
    best_guess: (u.best_guess || query).toString(),
    options: Array.isArray(u.options) ? u.options.filter((x) => typeof x === 'string').slice(0, 3) : [],
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
    try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await readFile(join(__dir, 'index.html'))); }
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
    try { res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=3600' }); res.end(await readFile(join(__dir, req.url.replace(/^\//, '')))); }
    catch { res.writeHead(404); res.end('no filler'); }
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
server.listen(PORT, '127.0.0.1', () => console.log(`callcenter GUI on http://127.0.0.1:${PORT}`));
