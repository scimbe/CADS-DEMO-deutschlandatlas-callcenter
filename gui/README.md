# Callcenter Service GUI

Interactive end-user GUI for the Deutschlandatlas call-center: ask a question (type or speak),
the full pipeline runs (`scripts/n8n_workflow_runtime.mjs` → catalog match → live Deutschlandatlas
query → grounded German answer), the answer is shown and spoken back — inside one continuous,
natural dialogue.

## Run
```
export LITELLM_BASE_URL=... LITELLM_API_KEY=... LITELLM_DEFAULT_MODEL=local-devstral-small2
# spoken dialogue: the llm2 audio_generation channel (primary) and/or local Piper (fallback)
export CC_TTS=1 CT_AGENT_BIN=/path/to/ct-agent CT_RELAY_ENV=/path/to/channel.env CT_AUDIO_CHANNEL_ID=<id>
export CC_PIPER_BIN=/opt/piper/piper CC_PIPER_MODEL=voices/de_DE-thorsten-medium.onnx
node gui/server.mjs   # http://127.0.0.1:8791
```
Dependency-free Node ≥ 22. No secrets are committed — everything is env-driven.

**Offline demo / test mode** — no proxy, no engine, no network:
```
CC_STUB=1 CC_TTS_STUB=1 CC_STUB_ANSWER_MS=9000 node gui/server.mjs
```
`CC_STUB=1` replaces the LLM steps, the Atlas pipeline and Wikipedia with deterministic stand-ins
(the answer takes `CC_STUB_ANSWER_MS`, default 6000, so the bridging is exercised); `CC_TTS_STUB=1`
synthesizes a soft tone whose length scales with the text instead of calling a TTS engine.

## Dialogue design (2026-09 consolidation)

`gui/dialog-fsm.mjs` is the single source of truth and is imported by **both** the server and the
browser (served at `/dialog-fsm.mjs`), so they can never disagree. In one sentence: the caller hears
ONE ordered stream of speech; the Atlas answer is the foreground and takes priority the moment it is
ready, but never interrupts a clip that is already being spoken; every wait is bridged with prepared
material, and "Wussten Sie schon" is produced *after* an answer for the *next* round, never fetched
live while someone waits.

Spoken parts and their class:

| part | class | source | when |
|---|---|---|---|
| greeting | hard | pool (boot) | first caller gesture |
| opener | soft | pool (service intro / topic-ack / continuation) or templated context bridge | t=0 on utterance |
| verstehen | soft | dynamic, short, cached by text | once `/understand` resolved |
| fact ("Wussten Sie schon") | soft | **N1** store (produced after the previous answer) or **F1** pool | only while still waiting |
| gap | soft | pool (boot) | repeats while waiting |
| clarify | hard | dynamic | replaces the answer this turn |
| answer | hard, **priority** | dynamic (high-priority TTS) | right after the current clip |
| invite | hard, optional | dynamic (low priority) | after the answer if ready in time, else bubbles only |

*soft* = bridging only: dropped if the answer is ready before it started. *hard* = always spoken to
the end. The bridging loop requests one prepared part at a time (lookahead 1): verstehen → fact →
gap → gap …; if `/understand` is slow, a gap comes first and the verstehen echo replaces the next
queued gap. `GET /fsm` returns the machine, the part classes and the ten invariants (I1–I10).

Preparation (the "prepared" half of the flow):
- **Pools** (`gui/lib/bridging.mjs`) are warmed once at boot, self-healing, protected from pruning,
  rotated per caller so consecutive turns never repeat a phrase.
- **N1 facts** are produced in the background, at low TTS priority, for the place just answered, for
  the places of the validated follow-up suggestions, and at session start for the example bubbles —
  so even the first wait has a real, place-linked fact. A caller never hears the same fact twice.
- The next **context bridge** is templated from the last turn's place/indicator (no LLM call) and
  prefetched right after every answer.

## Routes

| route | purpose |
|---|---|
| `POST /session {examples}` | greeting + turn-0 opener + topic-ack + continuation clips (pools); starts N1 production for the example places |
| `POST /opener {kind, context}` | the opener clip for an utterance |
| `POST /understand {query, context}` | classify + resolve to one clean question; starts Atlas speculation and the verstehen prefetch; returns `clarifyAudioUrl` when not precise |
| `POST /bridge {kind, query, place}` | ONE prepared bridging clip (`verstehen` \| `fact` \| `gap`); `audioUrl:null` = nothing to say |
| `POST /answer {query}` | the grounded answer + audio (priority); produces the N1 fact for the place |
| `POST /followup {query, answer}` | validated suggestions + spoken invite; produces N1 facts for the suggested places |
| `POST /stt` | speech-to-text (channel-first, whisper.cpp fallback) |
| `GET /health`, `/ready`, `/fsm`, `/debug/trace` | liveness (with pool/fact stats), readiness (503 while draining or saturated), the design, recent traces |

## Code layout

```
gui/dialog-fsm.mjs      the design: parts, classes, opener/bridge decisions, FSM, invariants (shared)
gui/dialog-client.mjs   browser engine: Player (one ordered audio queue) + Dialog (turn runner)
gui/index.html          UI only: orb, i18n, mic/VAD, bubbles, adapters for the engine
gui/server.mjs          routes + policy
gui/lib/limiter.mjs     bounded, per-caller-fair work queues + per-caller rotation state
gui/lib/tts.mjs         channel-first TTS, Piper fallback, fade-in, streaming, stub
gui/lib/stt.mjs         channel-first STT, whisper.cpp fallback
gui/lib/llm.mjs         understand / follow-up / narrate / Wikipedia fact (+ stubs)
gui/lib/pipeline.mjs    the grounded answer: runtime spawn, speculation + reuse caches, verified pool
gui/lib/bridging.mjs    pools, N1 fact store, openers, verstehen echo, invite text
```

## Tests
```
node --test 'tests/gui/*.test.mjs'                      # policy, player/dialog (fake audio + API), bridging (stub)
CC_STUB=1 CC_TTS_STUB=1 CC_STUB_ANSWER_MS=9000 PORT=8799 node gui/server.mjs &
NODE_PATH=<dir with node_modules/playwright> node tests/gui/smoke.playwright.mjs http://127.0.0.1:8799
```
The browser smoke test drives three turns (question → "✓ Ja" → new topic) in headless Chromium and
asserts the invariants on the real `#player` event timeline. After changing the FSM run
`node scripts/sync_n8n_fsm_notes.mjs` to refresh the n8n workflow's mirror notes.

## Multi-user / operations

- Three bounded work queues (pipeline runtime, local Piper, the llm2 channel) reject with `QUEUE_FULL`
  past their cap (HTTP 503 from `/answer`, silent fallback elsewhere) and dequeue round-robin per
  caller (by IP). Tunable via `CC_PIPER_QUEUE_HI/LO`, `CC_PIPELINE_QUEUE_HI/LO`, `CC_CHANNEL_QUEUE_HI/LO`.
- Answer TTS is high priority; every bridging/prepared clip is low priority — bridging can never delay
  the answer's own synthesis.
- `CC_DRAIN_DELAY_MS` (3000) / `CC_SHUTDOWN_TIMEOUT_MS` (15000): `/ready` flips to 503 first, the
  listener closes after the drain delay, in-flight turns finish, a backstop forces exit.
