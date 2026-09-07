# Callcenter Service GUI

Interactive end-user GUI for the Deutschlandatlas call-center: ask a question (type or speak),
the full pipeline runs (`scripts/n8n_workflow_runtime.mjs` → catalog match → live Deutschlandatlas
query → grounded German answer), the answer is shown and spoken back.

## Run
```
export LITELLM_BASE_URL=... LITELLM_API_KEY=... LITELLM_DEFAULT_MODEL=local-devstral-small2
# optional spoken answer via the CADS-Tunnel audio_generation channel:
export CC_TTS=1 CT_AGENT_BIN=/path/to/ct-agent CT_RELAY_ENV=/path/to/channel.env \
       CT_AUDIO_CHANNEL_ID=<audio channel id>
node gui/server.mjs   # http://127.0.0.1:8791
```
Dependency-free Node. No secrets are committed — everything is env-driven. Browser mic uses the
Web Speech API (de-DE) for spoken questions; the orb reacts to the spoken answer's audio.

## Multi-user / operations (2026-09)

- `GET /health` — liveness (always 200 while the process is up).
- `GET /ready` — readiness for a load balancer: 503 while draining after SIGTERM/SIGINT, or while
  the pipeline/Piper/channel queue is already at its cap (a new request would just be rejected anyway).
  Body includes each limiter's current `active`/`hiQueued`/`loQueued` for quick diagnosis.
- Concurrent callers no longer serialize behind a strict FIFO or share rotation state: each of the
  three internal work queues (pipeline runtime, local Piper, the llm2 channel) is capped (rejects with
  `QUEUE_FULL` past the cap — surfaced as HTTP 503 from `/answer`, and as a silent Piper/channel
  fallback everywhere else) and dequeues **round-robin per caller** (identified by IP) so one caller's
  own burst of speculative work can't starve another caller's real-time turn. Tunable via
  `CC_PIPER_QUEUE_HI/LO`, `CC_PIPELINE_QUEUE_HI/LO`, `CC_CHANNEL_QUEUE_HI/LO` (default 40 hi / 24 lo
  each). Phrase-variety rotation (greeting, "verstanden", bridge, follow-up invite) is now also
  per-caller instead of one global counter shared by everyone.
- `CC_DRAIN_DELAY_MS` (default 3000) / `CC_SHUTDOWN_TIMEOUT_MS` (default 15000): on SIGTERM/SIGINT,
  `/ready` flips to 503 immediately, the listening port closes only after the drain delay (so a load
  balancer has time to react before connections start being refused), and the process force-exits if
  drain + timeout is exceeded.
