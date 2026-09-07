// ============================================================================
//  Deutschlandatlas Sprach-Callcenter — Dialog State Machine (single source of truth)
// ----------------------------------------------------------------------------
//  The whole call-center dialogue is ONE explicit finite-state machine. Every
//  state declares three hooks — pre / enter / leave — exactly as classic UML
//  state semantics:
//
//     pre    : precompute / prefetch everything the state will need. Runs BEFORE
//              the state is entered and may fire speculatively, in parallel, so
//              the enter action never has to wait ("Zeit überbrücken").
//     enter  : the caller-facing action of the state (what Thorsten says / shows).
//     leave  : commit the outcome into the carried dialogue context and prepare
//              the NEXT turn. leave ALWAYS runs — success or failure — so the
//              machine can never regress (this is what stops the "service intro
//              repeats" / "fun-fact disappears" regressions from recurring).
//
//  DELIVER is an ordered, non-interruptible sequence with an OPEN-ENDED middle
//  (2026-09 redesign — the previous version had a fixed 5-part sequence; the
//  operator's actual mental model is simpler and doesn't pad a fast answer with
//  parts nobody asked for):
//
//     P1 BRIDGE          spoken FIRST, right on utterance, to bridge time until
//                         the Atlas answer is ready. First turn of a session →
//                         a service introduction (mentions Bunsenbrenner); every
//                         later turn → a short, unobtrusive transition
//                         referencing the previous interaction. Decided by
//                         turnCount, NEVER by whether the last answer succeeded.
//     P.FILLER (0..N)    an OPEN-ENDED loop, one clip at a time: slot 1 is a
//                         short "Verstanden: …" echo of the question; slot 2 is
//                         a REAL, place-linked Wikipedia fact (never invented,
//                         never a generic stand-in — see I4); slot 3+ is a
//                         generic "still looking it up" phrase, rotating. Each
//                         next filler is requested only once the answer is
//                         STILL not ready by the time the previous one starts
//                         playing — a fast answer may see zero, one, or two of
//                         these, never padding. The loop stops issuing NEW
//                         requests the instant the real answer is ready; the
//                         filler already playing/queued still finishes (I1).
//     P.ANTWORT          the grounded, live Deutschlandatlas answer.
//     P.WEITERFUEHRUNG   an active, varied lead-in that guides the caller
//                         onward to the next answerable question (yes/no-free:
//                         only "yes" or a concrete alternative, see I9).
//
//  This module is imported by gui/server.mjs (it drives the deterministic
//  bridge decision and is exposed read-only at GET /fsm) and is mirrored 1:1 by
//  the n8n workflow (n8n/callcenter-workflow.json → "Dialog State Machine"
//  sticky + Route by Dialog State), so the design lives in exactly one place.
// ============================================================================

/** The named spoken parts of a delivered turn. FILLER is emitted 0..N times
 *  (open-ended, see DELIVER below) between BRIDGE and ANTWORT — it is not a
 *  single fixed slot the way the others are. */
export const PARTS = ['BRIDGE', 'FILLER', 'ANTWORT', 'WEITERFUEHRUNG'];

/** The content kind of one FILLER instance, in the order they're tried. */
export const FILLER_KIND = { VERSTEHEN: 'verstehen', FUNFACT: 'funfact', GENERIC: 'generic' };

/** Turn kinds produced by the CLASSIFY state (mirrors the n8n "Route by Dialog State"). */
export const KIND = { NEU: 'neu', ANSCHLUSS: 'anschluss', KLARSTELLUNG: 'klarstellung' };

/**
 * The state machine, declared data-first so it is inspectable and testable.
 * Each state: { pre, enter, leave, on } where `on` maps an event to the next state.
 */
export const FSM = {
  initial: 'GREETING',
  states: {
    GREETING: {
      pre: 'prefetch a short spoken greeting (/greeting) AND the turn-0 bridge (/intro) up front',
      enter: 'browsers block autoplay on bare load, so on the caller\'s FIRST gesture (click/tap, not the ask button) play the greeting and fade the welcome hint',
      leave: 'mark greeted; a submitted question also counts as greeted (the turn-0 intro is then the opener)',
      on: { greeted: 'IDLE', utterance: 'CLASSIFY' },
    },
    IDLE: {
      pre: 'prepare, ready-to-play: the next BRIDGE (/intro) AND a "new topic" ack (/topicack)',
      enter: 'await caller utterance',
      leave: 'none',
      on: { utterance: 'CLASSIFY' },
    },
    CLASSIFY: {
      pre: 'carry {history, lastQuery, lastAnswer, pending, slots, followupActive} into the request',
      enter: 'POST /understand → { precise, kind∈{neu,anschluss,klarstellung}, slots, clarify, best_guess }',
      leave: 'merge dialogue-state slots',
      on: { precise: 'DELIVER', ambiguous: 'CLARIFY' },
    },
    CLARIFY: {
      pre: 'synthesize the targeted clarify question audio',
      enter: 'speak ONE targeted clarify question; offer best_guess + options as one-click bubbles',
      leave: 'set `pending` so the NEXT utterance is treated as the answer to this question (kind=klarstellung)',
      on: { answered: 'DELIVER', restated: 'CLASSIFY' },
    },
    DELIVER: {
      pre: 'POST /answer (pipeline, retry-guarded) fires immediately; concurrently, an open-ended FILLER loop calls POST /filler one clip at a time (n=1 Verstehen, n=2 Wikipedia fact, n=3+ generic) for as long as /answer has not yet resolved',
      enter: 'play BRIDGE, then the FILLER loop\'s clips as they arrive (0..N of them, strictly in order, each finishing before the next), then ANTWORT, then WEITERFUEHRUNG — never interrupted, never padded beyond what the wait actually needed',
      leave: 'commit {lastQuery, lastAnswer, slots, history}; turnCount++; ALWAYS prepare the next BRIDGE and topic-ack',
      on: { done: 'IDLE' },
      parts: PARTS,
      // P1 BRIDGE has three variants, chosen deterministically at turn start:
      //   turn 0        -> a service intro that ALSO conveys one helpful Bunsenbrenner fact (#2)
      //   topic pivot   -> a "that is also an interesting question" ack, when the caller typed a NEW
      //                    topic instead of the offered follow-up (#5); pre-synthesized, plays instantly
      //   otherwise     -> a short context bridge that references the previous interaction
      // WEITERFUEHRUNG offers only "Ja" + concrete alternatives, never a "Nein" (#4).
    },
  },
};

/** Hard invariants the implementation must uphold. */
export const INVARIANTS = [
  'I1 ordered/non-interruptible: BRIDGE, then each FILLER as it arrives, then ANTWORT, then WEITERFUEHRUNG always play in queue order, each to the end',
  'I2 bridge-first: P1 (BRIDGE) enters immediately on utterance, before /understand resolves',
  'I3 bridge identity is deterministic at turn start: turn 0 -> service intro + Bunsenbrenner fact; topic pivot -> topic-ack; else a short context bridge — NEVER keyed on last-answer success',
  'I4 a FILLER of kind funfact, if it plays at all, is ALWAYS a real, place-linked Wikipedia fact (shown; spoken per toggle) — never a generic stand-in phrase; it is not guaranteed to occur (only requested if the answer is still pending when its turn in the loop comes up)',
  'I5 the next BRIDGE and topic-ack are prepared in EVERY leave (success AND failure), so nothing can regress to the intro',
  'I6 the Atlas answer + all LLM calls retry transient proxy resets (ECONNRESET/5xx)',
  'I7 greeting plays on the FIRST caller gesture (autoplay policy), pre-synthesized, distinct from the turn-0 intro so they never repeat',
  'I8 topic pivot: a NEW topic asked instead of the offered follow-up opens with the pre-synthesized "also interesting" ack in place of the bridge',
  'I9 the follow-up (P5) offers only "Ja" + alternatives, never a "Nein" — declining means asking something new',
  'I10 the FILLER loop stops requesting NEW clips the instant the real answer is ready; whatever filler is already playing/queued still finishes (never cut off), but no additional filler is added after that point — a fast answer sees fewer (or zero) fillers, never padding',
];

/**
 * THE deterministic bridge decision (invariant I3). Both the server and the
 * client agree on this rule. `turnCount` is the number of turns already
 * DELIVERED in this session (0 on the very first turn).
 */
export function bridgeKind(turnCount) {
  return (Number(turnCount) || 0) === 0 ? 'service_intro' : 'context_bridge';
}

/** A compact, serializable view of the machine for GET /fsm and for the n8n mirror. */
export function describe() {
  return { parts: PARTS, kinds: KIND, fillerKinds: FILLER_KIND, fsm: FSM, invariants: INVARIANTS };
}

export default { PARTS, KIND, FILLER_KIND, FSM, INVARIANTS, bridgeKind, describe };
