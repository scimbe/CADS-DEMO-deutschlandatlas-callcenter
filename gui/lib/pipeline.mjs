// The grounded Atlas answer: runs the real pipeline (scripts/n8n_workflow_runtime.mjs: catalog
// match -> live Deutschlandatlas query -> grounded phrasing) behind a bounded, per-caller-fair
// limiter, with a speculation cache (in-memory promise per query) and a persistent reuse cache
// (a query that already produced grounded data replays instantly for 12h).
//
// answerFor() warms DATA only — audio is synthesized by the /answer route for the one delivered
// answer, so speculation never floods the single-slot TTS channel.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeLimiter } from './limiter.mjs';
import { narrate, STUB } from './llm.mjs';
import { placeFromQuery } from './text.mjs';

export const pipeLimit = makeLimiter(Number(process.env.CC_PIPELINE_CONCURRENCY) || 3,
  { hiQueueMax: Number(process.env.CC_PIPELINE_QUEUE_HI) || 40, loQueueMax: Number(process.env.CC_PIPELINE_QUEUE_LO) || 24 });

// lightweight per-request trace so /debug/trace can explain WHY a query behaved as it did
const traceBuf = [];
let traceSeq = 0;
export function trace(tag, obj) {
  const e = { i: ++traceSeq, ms: Date.now(), tag, ...obj };
  traceBuf.push(e); if (traceBuf.length > 120) traceBuf.shift();
  try { console.log('[trace] ' + tag + ' ' + JSON.stringify(obj)); } catch {}
}
export const traceLines = () => traceBuf.slice(-60);

let RUNTIME = null, REPO_ROOT = null;
export function configurePipeline({ runtime, repoRoot }) { RUNTIME = runtime; REPO_ROOT = repoRoot; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stubPipeline(query) {
  await sleep(Number(process.env.CC_STUB_ANSWER_MS) || 6000);
  const place = placeFromQuery(query) || 'Kiel';
  if (/bevölkerungsdichte|unbekannt/i.test(query)) {
    return { ok: true, final: { text: 'Dazu liegen im Deutschlandatlas leider keine Daten für ' + place + ' vor.', meta: { table: null, has_real_data: false, place_name_requested: place } } };
  }
  const v = (place.length * 7.31 % 20 + 3).toFixed(1).replace('.', ',');
  return { ok: true, final: { text: 'In ' + place + ' liegt der Wert bei ' + v + ' Prozent (Stand 2023).',
    meta: { table: 'stub_HA2023', field: 'stub', has_real_data: true, live_rows_used: 1, place_name_requested: place, place_resolved: place } } };
}
function runPipelineNow(query) {
  if (STUB) return stubPipeline(query);
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

// --- persistent reuse cache: query -> {answer, meta}, TTL 12h ---
const Q_CACHE = join(tmpdir(), 'cc-qcache');
const Q_TTL_MS = 12 * 3600 * 1000;
const qKey = (q) => Buffer.from(String(q || '').trim().toLowerCase().replace(/\s+/g, ' ')).toString('base64url').slice(0, 120);
function diskGet(q) {
  try { const f = join(Q_CACHE, qKey(q) + '.json'); if (!existsSync(f)) return null;
    const j = JSON.parse(readFileSync(f, 'utf8')); return (j && (Date.now() - (j.ts || 0)) < Q_TTL_MS) ? j : null; } catch { return null; }
}
function diskPut(q, obj) { try { mkdirSync(Q_CACHE, { recursive: true }); writeFileSync(join(Q_CACHE, qKey(q) + '.json'), JSON.stringify({ ...obj, ts: Date.now() })); } catch {} }

// Exact query strings that actually returned real, grounded data at least once — the only
// genuinely safe source of follow-up suggestions after a failed turn (an LLM improvising off a
// failure text produced unanswerable suggestions, and re-validation is itself non-deterministic).
const VERIFIED_POOL_MAX = 200;
const verifiedQueryPool = [];
function rememberVerified(query) {
  const idx = verifiedQueryPool.indexOf(query);
  if (idx !== -1) verifiedQueryPool.splice(idx, 1);
  verifiedQueryPool.push(query);
  while (verifiedQueryPool.length > VERIFIED_POOL_MAX) verifiedQueryPool.shift();
}
export function poolSuggestions(exclude, n) {
  const pool = verifiedQueryPool.filter((q) => q !== exclude);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}

export const hasRealData = (r) => !!(r && r.ok && r.meta && r.meta.table && r.meta.has_real_data !== false);

const specCache = new Map();   // query -> Promise<{ok, answer, meta, reused, err}>
export function answerFor(query, priority = false, userKey = 'anon') {
  const key = (query || '').trim();
  if (!key) return Promise.resolve({ ok: false, answer: null, meta: null, err: 'empty' });
  if (specCache.has(key)) return specCache.get(key);
  const promise = (async () => {
    let answer, meta, ok, err = null, reused = false;
    const cached = diskGet(key);
    if (cached && cached.answer && cached.meta) {
      answer = cached.answer; meta = cached.meta; ok = true; reused = true;
      rememberVerified(key);
    } else {
      let r;
      try { r = await pipeLimit(() => runPipelineNow(key), priority, userKey); }
      catch (e) { r = { ok: false, final: null, err: (e && e.code) || (e && e.message) || 'pipeline failed' }; }
      const rawAnswer = r.final?.text || r.final?.answer || null;
      meta = r.final?.meta || null; ok = r.ok; err = r.ok ? null : (r.err || 'pipeline failed');
      answer = rawAnswer ? await narrate(rawAnswer, 'answer') : null;
      if (ok && answer && meta && meta.table && meta.has_real_data !== false) { diskPut(key, { answer, meta }); rememberVerified(key); }
    }
    return { ok, answer, meta, reused, err };
  })();
  specCache.set(key, promise);
  promise.then((r) => { if (!hasRealData(r)) specCache.delete(key); }, () => specCache.delete(key));
  if (specCache.size > 80) specCache.delete(specCache.keys().next().value);
  return promise;
}

/** Keep only the suggestions the pipeline can actually answer with real data, within a budget. */
export async function validateSuggestions(suggestions, want = 3, timeoutMs = 8000, userKey = 'anon') {
  if (!suggestions.length) return [];
  const good = [];
  const checks = suggestions.map((s) => answerFor(s, false, userKey).then((r) => { if (hasRealData(r)) good.push(s); }).catch(() => {}));
  await Promise.race([Promise.all(checks), sleep(timeoutMs)]);
  return good.slice(0, want);
}

export const pipelineStats = () => pipeLimit.stats();
