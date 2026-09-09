// Cloudflare Workers AI (https://developers.cloudflare.com/workers-ai/) as a drop-in backend for
// the three AI-dependent services (LLM/TTS/STT) — selected per service via config.mjs.
//
// Auth: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN, read from process.env (populated from .env
// via process.loadEnvFile() in server.mjs — see .env.example; NEVER commit real values, .env is
// already gitignored). Get the account ID from the Cloudflare dashboard URL, and an API token
// with the "Workers AI" permission from My Profile -> API Tokens.
//
// Model choice (operator: "ausschliesslich free plan nutzen"): Workers AI grants a free daily
// neuron allowance on every account, including the Workers Free plan — no paid add-on needed. The
// defaults below are the smaller/cheaper model in each category specifically to fit comfortably
// inside that free allowance; override via env if a bigger model is ever wanted. Track actual
// usage against the free limit in the Cloudflare dashboard (Workers AI -> Usage) — this module has
// no way to see your quota from outside.
//
// Wire-format note: the LLM call uses Cloudflare's OpenAI-COMPATIBLE endpoint (documented at
// https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/), so it reuses
// the exact same request body llm.mjs already builds for litellm — only base URL/auth/model
// differ. The STT/TTS wire formats are documented less precisely at the time of writing (input/
// output encoding varies by model); both functions below try the most likely shape first and a
// documented fallback second. VERIFY against your own account with a real request once credentials
// are in place (e.g. `node -e` a one-off call, or just try dictation/an answer live) and simplify
// to whichever branch actually fires if the other never does.
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const BASE = ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai` : null;

/** True once both credentials are present. Every call below no-ops (returns null/'') without them
 *  instead of throwing, so an incomplete .env degrades like any other missing-provider case. */
export const ready = () => !!(BASE && API_TOKEN);

function authHeaders(extra = {}) {
  return { authorization: 'Bearer ' + API_TOKEN, ...extra };
}

// --- LLM ---------------------------------------------------------------------------------------
// Small+fast instruct model: cheap per call, and this app's LLM steps (understand/followup/
// narrate) are short classification/rephrasing tasks, not open-ended generation.
export const LLM_MODEL = process.env.CLOUDFLARE_LLM_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';

/** Same shape as llm.mjs's internal chat(body): body = { messages, temperature, max_tokens,
 *  response_format? }. Returns the assistant message text, or null on any failure. */
export async function chat(body) {
  if (!ready()) return null;
  try {
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: LLM_MODEL, ...body }),
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    return (j.choices?.[0]?.message?.content || '').trim();
  } catch { return null; }
}

// --- Speech-to-text ------------------------------------------------------------------------------
// Whisper (base): the free-tier-friendly choice — whisper-large-v3-turbo is materially more
// expensive per audio-minute for a demo that only ever transcribes a few seconds at a time.
export const STT_MODEL = process.env.CLOUDFLARE_STT_MODEL || '@cf/openai/whisper';

/** buf = raw audio bytes (any ffmpeg-readable format the caller already normalized upstream, as
 *  the local whisper.cpp path does). Returns the transcript, or '' on any failure. */
export async function transcribe(buf) {
  if (!ready() || !buf || !buf.length) return '';
  try {
    let resp = await fetch(`${BASE}/run/${STT_MODEL}`, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/octet-stream' }), body: buf,
    });
    if (!resp.ok) {
      // documented fallback shape for binary inputs called from outside a Worker: byte array in JSON
      resp = await fetch(`${BASE}/run/${STT_MODEL}`, {
        method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ audio: Array.from(buf) }),
      });
      if (!resp.ok) return '';
    }
    const j = await resp.json();
    const r = j.result || {};
    return (r.text || r.transcription_info?.text || '').trim();
  } catch { return ''; }
}

// --- Text-to-speech ------------------------------------------------------------------------------
// MeloTTS: the only Workers AI TTS model with an explicit German-capable multi-lingual mode at the
// time of writing (Aura is English-only). Confirm your account still shows this before relying on it
// — Workers AI's audio-generation catalog has changed shape before.
export const TTS_MODEL = process.env.CLOUDFLARE_TTS_MODEL || '@cf/myshell/melotts';

/** Returns a Buffer of audio bytes, or null on any failure. */
export async function synthesize(text) {
  if (!ready() || !text) return null;
  try {
    const resp = await fetch(`${BASE}/run/${TTS_MODEL}`, {
      method: 'POST', headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ text, lang: 'de' }),
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (ct.startsWith('audio/')) return Buffer.from(await resp.arrayBuffer());
    // some models return { result: { audio: '<base64>' } } instead of a raw audio response
    const j = await resp.json().catch(() => null);
    const b64 = j?.result?.audio;
    return b64 ? Buffer.from(b64, 'base64') : null;
  } catch { return null; }
}
