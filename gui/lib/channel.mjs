// Held ct-agent channel processes (persistent call mode, ct-agent#19).
//
// Before this module every speech_to_text / audio_generation call spawned a fresh `ct-agent channel`
// in one-shot mode: join → pair → Noise handshake → ONE call → exit. Measured on the live callcenter
// that is ~5.5 s of fixed cost per call — the reason a dictated question needed 6-10 s to come back,
// and the reason every dynamically spoken clip (the invite, a clarify question, the verstehen echo)
// arrived late or not at all. Persistent call mode holds ONE paired session for the process's life:
// each stdin line is one call, each response one NDJSON envelope line
//   {"ok":true,"output":"<bare service output>"}   or   {"ok":false,"error":"<message>"}
// (the failure envelope is followed by a non-zero exit; the caller re-spawns and retries once).
//
// One `ChannelClient` per service holds up to `size` such processes and hands each call to an idle
// one (FIFO queue otherwise). A process that exits, times out or answers garbage is dropped and the
// next call spawns a replacement — with a short backoff after repeated near-instant deaths so a
// misconfigured relay cannot turn into a spawn storm. `CC_CHANNEL_MODE=oneshot` restores the old
// per-call spawn (the runtime fallback while a host still runs a pre-0.5.0 ct-agent).
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = Number(process.env.CC_CHANNEL_TIMEOUT_MS) || 30000;
const RESPAWN_BACKOFF_MS = [0, 500, 2000, 5000, 15000];
const NEAR_INSTANT_MS = 3000;

/** The bash line that starts one `ct-agent channel` for `service`, env sourced from CT_RELAY_ENV. */
export function channelCommand(service, { persistent = true, env = process.env } = {}) {
  return `set -a; source "$CT_RELAY_ENV"; set +a; ` +
    `CT_CHANNEL_ROLE=initiate CT_CHANNEL_CALL_SERVICE=${service} CT_CHANNEL_CALL_PERSISTENT=${persistent ? '1' : '0'} CT_CHANNEL_RELAY_ONLY=1 ` +
    `CT_CHANNEL_ID="${env.CT_AUDIO_CHANNEL_ID}" CT_CHANNEL_GRANT="$CT_CHANNEL_GRANT_2E" CT_CHANNEL_HOLDER_KEY="$CT_CHANNEL_HOLDER_KEY" CT_CHANNEL_NOISE_KEY="$CT_CHANNEL_NOISE_KEY" ` +
    `CT_CHANNEL_FRONT_DOOR=bunsenbrenner.org:443 CT_CHANNEL_FRONT_DOOR_CERT="$CT_CHANNEL_FRONT_DOOR_CERT" CT_CHANNEL_FRONT_DOOR_ONLY=1 ` +
    `CT_CHANNEL_BROKER=bunsenbrenner.org:4435 CT_CHANNEL_RELAY=bunsenbrenner.org:4436 "$CT_AGENT_BIN" channel 2>/dev/null`;
}

/** Parse one envelope line. Returns { ok, output } / { ok:false, error } or null for a non-envelope line. */
export function parseEnvelope(line) {
  const t = (line || '').trim();
  if (!t.startsWith('{')) return null;
  try {
    const j = JSON.parse(t);
    if (typeof j !== 'object' || j === null || typeof j.ok !== 'boolean') return null;
    if (j.ok) return { ok: true, output: typeof j.output === 'string' ? j.output : JSON.stringify(j.output ?? '') };
    return { ok: false, error: String(j.error || 'channel call failed') };
  } catch { return null; }
}

/** One held process: spawn, feed lines, collect envelope lines. */
class Worker {
  constructor(client, id) {
    this.client = client; this.id = id; this.busy = null; this.alive = false; this.buf = ''; this.calls = 0;
    this.startedAt = Date.now();
    const cmd = client.command();
    // A process group so a stuck process (and the bash wrapper) can be killed as one.
    this.p = spawn(client.shell, ['-c', cmd], { env: process.env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.alive = true;
    this.p.stdout.on('data', (d) => this._onData(String(d)));
    this.p.on('exit', () => this._gone('exit'));
    this.p.on('error', () => this._gone('error'));
    this.p.stdin.on('error', () => {});
  }
  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      const env = parseEnvelope(line);
      if (!env) continue;                                   // diagnostics or a bare line: not a response
      const call = this.busy; if (!call) continue;          // an unsolicited envelope: ignore
      this.busy = null; clearTimeout(call.timer); this.calls++;
      if (env.ok) { call.resolve(env.output); this.client._idle(this); }
      else { call.resolve(null); this.client._dropWorker(this, 'call failed: ' + env.error); }
    }
  }
  _gone(why) {
    if (!this.alive) return;
    this.alive = false;
    const call = this.busy; this.busy = null;
    if (call) { clearTimeout(call.timer); call.resolve(null); }
    this.client._dropWorker(this, why);
  }
  send(call) {
    this.busy = call;
    call.timer = setTimeout(() => { if (this.busy === call) { this.busy = null; call.resolve(null); this.client._dropWorker(this, 'timeout'); } }, call.timeoutMs);
    try { this.p.stdin.write(call.line + '\n'); } catch { this._gone('write'); }
  }
  kill() {
    this.alive = false;
    try { this.p.stdin.end(); } catch {}
    try { process.kill(-this.p.pid, 'SIGKILL'); } catch { try { this.p.kill('SIGKILL'); } catch {} }
  }
}

export class ChannelClient {
  /**
   * @param {string} service  the channel service slug (speech_to_text, audio_generation)
   * @param {object} o        { size, timeoutMs, command, shell }
   *   command: () => bash line (default channelCommand(service)); shell: 'bash'
   */
  constructor(service, { size = 1, timeoutMs = DEFAULT_TIMEOUT_MS, command = null, shell = 'bash' } = {}) {
    this.service = service; this.size = Math.max(1, size); this.timeoutMs = timeoutMs; this.shell = shell;
    this.command = command || (() => channelCommand(service));
    this.workers = new Set(); this.queue = []; this.seq = 0; this.deaths = 0; this.lastDeath = 0; this.nextSpawnAt = 0;
    this.stats = { calls: 0, ok: 0, failed: 0, spawns: 0, deaths: 0 };
  }
  /** One call: `payload` (object or string) becomes one stdin line; resolves the bare output, or null. */
  call(payload, timeoutMs = this.timeoutMs) {
    const line = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (/\n/.test(line)) return Promise.resolve(null);      // one call = one line, by contract
    this.stats.calls++;
    return new Promise((resolve) => {
      const call = { line, timeoutMs, timer: null, resolve: (v) => { if (v == null) this.stats.failed++; else this.stats.ok++; resolve(v); } };
      this.queue.push(call);
      this._pump();
    });
  }
  _pump() {
    while (this.queue.length) {
      let w = [...this.workers].find((x) => x.alive && !x.busy);
      if (!w) {
        if (this.workers.size >= this.size) return;          // all busy: the call waits its turn
        if (Date.now() < this.nextSpawnAt) { this._pumpLater(this.nextSpawnAt - Date.now()); return; }
        w = new Worker(this, ++this.seq); this.workers.add(w); this.stats.spawns++;
      }
      w.send(this.queue.shift());
    }
  }
  _pumpLater(ms) {
    if (this._later) return;
    this._later = setTimeout(() => { this._later = null; this._pump(); }, ms);
    if (this._later.unref) this._later.unref();
  }
  _idle() { this._pump(); }
  _dropWorker(w, why) {
    if (!this.workers.has(w)) return;
    this.workers.delete(w); w.kill();
    this.stats.deaths++;
    const now = Date.now();
    // Repeated near-instant deaths (a bad relay env, a refused join) back off; a long-lived worker
    // that finally died resets the streak.
    this.deaths = now - w.startedAt < NEAR_INSTANT_MS ? this.deaths + 1 : 0;
    this.lastDeath = now;
    this.nextSpawnAt = now + RESPAWN_BACKOFF_MS[Math.min(this.deaths, RESPAWN_BACKOFF_MS.length - 1)];
    this.lastError = why;
    this._pump();
  }
  /** Spawn up to `n` idle processes now, so the first real call does not pay the join+pair
   *  (~5-8 s measured live for the first dictation after a restart). No-op for workers already up. */
  warm(n = this.size) {
    const want = Math.min(this.size, n);
    while (this.workers.size < want && Date.now() >= this.nextSpawnAt) {
      const w = new Worker(this, ++this.seq); this.workers.add(w); this.stats.spawns++;
    }
    return this.workers.size;
  }
  /** Close every held process (stdin EOF = clean teardown, then SIGKILL as a backstop). */
  close() {
    for (const w of this.workers) w.kill();
    this.workers.clear();
    for (const c of this.queue.splice(0)) c.resolve(null);
  }
  status() {
    return { service: this.service, size: this.size, live: [...this.workers].filter((w) => w.alive).length,
      busy: [...this.workers].filter((w) => w.busy).length, queued: this.queue.length, lastError: this.lastError || null, ...this.stats };
  }
}

const clients = new Map();
/** The process-wide client for `service` (size from CC_CHANNEL_POOL_<SERVICE> or `size`). */
export function channelFor(service, size = 1) {
  if (!clients.has(service)) {
    const envSize = Number(process.env['CC_CHANNEL_POOL_' + service.toUpperCase()]);
    clients.set(service, new ChannelClient(service, { size: envSize > 0 ? envSize : size }));
  }
  return clients.get(service);
}
export const channelStats = () => [...clients.values()].map((c) => c.status());
/** Hold the STT and TTS processes from the start (called once the relay env is known to be set). */
export function warmChannels() {
  channelFor('audio_generation', Number(process.env.CC_CHANNEL_CONCURRENCY) || 1).warm();
  channelFor('speech_to_text', 2).warm(1);
}
export function closeChannels() { for (const c of clients.values()) c.close(); clients.clear(); }
