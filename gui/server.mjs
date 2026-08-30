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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const PORT = parseInt(process.env.PORT || '8791', 10);
const RUNTIME = join(REPO_ROOT, 'scripts', 'n8n_workflow_runtime.mjs');

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
async function wikiFunFact(place) {
  if (!place) return null;
  try {
    const r = await fetch('https://de.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(place),
      { headers: { accept: 'application/json', 'user-agent': 'CADS-Demo-Callcenter/1.0 (https://bunsenbrenner.org)' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.type === 'disambiguation' || !j.extract) return null;
    // first 1-2 sentences, taken VERBATIM from Wikipedia -- never rephrased, never LLM-touched
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
    const answer = r.final?.text || r.final?.answer || null;
    const meta = r.final?.meta || null;
    let au = null;
    if (answer) { try { au = await ttsSpeak(answer, 'primary'); } catch {} }
    return { ok: r.ok, answer, meta, audioUrl: proxied(au), funfact, err: r.ok ? null : (r.err || 'pipeline failed') };
  })();
  specCache.set(key, promise);
  if (specCache.size > 24) specCache.delete(specCache.keys().next().value);
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

async function understand(query) {
  const u = await llmJSON(UNDERSTAND_SYS, 'Nutzerfrage: ' + query);
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
  'Biete IMMER passende Anschlussfragen an (gleicher Ort, verwandtes Thema, oder derselbe Indikator',
  'für einen Vergleichsort). Antworte NUR mit striktem JSON, ohne Erklärung:',
  '{"invite": string,        // eine EINZELNE, VOLLSTÄNDIG AUSFORMULIERTE gesprochene Anschlussfrage,',
  '                          // die an das Gespräch anknüpft. NIEMALS bei "zum Beispiel" oder ":" aufhören.',
  '                          // z.B. "Möchten Sie auch wissen, wie hoch die Arbeitslosenquote in Kiel ist?"',
  ' "suggestions": [string]} // 2-3 konkrete Anschlussfragen als vollständige deutsche Fragesätze (je Indikator + Ort)',
].join('\n');
async function followup(query, answer) {
  const u = await llmJSON(FOLLOWUP_SYS, 'Beantwortete Frage: ' + query + '\nGegebene Antwort: ' + (answer || ''));
  return {
    invite: (u.invite || 'Möchten Sie noch etwas wissen?').toString(),
    suggestions: Array.isArray(u.suggestions) ? u.suggestions.filter((x) => typeof x === 'string').slice(0, 3) : [],
  };
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
    const query = ((await readBody(req)).query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const u = await understand(query);
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
    return jsonRes(res, r.ok ? 200 : 502, { query, ...r });
  }
  if (req.method === 'POST' && req.url === '/followup') {
    const b = await readBody(req);
    const query = (b.query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const f = await followup(query, (b.answer || '').toString().slice(0, 600));
    let inviteAudioUrl = null;
    if (f.invite) { try { inviteAudioUrl = proxied(await ttsSpeak(f.invite, 'primary')); } catch {} }
    f.suggestions.forEach((s) => answerFor(s));   // pre-speculate the follow-ups too
    return jsonRes(res, 200, { ...f, inviteAudioUrl });
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
