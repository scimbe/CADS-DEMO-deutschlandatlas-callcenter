// Deutschlandatlas Callcenter — interactive service GUI backend.
//
// Serves the caller GUI and bridges it to the REAL pipeline: it shells out to
// scripts/n8n_workflow_runtime.mjs (catalog match -> live Deutschlandatlas query ->
// grounded phrasing), then optionally synthesizes the spoken answer via the CADS-Tunnel
// audio_generation channel. Dependency-free Node; every answer is grounded in live data.
//
// Env:
//   PORT                 (default 8791)
//   LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_DEFAULT_MODEL  (passed to the runtime)
//   CC_TTS=1             enable TTS via ct-agent audio channel (needs CT_AGENT_BIN + CT_RELAY_ENV)
//   CT_AGENT_BIN         path to ct-agent binary
//   CT_RELAY_ENV         path to the channel env file (grants, keys, front-door cert)
//   CT_AUDIO_CHANNEL_ID  audio_generation channel id
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
      // the runtime prints assorted trace to stderr and the final JSON to stdout
      let final = null;
      const lines = out.trim().split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try { final = JSON.parse(lines[i]); break; } catch { /* keep scanning */ }
      }
      resolve({ ok: code === 0 && final != null, final, code, err: err.slice(-600) });
    });
  });
}

function ttsSpeak(text, voice = 'primary') {
  if (process.env.CC_TTS !== '1') return Promise.resolve(null);
  const CT = process.env.CT_AGENT_BIN, RELAY = process.env.CT_RELAY_ENV;
  const CH = process.env.CT_AUDIO_CHANNEL_ID;
  if (!CT || !RELAY || !CH) return Promise.resolve(null);
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text, voice });
    const p = spawn('bash', ['-c',
      `set -a; source "$CT_RELAY_ENV"; set +a; ` +
      `printf '%s' '${payload.replace(/'/g, "'\\''")}' | ` +
      `CT_CHANNEL_ROLE=initiate CT_CHANNEL_CALL_SERVICE=audio_generation CT_CHANNEL_CALL_PERSISTENT=0 CT_CHANNEL_RELAY_ONLY=1 ` +
      `CT_CHANNEL_ID="${CH}" CT_CHANNEL_GRANT="$CT_CHANNEL_GRANT_2E" CT_CHANNEL_HOLDER_KEY="$CT_CHANNEL_HOLDER_KEY" CT_CHANNEL_NOISE_KEY="$CT_CHANNEL_NOISE_KEY" ` +
      `CT_CHANNEL_FRONT_DOOR=bunsenbrenner.org:443 CT_CHANNEL_FRONT_DOOR_CERT="$CT_CHANNEL_FRONT_DOOR_CERT" CT_CHANNEL_FRONT_DOOR_ONLY=1 ` +
      `CT_CHANNEL_BROKER=bunsenbrenner.org:4435 CT_CHANNEL_RELAY=bunsenbrenner.org:4436 ` +
      `"$CT_AGENT_BIN" channel 2>/dev/null | tail -1`],
      { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const url = (out.trim().split('\n').pop() || '').trim();
      resolve(/^https:\/\//.test(url) ? url : null);
    });
    p.on('error', () => resolve(null));
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = await readFile(join(__dir, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch { res.writeHead(500); res.end('index.html missing'); }
    return;
  }
  if (req.method === 'POST' && req.url === '/ask') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let query = '';
      try { query = (JSON.parse(body).query || '').toString().slice(0, 300); } catch {}
      if (!query.trim()) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"empty query"}'); return; }
      const r = await runPipeline(query);
      const answer = r.final?.text || r.final?.answer || null;
      const meta = r.final?.meta || null;
      let audioUrl = null;
      if (answer) { try { audioUrl = await ttsSpeak(answer, 'primary'); } catch {} }
      res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ query, ok: r.ok, answer, meta, audioUrl, error: r.ok ? null : (r.err || 'pipeline failed') }));
    });
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, '127.0.0.1', () => console.log(`callcenter GUI on http://127.0.0.1:${PORT}`));
