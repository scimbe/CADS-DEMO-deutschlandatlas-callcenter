// ============================================================================
//  Deutschlandatlas Sprach-Callcenter — Dialog State Machine (single source of truth)
// ----------------------------------------------------------------------------
//  This module is the ONE place the dialogue design lives. It is imported by
//  gui/server.mjs (route policy, GET /fsm) AND by the browser (gui/dialog-client.mjs
//  imports it from /dialog-fsm.mjs), so server and client can never disagree on
//  who speaks what, when, and what may be dropped. It is pure data + pure functions:
//  no I/O, no timers, no DOM — fully unit-testable (tests/gui/dialog-fsm.test.mjs).
//
//  Operator intent (scimbe, 2026-09-08), restated as the design goal:
//    * a NATURAL dialogue: one voice, one ordered stream of speech, no dead air,
//      no overlapping clips, no robotic fixed padding;
//    * the ATLAS ANSWER is the foreground: it has priority the moment it is ready —
//      but it never interrupts a clip that is already being spoken;
//    * "Wussten Sie schon" is ONLY a bridging device, and it is PRODUCED AFTER an
//      answer for the NEXT round (never fetched live while the caller is waiting);
//    * every wait is bridged from PREPARED material (pools warmed at boot, facts
//      produced in the background) plus a few short DYNAMIC parts (the "Verstanden"
//      echo, the answer, the follow-up invite), so the flow stays continuous.
// ============================================================================

/** The named spoken parts. Each belongs to a CLASS that decides its fate when the
 *  Atlas answer becomes ready (see INVARIANTS I1/I2). */
export const PART = {
  GREETING: 'greeting',     // first gesture of the session
  OPENER: 'opener',         // first thing said on an utterance (bridges the understand phase)
  VERSTEHEN: 'verstehen',   // "Verstanden, Sie möchten wissen: …" echo of the RESOLVED question
  FACT: 'fact',             // "Wussten Sie schon …" — prepared in a PREVIOUS round (N1) or generic (F1)
  GAP: 'gap',               // "Einen Moment, ich sehe nach …" — prepared pool, repeats while waiting
  CLARIFY: 'clarify',       // one targeted clarifying question (replaces the answer this turn)
  ANSWER: 'answer',         // the grounded, live Deutschlandatlas answer
  INVITE: 'invite',         // active lead-in to the next answerable question
};

/** hard = must be spoken to the end and is never dropped once queued;
 *  soft = bridging only: dropped if the Atlas answer is ready before it started. */
export const CLASS = { HARD: 'hard', SOFT: 'soft' };
export const PART_CLASS = {
  [PART.GREETING]: CLASS.HARD,
  [PART.OPENER]: CLASS.SOFT,
  [PART.VERSTEHEN]: CLASS.SOFT,
  [PART.FACT]: CLASS.SOFT,
  [PART.GAP]: CLASS.SOFT,
  [PART.CLARIFY]: CLASS.HARD,
  [PART.ANSWER]: CLASS.HARD,
  [PART.INVITE]: CLASS.HARD,
};
export const isSoft = (part) => PART_CLASS[part] === CLASS.SOFT;

/** The kinds of OPENER, chosen deterministically at utterance time (I3). */
export const OPENER_KIND = {
  SERVICE_INTRO: 'service_intro',   // turn 0: welcome + one helpful fact about the service
  TOPIC_ACK: 'topic_ack',           // a NEW topic typed while a follow-up was on offer
  CONTINUATION: 'continuation',     // the caller took the offered follow-up ("Ja" / a suggestion)
  CONTEXT_BRIDGE: 'context_bridge', // any later turn: short link from the previous question onward
};

/** Bridging kinds the client may request from POST /bridge, in their natural order. */
export const BRIDGE_KIND = { VERSTEHEN: PART.VERSTEHEN, FACT: PART.FACT, GAP: PART.GAP };

/** Turn kinds produced by the CLASSIFY state. */
export const KIND = { NEU: 'neu', ANSCHLUSS: 'anschluss', KLARSTELLUNG: 'klarstellung' };

/**
 * Deterministic opener decision (invariant I3). `turnCount` = turns already
 * DELIVERED this session; `pivot` = a new question was typed while a follow-up
 * was on offer; `continued` = the caller accepted the offered follow-up.
 * Never keyed on whether the last answer succeeded.
 */
export function openerKind({ turnCount = 0, pivot = false, continued = false } = {}) {
  if (continued) return OPENER_KIND.CONTINUATION;
  if ((Number(turnCount) || 0) === 0) return OPENER_KIND.SERVICE_INTRO;
  if (pivot) return OPENER_KIND.TOPIC_ACK;
  return OPENER_KIND.CONTEXT_BRIDGE;
}

/**
 * Which bridging part to request next while the answer is still pending.
 * `state` is the per-turn bridging progress: { understood, verstehenDone, factDone }.
 *   - the VERSTEHEN echo comes first, but only once the question is understood
 *     (it echoes the RESOLVED question, so it can never be stale);
 *   - the FACT comes after verstehen (or, if understanding is slow, after one gap);
 *   - everything else is a GAP, repeated for as long as the wait lasts.
 * Returns the next kind; the caller mutates `state` when a part was actually used.
 */
export function nextBridgeKind(state = {}) {
  const { understood = false, verstehenDone = false, factDone = false, gaps = 0 } = state;
  if (understood && !verstehenDone) return BRIDGE_KIND.VERSTEHEN;
  if (!factDone && (verstehenDone || gaps >= 1)) return BRIDGE_KIND.FACT;
  return BRIDGE_KIND.GAP;
}

/** Mark a bridging kind as used in the per-turn bridging state (pure helper). */
export function markBridgeUsed(state, kind) {
  const s = { understood: false, verstehenDone: false, factDone: false, gaps: 0, ...state };
  if (kind === BRIDGE_KIND.VERSTEHEN) s.verstehenDone = true;
  else if (kind === BRIDGE_KIND.FACT) s.factDone = true;
  else if (kind === BRIDGE_KIND.GAP) s.gaps += 1;
  return s;
}

/**
 * Playback decision when a HARD part becomes ready (invariant I2): every queued
 * part that is SOFT and has not started yet is dropped; the currently playing
 * clip (if any) always finishes. Pure: takes the queue, returns the new queue.
 * Items: { part, started:boolean, played:boolean }.
 */
export function dropPendingSoft(queue) {
  return queue.filter((it) => !(isSoft(it.part) && !it.started && !it.played));
}

/**
 * The state machine, declared data-first so it is inspectable (GET /fsm) and testable.
 * Each state: { pre, enter, leave, on } — pre = prepare/prefetch, enter = the
 * caller-facing action, leave = commit + prepare the NEXT turn (leave ALWAYS runs).
 */
export const FSM = {
  initial: 'GREETING',
  states: {
    GREETING: {
      pre: 'POST /session once: greeting + turn-0 opener + topic-ack from the prepared pools; N1 facts for the example places start producing in the background',
      enter: 'on the caller\'s FIRST gesture (autoplay policy) speak the greeting and fade the welcome hint',
      leave: 'greeted; a submitted question also counts as greeted (the turn-0 opener is then the first thing heard)',
      on: { greeted: 'IDLE', utterance: 'CLASSIFY' },
    },
    IDLE: {
      pre: 'the next opener (context bridge for the last question, or topic-ack/continuation) is already prepared',
      enter: 'await caller utterance',
      leave: 'none',
      on: { utterance: 'CLASSIFY' },
    },
    CLASSIFY: {
      pre: 'speak the prepared OPENER immediately (t=0); start bridging with GAP/FACT while /understand runs',
      enter: 'POST /understand {query, context} → {precise, kind, slots, clarify, best_guess, options}; the Atlas pipeline is already speculating on the raw query',
      leave: 'merge slots; request the VERSTEHEN echo for the resolved question',
      on: { precise: 'DELIVER', ambiguous: 'CLARIFY' },
    },
    CLARIFY: {
      pre: 'the clarify question is synthesized by /understand itself',
      enter: 'drop pending soft parts; speak ONE targeted clarify question (hard); offer best_guess + options as bubbles',
      leave: 'set `pending` so the next utterance is resolved AGAINST this question (kind=klarstellung)',
      on: { answered: 'DELIVER', restated: 'CLASSIFY' },
    },
    DELIVER: {
      pre: 'POST /answer (priority) runs; the bridge loop keeps ONE prepared part queued: verstehen → fact → gap…',
      enter: 'when the answer is ready: drop pending soft parts, speak ANSWER right after the current clip; then INVITE if it is ready within the grace window',
      leave: 'commit {lastQuery, slots, history}; turnCount++; prepare the next opener; produce N1 facts for the likely next places (background, low priority)',
      on: { done: 'IDLE' },
    },
  },
};

/** Hard invariants the implementation upholds (tests assert the pure ones). */
export const INVARIANTS = [
  'I1 ONE ordered player: parts are spoken strictly in queue order; a clip that is playing is never interrupted or cut',
  'I2 the Atlas answer has priority: the moment it is ready, every SOFT part not yet started is dropped and the answer plays right after the current clip',
  'I3 the opener is prepared material and plays at t=0 on utterance; its kind is openerKind(turnCount, pivot, continued) — never keyed on last-answer success',
  'I4 "Wussten Sie schon" is never fetched live during a wait: it is an N1 fact prepared for THIS question\'s place (produced at /understand or after a previous answer) or an F1 pool clip — never a prepared fact about some OTHER place; a wait with nothing prepared just gets a GAP',
  'I5 bridging parts are requested one at a time (lookahead 1) and are all prepared, except the short VERSTEHEN echo which is skipped if it is not ready in time',
  'I6 after EVERY answer (success or failure) the next opener and N1 facts for the likely next places are prepared in the background at low priority',
  'I7 the greeting plays on the first caller gesture, from the pool, and is distinct from the turn-0 service intro',
  'I8 the invite offers only "Ja" + concrete, validated alternatives (never a "Nein"); it is spoken after the answer only if ready within the grace window, else offered silently as bubbles',
  'I9 answer TTS is high priority; all bridging TTS is low priority; every LLM/pipeline/TTS call retries transient failures',
  'I10 every spoken string passes the same sanitizer (IPA, gender notation) exactly once, inside ttsSpeak',
  'I11 a bare spoken "Ja" while a follow-up offer is open IS the offered question: it is asked as a continuation without an LLM round trip; a qualified yes goes to the LLM with the offer in its context',
  'I12 fillers are never back-to-back: after a spoken filler clip there is a pause (7 s) of silence before the next one is requested; the answer ends the pause at once (I2); only the short VERSTEHEN echo follows the opener without a pause',
];

/** A compact, serializable view for GET /fsm and the n8n mirror. */
/** A bare affirmation ("ja", "ja bitte", "gerne", "ok", "genau", "klar") — nothing but consent. */
const AFFIRMATION = /^(ja|jа|ja bitte|ja gerne|ja gern|bitte|gerne|gern|okay|ok|klar|genau|sicher|natürlich|unbedingt|ja klar|ja genau|ja natürlich|ja unbedingt|jo|jup|jep|yes)[\s!.…]*$/i;
export const isAffirmation = (text) => AFFIRMATION.test(String(text || '').trim());

/**
 * I11: an offered follow-up ("Möchten Sie auch … wissen?" with the ✓-Ja bubble) is answered by voice as
 * often as by click. A bare "Ja" while an offer is open resolves to the offered question WITHOUT a
 * round trip to the LLM; anything else is a new/pivoting question. offered = { suggestions: [...] }.
 */
export function resolveOffered(text, offered) {
  const sug = (offered && offered.suggestions) || [];
  if (!sug.length) return null;
  return isAffirmation(text) ? sug[0] : null;
}

export function describe() {
  return { parts: PART, partClass: PART_CLASS, openerKinds: OPENER_KIND, bridgeKinds: BRIDGE_KIND, kinds: KIND, fsm: FSM, invariants: INVARIANTS };
}

export default { PART, CLASS, PART_CLASS, isSoft, OPENER_KIND, BRIDGE_KIND, KIND, openerKind, nextBridgeKind, markBridgeUsed, dropPendingSoft, isAffirmation, resolveOffered, FSM, INVARIANTS, describe };
