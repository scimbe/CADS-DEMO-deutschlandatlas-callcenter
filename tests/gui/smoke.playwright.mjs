#!/usr/bin/env node
// Browser smoke test of the whole dialogue against a running server (normally in stub mode):
//
//   CC_STUB=1 CC_TTS_STUB=1 CC_STUB_ANSWER_MS=16000 PORT=8799 node gui/server.mjs &
//   NODE_PATH=<dir containing node_modules/playwright> node tests/gui/smoke.playwright.mjs http://127.0.0.1:8799
//
// It drives three turns (typed question → "✓ Ja" follow-up → a new topic), records every
// play/ended event of the ONE #player element and every /bridge|/answer|/understand request, and
// asserts the dialogue invariants (dialog-fsm.mjs): order, no overlap, answer right after the clip
// that was playing when it arrived, no soft part after the answer, fact from the prepared store.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('playwright not resolvable — set NODE_PATH to a dir containing node_modules/playwright'); process.exit(2); }

const base = process.argv[2] || 'http://127.0.0.1:8799';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
const events = [], reqs = [];
await page.addInitScript(() => {
  window.__ev = [];
  document.addEventListener('DOMContentLoaded', () => {
    const p = document.getElementById('player');
    for (const e of ['play', 'ended', 'pause']) p.addEventListener(e, () => window.__ev.push({ t: Date.now(), e, src: (p.src || '').replace(location.origin, '') }));
  });
});
page.on('request', (r) => { const u = new URL(r.url()); if (/^\/(session|opener|understand|bridge|answer|followup)$/.test(u.pathname)) reqs.push({ t: Date.now(), path: u.pathname, body: r.postDataJSON && r.postDataJSON() }); });
page.on('response', async (r) => { const u = new URL(r.url()); if (/^\/(bridge|answer|understand|opener)$/.test(u.pathname)) { try { const j = await r.json(); reqs.push({ t: Date.now(), path: u.pathname + ' <-', kind: j.kind, ok: j.ok, query: j.query, audio: !!j.audioUrl, text: (j.text || j.answer || j.best_guess || '').slice(0, 60) }); } catch {} } });
page.on('pageerror', (e) => { console.error('PAGE ERROR', e.message); process.exitCode = 1; });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('CONSOLE', m.type(), m.text().slice(0, 200)); });
page.on('requestfailed', (r) => console.error('REQUEST FAILED', r.url(), r.failure() && r.failure().errorText));

await page.goto(base + '/');
await page.waitForFunction(() => window.ccDialog && window.ccDialog.session, null, { timeout: 15000 });
await page.click('h1');                                 // first gesture → greeting
await sleep(1500);
const q = 'Wie hoch ist die Arbeitslosenquote in Kiel?';
await page.fill('#q', q); await page.click('#go');
const dumpState = () => page.evaluate(() => JSON.stringify({ a: document.querySelector('#a').textContent.slice(0, 80), src: document.querySelector('#src').style.display, go: document.querySelector('#go').disabled,
  queue: (window.ccPlayer && window.ccPlayer.queue || []).map((it) => [it.part, it.ready, it.started, it.played]), busy: window.ccPlayer && window.ccPlayer.busy, ev: window.__ev }));
try { await page.waitForFunction(() => document.querySelector('#src').style.display === 'flex', null, { timeout: 45000 }); }
catch (e) { console.error('answer panel never appeared; page state:', await dumpState()); console.error('requests so far:', JSON.stringify(reqs)); throw e; }
await page.waitForFunction(() => [...document.querySelectorAll('#examples .ex')].some((b) => b.dataset.source === 'followup'), null, { timeout: 30000 });
await sleep(4000);
await page.click('#examples .ex.best');                 // ✓ Ja → continuation
await page.waitForFunction(() => document.querySelector('#qEcho').textContent.includes('Weiter'), null, { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll('#examples .ex[data-source=followup]').length > 0 && !document.querySelector('#go').disabled, null, { timeout: 40000 });
await sleep(3000);
await page.fill('#q', 'Wie ist die Breitbandversorgung in Rostock?'); await page.click('#go');   // new topic while follow-up on offer → topic ack
await page.waitForFunction(() => !document.querySelector('#go').disabled && document.querySelector('#a').textContent.includes('Rostock'), null, { timeout: 40000 });
await sleep(6000);
const ev = await page.evaluate(() => window.__ev);
await browser.close();

// ---- report ----
const t0 = ev[0] ? ev[0].t : Date.now();
const rel = (t) => ((t - t0) / 1000).toFixed(2).padStart(6) + 's';
const clipName = async (src) => src;
console.log('--- player events');
for (const e of ev) console.log(rel(e.t), e.e.padEnd(6), e.src);
console.log('--- requests');
for (const r of reqs) console.log(rel(r.t), r.path.padEnd(14), r.kind || '', r.ok === undefined ? '' : 'ok=' + r.ok, r.audio === undefined ? '' : 'audio=' + r.audio, r.text || (r.body && (r.body.kind || r.body.query) || ''));

// ---- assertions ----
let fails = 0;
const fail = (m) => { fails++; console.error('FAIL:', m); };
const plays = ev.filter((e) => e.e === 'play'), ends = ev.filter((e) => e.e === 'ended');
if (plays.length < 4) fail('too few clips played: ' + plays.length);
// no overlap: every play comes after the previous ended
for (let i = 1; i < plays.length; i++) { const prevEnd = ends.find((x) => x.t >= plays[i - 1].t && x.t <= plays[i].t + 5); if (!prevEnd) fail('clip ' + i + ' started before the previous one ended'); }
// answers: each /answer response is followed by an answer clip play within ~one clip (the clip playing at that time)
const answerResps = reqs.filter((r) => r.path === '/answer <-');
if (answerResps.length !== 3) fail('expected 3 answers, got ' + answerResps.length);
for (const ar of answerResps) {
  const playing = plays.filter((p) => p.t <= ar.t).at(-1);
  const playingEnd = playing && ends.find((x) => x.t >= playing.t);
  const next = plays.find((p) => p.t > ar.t);
  if (!next) { fail('no clip after answer at ' + rel(ar.t)); continue; }
  if (playingEnd && next.t - playingEnd.t > 1500) fail('answer did not start right after the current clip (gap ' + (next.t - playingEnd.t) + 'ms) at ' + rel(ar.t));
  // no bridging for THIS query after its answer was ready (a following turn may legitimately open
  // its own bridging while the previous answer is still queued behind a playing clip)
  const bridgeAfter = reqs.filter((r) => r.path === '/bridge' && r.t > ar.t && r.t < next.t && r.body && r.body.query === ar.query);
  if (bridgeAfter.length) fail('bridging still requested after the answer was ready for ' + ar.query);
}
const kinds = reqs.filter((r) => r.path === '/bridge <-').map((r) => r.kind);
// a fact is only reached when the wait outlasts opener + verstehen (run the server with
// CC_STUB_ANSWER_MS >= 16000 for this to be exercised; a fast answer is never padded)
if (!kinds.includes('fact')) fail('no prepared fact was used as a bridge (is CC_STUB_ANSWER_MS long enough?)');
if (!kinds.includes('verstehen')) fail('no verstehen echo');
const fact = reqs.find((r) => r.path === '/bridge <-' && r.kind === 'fact');
if (fact && !/Wussten Sie schon/.test(fact.text)) fail('fact text unexpected: ' + fact.text);
console.log(fails ? `\n${fails} FAILURE(S)` : '\nOK — dialogue invariants hold in the browser');
process.exit(fails ? 1 : 0);
