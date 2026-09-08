# Testing strategy for the voice call-center dialog system

> **New location.** This repo has no `docs/` directory or research-notes convention today —
> only `README.md` at the root, `gui/README.md`, and `deploy/README.md`. This file establishes
> `docs/` as the place for this kind of note. If the team prefers a different convention, move it.

Scope: `gui/dialog-fsm.mjs` (the FSM), `gui/server.mjs` (~1290 lines, dependency-free Node
HTTP server), `gui/index.html` (browser client, ordered speech queue). Every recommendation
below is checked against what these three files actually do, not generic advice, and every tool
claim is sourced to its own docs/repo.

The four real bugs from this session (funfact wiring, follow-up hallucination, I1 interruption,
spec/behavior drift) are used throughout as concrete test-design targets: at each relevant
section, "this test would have caught bug #N" is called out explicitly.

---

## 0. Testability seams already in the code (found while reading it)

Two facts make most of this plan cheap to implement with **zero new npm dependencies**:

1. **`gui/server.mjs` is a plain Node script with a dependency-free HTTP server** (see
   `gui/README.md`: "Dependency-free Node. No secrets are committed — everything is env-driven.").
   It can be started as a child process (`node gui/server.mjs`) and driven entirely over HTTP —
   no test harness needs to `import` its internals.
2. **Every LLM call in the whole pipeline is already routed through one env var.**
   `gui/server.mjs`'s `llmJSON()` (line 810) and `narrate()` (line 843) read
   `process.env.LITELLM_BASE_URL`, and — because `runPipeline()` (line 153) spawns
   `scripts/n8n_workflow_runtime.mjs` with `env: process.env` — the spawned pipeline's own
   catalog-match/phrasing LLM calls (`scripts/n8n_workflow_runtime.mjs:122-126`, confirmed by
   reading that file) read the **same** `LITELLM_BASE_URL`. Pointing `LITELLM_BASE_URL` at a tiny
   local HTTP stub server therefore makes the *entire* LLM layer — `/understand`, `/followup`,
   `narrate()`, the catalog-match step inside the child pipeline — deterministic, in one place,
   with no code change.

One real gap: the pipeline path is hardcoded (`RUNTIME = join(REPO_ROOT, 'scripts',
'n8n_workflow_runtime.mjs')`, line 29) and the `ct-agent` TTS/STT channel binary is read from
`CT_AGENT_BIN`/`CT_RELAY_ENV`/`CT_AUDIO_CHANNEL_ID` env vars (already overridable — see §2).
The only seam **worth adding** (a few lines, no new dependency) is making `RUNTIME` itself
overridable via an env var (e.g. `CC_RUNTIME_PATH`), so a test can substitute a fake pipeline
script that returns canned `{text, meta}` JSON instantly. Everything else below works against
the code as it stands today.

---

## 1. State-machine / model-based testing of `dialog-fsm.mjs`

**Primary sources:** GraphWalker project ([GitHub](https://github.com/GraphWalker/graphwalker-project),
[model syntax](https://github.com/GraphWalker/graphwalker.github.io/blob/afe72b34de552e7e4ae21ccbe0d534907bde7401/content/docs/gw_model_syntax.md)),
AltWalker ([docs](https://altwalker.github.io/altwalker/overview.html), [GitHub](https://github.com/altwalker/altwalker)).

GraphWalker models a system as a directed graph: **vertices** are states where assertions/oracles
live, **edges** are the actions/transitions between them, and it *generates* test paths through the
graph rather than requiring you to hand-write every path. Guards (`[condition]`) gate edges, actions
(`/code;`) mutate model-local state on an edge, and `SHARED:name` lets separate models jump between
each other at same-named vertices (model syntax doc, above). AltWalker is a wrapper that maps each
vertex/edge to a method on a Python or C#/.NET class and executes the graph AltWalker/GraphWalker
generates against your real system under test (AltWalker overview, above) — it uses GraphWalker's
REST API as an "online planner," so path generation and execution interleave.

**Fit for `dialog-fsm.mjs`:** The FSM here (`GREETING → IDLE → CLASSIFY → {DELIVER|CLARIFY} → IDLE`,
with `DELIVER` itself an ordered 5-part sub-sequence P1–P5) is small (5 states, ~8 edges) and
**already declared as data** (`FSM.states`, `PARTS`, `KIND` in `dialog-fsm.mjs`). Standing up a full
GraphWalker/AltWalker toolchain (JVM or Python + a `.graphml`/JSON model file, kept in sync with
`dialog-fsm.mjs` by hand) is disproportionate to a graph this size, and — per this repo's own
"dependency-free Node" constraint (`gui/README.md`) — introduces a second language runtime purely
for test generation.

**Recommendation:** don't adopt GraphWalker/AltWalker as external tools. Instead, treat
`dialog-fsm.mjs`'s own exported `FSM.states[...].on` map as the model, and write a **small custom
path-enumerator in `node:test`** (~40 lines, no dependency) that:
- walks all `on` edges from `FSM.states` up to a bounded depth (e.g. `IDLE→CLASSIFY→CLARIFY→CLASSIFY→DELIVER→IDLE`, `IDLE→CLASSIFY→DELIVER→IDLE`, etc.) and drives the real HTTP routes for each generated path, exactly the "generate paths from the graph, execute against the SUT" idea GraphWalker embodies, minus the extra runtime;
- separately, encode each of the 9 declared `INVARIANTS` (I1–I9) as one `node:test` assertion each, phrased directly from the comment text in `dialog-fsm.mjs` (e.g. I3 → "assert `bridgeKind(0) === 'service_intro'` and `bridgeKind(N>0) === 'context_bridge'` regardless of the previous answer's success" — this is a one-line pure-function test against `bridgeKind()`, already exported).
- If the FSM grows materially (more states, branching DELIVER sub-flows), revisit AltWalker — the model-to-code mapping (one method per vertex/edge) would then justify its own toolchain.

This would have caught **bug #4** (spec/behavior drift) directly: enumerating every declared path
and asserting against `INVARIANTS` forces someone to check the *written* FSM against what the
*code* does, which is exactly where the drift the user reported would surface — a currently-passing
"path test" that nonetheless produces a flow nobody intended is a signal the model itself needs
revising, separate from an implementation bug.

## 2. HTTP-level integration testing of the server routes (no real TTS/LLM)

**Primary sources:** [Node.js Test runner docs, v22.x](https://nodejs.org/docs/latest-v22.x/api/test.html);
[undici mocking best practices](https://undici.nodejs.org/best-practices/mocking-request) (undici
ships the `fetch`/`MockAgent` implementation bundled with Node 18+, per
[undici vs. builtin fetch](https://undici.nodejs.org/best-practices/undici-vs-builtin-fetch)).

`node --test` is built into Node ≥18 (stable since 20.0.0; `describe`/`it` since 18.6.0). It needs
no dependency, supports `describe`/`it`/`test`, `t.mock` (spy/stub functions and methods via
`mock.fn`/`mock.method`), `t.mock.timers` (deterministic fake timers — `enable({apis:[...]})` +
`tick(ms)`), snapshot assertions (`t.assert.snapshot`, requires `--test-update-snapshots` to record),
and CLI test filtering (`--test-name-pattern`). It has **no built-in HTTP-server or child-process
test helpers** — the documented pattern is: start the real server (or spawn it), hit it with the
native `fetch`, assert on the response (Node test runner docs, "HTTP Server" example).

Given the seam in §0, the concrete, deterministic setup for this project is:

1. **Stub the LLM.** Start a throwaway `http.createServer` in the test's `before()` hook that
   answers `/chat/completions` with fixed JSON matching the shapes `llmJSON()`/`narrate()`/the
   pipeline's catalog-match step expect. Point `LITELLM_BASE_URL` at it before starting
   `gui/server.mjs`. This is plain `node:http` — no `undici.MockAgent` needed, because the stub
   intercepts at the *transport* level the server already talks to (a real loopback socket), which
   is simpler here than mocking `fetch` in-process across a spawned child (undici's `MockAgent`
   would only work if the pipeline ran in the *same* process — it spawns as a child, so an
   in-process mock can't reach it; a real stub server is the correct tool, per the "mocking vs.
   real" tradeoff described in the undici docs above).
2. **Stub the TTS/STT channel** the same way: `CT_AGENT_BIN` is just an executable path
   (`gui/server.mjs:254-260`, `442-450`) invoked via `spawn('bash', ['-c', ...])`. Point it at a
   tiny fixture script (a `#!/usr/bin/env node` file under `gui/test/fixtures/`) that reads stdin
   JSON and prints either a fake `https://...` URL (success) or nothing/`ERROR:` (failure), keyed
   off an env var the test sets (e.g. `FAKE_CHANNEL_MODE=ok|timeout|error`) — this directly
   simulates the documented failure modes (`ttsChannel`'s 8s timeout at line 266, `sttChannel`'s
   30s timeout at line 454) without needing any mocking library.
3. **Stub the pipeline** via the `CC_RUNTIME_PATH` seam from §0: a fixture `.mjs` that reads
   `--query` and prints a canned `{text, meta}` line to stdout — this is what lets `/answer`,
   `/understand`'s speculative warm, and `/followup`'s `validateSuggestions()` run deterministically
   end-to-end without ArcGIS or a real catalog-match LLM call.
4. **Drive it with native `fetch`.** Spawn `node gui/server.mjs` as a child process (matching how
   it's actually run — see `gui/README.md`), poll `GET /health` until 200, then run `node:test`
   cases that `fetch()` `/understand`, `/context`, `/answer`, `/followup`, `/fsm` and assert on the
   JSON shape and the invariants below.

**Invariant assertions this makes possible, sourced directly to the code that documents them:**
- *"funfact is always Wikipedia-sourced or null"* (I4, `dialog-fsm.mjs:100`) — assert every
  `/context` response's `funfact` is either `null` or has `.url` matching
  `^https://de\.wikipedia\.org/wiki/`. This is **exactly bug #1**: a test asserting this on every
  `/context` call, run across many turns, would have caught the fun-fact slot being silently filled
  from the generic filler pool (`bridgeF1`/`BRIDGE_FACTS`, `server.mjs:696`) instead of Wikipedia —
  the code comment at `server.mjs:1056-1064` documents this exact regression and why `bridgeF1` was
  removed from that slot.
- *"bridge text depends only on turnCount, never on last-answer success"* (I3) — call `/intro`
  twice with `{turnCount:0}` (must be a `SERVICE_INTROS` variant) and `{turnCount:1, lastQuery:null}`
  (must be a `BRIDGE_FALLBACKS`/generated bridge, never a `SERVICE_INTROS` string) regardless of
  whether a preceding `/answer` failed.
- *QUEUE_FULL / 503 behavior* — call `/answer` beyond `CC_PIPELINE_QUEUE_HI`/`CC_PIPER_QUEUE_HI`
  concurrently and assert on the documented 503 (`server.mjs:1127`, "QUEUE_FULL is 'try again
  shortly'... distinct 503").
- *`/followup` never suggests an indicator absent from `catalog.json`* — this is **bug #2**'s
  target; see §7 for why the *reactive* check server.mjs already does (`validateSuggestions()`,
  line 998) is necessarily flaky, and what a regression test can assert instead.

## 3. Browser E2E testing of audio ordering / non-interruption (invariant I1)

**Primary sources:** [Playwright docs](https://playwright.dev/); pattern write-up: [Testing Browser
Audio with Playwright](https://www.kazis.dev/blogs/playwright-sounds-test); background: [Playwright
issue #23223, "Test video element (play, pause, end)"](https://github.com/microsoft/playwright/issues/23223)
(confirms Playwright itself has no first-class media-element assertion API — the community pattern
below is the documented workaround, not a Playwright feature).

Playwright has no built-in "assert audio played in order" primitive (issue #23223). The documented
technique is to **monkey-patch the `<audio>` element's prototype before the page's own scripts run**,
via `page.addInitScript()`, recording every `play()`/`pause()`/`ended` event (with the element's
`src` and a timestamp) into a `window`-scoped array that the test then reads back
(kazis.dev, "Testing Browser Audio with Playwright"). Because the spoken text is already available
in the JSON API responses (per the task brief), this project needs **no transcription** — only
ordering/overlap verification, which this pattern gives directly.

Concretely, for `gui/index.html`'s `#player` element and its `seq`/`pump()`/`advance()` queue
(`index.html:287-345`):

```js
await page.addInitScript(() => {
  window.__audioLog = [];
  const proto = HTMLMediaElement.prototype;
  const origPlay = proto.play;
  proto.play = function (...args) {
    window.__audioLog.push({ t: performance.now(), ev: 'play', src: this.src, id: this.id });
    return origPlay.apply(this, args);
  };
  ['pause', 'ended'].forEach(ev =>
    document.addEventListener(ev, e => {
      if (e.target && e.target.tagName === 'AUDIO')
        window.__audioLog.push({ t: performance.now(), ev, src: e.target.src, id: e.target.id });
    }, true));
});
```

Then assert, from `window.__audioLog` filtered to `id==='player'` (the ordered-queue element —
`#filler` is a *separate* element by design, `index.html:144`, and must be excluded or verified
never to overlap a `player` `play` event):
- **Non-interruption (I1):** every `play` event on `#player` is followed by a `pause`-with-`currentTime===0`-immediately-after or an `ended` for *that same clip* before the *next* `play` fires — i.e. no `play` event occurs while the previous clip's `ended`/qualifying-`pause` hasn't yet been logged. This is **bug #3**, precisely: the FSM's own I1 ("P1..P5 always play in queue order, each to the end... never interrupted") was violated by `newTurn()` calling `player.pause()` on a still-playing clip; the code has since been patched (`index.html:288-301` now defers via the `seqBusy && !player.paused && !player.ended` guard) — but nothing currently *asserts* I1 automatically, so a future regression here would again only be caught by manually listening. This Playwright check closes that gap permanently.
- **Ordering:** compare `src` values across successive `play` events on `#player` against the
  expected P1→P5 sequence for a scripted turn (drive the same `LITELLM_BASE_URL`/`CT_AGENT_BIN`/
  `CC_RUNTIME_PATH` stubs from §2 so clip URLs are deterministic and fast, avoiding real TTS
  latency in CI).
- Trigger the exact regression scenario from bug #3 directly: submit a question, then — before the
  previous turn's P5 (follow-up invite) audio has fired `ended` — submit a *new* question via the
  input field, and assert the old clip's `ended`/qualifying-`pause` was logged before the new turn's
  first `play`.

## 4. "Liveliness" / anti-repetition testing (phrase rotation)

**Primary sources:** [fast-check official docs](https://fast-check.dev/), [fast-check + node:test
tutorial](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-nodejs-test-runner/),
[GitHub](https://github.com/dubzzz/fast-check).

fast-check is a property-based testing library (à la QuickCheck) that works with any runner,
including `node:test`, via plain `fc.assert(fc.property(...arbitraries, predicate))` — no adapter
needed (fast-check docs, "Property Based Testing with Node.js test runner"). It also has an explicit
notion of "statistical properties" — properties checked not on every single generated input, but
in aggregate over many runs (same tutorial page) — which maps directly onto "does this rotation
list avoid repeating within N turns," a claim about a *distribution* across many turns, not a
single-call assertion.

The code under test — `rotFor()` (`server.mjs:122`) and the five rotation-backed pickers
(`greetingText`, `verstehenText`, `topicAckText`, `deriveInvite`, plus `introBridge`'s
`SERVICE_INTROS`/`BRIDGE_FALLBACKS` indices) — are all **pure, deterministic modulo functions**
(`list[(rotFor(userKey).X++) % list.length]`) once the userKey and call count are known, so this
does not even need true randomness to test; but fast-check is still the right tool for two reasons:
it generates the *userKey* and *call-count* combinations for you (catching an off-by-one or shared
state bug across an input space you wouldn't hand-enumerate), and its **shrinking** (fast-check
docs, "How It Works") turns a failing multi-hundred-call scenario into the minimal reproducing case
automatically.

Recommended properties (all runnable as plain `node:test` + `fast-check`, no server needed — these
call the exported/extractable pure functions directly):
- *No immediate repeat, single caller:* `fc.assert(fc.property(fc.integer({min:2,max:50}), n => { const seen=[]; for(let i=0;i<n;i++) seen.push(greetingText('capA')); return seen.every((v,i)=> i===0 || v!==seen[i-1]); }))` — generalizes to all five rotation lists.
- *No cross-caller collision (the documented multi-user regression, `server.mjs:115-119`
  "previously a single global counter... caller B's turn silently advanced caller A's rotation
  too"):* `fc.assert(fc.property(fc.array(fc.string(), {minLength:2}), fc.array(fc.nat(20)), (callers, calls) => { /* interleave calls across distinct userKeys; assert each caller's own sequence is exactly what it would be if called in isolation */ }))`.
- *Boundedness of `rotState`* (the `ROT_MAX`/`ROT_IDLE_MS` pruning at `server.mjs:120-121,126-129`):
  generate thousands of distinct synthetic userKeys via `fc.uniqueArray(fc.string())` and assert
  `rotState.size` (would need a small test-only export, or infer via `/debug/trace` if it's ever
  surfaced there) never exceeds `ROT_MAX`.

This class of test would **not** have caught bug #1 or #2 (those are wiring/LLM-reliability bugs,
not rotation bugs) but is exactly the right tool for exactly what "the operator directive: don't
repeat too soon" invariant needs, and the multi-user-fairness comments throughout `server.mjs`
(§5 below) show this project has already been bitten by cross-caller state bugs once.

## 5. Load testing for multi-user fairness / backpressure

**Primary sources:** [Grafana k6 docs — Scenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/),
[k6 GitHub](https://github.com/grafana/k6); [autocannon GitHub](https://github.com/mcollina/autocannon)
(the `mcollina/autocannon` repo is the actively maintained canonical one — several of the other
search hits are stale forks).

k6 scenarios let you run several independently-configured executors concurrently in one test run,
each with its own `exec` function, tags, and (via `startTime`) stagger — the docs explicitly
describe this as the way to "model diverse traffic patterns," including giving each simulated
"caller" its own function and metric tags (k6 scenarios docs, "Executor Types" / "Multi-Caller
Scenario Testing" above). This is a materially better fit than autocannon for `makeLimiter()`'s
round-robin-per-`userKey` fairness (`server.mjs:73-107`, keyed off `x-forwarded-for`/remote address
via `userKeyFor()`), because autocannon is a single-workload firehose (`-c`/`-p`/`-d`/`-a` flags —
concurrency/pipelining/duration/amount, per its README) with no native concept of "N distinct
simulated identities, each with its own request cadence" — you'd have to fake distinct source IPs
or headers yourself and there's no scenario/tag separation for per-identity result analysis.
**autocannon remains useful** for the simpler, single-dimension question "what's the max throughput
before `/health`/`/ready` degrade," where its lower setup cost (single Node binary, no separate
runtime/language) fits this project's dependency-free bias better than installing k6's Go binary.

Concrete k6 scenario for round-robin fairness (a genuine load-testing exercise — k6 is Go+JS, an
external tool, not an npm dependency, consistent with "minimal new *npm* dependency" rather than
zero external tooling):

```js
import http from 'k6/http';
export const options = {
  scenarios: {
    callerA: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '30s',
               preAllocatedVUs: 5, exec: 'askAsA', tags: { caller: 'A' } },
    callerB: { executor: 'constant-arrival-rate', rate: 5, timeUnit: '1s', duration: '30s',
               preAllocatedVUs: 5, exec: 'askAsB', tags: { caller: 'B' } },
  },
};
export function askAsA() { http.post(`${__ENV.BASE}/answer`, JSON.stringify({query:'...'}),
  { headers: { 'content-type':'application/json', 'x-forwarded-for':'10.0.0.1' } }); }
export function askAsB() { http.post(`${__ENV.BASE}/answer`, JSON.stringify({query:'...'}),
  { headers: { 'content-type':'application/json', 'x-forwarded-for':'10.0.0.2' } }); }
```

then assert on **response latency parity between the `caller:A` and `caller:B` tags** (k6's summary
breaks metrics down per tag) — a fair round-robin implementation should show comparable p95 latency
for both identities even when one caller (`A`, say) also fires a burst of low-priority speculative
work (`swapCityFollowups`, `server.mjs:490-500`) that could otherwise starve `B`, which is exactly
the scenario the code comment at `server.mjs:62-72` documents as the bug being fixed. Also assert:
`QUEUE_FULL`/503 only appears once *both* queues are provably at their configured cap (cross-check
against `/ready`'s reported `limiters` stats, `server.mjs:1247`), never as a false positive under
moderate concurrent load from two fairly-served callers.

## 6. Fault-injection / chaos testing for documented failure modes

**Primary sources:** [Shopify/toxiproxy GitHub](https://github.com/Shopify/toxiproxy) (a TCP proxy
for chaos/resiliency testing, controlled via a REST API — "toxics" like `reset_peer`, `timeout`,
`latency` are injected on a running connection without any client code change); for the two
in-process failure modes that don't go over a real TCP socket in dev/CI, plain **fixture scripts**
(no dependency) as already described in §2/§0.

The three documented failure modes in the task brief map to three different injection techniques,
because they occur at different layers of this specific codebase:

1. **llm2 channel timeout** (`ttsChannel`/`sttChannel`, `server.mjs:266,454`, hardcoded 8s/30s
   defaults via `CC_CHANNEL_TIMEOUT_MS`) — this is a `spawn('bash', ...)` invoking `CT_AGENT_BIN`,
   not a TCP connection this test process can see directly (the actual network hop happens inside
   the `ct-agent` binary). **Toxiproxy doesn't apply here** unless `CT_AGENT_BIN`'s own network
   target is proxied — simplest and fully sufficient: the `CT_AGENT_BIN` fixture script from §2,
   with a `FAKE_CHANNEL_MODE=timeout` branch that just `sleep`s past the configured timeout, then
   assert `ttsSpeak()`'s documented fallback engaged (`server.mjs:308-330`: "if the channel call
   fails at request time... we synthesize with Piper instead" — assert the `/answer` response's
   audio still resolves, or, with Piper also unavailable in CI, that the turn degrades to `null`
   audio without the request hanging past the timeout + a small margin).
2. **ArcGIS `ECONNRESET`** — this happens *inside* `scripts/n8n_workflow_runtime.mjs`, a real TCP
   call to `karto365.de`. Here **Toxiproxy is the right tool** if/when that script's ArcGIS base
   URL becomes env-configurable (it currently is not — confirmed by grep; each `catalog.json` row
   hardcodes a full `https://www.karto365.de/...` URL) — point it at a local Toxiproxy instance
   proxying to the real host, and use the `reset_peer` toxic to inject a real mid-response RST.
   Until that seam exists, the achievable-today equivalent is the `CC_RUNTIME_PATH` fixture (§0):
   have the fake runtime script model the retry/backoff logic's *interface* (fail N times then
   succeed) so `runPipeline()`'s consumer-side handling is covered, while filing the ArcGIS-URL
   env-var seam as a follow-up for true wire-level fault injection.
3. **litellm-proxy connection reset** — this **is already directly testable today**, because (per
   §0) `LITELLM_BASE_URL` is fully env-driven end-to-end. Point it at a local `http.createServer`
   stub that, on request N, destroys the socket mid-response (`res.socket.destroy()` after writing
   partial headers) to produce a real `ECONNRESET`/`UND_ERR_SOCKET` on the client side — no
   Toxiproxy needed, since you already control the server. Assert `llmJSON()`'s documented retry
   (`server.mjs:813-838`: "Retry transient network/5xx errors a few times with a short backoff...
   request is idempotent, temp 0") actually fires — count requests received by the stub and assert
   it saw `RETRIES` (3) attempts before either succeeding or falling back to `{}`.

## 7. Making `/debug/trace` and `/fsm` useful for automated regression testing

`/fsm` (`server.mjs:1254-1259`) already serves `describeFsm()` — i.e. `dialog-fsm.mjs`'s own
`PARTS`/`KIND`/`FSM`/`INVARIANTS` as JSON. The direct use: **a `node:test` case that fetches `/fsm`
and diff-checks it against a checked-in snapshot** (using the built-in `t.assert.snapshot`,
regenerable via `node --test --test-update-snapshots`, per the Node test runner docs in §2) turns
any *unreviewed* change to the FSM's shape/invariants into an explicit, visible diff in code review
— cheap insurance against exactly the kind of silent spec drift behind bug #4 (a change to
`dialog-fsm.mjs`'s comments/invariants without a matching implementation change, or vice versa,
would show up as an unexpected snapshot diff).

`/debug/trace` (`server.mjs:1225-1234`) is a ring buffer of the last 120 `trace()` calls
(`understand`, `pipeline`, `answer` tags — see the `trace()` calls at lines 1030, 171, 1119), each a
structured object serialized as one JSON-ish line. Two uses:

- **Trace-based regression tests from real recorded sessions**, as the brief asks: capture a real
  `/debug/trace` output during a manual/live session (or during the Playwright E2E run in §3 —
  fetch `/debug/trace` right after the scripted turns complete), save the JSON objects as fixtures,
  and write assertions that pin down properties that must hold in *every* trace regardless of the
  exact query text — e.g. "every `pipeline` trace with `ok:true` has a non-null `table`," "no
  `understand` trace ever has `precise:true` and empty `best_guess`," "a `kind:'anschluss'` trace
  is never immediately followed by another `understand` trace referencing the *same* unresolved
  slot" (a proxy for catching dialogue-state-tracking regressions). This is a lighter-weight,
  Node-native analogue of the fixture format model-based tools like AltWalker use for known-path
  regression, without adopting AltWalker itself (§1).
- **This is exactly the tool bug #2 (hallucinated follow-up suggestions) needs**, because — as the
  code comment at `server.mjs:576-583,1138-1145` documents in detail — the *runtime* mitigation
  (`validateSuggestions()` re-running the pipeline live) is fundamentally unreliable: "the
  catalog-match LLM step is itself non-deterministic... and can occasionally hallucinate a match for
  text that names no real indicator." No runtime check can fully close this, precisely because it's
  the same non-deterministic component checking itself. What *can* be tested deterministically and
  offline: **a static audit** — for every question ever fed into `followup()` during the E2E/trace
  corpus, verify every string returned in `suggestions` parses (via the same `placeFromQuery`-style
  regex, or a slightly stricter one) to a `{indicator, place}` pair where the indicator text overlaps
  a `catalog.json` `indicator` row's `snippet` above some similarity threshold — this doesn't need a
  live LLM call at all, only the recorded suggestion strings and the static `catalog.json`, so it's
  fully deterministic and can run in CI on every trace fixture without hitting a network at all.
  It converts an *unreliable runtime safety net* into a *deterministic offline regression check* —
  exactly the shift from "re-run the flaky thing and hope" to "check the recorded output against a
  static ground truth" that this bug needs.

---

## Prioritized, minimal-new-dependency recommendation

Ordered by (bug-catching value) ÷ (implementation cost), assuming **zero new npm dependencies**
beyond what's listed (all are either built into Node or a single dev-only external binary,
consistent with `gui/README.md`'s "dependency-free Node"):

1. **`node --test` HTTP integration suite** (§2) — start `gui/server.mjs` as a child process against
   a local LLM stub (plain `node:http`) + a fake `CT_AGENT_BIN` fixture script + (after adding the
   one-line `CC_RUNTIME_PATH` seam from §0) a fake pipeline script. Assert the I1–I9 invariants
   directly on route responses. This alone would have caught bug #1 (funfact source assertion on
   every `/context` call) and gives the fastest, cheapest CI signal. **Do this first.**
2. **`/fsm` snapshot test** (§7) using `node:test`'s built-in `t.assert.snapshot` — a five-minute
   addition once (1) exists, and it is the most direct defense against bug #4 (spec/implementation
   drift): any edit to `dialog-fsm.mjs` that isn't intentional shows up as a reviewable diff.
3. **Playwright I1 non-interruption check** (§3) — the monkey-patched `<audio>` event log, run
   against the same stubbed backend from (1). Directly targets bug #3, and is the only technique in
   this document that observes the *browser's actual playback behavior* rather than server-side
   state, so it's the one test that would have caught that regression the way it actually manifested
   (an abrupt audible cutoff).
4. **fast-check rotation properties** (§4) on the pure `rotFor()`-backed functions — cheap (one new
   dev dependency, `fast-check`, explicitly designed to be dependency-light and runner-agnostic) and
   guards the multi-user fairness work already done in this codebase from regressing silently.
5. **Deterministic litellm-ECONNRESET fault-injection test** (§6.3) — no new tool at all (a stub
   `http.createServer` that calls `res.socket.destroy()`), verifies the retry logic in `llmJSON()`
   actually engages under a real reset, not just a mocked rejection.
6. **k6 fairness/backpressure scenario** (§5) — the one item here that's a genuinely separate
   external tool (a Go binary) rather than something layered on `node:test`; do this once (1)-(5)
   are in place and stable, since it's the most expensive to run in CI (needs a live server, takes
   real wall-clock time) and its main value (confirming round-robin fairness holds under real
   concurrent load, not just unit-level queue logic) is a capstone check rather than a fast
   first-line-of-defense test.
7. **Toxiproxy for the ArcGIS `ECONNRESET` path** (§6.2) — deprioritized below k6 because it first
   needs the ArcGIS-base-URL-env-var seam added to `scripts/n8n_workflow_runtime.mjs`/`catalog.json`
   handling, which is out of scope for a testing-strategy note and belongs in its own small PR.
8. **Custom FSM path-enumerator** (§1) — valuable but the lowest urgency: the state graph is small
   and stable today, and items (1)+(2) already exercise most single-hop transitions incidentally.
   Revisit if the FSM grows more states/branches, at which point re-evaluate AltWalker specifically
   (not GraphWalker directly — AltWalker's Python/C# harness is the part that would actually save
   effort here, GraphWalker alone is just the path generator underneath it).

Sources cited above (deduplicated):
- [Node.js Test runner docs (v22.x)](https://nodejs.org/docs/latest-v22.x/api/test.html)
- [undici — Mocking Request best practices](https://undici.nodejs.org/best-practices/mocking-request)
- [undici — undici vs. builtin fetch](https://undici.nodejs.org/best-practices/undici-vs-builtin-fetch)
- [GraphWalker project (GitHub)](https://github.com/GraphWalker/graphwalker-project)
- [GraphWalker model syntax](https://github.com/GraphWalker/graphwalker.github.io/blob/afe72b34de552e7e4ae21ccbe0d534907bde7401/content/docs/gw_model_syntax.md)
- [AltWalker overview](https://altwalker.github.io/altwalker/overview.html) / [AltWalker GitHub](https://github.com/altwalker/altwalker)
- [Playwright](https://playwright.dev/) / [Playwright issue #23223 (no native media-element testing API)](https://github.com/microsoft/playwright/issues/23223)
- [Testing Browser Audio with Playwright (monkey-patch pattern)](https://www.kazis.dev/blogs/playwright-sounds-test)
- [fast-check](https://fast-check.dev/) / [fast-check + node:test tutorial](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-nodejs-test-runner/)
- [Grafana k6 — Scenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/) / [k6 GitHub](https://github.com/grafana/k6)
- [autocannon (mcollina/autocannon)](https://github.com/mcollina/autocannon)
- [Shopify/toxiproxy](https://github.com/Shopify/toxiproxy)
