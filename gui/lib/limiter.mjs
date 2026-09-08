// Bounded, per-caller-fair work queues for the heavy child processes (pipeline runtime,
// local Piper, the single-slot llm2 TTS channel).
//
// Why: a burst of speculative + live requests once spawned 8 concurrent Piper procs and drove
// the 2-vCPU host to load 200+ (everything appeared to hang). Two more failure shapes appear
// with several callers: an uncapped queue that just grows (looks like a hang instead of a fast
// "busy, retry"), and plain FIFO that lets one caller's speculative burst crowd out another
// caller's real turn. So each limiter is capped (rejects with code QUEUE_FULL past the cap —
// every call site treats that as "degrade gracefully") and dequeues round-robin ACROSS callers,
// one job per caller per round. A high-priority queue (user-facing work) is always served
// before the low-priority one (background speculation / prewarm).

export function makeLimiter(max, { hiQueueMax = 40, loQueueMax = 24 } = {}) {
  let active = 0;
  const mkQueue = () => ({ order: [], byUser: new Map() });   // order: user keys in round-robin rotation
  const hi = mkQueue(), lo = mkQueue();
  const qlen = (q) => { let n = 0; for (const arr of q.byUser.values()) n += arr.length; return n; };
  const enqueue = (q, userKey, job) => {
    let arr = q.byUser.get(userKey);
    if (!arr) { arr = []; q.byUser.set(userKey, arr); q.order.push(userKey); }
    arr.push(job);
  };
  const dequeue = (q) => {
    for (let i = 0; i < q.order.length; i++) {
      const uk = q.order.shift();
      const arr = q.byUser.get(uk);
      if (!arr || !arr.length) { q.byUser.delete(uk); i--; continue; }
      const job = arr.shift();
      if (arr.length) q.order.push(uk); else q.byUser.delete(uk);
      return job;
    }
    return null;
  };
  const pump = () => {
    if (active >= max) return;
    const job = dequeue(hi) || dequeue(lo); if (!job) return;
    active++;
    Promise.resolve().then(job.task).then(job.resolve, job.reject).finally(() => { active--; pump(); });
  };
  const limiter = (task, priority = false, userKey = 'anon') => new Promise((resolve, reject) => {
    const q = priority ? hi : lo, cap = priority ? hiQueueMax : loQueueMax;
    if (qlen(q) >= cap) { reject(Object.assign(new Error('limiter queue full'), { code: 'QUEUE_FULL' })); return; }
    enqueue(q, userKey || 'anon', { task, resolve, reject }); pump();
  });
  limiter.stats = () => ({ active, max, hiQueued: qlen(hi), loQueued: qlen(lo), hiQueueMax, loQueueMax });
  return limiter;
}

// Identify a caller for fairness + per-caller variety rotation (no login/session cookie in this
// protocol): best-effort from the request, falling back to 'anon'.
export function userKeyFor(req) {
  const xf = (req && req.headers && req.headers['x-forwarded-for']) || '';
  return xf.split(',')[0].trim() || (req && req.socket && req.socket.remoteAddress) || 'anon';
}

// Per-caller rotation/variety state (greeting, opener, verstehen, invite, gap… counters and the
// set of prepared facts this caller has already heard). Bounded + idle-pruned so it can never
// grow without limit over the process lifetime.
const ROT_MAX = 500, ROT_IDLE_MS = 2 * 3600 * 1000;
const rotState = new Map();
export function rotFor(userKey) {
  const key = userKey || 'anon';
  let r = rotState.get(key);
  if (!r) {
    if (rotState.size >= ROT_MAX) {
      const cutoff = Date.now() - ROT_IDLE_MS;
      for (const [k, v] of rotState) if (v.ts < cutoff) rotState.delete(k);
      if (rotState.size >= ROT_MAX) rotState.delete(rotState.keys().next().value);
    }
    r = { greet: 0, intro: 0, ack: 0, cont: 0, bridge: 0, verstehen: 0, invite: 0, gap: 0, f1: 0, heardFacts: new Set(), ts: Date.now() };
    rotState.set(key, r);
  }
  r.ts = Date.now();
  return r;
}
/** Next element of `list` for this caller's `counter`, rotating so consecutive turns differ. */
export function rotate(userKey, counter, list) {
  const r = rotFor(userKey);
  const i = (r[counter] || 0) % list.length;
  r[counter] = (r[counter] || 0) + 1;
  return list[i];
}
