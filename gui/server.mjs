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
import { randomUUID } from 'node:crypto';
import FSM_SPEC, { bridgeKind, describe as describeFsm } from './dialog-fsm.mjs';

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

// --- lightweight per-request trace so a caller (or /debug/trace) can see WHY a query behaved as it did ---
const traceBuf = [];
let traceSeq = 0;
function trace(tag, obj) {
  const e = { i: ++traceSeq, ms: Date.now(), tag, ...obj };
  traceBuf.push(e); if (traceBuf.length > 120) traceBuf.shift();
  try { console.log('[trace] ' + tag + ' ' + JSON.stringify(obj)); } catch {}
}

// Bound concurrent heavy child processes so a burst of requests can't thrash a small host. Real
// incident: a backlog of speculative + live requests spawned 8 concurrent Piper procs and drove the
// 2-vCPU host to load 200+, making everything appear to hang. A priority queue runs user-facing work
// (real /answer) before background speculation. Caps are env-tunable per host size.
function makeLimiter(max) {
  let active = 0; const hi = [], lo = [];
  const pump = () => {
    if (active >= max) return;
    const job = hi.shift() || lo.shift(); if (!job) return;
    active++;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { active--; pump(); });
  };
  return (task, priority = false) => new Promise((resolve, reject) => { (priority ? hi : lo).push({ task, resolve, reject }); pump(); });
}
// Default 1: Piper is CPU-bound and even 2 concurrent synths saturate a 2-core host, making EACH job
// ~10-30x slower (measured: 18-61s for 67-450 chars at cap 2). Serialising at cap 1 lets each clip
// synth at full speed, so the caller hears each part sooner. Raise CC_PIPER_CONCURRENCY on a bigger host.
const piperLimit = makeLimiter(Number(process.env.CC_PIPER_CONCURRENCY) || 1);   // CPU-bound TTS
const pipeLimit = makeLimiter(Number(process.env.CC_PIPELINE_CONCURRENCY) || 3);  // pipeline runtime spawns
// The llm2 audio_generation channel is a SINGLE-SLOT serve (one parked accept leg at a time). A real
// turn fires 3 channel calls near-simultaneously -- verstehen + funfact (/context) and the answer
// (/answer) -- which, unserialised, thrash the broker's park/re-park cycle: each call waits for the
// serve to re-park, so 3 concurrent ~6s calls balloon to ~80s AND verstehen/funfact often exceed the
// per-call timeout and come back null (never play). Serialising channel calls to 1 makes them run
// back-to-back (~6s each, in play order) with no thrash. Env-tunable if llm2 ever gets multi-slot.
const chanLimit = makeLimiter(Number(process.env.CC_CHANNEL_CONCURRENCY) || 1);

function runPipeline(query, priority = false) {
  return pipeLimit(() => _runPipelineNow(query), priority);
}
function _runPipelineNow(query) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn('node', [RUNTIME, '--query', query], { cwd: REPO_ROOT, env: process.env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      let final = null;
      const lines = out.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) { try { final = JSON.parse(lines[i]); break; } catch {} }
      const m = final && final.meta;
      // pull the runtime's per-stage TIMING traces (catalog-match-LLM / arcgis-total / phrasing-LLM)
      // out of stderr so the breakdown shows in the log + /debug/trace, not just the total took_ms.
      const timings = (err.match(/TIMING [^\n]+/g) || []).map((l) => l.replace('TIMING ', '').trim());
      trace('pipeline', { query, ok: code === 0 && final != null, code, took_ms: Date.now() - t0,
        timings: timings.length ? timings : undefined,
        table: m && m.table, has_real_data: m && m.has_real_data, rows: m && m.live_rows_used,
        place: m && (m.place_resolved || m.place_name_requested), note: (m && (m.reformulation_note || m.note)) || null,
        err_tail: err ? err.replace(/\s+/g, ' ').slice(-260) : null });
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
// Greeting clips are prewarmed at startup (see prewarmGreetings) and cached here; protect them from
// pruning so the "logo -> first ton" stays instant even after many answer clips fill TTS_DIR.
const greetingCache = new Map(); // raw greeting text -> /tts/<id>.wav
// Pre-produced bridging pools (operator spec B1/F1/K1/N1): a generic F1 pool (atlas/bunsenbrenner info,
// first question + fallback) and a content-linked N1 queue (a "wussten Sie schon" produced in the
// background right after each answer, for the NEXT round). Both hold /tts/<id>.wav clips protected below.
const bridgeF1 = [];        // [{ text, audioUrl }]
const bridgeN1Queue = [];   // [{ text, audioUrl, ... }] content-linked, FIFO
const gapPool = [];         // [{ text, audioUrl }] pre-produced "looking it up" gap clips (verstehen slot)
function pruneTtsDir(keep = 100) {
  try {
    const keepFiles = new Set([
      ...[...greetingCache.values()],
      ...bridgeF1.map((c) => c.audioUrl),
      ...bridgeN1Queue.map((c) => c.audioUrl),
      ...gapPool.map((c) => c.audioUrl),
    ].filter(Boolean).map((u) => u.replace('/tts/', '')));
    const files = readdirSync(TTS_DIR).filter((f) => f.endsWith('.wav') && !keepFiles.has(f))
      .map((f) => ({ f, t: statSync(join(TTS_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) { try { unlinkSync(join(TTS_DIR, f)); } catch {} }
  } catch {}
}
function ttsLocalPiper(text, priority = true) {
  // gated through piperLimit so at most CC_PIPER_CONCURRENCY Piper procs run at once (else a burst
  // spawns dozens and thrashes a small host). User-facing TTS is high-priority; background work
  // (filler regeneration, speculation) passes priority=false so a real answer never waits behind it.
  const tQueued = Date.now();
  return piperLimit(() => new Promise((resolve) => {
    const tStart = Date.now();
    try { mkdirSync(TTS_DIR, { recursive: true }); } catch {}
    const id = process.pid + '-' + (ttsSeq++);
    const wav = join(TTS_DIR, id + '.wav');
    let done = false;
    const fin = (v) => { if (done) return; done = true;
      // visibility into where a slow spoken clip goes: time spent WAITING for a Piper slot vs the
      // actual synth time (services could see the total 100s gap but not whether it was queueing).
      console.error(`[trace] piper-tts prio=${priority ? 'hi' : 'lo'} queued=${tStart - tQueued}ms synth=${Date.now() - tStart}ms chars=${(text || '').length} ok=${v != null}`);
      resolve(v);
    };
    try {
      const p = spawn(process.env.CC_PIPER_BIN, ['--model', process.env.CC_PIPER_MODEL, '--output_file', wav], { env: process.env });
      p.stdin.on('error', () => {});
      p.stdin.end(text);
      p.on('close', (code) => { pruneTtsDir(); fin(code === 0 && existsSync(wav) ? '/tts/' + id + '.wav' : null); });
      p.on('error', () => fin(null));
    } catch { fin(null); }
  }), priority);
}

// The llm2 agent `audio_generation` channel. Resolves to an https clip URL, or null on any failure
// (spawn error, non-URL output) so the caller can fall back.
function ttsChannel(text, voice = 'primary') {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text, voice });
    const p = spawn('bash', ['-c',
      `set -a; source "$CT_RELAY_ENV"; set +a; printf '%s' '${payload.replace(/'/g, "'\\''")}' | ` +
      `CT_CHANNEL_ROLE=initiate CT_CHANNEL_CALL_SERVICE=audio_generation CT_CHANNEL_CALL_PERSISTENT=${process.env.CC_CALL_PERSISTENT || '0'} CT_CHANNEL_RELAY_ONLY=1 ` +
      `CT_CHANNEL_ID="${process.env.CT_AUDIO_CHANNEL_ID}" CT_CHANNEL_GRANT="$CT_CHANNEL_GRANT_2E" CT_CHANNEL_HOLDER_KEY="$CT_CHANNEL_HOLDER_KEY" CT_CHANNEL_NOISE_KEY="$CT_CHANNEL_NOISE_KEY" ` +
      `CT_CHANNEL_FRONT_DOOR=bunsenbrenner.org:443 CT_CHANNEL_FRONT_DOOR_CERT="$CT_CHANNEL_FRONT_DOOR_CERT" CT_CHANNEL_FRONT_DOOR_ONLY=1 ` +
      `CT_CHANNEL_BROKER=bunsenbrenner.org:4435 CT_CHANNEL_RELAY=bunsenbrenner.org:4436 "$CT_AGENT_BIN" channel 2>/dev/null | tail -1`],
      { env: process.env });
    let out = '', done = false;
    const finish = (url) => { if (done) return; done = true; clearTimeout(timer); try { p.kill('SIGKILL'); } catch {} resolve(url); };
    // A channel call must NEVER hang the whole answer: if the edge stalls (e.g. the grant is not yet a
    // valid member -> [not-member], or the flaky tunnel), time out and resolve null so ttsSpeak falls
    // back to local Piper. Without this, a stalled channel call left TTS silent ("höre nichts").
    const timer = setTimeout(() => finish(null), Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 8000);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const url = (out.trim().split('\n').pop() || '').trim(); finish(/^https:\/\//.test(url) ? url : null); });
    p.on('error', () => finish(null));
  });
}

// A channel clip's https URL is in-memory on llm2's side with a ~15-min TTL, so a PREFETCHED/warmed
// clip (intro/greeting/topic-ack/invite) played later would 404. Fetch the bytes IMMEDIATELY on
// receipt and cache them under our own /tts/ dir, returning a same-origin /tts/<id>.wav path -- that
// decouples playback from the channel TTL. On any fetch failure, fall back to the original channel URL
// (still works if the clip is played promptly). Reuses the Piper TTS_DIR + its capped pruning.
async function localizeChannelClip(url) {
  try {
    const resp = await fetch(url);
    if (!resp || !resp.ok) return url;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return url;
    try { mkdirSync(TTS_DIR, { recursive: true }); } catch {}
    const id = 'ch-' + process.pid + '-' + (ttsSeq++);
    await writeFile(join(TTS_DIR, id + '.wav'), buf);
    pruneTtsDir();
    return '/tts/' + id + '.wav';
  } catch { return url; }
}

// STREAMING path (CC_TTS_STREAM=1): for the immediate, user-facing answer the real-time character
// matters -- buffering the whole clip (localizeChannelClip) before playback kills it. Instead of
// fetching+buffering here, register the channel clip URL and return a same-origin /tts-stream/<id>
// path IMMEDIATELY; the browser's plain <audio> element then plays it progressively while the
// /tts-stream route pipes llm2's chunked WAV through in real time (no MediaSource needed). Used only
// for priority (answer) calls; prefetched/warmed clips keep localizeChannelClip's TTL-safe caching.
const streamClips = new Map(); // id -> { url, ts }
function streamChannelClip(url) {
  const id = 'st-' + process.pid + '-' + (ttsSeq++);
  streamClips.set(id, { url, ts: Date.now() });
  const cutoff = Date.now() - 15 * 60 * 1000; // channel-URL TTL
  for (const [k, v] of streamClips) { if (v.ts < cutoff) streamClips.delete(k); }
  while (streamClips.size > 128) { const k = streamClips.keys().next().value; streamClips.delete(k); }
  return '/tts-stream/' + id;
}

function ttsSpeak(text, voice = 'primary', priority = true, forceStream = false) {
  text = stripPronunciation(text);
  if (process.env.CC_TTS !== '1') return Promise.resolve(null);
  // Production voice = the llm2 agent `audio_generation` channel (operator directive), CHANNEL-FIRST.
  // Local Piper, when configured, is an automatic RUNTIME fallback: if the channel call fails at
  // request time (host can't reach it, spawn error, non-URL output), we synthesize with Piper instead
  // so a delivered turn is never silent. With no channel env, Piper is used directly; with neither,
  // TTS is a no-op. (Operator choice: "Channel + Piper-Fallback — nutzt den Channel wenn erreichbar,
  // verstummt nie".)
  const channelReady = process.env.CT_AGENT_BIN && process.env.CT_RELAY_ENV && process.env.CT_AUDIO_CHANNEL_ID;
  const piperReady = process.env.CC_PIPER_BIN && process.env.CC_PIPER_MODEL;
  if (channelReady) {
    // serialise channel calls (chanLimit=1) so verstehen/funfact/answer don't thrash llm2's single-slot
    // serve; the user-facing answer (priority=true) still jumps ahead of any low-priority prefetch.
    return chanLimit(() => ttsChannel(text, voice), priority).then((url) => (url ? ((process.env.CC_TTS_STREAM === '1' && (priority || forceStream)) ? streamChannelClip(url) : localizeChannelClip(url)) : (piperReady ? ttsLocalPiper(text, priority) : null)));
  }
  if (piperReady) return ttsLocalPiper(text, priority);
  return Promise.resolve(null);
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
  // Filler regeneration is background work: gate it through piperLimit at LOW priority so it never
  // occupies a Piper slot ahead of a real user-facing clip (a boot-time filler resynth otherwise held
  // the cores and delayed the first real audio to ~150s on the small host).
  return piperLimit(() => new Promise((res) => {
    try {
      const p = spawn(process.env.CC_PIPER_BIN, ['--model', process.env.CC_PIPER_MODEL, '--output_file', f], { env: process.env });
      p.stdin.on('error', () => {}); p.stdin.end(text);
      p.on('close', (code) => res(code === 0 && existsSync(f) && statSync(f).size > 0));
      p.on('error', () => res(false));
    } catch { res(false); }
  }), false);
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

// --- STT via the llm2 `speech_to_text` channel (operator directive: all heavy compute off this host,
// same channel bd72dd51 as audio_generation, one grant covers both -- only CT_CHANNEL_CALL_SERVICE
// differs). Structurally different from TTS: the service takes an https audio_url (it downloads the
// file itself), not an inline payload -- so the mic audio must first be reachable under our OWN public
// origin. We normalize to 16kHz mono wav, host it briefly, hand the URL to the channel, then evict it.
// Local whisper.cpp stays as the runtime fallback (channel failure -> never silent). Gated on
// CC_STT_CHANNEL=1 so it can be rolled out independently of the (already live) TTS channel. ---
const STT_BLOB_DIR = join(tmpdir(), 'cc-stt-blob');
try { mkdirSync(STT_BLOB_DIR, { recursive: true }); } catch {}
const sttBlobs = new Map();  // id -> local wav path (only ids in here are served by /stt-blob)
async function toWav16k(buf) {
  const base = join(tmpdir(), 'cc-sttc-' + process.pid + '-' + (sttSeq++));
  const inp = base + '.in', wav = base + '.wav';
  try {
    await writeFile(inp, buf);
    if ((await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inp, '-ar', '16000', '-ac', '1', wav, '-y'])).code !== 0) return null;
    return await readFile(wav);
  } catch { return null; }
  finally { rm(inp, { force: true }).catch(() => {}); rm(wav, { force: true }).catch(() => {}); }
}
async function hostSttBlob(wav, publicBase) {
  const id = randomUUID().replace(/-/g, '');
  const p = join(STT_BLOB_DIR, id + '.wav');
  await writeFile(p, wav);
  sttBlobs.set(id, p);
  const t = setTimeout(() => { sttBlobs.delete(id); rm(p, { force: true }).catch(() => {}); }, 60000);  // backstop TTL
  if (t.unref) t.unref();
  return { id, url: publicBase.replace(/\/$/, '') + '/stt-blob/' + id + '.wav' };
}
function evictSttBlob(id) { const p = sttBlobs.get(id); if (p) { sttBlobs.delete(id); rm(p, { force: true }).catch(() => {}); } }
// One speech_to_text call over the channel. The WHOLE stdout is the plain-text transcription
// (ct-agent's own status/log lines go to stderr, stripped by 2>/dev/null). Returns null on an
// ERROR:/empty result so the caller falls back to local whisper.
function sttChannel(audioUrl, lang = 'de') {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ audio_url: audioUrl, lang });
    const p = spawn('bash', ['-c',
      `set -a; source "$CT_RELAY_ENV"; set +a; printf '%s' '${payload.replace(/'/g, "'\\''")}' | ` +
      `CT_CHANNEL_ROLE=initiate CT_CHANNEL_CALL_SERVICE=speech_to_text CT_CHANNEL_CALL_PERSISTENT=${process.env.CC_CALL_PERSISTENT || '0'} CT_CHANNEL_RELAY_ONLY=1 ` +
      `CT_CHANNEL_ID="${process.env.CT_AUDIO_CHANNEL_ID}" CT_CHANNEL_GRANT="$CT_CHANNEL_GRANT_2E" CT_CHANNEL_HOLDER_KEY="$CT_CHANNEL_HOLDER_KEY" CT_CHANNEL_NOISE_KEY="$CT_CHANNEL_NOISE_KEY" ` +
      `CT_CHANNEL_FRONT_DOOR=bunsenbrenner.org:443 CT_CHANNEL_FRONT_DOOR_CERT="$CT_CHANNEL_FRONT_DOOR_CERT" CT_CHANNEL_FRONT_DOOR_ONLY=1 ` +
      `CT_CHANNEL_BROKER=bunsenbrenner.org:4435 CT_CHANNEL_RELAY=bunsenbrenner.org:4436 "$CT_AGENT_BIN" channel 2>/dev/null`],
      { env: process.env });
    let out = '', done = false;
    const finish = (t) => { if (done) return; done = true; clearTimeout(timer); try { p.kill('SIGKILL'); } catch {} resolve(t); };
    const timer = setTimeout(() => finish(null), Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 30000);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const t = (out || '').replace(/\s+/g, ' ').trim(); finish(t && !/^ERROR:/i.test(t) ? t : null); });
    p.on('error', () => finish(null));
  });
}
// CHANNEL-FIRST STT with local whisper fallback (mirrors ttsSpeak). publicBase = the origin llm2 can
// fetch the hosted blob from (derived from the request Host, overridable via CC_PUBLIC_BASE).
async function sttSpeak(buf, publicBase) {
  if (!buf || !buf.length) return '';
  const channelReady = process.env.CC_STT_CHANNEL === '1' && process.env.CT_AGENT_BIN && process.env.CT_RELAY_ENV && process.env.CT_AUDIO_CHANNEL_ID && publicBase;
  if (channelReady) {
    const wav = await toWav16k(buf);
    if (wav) {
      let id = null;
      try { const h = await hostSttBlob(wav, publicBase); id = h.id; const t = await sttChannel(h.url, 'de'); if (t) return t; }
      catch {}
      finally { if (id) evictSttBlob(id); }
    }
    // any channel failure falls through to local whisper below (never silent)
  }
  if (process.env.CC_WHISPER_MODEL) return transcribe(buf);
  return '';
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

// Turn a (validated, answerable) suggestion into a spoken LEAD-IN: Thorsten does not passively
// offer, he ACTIVELY guides the caller onward to the next question, knüpft an das laufende
// Gespräch an, varied so consecutive turns don't repeat, and ALWAYS ends as a clear closed
// question so the one-click "Ja" bubble works. The concrete question core is derived from a
// VALIDATED suggestion (guaranteed answerable); only the leading wrapper varies.
let inviteRot = 0;
function deriveInvite(q) {
  const s = (q || '').trim().replace(/\?+$/, '');
  let core = null;
  const m = s.match(/^wie\s+hoch\s+ist\s+(.+?)\s+in\s+(.+)$/i);
  if (m) core = `wie hoch ${m[1]} in ${m[2]} ist`;
  if (!core) { const m2 = s.match(/^wie\s+viele?\s+(.+?)\s+(?:gibt es\s+)?in\s+(.+)$/i); if (m2) core = `wie viele ${m2[1]} es in ${m2[2]} gibt`; }
  // fully-leading variants (used when we could parse Indikator+Ort) vs. a lighter wrap otherwise
  const leads = core ? [
    `Bleiben wir gleich dran: soll ich Ihnen auch sagen, ${core}?`,
    `Da wir schon dabei sind — ich schaue direkt weiter: möchten Sie wissen, ${core}?`,
    `Ich führe Sie nahtlos weiter: interessiert Sie auch, ${core}?`,
    `Wenn Sie mögen, gehe ich gleich einen Schritt weiter: soll ich nachsehen, ${core}?`,
    `Passend dazu hätte ich noch etwas: möchten Sie auch erfahren, ${core}?`,
    `Und weil es sich anbietet — sagen Sie einfach ja, dann verrate ich Ihnen, ${core}.`,
  ] : [
    `Bleiben wir gleich dran: möchten Sie auch wissen: ${s}?`,
    `Ich führe Sie direkt weiter — soll ich nachsehen: ${s}?`,
    `Passend dazu: interessiert Sie auch: ${s}?`,
  ];
  return leads[(inviteRot++) % leads.length];
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

function answerFor(query, priority = false) {
  const key = (query || '').trim();
  if (!key) return Promise.resolve({ ok: false, answer: null, meta: null, audioUrl: null, err: 'empty' });
  if (specCache.has(key)) return specCache.get(key);
  const promise = (async () => {
    let answer, meta, ok, err = null, reused = false;
    const cached = diskGet(key);
    if (cached && cached.answer && cached.meta) {           // reuse: same request ran before, data unchanged within TTL
      answer = cached.answer; meta = cached.meta; ok = true; reused = true;
    } else {
      const r = await runPipeline(key, priority);           // real /answer jumps the queue ahead of speculation
      const rawAnswer = r.final?.text || r.final?.answer || null;
      meta = r.final?.meta || null; ok = r.ok; err = r.ok ? null : (r.err || 'pipeline failed');
      answer = rawAnswer ? await narrate(rawAnswer, 'answer') : null;   // narrative style, number-guarded
      if (ok && answer && meta && meta.table && meta.has_real_data !== false) diskPut(key, { answer, meta });
    }
    // NO TTS here: answerFor warms DATA only. Audio is synthesized ON-DEMAND by the delivering route
    // (/answer) for the ONE real answer. Speculation fires swapCityFollowups -> 3-9 answerFor calls per
    // turn; synthesizing their audio flooded the channel with throwaway TTS calls (self-inflicted
    // contention: 6s -> 14s roundtrips + spurious Piper fallbacks). Warming the pipeline/narration is
    // enough -- a confirmed query then reuses the cached data and pays only its own single TTS.
    return { ok, answer, meta, audioUrl: null, reused, err };
  })();
  specCache.set(key, promise);
  // cache only successes in memory: drop failed/empty runs so transient flakiness can be retried
  promise.then((r) => { if (!r || !r.ok || !(r.meta && r.meta.table && r.meta.has_real_data !== false)) specCache.delete(key); },
    () => specCache.delete(key));
  if (specCache.size > 80) specCache.delete(specCache.keys().next().value);
  return promise;
}

// Part 1 "Verstehen": a short spoken confirmation of the understood question (varied lead-in).
const VERSTEHEN_LEADINS = ['Verstanden — Ihre Frage lautet', 'Alles klar, Sie möchten wissen', 'Gut, Sie fragen', 'Ich habe verstanden — Sie möchten wissen', 'In Ordnung, Ihre Frage ist', 'Notiert — Sie interessiert', 'Gerne — Sie fragen also', 'Habe ich — Sie möchten erfahren', 'Klar, es geht Ihnen um', 'Ich sehe, Sie wollen wissen'];
let verstehenRot = 0;
function verstehenText(query) {
  const q = String(query || '').trim();
  return VERSTEHEN_LEADINS[(verstehenRot++) % VERSTEHEN_LEADINS.length] + ': ' + q;
}

// Part 2 "Überbrücken": a short bridge — first turn introduces the service (varied), later turns
// loosely reference the previous interaction. Prepared in advance by the client so it plays instantly.
// Turn 0 (first question): a welcome that ALSO conveys one genuinely helpful fact about the service /
// the Bunsenbrenner marketplace it runs on (operator: erste Frage = evtl. hilfreiche Info über
// Bunsenbrenner selbst). Varied so repeat visits don't hear the same opener.
const SERVICE_INTROS = [
  'Willkommen beim Deutschlandatlas-Sprach-Callcenter. Übrigens: dies ist eine Demo auf dem Bunsenbrenner-Marktplatz — jede Antwort ist auf echten, live abgefragten Zahlen geerdet, nichts wird erfunden.',
  'Schön, dass Sie da sind. Gut zu wissen: Ich laufe als Bunsenbrenner-Demo über einen abgesicherten Tunnel, und das Sprachmodell dahinter arbeitet DSGVO-konform in Deutschland — fragen Sie mich zu Kriminalität, Bildung, Beschäftigung oder Wohnen in Ihrer Region.',
  'Hier spricht das Deutschlandatlas-Callcenter. Kleiner Hinweis vorweg: die Zahlen kommen direkt aus dem offiziellen Deutschlandatlas, und wenn ich zu etwas keine Daten habe, sage ich das ehrlich, statt zu raten.',
  'Guten Tag, willkommen beim Sprach-Callcenter zum Deutschlandatlas. Ein Tipp: Sie können mich ganz natürlich fragen, etwa nach der Arbeitslosenquote oder der Bevölkerung eines Ortes — ich sehe dann live in den echten Daten nach.',
  'Willkommen. Dies ist eine von mehreren Bunsenbrenner-Demos, die zeigen, wie sich KI faktentreu einsetzen lässt — hier für Regionaldaten aus dem Deutschlandatlas. Nennen Sie mir einfach einen Ort und eine Kennzahl.',
  'Schön, dass Sie reinschauen. Damit Sie wissen, womit Sie es zu tun haben: Ich verbinde ein Sprachmodell mit der echten Deutschlandatlas-Datenbank und prüfe jede genannte Zahl gegen die Quelle. Fragen Sie los.',
];
const BRIDGE_FALLBACKS = ['Kommen wir zu Ihrer nächsten Frage.', 'Gerne sehe ich für Sie weiter nach.', 'Bleiben wir gleich dran — einen Moment, ich schaue nach.', 'Sehr gern — ich prüfe das eben für Sie.', 'Gut, dann schauen wir uns das gemeinsam an.', 'Einen Augenblick, ich hole die passenden Zahlen.'];

// When the caller asks a NEW topic instead of taking the offered follow-up, we open with a warm
// acknowledgement that the fresh question is also worth answering — pre-synthesized by the client
// (parallel to the answer) so it can play instantly in place of the usual bridge. Varied.
const TOPIC_ACKS = [
  'Oh, eine ganz neue Richtung — auch das schaue ich Ihnen gerne nach.',
  'Interessante neue Frage — sehr gern, dazu sehe ich für Sie in den Daten nach.',
  'Ein anderes Thema, kein Problem — einen Moment, ich hole die passenden Zahlen.',
  'Auch eine spannende Frage — kommen wir gleich dazu.',
  'Gerne, ganz frisch gefragt — ich schaue direkt für Sie nach.',
  'Wechseln wir das Thema — mache ich gern, ich prüfe das eben.',
];
let ackRot = 0;
function topicAckText() { return TOPIC_ACKS[(ackRot++) % TOPIC_ACKS.length]; }

// #1: a short spoken greeting played on the caller's FIRST interaction (browsers block autoplay on
// bare load, so it fires on the first gesture). Kept distinct from the turn-0 service intro (which
// carries the helpful Bunsenbrenner info) so the two don't repeat. Varied.
const GREETINGS = [
  'Willkommen — schön, dass Sie da sind. Stellen Sie mir einfach Ihre Frage.',
  'Hallo und willkommen beim Deutschlandatlas-Callcenter. Fragen Sie mich, wann immer Sie bereit sind.',
  'Guten Tag — schön, dass Sie reinschauen. Tippen Sie Ihre Frage ein, ich höre zu.',
  'Willkommen. Ich bin bereit — nennen Sie mir einfach einen Ort und eine Kennzahl.',
  'Schön, dass Sie da sind. Fragen Sie mich gern etwas zu den Regionaldaten in Deutschland.',
];
let greetRot = 0;
function greetingText() { return GREETINGS[(greetRot++) % GREETINGS.length]; }
// Warm all greeting variants once at startup so /greeting serves an instant cached clip instead of
// paying the ~7s cold channel-setup on each caller's first interaction. chanLimit=1 serialises these,
// so they never contend with a live answer; best-effort, cache-misses fall back to on-demand.
async function prewarmGreetings() {
  for (const g of GREETINGS) {
    try { const au = await ttsSpeak(stripPronunciation(g), 'primary', false); if (au && au.startsWith('/tts/')) greetingCache.set(g, au); } catch {}
  }
}

// F1 = generic bridging shown on the FIRST question and as a fallback: atlas/bunsenbrenner info, warmed
// once at startup so /context can serve it INSTANTLY instead of the ~21s live verstehen+funfact synth.
const BRIDGE_FACTS = [
  'Während ich für Sie nachsehe: der Deutschlandatlas bündelt über hundert Indikatoren zu ganz Deutschland, von Beschäftigung über Wohnen bis Infrastruktur — gleich habe ich Ihre Zahl.',
  'Ich frage Ihre Werte gerade live aus dem echten Deutschlandatlas ab, nichts Vorgefertigtes, sondern der aktuelle Stand direkt aus der Quelle — einen kleinen Moment noch.',
  'Einen Augenblick, ich hole die Regionaldaten für Sie — die laufen übrigens Ende-zu-Ende-verschlüsselt über den Tunnel, sodass niemand außer Ihnen die Frage mitliest.',
  'Ich schaue gerade in den Zahlen nach; der Atlas deckt jeden Landkreis in Deutschland ab, deshalb kann ich Ihnen gleich einen ganz konkreten Wert für Ihren Ort nennen.',
  'Gerade hole ich Ihre Daten heran — der Deutschlandatlas wird laufend aktualisiert, Sie bekommen also den aktuellen Stand und keine alte Momentaufnahme.',
  'Ich sehe die passende Tabelle gerade durch — für die meisten Kennzahlen reichen die Werte bis auf die Kreisebene hinunter, gleich habe ich Ihre.',
  'Während ich nachschaue: diese Zahlen kommen aus dem offiziellen Deutschlandatlas des Bundes, nicht aus einer Schätzung — einen kurzen Augenblick.',
  'Ich hole Ihre Werte gerade heran; der Atlas vergleicht Regionen quer durch Deutschland — Beschäftigung, Bildung, Gesundheit, Umwelt und mehr — gleich sind Ihre Daten da.',
  'Einen Moment noch, ich frage die aktuellen Regionaldaten ab — die ganze Abfrage läuft verschlüsselt über den Tunnel, ohne dass Ihre Frage irgendwo mitgelesen wird.',
  'Lassen Sie mich kurz den passenden Datensatz heraussuchen — der Deutschlandatlas macht regionale Unterschiede in Deutschland sichtbar, und gleich sehen Sie Ihren Wert.',
];
let bridgeRot = 0;
async function prewarmBridge() {
  for (const t of BRIDGE_FACTS) {
    try { const au = await ttsSpeak(stripPronunciation(t), 'primary', false); if (au && au.startsWith('/tts/')) bridgeF1.push({ text: t, audioUrl: au }); } catch {}
  }
}
// K1 -> N1: right after each answer, produce the NEXT round's "wussten Sie schon" in the BACKGROUND,
// content-linked to the place just answered, so it is ready as instant N1 when the next question comes.
async function produceNextN1(place) {
  if (!place) return;
  if (bridgeN1Queue.length >= 2) return;   // already stocked -> don't fire a contending wiki+narrate+TTS after EVERY answer (feeds the chanLimit=1 starvation)
  try {
    const ff = await wikiFunFact(place);
    if (ff && ff.text) {
      const ftext = stripPronunciation(await narrate(ff.text, 'funfact'));
      const au = await ttsSpeak(ftext, 'primary', false);
      if (au && au.startsWith('/tts/')) { bridgeN1Queue.push({ ...ff, text: ftext, audioUrl: au }); while (bridgeN1Queue.length > 4) bridgeN1Queue.shift(); }
    }
  } catch {}
}
// Pick the pre-produced bridge to speak while the answer computes: prefer the content-linked N1 from a
// prior round, else a generic F1 clip; null means the pool is not warm yet -> caller synthesizes live.
function pickBridge() {
  if (bridgeN1Queue.length) return bridgeN1Queue.shift();
  if (bridgeF1.length) return bridgeF1[bridgeRot++ % bridgeF1.length];
  return null;
}
// GAP = the operator-spec "Ich schaue in der Datenbank nach…" slot (replaces the live verstehen TTS).
// Pre-produced at startup so /context carries NO live channel TTS at all -> it returns instantly and
// stays out of the chanLimit=1 contention that otherwise queued it behind the answer + speculation.
const GAP_TEXTS = [
  'Einen Moment — ich schaue die aktuellen Zahlen im Deutschlandatlas für Sie nach.',
  'Ich frage die passenden Regionaldaten gerade live ab, einen kurzen Augenblick.',
  'Alles klar — ich hole die Werte aus dem Deutschlandatlas, gleich habe ich sie.',
  'Ich sehe in der Datenbank nach, die aktuellen Daten kommen gleich.',
  'Lassen Sie mich das kurz für Sie nachschlagen, einen Augenblick.',
  'Ich hole Ihre Zahl gerade aus dem Atlas — gleich bin ich da.',
  'Gerne — ich suche die passenden Daten heraus, gleich habe ich Ihre Antwort.',
  'Einen kleinen Moment, ich prüfe das eben im Deutschlandatlas für Sie.',
];
let gapRot = 0;
async function prewarmGap() {
  for (const t of GAP_TEXTS) {
    try { const au = await ttsSpeak(stripPronunciation(t), 'primary', false); if (au && au.startsWith('/tts/')) gapPool.push({ text: t, audioUrl: au }); } catch {}
  }
}
function pickGap() { return gapPool.length ? gapPool[gapRot++ % gapPool.length] : null; }
let introRot = 0;
async function introBridge(context) {
  // Invariant I3: the bridge identity is decided by turnCount (how many turns were already
  // delivered this session), NOT by whether the last answer succeeded. turnCount 0 -> introduce
  // the service; every later turn -> a context bridge that references the previous interaction to
  // buy time until the Atlas answer is ready. The client passes turnCount; lastQuery is only the
  // *content* for the bridge, never the switch (that was the "service intro repeats" bug).
  const turnCount = Number((context && context.turnCount) || 0);
  const last = context && context.lastQuery;
  let text;
  if (bridgeKind(turnCount) === 'context_bridge') {
    if (last) {
      const u = await llmJSON(
        'Formuliere EINEN sehr kurzen, freundlichen deutschen Überleitungssatz für ein Callcenter, der lose an die zuletzt beantwortete Frage anknüpft und zur nächsten überleitet. Variiere die Formulierung, kein Aussprache-Hinweis. Antworte NUR als striktes JSON: {"text": "..."}',
        'Zuletzt beantwortet: ' + String(last).slice(0, 200));
      text = (u && typeof u.text === 'string' && u.text.trim()) ? u.text.trim() : 'Kommen wir zu Ihrer nächsten Frage.';
    } else {
      // later turn but no carried content (e.g. the previous answer failed) -> a neutral bridge,
      // still NOT the service intro. Keeps I5 intact.
      text = BRIDGE_FALLBACKS[(introRot++) % BRIDGE_FALLBACKS.length];
    }
  } else {
    text = SERVICE_INTROS[(introRot++) % SERVICE_INTROS.length];
  }
  return stripPronunciation(text);
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function llmJSON(system, user) {
  const base = (process.env.LITELLM_BASE_URL || '').replace(/\/$/, '');
  const key = process.env.LITELLM_API_KEY, model = process.env.LITELLM_DEFAULT_MODEL || 'local-devstral-small2';
  // The litellm call is tunnelled over a flaky edge (peer resets mid-request -> ECONNRESET); a single
  // reset otherwise silently degrades understand/bridge/narrate to an empty object. Retry transient
  // network/5xx errors a few times with a short backoff before giving up (request is idempotent, temp 0).
  const RETRIES = 3;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const resp = await fetch(base + '/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, max_tokens: 400, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!resp.ok) {
        if (resp.status >= 500 && attempt < RETRIES) { await _sleep(300 * attempt); continue; }
        return {};
      }
      const j = await resp.json();
      return JSON.parse(j.choices?.[0]?.message?.content || '{}');
    } catch (e) {
      const msg = String((e && e.cause && e.cause.code) || (e && e.message) || e);
      if (/ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|UND_ERR|fetch failed|socket|network|terminated|other side closed/i.test(msg) && attempt < RETRIES) {
        await _sleep(300 * attempt); continue;
      }
      return {};
    }
  }
  return {};
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
    try { const html = (await readFile(join(__dir, 'index.html'), 'utf8')).replace('</head>', `<script>window.CC_STT_LIVE=${process.env.CC_STT_LIVE === '1'};</script></head>`); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, must-revalidate' }); res.end(html); }
    catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (req.method === 'POST' && req.url === '/understand') {
    const b = await readBody(req);
    const query = (b.query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    // Fire the Atlas DATA pipeline IMMEDIATELY on the raw query (t=0, in parallel with understand() +
    // the spoken verstehen/funfact/bridge) so its ~10s catalog-match+phrasing-LLM latency runs UNDER the
    // preamble instead of after it. answerFor dedupes by key, so the best_guess warm below is a cache hit
    // whenever understand didn't rewrite the query (the common case); a rewrite just warms both.
    answerFor(query);                              // t=0 speculation: max lead time for the Atlas query (operator: "sofort parallel absenden")
    const u = await understand(query, b.context);
    trace('understand', { query, precise: u.precise, kind: u.kind, clarify: (u.clarify || '').slice(0, 70), best_guess: u.best_guess, slots: u.slots });
    answerFor(u.best_guess);                       // also warm the resolved query (cache hit when === raw)
    let clarifyAudioUrl = null;
    if (!u.precise && u.clarify) { try { clarifyAudioUrl = proxied(await ttsSpeak(u.clarify, 'primary')); } catch {} }
    return jsonRes(res, 200, { ...u, clarifyAudioUrl });
  }
  if (req.method === 'POST' && req.url === '/stt') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const base = process.env.CC_PUBLIC_BASE || (req.headers.host ? 'https://' + req.headers.host : null);
    const text = await sttSpeak(Buffer.concat(chunks), base);
    return jsonRes(res, 200, { text });
  }
  if (req.method === 'POST' && req.url === '/context') {
    // fast, pre-answer parts (no ArcGIS pipeline): part 1 "Verstehen" (confirm the question) + part 3
    // "Wussten Sie schon" (a VARIED, fresh Wikipedia fact). Filled into the ordered speech queue on the client.
    const b = await readBody(req);
    const q = (b.query || '').toString().slice(0, 300);
    const place = placeFromQuery(q) || q;
    let vtext, vau = null, funfact = null;
    // Both preamble slots are now PRE-PRODUCED so /context carries NO live channel TTS (operator spec):
    // verstehen -> a "looking it up" GAP clip; funfact -> the F1/N1 bridge. This takes /context out of the
    // chanLimit=1 contention entirely. Live synthesis only if a pool isn't warm yet (startup window).
    const gap = pickGap();
    const pre = pickBridge();
    if (gap) { vtext = gap.text; vau = gap.audioUrl; }
    else { vtext = stripPronunciation(verstehenText(q)); await ttsSpeak(vtext, 'primary').then((u) => { vau = u; }, () => {}); }
    if (pre) {
      funfact = { ...pre, audioUrl: proxied(pre.audioUrl) };
    } else {
      const ff = await wikiFunFact(place);
      if (ff && ff.text) {
        const ftext = stripPronunciation(await narrate(ff.text, 'funfact'));
        let fau = null; await ttsSpeak(ftext, 'primary').then((u) => { fau = u; }, () => {});
        funfact = { ...ff, text: ftext, audioUrl: proxied(fau) };
      }
    }
    return jsonRes(res, 200, { verstehen: { text: vtext, audioUrl: proxied(vau) }, funfact });
  }
  if (req.method === 'POST' && req.url === '/intro') {
    // part 2 "Überbrücken" — prepared in advance by the client (first turn: service intro; later: bridge)
    const b = await readBody(req);
    const text = await introBridge(b.context || {});
    let au = null; try { au = await ttsSpeak(text, 'primary', false); } catch {}   // prefetch (next-turn bridge / topic-ack / greeting) -> low priority, must not slow the current answer's TTS
    return jsonRes(res, 200, { text, audioUrl: proxied(au) });
  }
  if (req.method === 'POST' && req.url === '/topicack') {
    // a "that's also an interesting question" opener, pre-synthesized so it can play the instant the
    // caller asks a NEW topic instead of the offered follow-up (client decides when to use it).
    const text = stripPronunciation(topicAckText());
    let au = null; try { au = await ttsSpeak(text, 'primary', false); } catch {}   // prefetch (next-turn bridge / topic-ack / greeting) -> low priority, must not slow the current answer's TTS
    return jsonRes(res, 200, { text, audioUrl: proxied(au) });
  }
  if (req.method === 'POST' && req.url === '/greeting') {
    // #1: a short welcome, played on the caller's first interaction. Served from the startup prewarm
    // cache (instant) so the "logo -> first ton" doesn't pay the ~7s cold channel-setup per caller;
    // falls back to on-demand synthesis only while the boot warm hasn't finished yet.
    const g = greetingText();                 // raw greeting (rotates) = cache key
    const text = stripPronunciation(g);
    const cached = greetingCache.get(g);
    if (cached) return jsonRes(res, 200, { text, audioUrl: proxied(cached) });
    let au = null; try { au = await ttsSpeak(text, 'primary', false); } catch {}
    return jsonRes(res, 200, { text, audioUrl: proxied(au) });
  }
  if (req.method === 'POST' && (req.url === '/answer' || req.url === '/ask')) {
    const query = ((await readBody(req)).query || '').toString().slice(0, 300);
    if (!query.trim()) return jsonRes(res, 400, { error: 'empty query' });
    const r = await answerFor(query, true);   // user-facing -> priority over any background speculation
    // Synthesize the atlas-answer audio ON-DEMAND, only for this one real delivered answer (speculation
    // warmed DATA only). The real answer's TTS thus gets the channel to itself instead of queueing
    // behind 3-9 throwaway speculative synths.
    let audioUrl = null;
    if (r.ok && r.answer) { try { audioUrl = proxied(await ttsSpeak(r.answer, 'primary', true)); } catch {} }
    trace('answer', { query, ok: r.ok, table: r.meta && r.meta.table, has_real_data: r.meta && r.meta.has_real_data, rows: r.meta && r.meta.live_rows_used, reused: r.reused, err: r.err });
    produceNextN1(r.meta && (r.meta.place_resolved || r.meta.place_name_requested));   // K1: content-linked "wussten Sie schon" for the NEXT round's instant N1 bridge (background)
    // warm follow-up candidates in the background so /followup can validate them from cache (some cities have no data)
    if (r.ok && r.meta && r.meta.table && r.meta.has_real_data !== false) {
      const place = placeFromQuery(query) || r.meta.place_name_requested || r.meta.place_resolved || '';
      swapCityFollowups(query, place, 3).forEach((s) => { answerFor(s, false); });   // fire-and-forget DATA speculation (no TTS)
    }
    return jsonRes(res, r.ok ? 200 : 502, { query, ...r, audioUrl });
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
    const swaps = curHasData ? swapCityFollowups(query, place, 3) : [];
    const seen = new Set([query]); const candidates = [];
    for (const s of [...swaps, ...f.suggestions]) { if (s && !seen.has(s)) { seen.add(s); candidates.push(s); } }
    candidates.splice(4);   // cap the background burst: warming 9+ live city-pipelines starved the real answer (chanLimit=1 TTS + litellm-over-tunnel contention). 4 is plenty to yield 3 validated.
    candidates.forEach((s) => answerFor(s));   // warm (swaps are mostly cache hits from /answer already)
    const validated = await validateSuggestions(candidates, 3, 8000);   // ONLY answerable ones survive; short deadline so /followup doesn't hog LLM+TTS from the next real answer
    // spoken invite must also be answerable -> derive it from a validated suggestion (fall back to a safe generic)
    const inviteText = validated.length ? deriveInvite(validated[0])
      : 'Möchten Sie noch etwas aus dem Deutschlandatlas wissen?';
    let inviteAudioUrl = null;
    try { inviteAudioUrl = proxied(await ttsSpeak(inviteText, 'primary', false)); } catch {}   // P5 follow-up plays last -> low priority, never ahead of the answer's TTS
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
  // STREAMING proxy (CC_TTS_STREAM): pipe llm2's chunked WAV straight through so the plain <audio>
  // element plays it progressively (real-time), instead of a fully-buffered file. Re-fetches the
  // channel clip URL on request (fresh for the immediate answer; still within the ~15-min TTL for a
  // prompt replay). On any upstream failure the stream just ends -- the answer text is already shown.
  if (req.method === 'GET' && /^\/tts-stream\/[\w.-]+$/.test(req.url)) {
    const entry = streamClips.get(req.url.replace('/tts-stream/', ''));
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
  // Short-lived mic-audio blob for the speech_to_text channel (llm2 downloads it by this URL). Only
  // ids currently in sttBlobs are served (no path traversal), and each is evicted right after its
  // channel call resolves, with a 60s backstop TTL.
  if (req.method === 'GET' && /^\/stt-blob\/[a-f0-9]{32}\.wav$/.test(req.url)) {
    const p = sttBlobs.get(req.url.replace('/stt-blob/', '').replace('.wav', ''));
    if (!p) { res.writeHead(404); res.end('no blob'); return; }
    try { const buf = await readFile(p); res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' }); res.end(buf); }
    catch { res.writeHead(404); res.end('no blob'); }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/audio?')) {
    try {
      const u = new URL(req.url, 'http://x').searchParams.get('u') || '';
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('bunsenbrenner.org')) { res.writeHead(400); res.end('bad url'); return; }
      // The channel fileserver (llm2/labor audio_generation) can hiccup with a transient 502 under
      // load or a brief restart. Retry a few times with a short backoff before giving up, so a single
      // upstream blip doesn't drop a spoken part. (A truly evicted clip stays 502 — the client's
      // pump() then skips that part and continues, so the sequence never hangs.)
      let up = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { up = await fetch(u); } catch { up = null; }
        if (up && up.ok) break;
        if (attempt < 3) await _sleep(250 * attempt);
      }
      if (!up || !up.ok) { res.writeHead(502); res.end('upstream ' + (up ? up.status : 'fetch-failed')); return; }
      res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/wav', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch { res.writeHead(500); res.end('proxy err'); }
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/debug/trace')) {
    // recent per-request trace (understand decision + pipeline result) so a run can be explained
    const pretty = traceBuf.slice(-60).map((e) => {
      const d = new Date(e.ms).toISOString().slice(11, 19);
      return `${d} #${e.i} ${e.tag}\t${JSON.stringify((({ i, ms, tag, ...rest }) => rest)(e))}`;
    }).join('\n');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pretty || '(no trace yet — make a request first)');
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/fsm')) {
    // read-only view of the canonical dialog state machine (design single source of truth)
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(describeFsm(), null, 2));
    return;
  }
  res.writeHead(404); res.end('not found');
});
const HOST = process.env.CC_HOST || '127.0.0.1';   // default local-only; set CC_HOST=0.0.0.0 in a container fronted by a tunnel
server.listen(PORT, HOST, () => { console.log(`callcenter GUI on http://${HOST}:${PORT}`); prewarmGreetings(); prewarmBridge(); prewarmGap(); });
ensureFillers().catch(() => {});   // self-contained wait-clips (no-op if already present or no Piper)

// A single bad request (e.g. a missing static asset hit by two writeHead calls, see the
// 2026-08-31 fillers/ 404 incident that crash-looped every caller until fixed at the source)
// must never take down the whole shared process for durable unattended hosting -- log and keep
// serving everyone else instead of letting Node's default uncaught-exception behavior exit.
process.on('uncaughtException', (err) => console.error('uncaughtException (server kept running):', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection (server kept running):', err));
