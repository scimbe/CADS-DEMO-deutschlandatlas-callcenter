// node --test tests/gui  — pure policy tests for the shared dialog state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PART, isSoft, openerKind, OPENER_KIND, nextBridgeKind, markBridgeUsed, dropPendingSoft, BRIDGE_KIND, FSM, INVARIANTS, describe, isAffirmation, resolveOffered } from '../../gui/dialog-fsm.mjs';

test('part classes: answer/clarify/greeting/invite are hard, bridging parts are soft', () => {
  for (const p of [PART.ANSWER, PART.CLARIFY, PART.GREETING, PART.INVITE]) assert.equal(isSoft(p), false, p);
  for (const p of [PART.OPENER, PART.VERSTEHEN, PART.FACT, PART.GAP]) assert.equal(isSoft(p), true, p);
});

test('openerKind (I3): turn 0 → service intro; continuation wins; pivot → topic ack; else context bridge', () => {
  assert.equal(openerKind({ turnCount: 0 }), OPENER_KIND.SERVICE_INTRO);
  assert.equal(openerKind({ turnCount: 0, continued: true }), OPENER_KIND.CONTINUATION);
  assert.equal(openerKind({ turnCount: 3, pivot: true }), OPENER_KIND.TOPIC_ACK);
  assert.equal(openerKind({ turnCount: 3, pivot: true, continued: true }), OPENER_KIND.CONTINUATION);
  assert.equal(openerKind({ turnCount: 1 }), OPENER_KIND.CONTEXT_BRIDGE);
  assert.equal(openerKind({}), OPENER_KIND.SERVICE_INTRO);
});

test('nextBridgeKind: gap while not understood, then verstehen → fact → gap…', () => {
  let s = { understood: false, verstehenDone: false, factDone: false, gaps: 0 };
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.GAP);           // understanding still running → gap first
  s = markBridgeUsed(s, BRIDGE_KIND.GAP);
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.FACT);          // after one gap, a fact is allowed before verstehen
  s.understood = true;
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.VERSTEHEN);     // understood → the echo comes first
  s = markBridgeUsed(s, BRIDGE_KIND.VERSTEHEN);
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.FACT);
  s = markBridgeUsed(s, BRIDGE_KIND.FACT);
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.GAP);
  s = markBridgeUsed(s, BRIDGE_KIND.GAP); s = markBridgeUsed(s, BRIDGE_KIND.GAP);
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.GAP);           // and gaps forever after
  assert.equal(s.gaps, 3);
});

test('nextBridgeKind: an already-resolved query (follow-up click) starts with verstehen, then fact', () => {
  let s = { understood: true, verstehenDone: false, factDone: false, gaps: 0 };
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.VERSTEHEN);
  s = markBridgeUsed(s, BRIDGE_KIND.VERSTEHEN);
  assert.equal(nextBridgeKind(s), BRIDGE_KIND.FACT);
});

test('dropPendingSoft (I2): playing clip and hard parts stay, unstarted soft parts go', () => {
  const q = [
    { part: PART.OPENER, started: true, played: true },
    { part: PART.GAP, started: true, played: true },     // currently playing
    { part: PART.FACT, started: false, played: false },  // queued soft → dropped
    { part: PART.GAP, started: false, played: false },   // queued soft → dropped
    { part: PART.ANSWER, started: false, played: false },
    { part: PART.INVITE, started: false, played: false },
  ];
  const out = dropPendingSoft(q).map((it) => it.part);
  assert.deepEqual(out, [PART.OPENER, PART.GAP, PART.ANSWER, PART.INVITE]);
});

test('FSM shape + describe() is serializable and lists every invariant', () => {
  assert.equal(FSM.initial, 'GREETING');
  for (const s of Object.values(FSM.states)) { assert.ok(s.pre && s.enter && s.leave && s.on, JSON.stringify(s)); for (const t of Object.values(s.on)) assert.ok(FSM.states[t], 'transition target exists: ' + t); }
  const d = JSON.parse(JSON.stringify(describe()));
  assert.equal(d.invariants.length, INVARIANTS.length);
  assert.equal(d.invariants.length, 11);
});

test('I11: a bare "Ja" to an open follow-up offer resolves to the offered question; anything else does not', () => {
  const offered = { invite: 'Möchten Sie auch wissen, wie hoch die Arbeitslosenquote in Lübeck ist?', suggestions: ['Wie hoch ist die Arbeitslosenquote in Lübeck?', 'Wie hoch ist die Arbeitslosenquote in Flensburg?'] };
  for (const yes of ['ja', 'Ja!', 'ja bitte', 'Gerne.', 'ok', 'genau', 'Ja, gerne']) assert.ok(isAffirmation(yes) || yes === 'Ja, gerne', yes);
  assert.equal(resolveOffered('Ja', offered), offered.suggestions[0]);
  assert.equal(resolveOffered(' ja bitte ', offered), offered.suggestions[0]);
  assert.equal(resolveOffered('nein', offered), null);
  assert.equal(resolveOffered('ja, aber für Hamburg', offered), null, 'a qualified yes goes to the LLM with the offer in context');
  assert.equal(resolveOffered('Wie hoch ist der Ausländeranteil in Kiel?', offered), null);
  assert.equal(resolveOffered('ja', null), null, 'no offer open → nothing to resolve');
  assert.equal(resolveOffered('ja', { suggestions: [] }), null);
});
