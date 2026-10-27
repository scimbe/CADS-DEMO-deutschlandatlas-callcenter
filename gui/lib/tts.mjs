// Text-to-speech: CHANNEL-FIRST (the llm2 agent `audio_generation` channel via ct-agent) with
// local Piper as the automatic runtime fallback, so a turn is never silent. One entry point,
// ttsSpeak(), applies the spoken-text sanitizer exactly once (invariant I10) and returns a
// same-origin /tts/<id>.wav path (or a /tts-stream/<id> path for the streamed answer), or null.
//
// Env: CC_TTS=1 enables TTS. Channel: CT_AGENT_BIN + CT_RELAY_ENV + CT_AUDIO_CHANNEL_ID.
//      Piper: CC_PIPER_BIN + CC_PIPER_MODEL. CC_TTS_STREAM=1 streams the answer clip.
//      CC_TTS_STUB=1 (tests/offline demo): synthesizes a short tone whose length scales with the
//      text instead of calling any engine — lets the whole dialogue be exercised without Piper.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { mkdirSync, existsSync, readdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeLimiter } from './limiter.mjs';
import { ttsSafe } from './text.mjs';
import { channelFor, channelCommand } from './channel.mjs';
import { TTS_PROVIDER } from './providers/config.mjs';
import * as cloudflare from './providers/cloudflare.mjs';

export const TTS_DIR = join(tmpdir(), 'cc-tts');
let ttsSeq = 0;

// Piper is CPU-bound: 2 concurrent synths saturate a 2-core host and make each job 10-30x slower,
// so the default cap is 1 (raise CC_PIPER_CONCURRENCY on a bigger host). The llm2 channel is a
// single-slot serve: concurrent calls thrash its park/re-park cycle, so it is serialised too.
export const piperLimit = makeLimiter(Number(process.env.CC_PIPER_CONCURRENCY) || 1,
  { hiQueueMax: Number(process.env.CC_PIPER_QUEUE_HI) || 40, loQueueMax: Number(process.env.CC_PIPER_QUEUE_LO) || 24 });
export const chanLimit = makeLimiter(Number(process.env.CC_CHANNEL_CONCURRENCY) || 1,
  { hiQueueMax: Number(process.env.CC_CHANNEL_QUEUE_HI) || 40, loQueueMax: Number(process.env.CC_CHANNEL_QUEUE_LO) || 24 });

// Clips that must survive pruning (prepared pools). Registered by bridging.mjs.
const protectedClips = new Set();
export function protectClip(url) { if (url) protectedClips.add(url.replace('/tts/', '')); }
export function unprotectClip(url) { if (url) protectedClips.delete(url.replace('/tts/', '')); }
export function pruneTtsDir(keep = 120) {
  try {
    const files = readdirSync(TTS_DIR).filter((f) => f.endsWith('.wav') && !protectedClips.has(f))
      .map((f) => ({ f, t: statSync(join(TTS_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) { try { unlinkSync(join(TTS_DIR, f)); } catch {} }
  } catch {}
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args); let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err })); p.on('error', () => resolve({ code: -1, out, err }));
  });
}

// Every synthesized clip started at 0 dB in its first 80 ms (measured, naturalness-analysis.md §4) —
// the most audible signature of "clips glued together". A 50 ms fade-in removes the hard cut.
// Best-effort: on any ffmpeg failure the original file stays in place.
export async function applyFadeIn(path, ms = 50) {
  const tmp = path + '.fade.wav';
  try {
    const r = await run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', path, '-af', `afade=t=in:d=${(ms / 1000).toFixed(3)}`, tmp]);
    if (r.code === 0 && existsSync(tmp) && statSync(tmp).size > 0) renameSync(tmp, path);
    else { try { unlinkSync(tmp); } catch {} }
  } catch { try { unlinkSync(tmp); } catch {} }
}

function newClipPath(prefix = '') {
  try { mkdirSync(TTS_DIR, { recursive: true }); } catch {}
  const id = prefix + process.pid + '-' + (ttsSeq++);
  return { id, wav: join(TTS_DIR, id + '.wav'), url: '/tts/' + id + '.wav' };
}

// --- stub: a soft tone whose duration scales with the text (~16 chars/s), pure Node, no engine ---
function stubWav(text) {
  const secs = Math.max(0.8, Math.min(12, (text || '').length / 16));
  const rate = 16000, n = Math.round(rate * secs), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.min(1, t / 0.05, (secs - t) / 0.1);
    const v = Math.sin(2 * Math.PI * 220 * t) * 0.25 * env * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
async function ttsStub(text) {
  const { wav, url } = newClipPath('stub-');
  await writeFile(wav, stubWav(text));
  pruneTtsDir();
  return url;
}

// Persistent Piper: ONE long-lived process with the voice loaded (--json-input). The old
// spawn-per-clip paid the ~3 s model load for every clip on a 2-vCPU host (measured: 13 s cold for a
// 5 s sentence). Each request is one JSON line; Piper prints the written file path when done.
// Speed: CC_PIPER_LENGTH_SCALE (default 0.9 = ~10 % faster speech).
class PiperServer {
  constructor() { this.p = null; this.cur = null; this.buf = ''; }
  _start() {
    const args = ['--model', process.env.CC_PIPER_MODEL, '--json-input', '--length_scale', String(process.env.CC_PIPER_LENGTH_SCALE || 0.9), '--sentence_silence', '0.1'];
    const p = spawn(process.env.CC_PIPER_BIN, args, { env: process.env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.p = p; this.buf = '';
    p.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (this.cur && line === this.cur.wav) { const c = this.cur; this.cur = null; clearTimeout(c.timer); c.resolve(true); }
      }
    });
    const gone = () => { if (this.p === p) this.p = null; if (this.cur) { const c = this.cur; this.cur = null; clearTimeout(c.timer); c.resolve(false); } };
    p.on('exit', gone); p.on('error', gone); p.stdin.on('error', () => {});
  }
  /** One synthesis (callers are serialised by piperLimit). Resolves true when `wav` was written. */
  synth(text, wav, timeoutMs = Number(process.env.CC_PIPER_TIMEOUT_MS) || 45000) {
    return new Promise((resolve) => {
      if (!this.p) { try { this._start(); } catch { return resolve(false); } }
      const c = { wav, resolve, timer: setTimeout(() => { if (this.cur === c) { this.cur = null; try { this.p.kill('SIGKILL'); } catch {} this.p = null; resolve(false); } }, timeoutMs) };
      this.cur = c;
      try { this.p.stdin.write(JSON.stringify({ text, output_file: wav }) + '\n'); } catch { this.cur = null; clearTimeout(c.timer); resolve(false); }
    });
  }
  close() { try { this.p && this.p.kill('SIGKILL'); } catch {} this.p = null; }
}
export const piperServer = new PiperServer();

function ttsLocalPiper(text, priority, userKey) {
  const tQueued = Date.now();
  return piperLimit(async () => {
    const tStart = Date.now();
    const { wav, url } = newClipPath();
    const ok = await piperServer.synth(text, wav);
    if (ok && existsSync(wav)) await applyFadeIn(wav);
    pruneTtsDir();
    const good = ok && existsSync(wav);
    console.error(`[trace] piper-tts prio=${priority ? 'hi' : 'lo'} queued=${tStart - tQueued}ms synth=${Date.now() - tStart}ms chars=${(text || '').length} ok=${good}`);
    return good ? url : null;
  }, priority, userKey);
}

// Channel circuit breaker. The channel can "succeed" (a clip URL comes back in ~0.2 s) while the
// clip host (site-<tenant>.bunsenbrenner.org) is unreachable — observed live: every answer was
// silent (/tts-stream -> 502) because the dead URL was returned and Piper never took over.
// A clip is only accepted once its bytes were fetched; a failure opens the breaker for
// CC_CHANNEL_COOLDOWN_MS (default 60 s) during which the channel is skipped entirely. After the
// cooldown the next call probes again, so channel clips return automatically once the host is back.
export const channelBreaker = { downUntil: 0, failures: 0 };
export const channelUsable = () => Date.now() >= channelBreaker.downUntil;
export function channelFailed() {
  channelBreaker.failures++;
  channelBreaker.downUntil = Date.now() + (Number(process.env.CC_CHANNEL_COOLDOWN_MS) || 60000);
}
export function channelOk() { channelBreaker.failures = 0; channelBreaker.downUntil = 0; }

// One audio_generation call over the channel. Resolves to an https clip URL or null. A channel
// call must never hang a turn: a timeout resolves null so the caller falls back to Piper.
// Default: over the HELD channel process (persistent call mode, channel.mjs): one paired session
// per process life instead of a ~5.5 s join+pair+Noise per clip — the difference between an invite
// or clarify question that is spoken and one that arrives after the caller has moved on.
// CC_CHANNEL_MODE=oneshot keeps the spawn-per-call path.
async function ttsChannel(text, voice = 'primary') {
  if ((process.env.CC_CHANNEL_MODE || 'persistent') !== 'oneshot') {
    const out = await channelFor('audio_generation', Number(process.env.CC_CHANNEL_CONCURRENCY) || 1)
      .call({ text, voice }, Math.min(Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 6000, 6000));
    const url = (out || '').trim().split('\n').pop() || '';
    return /^https:\/\//.test(url.trim()) ? url.trim() : null;
  }
  return ttsChannelOneShot(text, voice);
}
function ttsChannelOneShot(text, voice = 'primary') {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text, voice });
    const p = spawn('bash', ['-c', `printf '%s' '${payload.replace(/'/g, "'\\''")}' | ` + channelCommand('audio_generation', { persistent: false })],
      { env: process.env, detached: true });
    let out = '', done = false;
    const finish = (url) => { if (done) return; done = true; clearTimeout(timer); try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve(url); };
    const timer = setTimeout(() => finish(null), Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 8000);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const url = (out.trim().split('\n').pop() || '').trim(); finish(/^https:\/\//.test(url) ? url : null); });
    p.on('error', () => finish(null));
  });
}

// A channel clip's https URL lives in memory on llm2's side for ~15 min: a prepared clip played
// later would 404. Fetch the bytes on receipt and cache them under our own /tts/ dir.
async function ttsCloudflareClip(text) {
  const buf = await cloudflare.synthesize(text);
  if (!buf || !buf.length) return null;
  const { wav, url } = newClipPath('cf-');
  await writeFile(wav, buf);
  await applyFadeIn(wav);
  pruneTtsDir();
  return url;
}

export async function localizeChannelClip(url, fetchImpl = fetch) {
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(Number(process.env.CC_CLIP_FETCH_MS) || 5000) });
    if (!resp || !resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return null;
    const { wav, url: local } = newClipPath('ch-');
    await writeFile(wav, buf);
    await applyFadeIn(wav);
    pruneTtsDir();
    return local;
  } catch { return null; }
}

// STREAMING path (CC_TTS_STREAM=1) for the answer: register the channel URL and return a
// same-origin /tts-stream/<id> path immediately; the route pipes the chunked WAV through.
export const streamClips = new Map(); // id -> { url, ts }
function streamChannelClip(url) {
  const id = 'st-' + process.pid + '-' + (ttsSeq++);
  streamClips.set(id, { url, ts: Date.now() });
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [k, v] of streamClips) { if (v.ts < cutoff) streamClips.delete(k); }
  while (streamClips.size > 128) { const k = streamClips.keys().next().value; streamClips.delete(k); }
  return '/tts-stream/' + id;
}

export const proxied = (u) => (u ? (u.startsWith('/') ? u : '/audio?u=' + encodeURIComponent(u)) : null);

/**
 * Speak `text`. priority=true for the user-facing answer/clarify (jumps every queue), false for
 * bridging/prepared material. Never rejects: resolves a same-origin path, or null.
 */
export function ttsSpeak(text, { priority = false, userKey = 'anon', stream = false, voice = 'primary' } = {}) {
  text = ttsSafe(text);
  if (!text) return Promise.resolve(null);
  if (process.env.CC_TTS_STUB === '1') return ttsStub(text).catch(() => null);
  if (process.env.CC_TTS !== '1') return Promise.resolve(null);
  if (TTS_PROVIDER === 'cloudflare') return ttsCloudflareClip(text).catch(() => null);
  const channelReady = process.env.CT_AGENT_BIN && process.env.CT_RELAY_ENV && process.env.CT_AUDIO_CHANNEL_ID;
  const piperReady = process.env.CC_PIPER_BIN && process.env.CC_PIPER_MODEL;
  const fallbackPiperFor = (pr) => (piperReady ? ttsLocalPiper(text, pr, userKey).catch(() => null) : Promise.resolve(null));
  const fallbackPiper = () => fallbackPiperFor(priority);
  if (channelReady && channelUsable()) {
    return chanLimit(() => ttsChannel(text, voice), priority, userKey).catch(() => null)
      .then(async (url) => {
        const local = url ? await localizeChannelClip(url) : null;
        if (local) { channelOk(); return local; }
        channelFailed();                                   // call failed or the clip host is unreachable
        return priority ? fallbackPiperFor(true) : null;   // background clips never take the scarce CPU
      });
  }
  // Channel down: background material (fillers, pools) is not worth the scarce CPU — only the
  // user-facing speech (priority) is synthesised locally.
  if (channelReady && !priority) return Promise.resolve(null);
  return fallbackPiper();
}

/** Speak and return a proxied same-origin URL (or null). */
export const speakUrl = (text, opts) => ttsSpeak(text, opts).then(proxied);

export const limiterStats = () => ({ piper: piperLimit.stats(), channel: chanLimit.stats() });
export const ttsHealth = () => ({ channelUsable: channelUsable(), failures: channelBreaker.failures, retryInMs: Math.max(0, channelBreaker.downUntil - Date.now()) });
