// Speech-to-text: CHANNEL-FIRST (the llm2 `speech_to_text` channel, CC_STT_CHANNEL=1) with local
// whisper.cpp as the runtime fallback (CC_WHISPER_MODEL / CC_WHISPER_CLI). The channel takes an
// https audio_url, so the mic audio is normalized to 16 kHz mono, hosted briefly under our own
// origin (/stt-blob/<id>.wav), handed over, then evicted.
import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { channelFor, channelCommand } from './channel.mjs';
import { STT_PROVIDER } from './providers/config.mjs';
import * as cloudflare from './providers/cloudflare.mjs';

let sttSeq = 0;
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args); let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err })); p.on('error', () => resolve({ code: -1, out, err }));
  });
}
async function toWav16k(buf) {
  const base = join(tmpdir(), 'cc-stt-' + process.pid + '-' + (sttSeq++));
  const inp = base + '.in', wav = base + '.wav';
  try {
    await writeFile(inp, buf);
    if ((await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', inp, '-ar', '16000', '-ac', '1', wav, '-y'])).code !== 0) return null;
    return await readFile(wav);
  } catch { return null; }
  finally { rm(inp, { force: true }).catch(() => {}); rm(wav, { force: true }).catch(() => {}); }
}

async function transcribeLocal(buf) {
  const model = process.env.CC_WHISPER_MODEL, cli = process.env.CC_WHISPER_CLI || 'whisper-cli';
  if (!model || !buf || !buf.length) return '';
  const wav16 = await toWav16k(buf);
  if (!wav16) return '';
  const wav = join(tmpdir(), 'cc-stt-' + process.pid + '-' + (sttSeq++) + '.wav');
  try {
    await writeFile(wav, wav16);
    const w = await run(cli, ['-m', model, '-l', 'de', '-nt', '-f', wav]);
    return (w.out || '').replace(/\[[0-9:.\s>\-]+\]/g, '').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
  finally { rm(wav, { force: true }).catch(() => {}); }
}

const STT_BLOB_DIR = join(tmpdir(), 'cc-stt-blob');
try { mkdirSync(STT_BLOB_DIR, { recursive: true }); } catch {}
const sttBlobs = new Map();  // id -> local wav path
export function sttBlobPath(id) { return sttBlobs.get(id) || null; }
async function hostSttBlob(wav, publicBase) {
  const id = randomUUID().replace(/-/g, '');
  const p = join(STT_BLOB_DIR, id + '.wav');
  await writeFile(p, wav);
  sttBlobs.set(id, p);
  const t = setTimeout(() => { sttBlobs.delete(id); rm(p, { force: true }).catch(() => {}); }, 60000);
  if (t.unref) t.unref();
  return { id, url: publicBase.replace(/\/$/, '') + '/stt-blob/' + id + '.wav' };
}
function evictSttBlob(id) { const p = sttBlobs.get(id); if (p) { sttBlobs.delete(id); rm(p, { force: true }).catch(() => {}); } }

// One speech_to_text call. Default: over the HELD channel process (persistent call mode, see
// channel.mjs) — the ~5.5 s join+pair+Noise cost per call is paid once per process life, not per
// dictation. CC_CHANNEL_MODE=oneshot keeps the old spawn-per-call path (pre-0.5.0 ct-agent hosts).
async function sttChannel(audioUrl, lang = 'de') {
  if ((process.env.CC_CHANNEL_MODE || 'persistent') !== 'oneshot') {
    const t = await channelFor('speech_to_text', 2).call({ audio_url: audioUrl, lang });
    const out = (t || '').replace(/\s+/g, ' ').trim();
    return out && !/^ERROR:/i.test(out) ? out : null;
  }
  return sttChannelOneShot(audioUrl, lang);
}
function sttChannelOneShot(audioUrl, lang = 'de') {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ audio_url: audioUrl, lang });
    const p = spawn('bash', ['-c', `printf '%s' '${payload.replace(/'/g, "'\\''")}' | ` + channelCommand('speech_to_text', { persistent: false })],
      { env: process.env, detached: true });
    let out = '', done = false;
    const finish = (t) => { if (done) return; done = true; clearTimeout(timer); try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve(t); };
    const timer = setTimeout(() => finish(null), Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 30000);
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => { const t = (out || '').replace(/\s+/g, ' ').trim(); finish(t && !/^ERROR:/i.test(t) ? t : null); });
    p.on('error', () => finish(null));
  });
}

/** A silent 16-bit PCM mono WAV of `seconds` at `rate` Hz — the payload of the start-up probe. */
export function silentWav(rate = 16000, seconds = 0.6) {
  const n = Math.round(rate * seconds), data = n * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

/** Transcribe caller audio (any ffmpeg-readable format). publicBase = origin llm2 can fetch from. */
export async function transcribe(buf, publicBase) {
  if (!buf || !buf.length) return '';
  if (STT_PROVIDER === 'cloudflare') {
    // No 16kHz pre-conversion here (unlike the channel path below, which specifically needs it) --
    // verified live 2026-09-09: Cloudflare's Whisper transcribes the caller's ORIGINAL format
    // directly; running it through toWav16k first produced empty transcripts instead (the 16kHz
    // mono re-encode this ffmpeg pass produces apparently isn't something this model likes, and
    // there's no reason to pay the extra conversion when the raw buffer already works).
    const t = await cloudflare.transcribe(buf);
    return t || transcribeLocal(buf);   // never silent: fall back to local whisper.cpp on any Cloudflare failure
  }
  const channelReady = process.env.CC_STT_CHANNEL === '1' && process.env.CT_AGENT_BIN && process.env.CT_RELAY_ENV && process.env.CT_AUDIO_CHANNEL_ID && publicBase;
  if (channelReady) {
    const wav = await toWav16k(buf);
    if (wav) {
      let id = null;
      try { const h = await hostSttBlob(wav, publicBase); id = h.id; const t = await sttChannel(h.url, 'de'); if (t) return t; }
      catch {}
      finally { if (id) evictSttBlob(id); }
    }
  }
  return transcribeLocal(buf);
}
