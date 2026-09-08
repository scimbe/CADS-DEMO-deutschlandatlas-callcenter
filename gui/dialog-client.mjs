// Browser-side dialogue engine (DOM-free, testable with a fake <audio> element).
//
//   Player  — ONE ordered speech queue on ONE audio element. Parts are spoken strictly in order;
//             a playing clip is never interrupted (I1). When a HARD part is filled, every SOFT part
//             that has not started yet is dropped (I2). Optional tail parts (the invite) play only if
//             they are ready by the time they are reached, or later while the player is idle.
//   Dialog  — the turn runner: opener at t=0, bridging loop (lookahead 1, verstehen → fact → gap…),
//             /understand, /answer with priority, /followup, clarify detour, memory + slots.
//
// The policy itself (which opener, which bridging kind next, what to drop) is imported from
// dialog-fsm.mjs so server and client share one definition.
import { PART, isSoft, openerKind, nextBridgeKind, markBridgeUsed, dropPendingSoft, BRIDGE_KIND, KIND, resolveOffered } from './dialog-fsm.mjs';

export class Player {
  /**
   * @param {object} audio  an <audio>-like object: src, load(), play()->Promise, pause(), paused,
   *                        ended, currentTime, muted, onended, onerror, oncanplaythrough
   * @param {object} hooks  { onSpeaking(bool), onIdle(), setTimeout? }
   */
  constructor(audio, hooks = {}) {
    this.audio = audio; this.hooks = hooks;
    this.queue = []; this.busy = false; this.paused = false; this.seq = 0;
    this.timers = hooks.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) };
  }
  /** Reserve the next slot for `part`; fill it later with fill(). */
  enqueue(part, { optional = false } = {}) {
    const item = { id: ++this.seq, part, url: null, ready: false, started: false, played: false, optional, soft: isSoft(part) };
    item.startedP = new Promise((res) => { item._start = res; });
    // endedP: resolves when the clip has finished playing, or at once for a skipped/dropped slot
    item.endedP = new Promise((res) => { item._end = res; });
    item.startedP.then((how) => { if (how !== 'playing') item._end(how); });
    this.queue.push(item);
    return item;
  }
  /** Provide the clip (url may be null = nothing to say → slot is skipped). */
  fill(item, url) {
    if (!item || !this.queue.includes(item)) { if (item && item._start) item._start('dropped'); return; }
    item.ready = true; item.url = url || null;
    if (!item.soft && !item.optional) this.dropPendingSoft();          // I2: a hard part is ready → pending soft parts go
    this.pump();
  }
  /** Drop ONE queued item that has not started yet (no-op otherwise). */
  drop(item) {
    if (!item || !this.queue.includes(item) || item.started) return false;
    this.queue = this.queue.filter((it) => it !== item); item._start('dropped'); return true;
  }
  /** Drop every soft part that has not started yet (the playing clip always finishes). */
  dropPendingSoft() {
    const keep = dropPendingSoft(this.queue);
    for (const it of this.queue) if (!keep.includes(it)) it._start('dropped');
    this.queue = keep;
  }
  /** A new turn begins: pending soft parts and not-yet-started optional tails of the old turn are
   *  dropped; whatever is playing right now finishes (I1). */
  newTurn() {
    this.dropPendingSoft();
    const keep = this.queue.filter((it) => !(it.optional && !it.started));
    for (const it of this.queue) if (!keep.includes(it)) it._start('dropped');
    this.queue = keep;
  }
  get pendingCount() { return this.queue.filter((it) => !it.played).length; }
  pump() {
    if (this.busy || this.paused) return;
    const it = this.queue.find((s) => !s.played);
    if (!it) { this.hooks.onIdle && this.hooks.onIdle(); return; }
    if (!it.ready) { if (it.optional) this.hooks.onIdle && this.hooks.onIdle(); return; }   // preserve order: wait for the head slot
    if (!it.url) { it.played = true; it.started = true; it._start('skipped'); this.pump(); return; }
    this.busy = true; it.started = true; it.played = true; it._start('playing');
    this.hooks.onSpeaking && this.hooks.onSpeaking(true, it);
    const a = this.audio;
    let started = false, advanced = false;
    const advance = () => { if (advanced) return; advanced = true; this.busy = false; it._end('played'); this.hooks.onSpeaking && this.hooks.onSpeaking(false, it); this.timers.set(() => this.pump(), 0); };
    a.onended = advance; a.onerror = advance;
    const start = () => { if (started || this.paused) return; started = true;
      const pr = a.play(); if (pr && pr.catch) pr.catch(() => { if (!a.ended && (a.paused || a.currentTime === 0)) advance(); }); };
    a.oncanplaythrough = () => { a.oncanplaythrough = null; if (!this.paused) start(); };
    try { a.muted = false; } catch {}
    a.src = it.url; a.load && a.load();
    this.timers.set(() => { if (a.paused && a.currentTime === 0 && !this.paused && this.busy && !started) start(); }, 500);
    this.timers.set(() => { if (this.busy && !advanced && a.paused && a.currentTime === 0) advance(); }, 9000);   // stall-breaker
  }
  togglePause() {
    if (!this.paused) { this.paused = true; try { if (!this.audio.paused) this.audio.pause(); } catch {} }
    else { this.paused = false;
      if (this.audio.src && this.audio.paused && this.audio.currentTime > 0 && !this.audio.ended) { const p = this.audio.play(); p && p.catch && p.catch(() => {}); }
      else { this.busy = false; this.pump(); } }
    return this.paused;
  }
  /** Stop everything queued (user pressed Stop). */
  stopAll() {
    for (const it of this.queue) { if (!it.played) { it.played = true; it._start('dropped'); } it._end('dropped'); }
    this.queue = []; this.busy = false; this.paused = false;
    try { this.audio.pause(); this.audio.currentTime = 0; this.audio.onended = null; } catch {}
    this.hooks.onSpeaking && this.hooks.onSpeaking(false, null);
    this.hooks.onIdle && this.hooks.onIdle();
  }
}

const withTimeout = (p, ms, fallback = null) => Promise.race([p, new Promise((res) => setTimeout(() => res(fallback), ms))]);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
/** I12: silence between filler clips. A slow Atlas answer is bridged by ONE clip, then a pause of
 *  this length, then the next — never a back-to-back stream of fillers. The answer ends the pause
 *  the moment it is ready (I2). The VERSTEHEN echo is exempt: it follows the opener promptly. */
export const BRIDGE_PAUSE_MS = 7000;

export class Dialog {
  /**
   * @param {object} o  { player, api, ui, speakFact:()=>boolean }
   *   api: session(examples), opener(kind, ctx), understand(query, ctx), bridge(kind, query, place),
   *        answer(query), followup(query, answer)   — each returns a Promise of the route's JSON
   *   ui:  setState(s), echoQuery(kind, q), working(text), answer(text, meta, ok), showFact(fact),
   *        bubbles(items, note, source), examples(), clarify(text), busy(bool), error(msg),
   *        ffToggle()->bool (speak facts?)
   */
  constructor({ player, api, ui, bridgePauseMs = BRIDGE_PAUSE_MS }) {
    this.player = player; this.api = api; this.ui = ui; this.bridgePauseMs = bridgePauseMs;
    this.turnCount = 0; this.history = []; this.lastQuery = null; this.lastAnswer = null;
    this.slots = { ort: null, indikator: null }; this.pending = null; this.followupActive = false; this.offered = null;
    this.session = null; this.nextContextBridge = null; this.turnSeq = 0; this.turn = null; this.greeted = false;
  }

  /** Session start (once): pooled clips + N1 production for the example places. */
  async start(examples) {
    try { this.session = await this.api.session(examples); } catch { this.session = null; }
    return this.session;
  }
  /** First caller gesture: greeting from the pool (I7), only while nothing else is queued. */
  greet() {
    if (this.greeted) return;
    this.greeted = true;
    const g = this.session && this.session.greeting;
    if (g && g.audioUrl && this.player.pendingCount === 0 && !this.turn) { const s = this.player.enqueue(PART.GREETING); this.player.fill(s, g.audioUrl); }
  }

  /** The caller typed/spoke something. */
  async ask(query) {
    query = (query || '').trim(); if (!query) return;
    this.greeted = true;
    // I11: a spoken "Ja" to an open follow-up offer IS the offered question — no LLM round trip
    const offeredQ = this.followupActive ? resolveOffered(query, this.offered) : null;
    if (offeredQ) { this.ui.echoQuery('your', query); return this.deliverChoice(offeredQ, true); }
    const pivot = this.followupActive; this.followupActive = false;
    const offered = this.offered; this.offered = null;
    const turn = this._openTurn({ query, pivot, continued: false });
    this.ui.echoQuery('your', query); this.ui.setState('listen'); this.ui.working('understanding');
    let u;
    try { u = await this.api.understand(query, { history: this.history, lastQuery: this.lastQuery, lastAnswer: this.lastAnswer, pending: this.pending, slots: this.slots, offered }); }
    catch (e) { return this._fail(turn, e); }
    if (!turn.active) return;
    if (u.slots) this.slots = { ort: u.slots.ort || this.slots.ort, indikator: u.slots.indikator || this.slots.indikator };
    // the place we understood is what the bridging (fact) is about while the answer is fetched
    if (u.slots && u.slots.ort) turn.place = u.slots.ort;
    if (u.precise) { this.pending = null; turn.kind = u.kind; return this._deliver(turn, u.best_guess); }
    // CLARIFY: the question replaces the answer this turn (hard part → pending soft parts are dropped)
    turn.waiting = false; this.player.dropPendingSoft();
    this.pending = { clarify: u.clarify || '', best_guess: u.best_guess || '', options: u.options || [], original: query };
    const c = this.player.enqueue(PART.CLARIFY); this.player.fill(c, u.clarifyAudioUrl || null);
    this.ui.setState('idle'); this.ui.clarify(u.clarify);
    const items = [];
    if (u.best_guess) items.push({ label: u.best_guess, best: true, onClick: () => this.deliverChoice(u.best_guess, false) });
    (u.options || []).forEach((o) => { if (o && o !== u.best_guess) items.push({ label: o, onClick: () => this.deliverChoice(o, false) }); });
    this.ui.bubbles(items, 'clarify');
    this.ui.busy(false); turn.active = false;
  }
  /** A bubble was clicked: a clarify option (fresh turn) or an offered follow-up (continuation). */
  deliverChoice(query, continued) {
    this.pending = null; this.followupActive = false; this.offered = null;
    const turn = this._openTurn({ query, pivot: false, continued, resolved: true });
    this.ui.echoQuery(continued ? 'follow' : 'question', query);
    return this._deliver(turn, query);
  }

  _openTurn({ query, pivot, continued, resolved = false }) {
    if (this.turn) this.turn.active = false;
    const turn = { id: ++this.turnSeq, query, resolvedQuery: resolved ? query : null, place: null, active: true, waiting: true,
      bridge: { understood: resolved, verstehenDone: false, factDone: false, gaps: 0 }, kind: continued ? KIND.ANSCHLUSS : KIND.NEU };
    this.turn = turn;
    this.ui.busy(true); this.ui.reset();
    this.player.newTurn();
    // OPENER at t=0 (I3): kind by openerKind(); pool kinds are instant, the context bridge was prefetched
    const kind = openerKind({ turnCount: this.turnCount, pivot, continued });
    const slot = this.player.enqueue(PART.OPENER);
    const prepared = kind === 'context_bridge' ? this.nextContextBridge : (this.session && { service_intro: this.session.intro, topic_ack: this.session.topicAck, continuation: this.session.continuation }[kind]);
    this.nextContextBridge = null;
    if (prepared && prepared.audioUrl) this.player.fill(slot, prepared.audioUrl);
    else withTimeout(this.api.opener(kind, { lastPlace: this.slots.ort, lastIndicator: this.slots.indikator }).catch(() => null), 1800).then((o) => this.player.fill(slot, o && o.audioUrl));
    this.turnCount++;
    this._bridgeLoop(turn);
    return turn;
  }

  /** Bridging loop (I4/I5): one prepared part at a time, next one requested when the current starts. */
  async _bridgeLoop(turn) {
    let spoken = null;                                  // the last bridging clip that actually played
    while (turn.active && turn.waiting) {
      const kind = nextBridgeKind(turn.bridge);
      // I12: after a spoken filler, a pause before the next one (not before the verstehen echo)
      if (spoken && kind !== BRIDGE_KIND.VERSTEHEN) {
        await spoken.endedP;
        if (!turn.active || !turn.waiting) return;
        await sleep(this.bridgePauseMs);
        if (!turn.active || !turn.waiting) return;
      }
      const slot = this.player.enqueue(kind);
      const q = turn.resolvedQuery || turn.query;
      const clip = await withTimeout(this.api.bridge(kind, q, turn.place).catch(() => null), kind === BRIDGE_KIND.VERSTEHEN ? 4000 : 2500);
      if (!turn.active || !turn.waiting) { this.player.fill(slot, null); return; }
      turn.bridge = markBridgeUsed(turn.bridge, kind);
      const speak = clip && clip.audioUrl && (clip.kind !== BRIDGE_KIND.FACT || this.ui.ffToggle());
      if (clip && clip.kind === BRIDGE_KIND.FACT && clip.text && clip.url) this.ui.showFact(clip);
      this.player.fill(slot, speak ? clip.audioUrl : null);
      const how = await slot.startedP;              // 'playing' | 'skipped' | 'dropped'
      if (how === 'dropped') return;                // the answer (or a new turn) took over
      if (how === 'playing') spoken = slot;
    }
  }

  async _deliver(turn, query) {
    turn.resolvedQuery = query; turn.bridge.understood = true;
    // if a GAP is queued but not started, let the verstehen echo take its place (drop just that gap;
    // the opener ahead of it stays — it is what the caller hears first)
    const pendingGap = this.player.queue.find((it) => it.part === BRIDGE_KIND.GAP && !it.started && !it.played);
    if (pendingGap && this.player.drop(pendingGap)) this._bridgeLoop(turn);
    this.ui.working('fetching'); this.ui.setState('query');
    let d;
    try { d = await this.api.answer(query); } catch (e) { return this._fail(turn, e); }
    if (!turn.active) return;
    turn.waiting = false;                                      // I2: the answer takes priority now
    const okA = d.ok !== false;
    const matched = okA && (d.meta ? (d.meta.has_real_data !== false && !!d.meta.table) : true);
    const ans = okA ? (d.answer || this.ui.t('noAnswer')) : this.ui.t('busy');
    this.ui.answer(ans, d.meta, okA, matched, !!d.reused);
    const sA = this.player.enqueue(PART.ANSWER); this.player.fill(sA, okA ? d.audioUrl : null);
    this.ui.busy(false);
    if (!okA) { this.followupActive = false; this.ui.examples(); this.ui.setState('done'); turn.active = false; this._prepareNext(); return; }
    this.lastQuery = query; this.lastAnswer = ans;
    const place = (d.meta && (d.meta.place_resolved || d.meta.place_name_requested)) || null;
    this.history.push({ q: query, place, answer: ans }); if (this.history.length > 6) this.history.shift();
    // INVITE (I8): optional tail — spoken whenever /followup answers, as long as no new turn has
    // dropped the slot. (A fixed cutoff here left the invite silent on every slow /followup: the
    // bubbles appeared, the "Ja" was on screen, but the spoken question never came.)
    const sI = this.player.enqueue(PART.INVITE, { optional: true });
    withTimeout(this._followup(query, ans), 60000).then((url) => this.player.fill(sI, url));
    turn.active = false;
    this._prepareNext();
  }
  async _followup(query, answer) {
    try {
      const f = await this.api.followup(query, answer);
      const sug = f.suggestions || [];
      if (sug.length) {
        const items = [{ label: '✓ Ja', best: true, onClick: () => this.deliverChoice(sug[0], true) },
          ...sug.slice(1).map((s) => ({ label: s, onClick: () => this.deliverChoice(s, true) }))];
        this.ui.bubbles(items, 'followup', '💬 ' + (f.invite || this.ui.t('inviteFallback')));
        this.offered = { invite: f.invite || '', suggestions: sug };
        this.followupActive = true;
      } else { this.ui.examples(); this.followupActive = false; this.offered = null; }
      return f.inviteAudioUrl || null;
    } catch { return null; }
  }
  /** I6: the next opener is prepared right after every answer (success or failure). */
  _prepareNext() {
    this.api.opener('context_bridge', { lastPlace: this.slots.ort, lastIndicator: this.slots.indikator })
      .then((o) => { this.nextContextBridge = o; }).catch(() => {});
  }
  _fail(turn, e) {
    turn.waiting = false; turn.active = false; this.player.dropPendingSoft();
    this.ui.error(e && e.message ? e.message : String(e)); this.ui.busy(false); this.ui.setState('done');
    this._prepareNext();
  }
}
