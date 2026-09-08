// node --test tests/gui — the ordered player and the turn runner with a fake <audio> element and
// a fake API, so the whole dialogue policy runs in milliseconds without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Player, Dialog } from '../../gui/dialog-client.mjs';
import { PART } from '../../gui/dialog-fsm.mjs';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A fake <audio>: play() "plays" for `durations[src]` ms (default 30), then fires onended. */
function fakeAudio(durations = {}) {
  const a = { src: '', paused: true, ended: false, currentTime: 0, muted: false, onended: null, onerror: null, oncanplaythrough: null, log: [] };
  a.load = () => { a.ended = false; a.currentTime = 0; setTimeout(() => a.oncanplaythrough && a.oncanplaythrough(), 1); };
  a.play = () => { a.paused = false; a.currentTime = 0.01; a.log.push(a.src);
    setTimeout(() => { if (a.paused) return; a.paused = true; a.ended = true; a.onended && a.onended(); }, durations[a.src] || 30);
    return Promise.resolve(); };
  a.pause = () => { a.paused = true; };
  return a;
}
// settled: nothing playing and nothing playable left (an unready OPTIONAL tail does not count — the
// player is legitimately idle in front of it). Bounded so a regression fails instead of hanging.
const done = (p, maxMs = 3000) => new Promise((res, rej) => { const t0 = Date.now(); const check = () => {
  const playable = p.queue.some((it) => !it.played && !(it.optional && !it.ready));
  if (!p.busy && !playable) return res();
  if (Date.now() - t0 > maxMs) return rej(new Error('player did not settle: ' + JSON.stringify(p.queue.map((it) => [it.part, it.ready, it.played]))));
  setTimeout(check, 5); }; check(); });

test('Player plays strictly in queue order (hard parts wait for the head) and skips silent slots', async () => {
  const a = fakeAudio();
  const p = new Player(a);
  const s1 = p.enqueue(PART.GREETING), s2 = p.enqueue(PART.CLARIFY), s3 = p.enqueue(PART.ANSWER);
  p.fill(s3, '/answer.wav');          // ready first, but must wait for the hard parts ahead of it
  await tick(20);
  assert.deepEqual(a.log, []);         // head slot not ready → nothing plays (order preserved)
  p.fill(s1, '/greeting.wav'); p.fill(s2, null);   // silent slot is skipped, order still holds
  await done(p);
  assert.deepEqual(a.log, ['/greeting.wav', '/answer.wav']);
});

test('I2 applies to unstarted soft parts ahead of the answer too (a ready answer never waits for bridging)', async () => {
  const a = fakeAudio();
  const p = new Player(a);
  p.enqueue(PART.OPENER); p.enqueue(PART.GAP);      // reserved, not ready yet
  const ans = p.enqueue(PART.ANSWER); p.fill(ans, '/answer.wav');
  await done(p);
  assert.deepEqual(a.log, ['/answer.wav']);
  assert.equal(p.queue.length, 1);
});

test('I2: filling the ANSWER drops queued soft parts but never the playing clip', async () => {
  const a = fakeAudio({ '/opener.wav': 80 });
  const p = new Player(a);
  const opener = p.enqueue(PART.OPENER); p.fill(opener, '/opener.wav');
  await tick(10);                       // opener is playing now
  const gap1 = p.enqueue(PART.GAP); p.fill(gap1, '/gap1.wav');
  const fact = p.enqueue(PART.FACT); p.fill(fact, '/fact.wav');
  const ans = p.enqueue(PART.ANSWER); p.fill(ans, '/answer.wav');
  assert.equal(p.queue.includes(gap1), false); assert.equal(p.queue.includes(fact), false);
  assert.equal(p.queue.includes(opener), true);
  await done(p);
  assert.deepEqual(a.log, ['/opener.wav', '/answer.wav']);
  assert.equal(await gap1.startedP, 'dropped');
});

test('optional INVITE plays only when ready; a new turn drops an unstarted invite', async () => {
  const a = fakeAudio();
  const p = new Player(a);
  const ans = p.enqueue(PART.ANSWER); p.fill(ans, '/a.wav');
  const inv = p.enqueue(PART.INVITE, { optional: true });
  await done(p);
  assert.deepEqual(a.log, ['/a.wav']);   // reached the invite, not ready → idle, no stall
  p.newTurn();
  assert.equal(p.queue.includes(inv), false);
  p.fill(inv, '/inv.wav');               // late fill of a dropped item is a no-op
  await tick(20);
  assert.deepEqual(a.log, ['/a.wav']);
});

// --- the turn runner against a fake API -------------------------------------------------------
function fakeApi({ answerMs = 120, precise = true } = {}) {
  const calls = [];
  const clip = (kind, n) => ({ kind, text: kind + n, audioUrl: '/' + kind + n + '.wav' });
  let b = 0;
  return {
    calls,
    session: async () => ({ greeting: clip('greeting', 0), intro: clip('service_intro', 0), topicAck: clip('topic_ack', 0), continuation: clip('continuation', 0) }),
    opener: async (kind) => { calls.push(['opener', kind]); return clip(kind, 1); },
    understand: async (query) => { calls.push(['understand', query]); await tick(30);
      return precise ? { precise: true, kind: 'neu', best_guess: query, options: [], slots: { ort: 'Kiel', indikator: 'Arbeitslosenquote' } }
        : { precise: false, kind: 'neu', clarify: 'Welcher Ort?', best_guess: 'Wie hoch ist die Arbeitslosenquote in Kiel?', options: ['Wie hoch ist die Arbeitslosenquote in Lübeck?'], slots: {}, clarifyAudioUrl: '/clarify.wav' }; },
    bridge: async (kind, query) => { calls.push(['bridge', kind]); const c = clip(kind, ++b); if (kind === 'fact') { c.url = 'https://de.wikipedia.org/x'; c.title = 'Kiel'; } return c; },
    answer: async (query) => { calls.push(['answer', query]); await tick(answerMs); return { ok: true, answer: 'In Kiel 5,1 Prozent.', meta: { table: 't', has_real_data: true, place_resolved: 'Kiel' }, audioUrl: '/answer.wav' }; },
    followup: async () => { calls.push(['followup']); await tick(20); return { invite: 'Auch Lübeck?', suggestions: ['Wie hoch ist die Arbeitslosenquote in Lübeck?'], inviteAudioUrl: '/invite.wav' }; },
  };
}
function fakeUi() {
  const u = { events: [], facts: [], bubbleLog: [] };
  for (const k of ['setState', 'reset', 'busy', 'echoQuery', 'working', 'answer', 'clarify', 'error', 'examples']) u[k] = (...a) => u.events.push([k, ...a]);
  u.showFact = (f) => u.facts.push(f); u.bubbles = (items, source) => u.bubbleLog.push({ items, source }); u.t = (k) => k; u.ffToggle = () => true;
  return u;
}

test('a full turn: opener at t=0, bridging while waiting, answer takes priority, invite after', async () => {
  const a = fakeAudio({ '/service_intro0.wav': 60, '/gap1.wav': 40, '/verstehen2.wav': 40, '/fact3.wav': 40 });
  const player = new Player(a), api = fakeApi({ answerMs: 150 }), ui = fakeUi();
  const d = new Dialog({ player, api, ui });
  await d.start(['Wie hoch ist die Arbeitslosenquote in Kiel?']);
  d.ask('Wie hoch ist die Arbeitslosenquote in Kiel?');
  await tick(5);
  assert.equal(a.log[0], '/service_intro0.wav', 'the turn-0 opener plays immediately from the session pool');
  await tick(400); await done(player); await tick(80); await done(player);   // the optional invite may arrive just after the answer ended
  const log = a.log;
  assert.equal(log[0], '/service_intro0.wav');
  assert.ok(log.includes('/answer.wav'), 'answer spoken');
  assert.equal(log[log.length - 1], '/invite.wav', 'invite last');
  assert.ok(log.indexOf('/answer.wav') > log.indexOf('/service_intro0.wav'));
  // nothing soft is spoken AFTER the answer
  const afterAnswer = log.slice(log.indexOf('/answer.wav') + 1);
  assert.deepEqual(afterAnswer, ['/invite.wav']);
  // the bridging requests happened in policy order: gap or verstehen first, fact only once
  const bridges = api.calls.filter((c) => c[0] === 'bridge').map((c) => c[1]);
  assert.equal(bridges.filter((k) => k === 'fact').length <= 1, true);
  assert.equal(bridges.filter((k) => k === 'verstehen').length <= 1, true);
  assert.equal(ui.facts.length, 1, 'the prepared fact is shown once');
  assert.equal(ui.bubbleLog.at(-1).source, 'followup');
  assert.equal(d.turnCount, 1);
  assert.ok(api.calls.some((c) => c[0] === 'opener' && c[1] === 'context_bridge'), 'next opener prepared (I6)');
});

test('a fast answer sees no fact and no extra gap (never padded)', async () => {
  const a = fakeAudio({ '/service_intro0.wav': 300 });
  const player = new Player(a), api = fakeApi({ answerMs: 10 }), ui = fakeUi();
  const d = new Dialog({ player, api, ui });
  await d.start([]);
  d.ask('Wie hoch ist die Arbeitslosenquote in Kiel?');
  await tick(500); await done(player);
  assert.deepEqual(a.log.filter((u) => u !== '/invite.wav'), ['/service_intro0.wav', '/answer.wav']);
});

test('clarify detour: the question is spoken (hard), pending is set, a bubble click delivers', async () => {
  const a = fakeAudio();
  const player = new Player(a), api = fakeApi({ precise: false, answerMs: 20 }), ui = fakeUi();
  const d = new Dialog({ player, api, ui });
  await d.start([]);
  d.ask('Arbeitslosenquote');
  await tick(150); await done(player);
  assert.ok(a.log.includes('/clarify.wav'));
  assert.ok(d.pending && d.pending.original === 'Arbeitslosenquote');
  assert.equal(ui.bubbleLog.at(-1).source, 'clarify');
  ui.bubbleLog.at(-1).items[0].onClick();   // best guess
  await tick(200); await done(player);
  assert.ok(a.log.includes('/answer.wav'));
  assert.equal(d.pending, null);
  assert.ok(api.calls.some((c) => c[0] === 'opener' && c[1] === 'context_bridge') || d.turnCount === 2);
});

test('follow-up "Ja" is a continuation: continuation opener, no service intro replay', async () => {
  const a = fakeAudio();
  const player = new Player(a), api = fakeApi({ answerMs: 20 }), ui = fakeUi();
  const d = new Dialog({ player, api, ui });
  await d.start([]);
  d.ask('Wie hoch ist die Arbeitslosenquote in Kiel?');
  await tick(300); await done(player);
  ui.bubbleLog.at(-1).items[0].onClick();   // ✓ Ja
  await tick(5);
  assert.equal(a.log.filter((u) => u === '/service_intro0.wav').length, 1, 'intro only once');
  await tick(300); await done(player);
  assert.ok(a.log.includes('/continuation0.wav'));
  assert.equal(a.log.filter((u) => u === '/answer.wav').length, 2);
});

test('a new question typed while a follow-up is on offer opens with the topic-ack', async () => {
  const a = fakeAudio();
  const player = new Player(a), api = fakeApi({ answerMs: 20 }), ui = fakeUi();
  const d = new Dialog({ player, api, ui });
  await d.start([]);
  d.ask('Wie hoch ist die Arbeitslosenquote in Kiel?');
  await tick(300); await done(player);
  assert.equal(d.followupActive, true);
  d.ask('Wie ist die Breitbandversorgung in Rostock?');
  await tick(300); await done(player);
  assert.ok(a.log.includes('/topic_ack0.wav'));
});
