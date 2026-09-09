// Deutschlandatlas Callcenter — service GUI backend: routes + dialogue policy only.
//
// The design lives in gui/dialog-fsm.mjs (shared with the browser). The heavy lifting is in
// gui/lib/: limiter (bounded, per-caller-fair queues), tts/stt (channel-first, Piper/whisper
// fallback), llm (understand / follow-up / narrate / Wikipedia), pipeline (the grounded Atlas
// answer + caches), bridging (prepared pools, N1 facts, openers, verstehen echo, invite).
//
// Routes (all JSON unless noted):
//   POST /session    {examples}          -> greeting + turn-0 opener + topic-ack clips (pools); starts
//                                           producing N1 facts for the example places
//   POST /opener     {kind, context}     -> the opener clip for an utterance (pool, or templated bridge)
//   POST /understand {query, context}    -> classify + resolve; speculation + verstehen prefetch start
//   POST /bridge     {kind, query, place}-> ONE prepared bridging clip: verstehen | fact | gap
//   POST /answer     {query}             -> the grounded answer (+ audio, high priority); produces the
//                                           N1 fact for the answered place in the background
//   POST /followup   {query, answer}     -> validated suggestions + spoken invite; produces N1 facts
//                                           for the suggested places in the background
//   POST /stt        (audio body)        -> {text}
//   GET  /, /dialog-fsm.mjs, /dialog-client.mjs, /tts/<id>.wav, /tts-stream/<id>, /stt-blob/<id>.wav,
//        /audio?u=, /debug/trace, /health, /ready, /fsm
//
// Env: PORT (8791), CC_HOST; LITELLM_*; CC_TTS=1 + channel/Piper vars (see lib/tts.mjs);
//      CC_STUB=1 + CC_TTS_STUB=1 run the whole dialogue offline (tests / demo without a proxy).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe as describeFsm, openerKind, OPENER_KIND, BRIDGE_KIND } from './dialog-fsm.mjs';
import { userKeyFor } from './lib/limiter.mjs';
import { placeFromQuery, swapCityFollowups } from './lib/text.mjs';
import { ttsSpeak, proxied, TTS_DIR, streamClips, limiterStats, protectClip, unprotectClip } from './lib/tts.mjs';
import { transcribe, sttBlobPath } from './lib/stt.mjs';
import { catalogSummary, understand, followupSuggestions, STUB } from './lib/llm.mjs';
import { configurePipeline, answerFor, hasRealData, validateSuggestions, poolSuggestions, trace, traceLines, pipelineStats } from './lib/pipeline.mjs';
import * as bridging from './lib/bridging.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dir, '..');
const PORT = parseInt(process.env.PORT || '8791', 10);
configurePipeline({ runtime: join(REPO_ROOT, 'scripts', 'n8n_workflow_runtime.mjs'), repoRoot: REPO_ROOT });
const CATALOG_SUMMARY = catalogSummary(join(REPO_ROOT, 'catalog.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readBody(req) { let b = ''; for await (const c of req) b += c; try { return JSON.parse(b); } catch { return {}; } }
const jsonRes = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
const str = (v, max = 300) => (v == null ? '' : String(v)).slice(0, max);

// Prepared invites: the first "same question, other city" follow-up is known at /understand, so its
// invite ("Bleiben wir gleich dran: soll ich Ihnen auch sagen, …?") is rendered and spoken (low
// priority) right then, and /followup finds it ready instead of paying a full TTS round trip after
// the answer — that round trip is what left the invite silent on every slow /followup.
const preparedInvites = new Map();   // userKey|candidate -> { text, audioP, ts }
function prepareInvite(candidate, userKey) {
  const key = userKey + '|' + candidate;
  if (!candidate || preparedInvites.has(key)) return;
  const text = bridging.inviteText(candidate, userKey);
  const audioP = ttsSpeak(text, { priority: false, userKey }).then((u) => { if (u) protectClip(u); return u; }).catch(() => null);
  preparedInvites.set(key, { text, audioP, ts: Date.now() });
  while (preparedInvites.size > 64) { const k = preparedInvites.keys().next().value; preparedInvites.get(k).audioP.then(unprotectClip); preparedInvites.delete(k); }
}
function takePreparedInvite(candidate, userKey) {
  const key = userKey + '|' + candidate;
  const e = preparedInvites.get(key);
  if (!e) return null;
  preparedInvites.delete(key);
  if (Date.now() - e.ts > 10 * 60 * 1000) { e.audioP.then(unprotectClip); return null; }
  return e;
}

/** Produce N1 facts for a few places in the background (never awaited by a caller). */
function produceFactsFor(places, userKey) {
  const seen = new Set();
  for (const p of places) { const k = String(p || '').trim(); if (!k || seen.has(k)) continue; seen.add(k); bridging.produceFact(k, userKey).catch(() => {}); }
}

async function handle(req, res) {
  const url = req.url || '/';
  const userKey = userKeyFor(req);

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try {
      const html = (await readFile(join(__dir, 'index.html'), 'utf8')).replace('</head>', `<script>window.CC_STT_LIVE=${process.env.CC_STT_LIVE === '1'};window.CC_BRIDGE_PAUSE_MS=${Number(process.env.CC_BRIDGE_PAUSE_MS) >= 0 ? Number(process.env.CC_BRIDGE_PAUSE_MS) : 'undefined'};</script></head>`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' }); res.end(html);
    } catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (req.method === 'GET' && (url === '/dialog-fsm.mjs' || url === '/dialog-client.mjs')) {
    try { const js = await readFile(join(__dir, url.slice(1)), 'utf8'); res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); res.end(js); }
    catch { res.writeHead(404); res.end('missing'); }
    return;
  }

  if (req.method === 'POST' && url === '/session') {
    const b = await readBody(req);
    const examples = Array.isArray(b.examples) ? b.examples.slice(0, 4).map((x) => str(x)) : [];
    const [greeting, intro, topicAck, continuation] = await Promise.all([
      bridging.fromPool('greeting', userKey),
      bridging.opener(OPENER_KIND.SERVICE_INTRO, {}, userKey),
      bridging.opener(OPENER_KIND.TOPIC_ACK, {}, userKey),
      bridging.opener(OPENER_KIND.CONTINUATION, {}, userKey),
    ]);
    // I6/I4: the very first wait should already have a REAL fact ready → prepare the example places now
    produceFactsFor(examples.map(placeFromQuery), userKey);
    return jsonRes(res, 200, { greeting, intro, topicAck, continuation });
  }

  if (req.method === 'POST' && url === '/opener') {
    const b = await readBody(req);
    const kind = Object.values(OPENER_KIND).includes(b.kind) ? b.kind : openerKind(b.context || {});
    const ctx = b.context || {};
    return jsonRes(res, 200, await bridging.opener(kind, { lastPlace: str(ctx.lastPlace, 80), lastIndicator: str(ctx.lastIndicator, 80) }, userKey));
  }

  if (req.method === 'POST' && url === '/understand') {
    const b = await readBody(req);
    const query = str(b.query);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    answerFor(query, false, userKey);                       // t=0 speculation: the Atlas query starts before we even understood it
    const u = await understand(query, b.context, CATALOG_SUMMARY);
    trace('understand', { query, precise: u.precise, kind: u.kind, clarify: u.clarify.slice(0, 70), best_guess: u.best_guess, slots: u.slots });
    answerFor(u.best_guess, false, userKey);                // also warm the resolved query (cache hit when unchanged)
    if (u.precise) {
      bridging.verstehen(u.best_guess, userKey).catch(() => {});   // prefetch the echo the client asks for next
      // Follow-up candidates ("same question, other city") are answerable by construction — start
      // their DATA speculation now, in parallel with the real answer (low priority), so /followup can
      // validate them within its budget instead of racing pipelines that only began when the answer
      // returned (that race left slow turns without any follow-up).
      const place = (u.slots && u.slots.ort) || placeFromQuery(u.best_guess) || '';
      const swaps = swapCityFollowups(u.best_guess, place, 3);
      swaps.forEach((s) => { answerFor(s, false, userKey); });
      if (swaps[0]) prepareInvite(swaps[0], userKey);   // the invite for the likeliest follow-up, spoken now
      // N1 for THIS place too (low priority): a slow answer then gets a fact about the place asked
      // about, never one about a different place (the fact bridge is same-place or generic only)
      if (place) produceFactsFor([place], userKey);
    }
    let clarifyAudioUrl = null;
    if (!u.precise && u.clarify) { try { clarifyAudioUrl = proxied(await ttsSpeak(u.clarify, { priority: true, userKey })); } catch {} }
    return jsonRes(res, 200, { ...u, clarifyAudioUrl });
  }

  if (req.method === 'POST' && url === '/bridge') {
    // ONE prepared bridging clip. Nothing here is fetched live (I4): verstehen is a short cached
    // dynamic clip, fact comes from the N1 store / F1 pool, gap from the pool. audioUrl:null means
    // "nothing to say" — the client skips the slot instantly and asks for the next kind.
    const b = await readBody(req);
    const query = str(b.query), place = str(b.place, 80) || placeFromQuery(query) || '';
    if (b.kind === BRIDGE_KIND.VERSTEHEN) return jsonRes(res, 200, query.trim() ? await bridging.verstehen(query, userKey) : { kind: b.kind, text: null, audioUrl: null });
    if (b.kind === BRIDGE_KIND.FACT) return jsonRes(res, 200, bridging.takeFact(place, userKey));
    return jsonRes(res, 200, bridging.gap(userKey));
  }

  if (req.method === 'POST' && url === '/answer') {
    const query = str((await readBody(req)).query);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const r = await answerFor(query, true, userKey);         // user-facing: priority over any speculation
    let audioUrl = null;
    if (r.ok && r.answer) { try { audioUrl = proxied(await ttsSpeak(r.answer, { priority: true, userKey, stream: true })); } catch {} }
    trace('answer', { query, ok: r.ok, table: r.meta && r.meta.table, has_real_data: r.meta && r.meta.has_real_data, rows: r.meta && r.meta.live_rows_used, reused: r.reused, err: r.err });
    const place = placeFromQuery(query) || (r.meta && (r.meta.place_resolved || r.meta.place_name_requested)) || '';
    // I6: prepare the NEXT round now — the fact for this place (N1) and the data for the likely
    // "same question, other city" follow-ups. Background, low priority, never awaited.
    if (place) produceFactsFor([place], userKey);
    if (hasRealData(r)) swapCityFollowups(query, place, 3).forEach((s) => { answerFor(s, false, userKey); });
    const status = r.ok ? 200 : (r.err === 'QUEUE_FULL' ? 503 : 502);
    return jsonRes(res, status, { query, ...r, audioUrl });
  }

  if (req.method === 'POST' && url === '/followup') {
    const b = await readBody(req);
    const query = str(b.query);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const cur = await answerFor(query, false, userKey);     // cached from the answer just delivered
    const curOk = hasRealData(cur);
    const place = placeFromQuery(query) || (cur && cur.meta && (cur.meta.place_name_requested || cur.meta.place_resolved)) || '';
    // After a FAILED turn the LLM must not improvise off the failure text: suggestions then come
    // only from the verified pool (exact queries proven to return real data before).
    const llmSugs = curOk ? await followupSuggestions(query, str(cur.answer, 600), CATALOG_SUMMARY) : [];
    const swaps = curOk ? swapCityFollowups(query, place, 3) : [];
    const seen = new Set([query]); const candidates = [];
    for (const s of [...swaps, ...llmSugs]) { if (s && !seen.has(s)) { seen.add(s); candidates.push(s); } }
    if (candidates.length < 3) for (const s of poolSuggestions(query, 5 - candidates.length)) { if (s && !seen.has(s)) { seen.add(s); candidates.push(s); } }
    candidates.splice(6);
    candidates.forEach((s) => answerFor(s, false, userKey));
    const validated = await validateSuggestions(candidates, 3, 8000, userKey);
    const prepared = validated.length ? takePreparedInvite(validated[0], userKey) : null;
    const invite = prepared ? prepared.text
      : validated.length ? bridging.inviteText(validated[0], userKey) : 'Möchten Sie noch etwas aus dem Deutschlandatlas wissen?';
    let inviteAudioUrl = null;
    try {
      const au = prepared ? (await prepared.audioP) : null;
      if (au) unprotectClip(au);
      inviteAudioUrl = proxied(au || await ttsSpeak(invite, { priority: false, userKey }));
    } catch {}
    // I6: the places the caller is most likely to ask about next get their "Wussten Sie schon" now
    produceFactsFor(validated.slice(0, 2).map(placeFromQuery), userKey);
    return jsonRes(res, 200, { invite, suggestions: validated, inviteAudioUrl });
  }

  if (req.method === 'POST' && url === '/stt') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const base = process.env.CC_PUBLIC_BASE || (req.headers.host ? 'https://' + req.headers.host : null);
    return jsonRes(res, 200, { text: await transcribe(Buffer.concat(chunks), base) });
  }

  if (req.method === 'GET' && /^\/tts\/[\w.-]+\.wav$/.test(url)) {
    try { const buf = await readFile(join(TTS_DIR, url.replace('/tts/', ''))); res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }); res.end(buf); }
    catch { res.writeHead(404); res.end('no tts'); }
    return;
  }
  if (req.method === 'GET' && /^\/tts-stream\/[\w.-]+$/.test(url)) {
    const entry = streamClips.get(url.replace('/tts-stream/', ''));
    if (!entry) { res.writeHead(404); res.end('no stream'); return; }
    try {
      const up = await fetch(entry.url);
      if (!up || !up.ok || !up.body) { res.writeHead(502); res.end('upstream'); return; }
      res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/wav', 'cache-control': 'no-store' });
      for await (const chunk of up.body) { if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); }
      res.end();
    } catch { try { if (!res.headersSent) res.writeHead(502); res.end(); } catch {} }
    return;
  }
  if (req.method === 'GET' && /^\/stt-blob\/[a-f0-9]{32}\.wav$/.test(url)) {
    const p = sttBlobPath(url.replace('/stt-blob/', '').replace('.wav', ''));
    if (!p) { res.writeHead(404); res.end('no blob'); return; }
    try { const buf = await readFile(p); res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }); res.end(buf); }
    catch { res.writeHead(404); res.end('no blob'); }
    return;
  }
  if (req.method === 'GET' && url.startsWith('/audio?')) {
    // Proxy for channel clip URLs (bunsenbrenner.org only); retries transient upstream blips.
    try {
      const u = new URL(url, 'http://x').searchParams.get('u') || '';
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('bunsenbrenner.org')) { res.writeHead(400); res.end('bad url'); return; }
      let up = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { up = await fetch(u); } catch { up = null; }
        if (up && up.ok) break;
        if (attempt < 3) await sleep(250 * attempt);
      }
      if (!up || !up.ok) { res.writeHead(502); res.end('upstream ' + (up ? up.status : 'fetch-failed')); return; }
      res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/wav', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch { res.writeHead(500); res.end('proxy err'); }
    return;
  }

  if (req.method === 'GET' && url.startsWith('/debug/trace')) {
    const pretty = traceLines().map((e) => `${new Date(e.ms).toISOString().slice(11, 19)} #${e.i} ${e.tag}\t${JSON.stringify((({ i, ms, tag, ...rest }) => rest)(e))}`).join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pretty || '(no trace yet — make a request first)');
    return;
  }
  if (req.method === 'GET' && url === '/health') {
    return jsonRes(res, 200, { status: 'ok', uptime_s: Math.round(process.uptime()), pid: process.pid, stub: STUB, pools: bridging.poolStats(), facts: bridging.factStats() });
  }
  if (req.method === 'GET' && url === '/ready') {
    const limiters = { pipeline: pipelineStats(), ...limiterStats() };
    const saturated = Object.values(limiters).some((s) => s.hiQueued >= s.hiQueueMax || s.loQueued >= s.loQueueMax);
    const ready = !shuttingDown && !saturated;
    return jsonRes(res, ready ? 200 : 503, { ready, shutting_down: shuttingDown, limiters });
  }
  if (req.method === 'GET' && url.startsWith('/fsm')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(describeFsm(), null, 2));
    return;
  }
  res.writeHead(404); res.end('not found');
}

let shuttingDown = false;
const server = createServer((req, res) => { handle(req, res).catch((e) => { console.error('route error', req.url, e); try { if (!res.headersSent) res.writeHead(500); res.end('error'); } catch {} }); });
const HOST = process.env.CC_HOST || '127.0.0.1';
server.listen(PORT, HOST, () => { console.log(`callcenter GUI on http://${HOST}:${PORT}${STUB ? ' (STUB mode)' : ''}`); bridging.prewarm(); });

// A single bad request must never take down the shared process (durable unattended hosting).
process.on('uncaughtException', (err) => console.error('uncaughtException (server kept running):', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection (server kept running):', err));

// Graceful drain: /ready flips to 503 first, the listener closes after a grace period so a load
// balancer sees the 503 before connections are refused; in-flight turns finish; a backstop forces exit.
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const drainDelayMs = Number(process.env.CC_DRAIN_DELAY_MS) || 3000;
  console.log(`${signal} received — /ready now 503; closing the listener in ${drainDelayMs}ms…`);
  setTimeout(() => { server.close(() => { console.log('drained, exiting'); process.exit(0); }); }, drainDelayMs);
  const t = setTimeout(() => { console.error('graceful shutdown timed out — forcing exit'); process.exit(1); }, drainDelayMs + (Number(process.env.CC_SHUTDOWN_TIMEOUT_MS) || 15000));
  if (t.unref) t.unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
