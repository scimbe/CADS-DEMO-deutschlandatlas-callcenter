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

function ttsLocalPiper(text, priority, userKey) {
  const tQueued = Date.now();
  return piperLimit(() => new Promise((resolve) => {
    const tStart = Date.now();
    const { wav, url } = newClipPath();
    let done = false;
    const fin = (v) => { if (done) return; done = true;
      console.error(`[trace] piper-tts prio=${priority ? 'hi' : 'lo'} queued=${tStart - tQueued}ms synth=${Date.now() - tStart}ms chars=${(text || '').length} ok=${v != null}`);
      resolve(v); };
    try {
      const p = spawn(process.env.CC_PIPER_BIN, ['--model', process.env.CC_PIPER_MODEL, '--output_file', wav], { env: process.env });
      p.stdin.on('error', () => {});
      p.stdin.end(text);
      p.on('close', async (code) => { if (code === 0 && existsSync(wav)) await applyFadeIn(wav); pruneTtsDir(); fin(code === 0 && existsSync(wav) ? url : null); });
      p.on('error', () => fin(null));
    } catch { fin(null); }
  }), priority, userKey);
}

// One audio_generation call over the channel. Resolves to an https clip URL or null. A channel
// call must never hang a turn: a timeout resolves null so the caller falls back to Piper.
// Default: over the HELD channel process (persistent call mode, channel.mjs): one paired session
// per process life instead of a ~5.5 s join+pair+Noise per clip — the difference between an invite
// or clarify question that is spoken and one that arrives after the caller has moved on.
// CC_CHANNEL_MODE=oneshot keeps the spawn-per-call path.
async function ttsChannel(text, voice = 'primary') {
  if ((process.env.CC_CHANNEL_MODE || 'persistent') !== 'oneshot') {
    const out = await channelFor('audio_generation', Number(process.env.CC_CHANNEL_CONCURRENCY) || 1)
      .call({ text, voice }, Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 8000);
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
async function localizeChannelClip(url) {
  try {
    const resp = await fetch(url);
    if (!resp || !resp.ok) return url;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return url;
    const { wav, url: local } = newClipPath('ch-');
    await writeFile(wav, buf);
    await applyFadeIn(wav);
    pruneTtsDir();
    return local;
  } catch { return url; }
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
  const channelReady = process.env.CT_AGENT_BIN && process.env.CT_RELAY_ENV && process.env.CT_AUDIO_CHANNEL_ID;
  const piperReady = process.env.CC_PIPER_BIN && process.env.CC_PIPER_MODEL;
  const fallbackPiper = () => (piperReady ? ttsLocalPiper(text, priority, userKey).catch(() => null) : Promise.resolve(null));
  if (channelReady) {
    return chanLimit(() => ttsChannel(text, voice), priority, userKey).catch(() => null)
      .then((url) => (url ? ((process.env.CC_TTS_STREAM === '1' && stream) ? streamChannelClip(url) : localizeChannelClip(url)) : fallbackPiper()));
  }
  return fallbackPiper();
}

/** Speak and return a proxied same-origin URL (or null). */
export const speakUrl = (text, opts) => ttsSpeak(text, opts).then(proxied);

export const limiterStats = () => ({ piper: piperLimit.stats(), channel: chanLimit.stats() });
