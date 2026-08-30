# Deploying the Deutschlandatlas Sprach-Callcenter

A container image for durable hosting of the voice call-center GUI.

## What runs

`gui/server.mjs` (pure Node, no npm deps) serving the caller GUI on `PORT` (default 8791),
bound to `CC_HOST` (default `0.0.0.0` in the image). It shells out to:

- **whisper.cpp** `whisper-cli` (built in the image, pinned tag `b4938`, multilingual `ggml-base`) for STT
- **`ct-agent channel`** (`audio_generation`) for the Thorsten TTS voice
- **`node scripts/n8n_workflow_runtime.mjs`** for the live Deutschlandatlas ArcGIS/catalog pipeline

**Footprint is static** — STT temp files are deleted per request, TTS audio is streamed through
(never stored), the speculation cache is in-memory (capped at 80). Nothing accumulates per call.
Image size is dominated by the `ggml-base` model (~141 MB) + the ct-agent binary (~20 MB).

## Two things the deployer must supply

1. **A Linux `ct-agent` binary for the target arch** at `deploy/vendor/ct-agent` before building
   (the dev binary is macOS/arm64 and will not run in a Linux container). Same version family as
   what the audio channel expects (dev used v0.7.9). Obtain it from the CADS-Tunnel release/build
   for your arch.
2. **The `audio_generation` channel grant + keys** at run time (the `CT_CHANNEL_*` secrets referenced
   by `CT_RELAY_ENV`) — coordinated with **Maintainer labor**. These are NOT baked into the image.

## Build

```bash
# place the target-arch Linux ct-agent binary first
cp /path/to/linux/ct-agent deploy/vendor/ct-agent

# build from the repo root (build context must include gui/, scripts/, catalog.json, deploy/)
docker build -f deploy/Dockerfile -t cads-callcenter:latest .
```

## Run

```bash
cp deploy/.env.template .env   # fill in LITELLM_* and the ct-agent audio-channel values
docker run --rm --env-file .env -p 8791:8791 cads-callcenter:latest
```

Then front `:8791` with your tunnel / the `callcenter-<hash>.bunsenbrenner.org` subdomain
(coordinated with core). The GUI already carries the required support/legal footer.

## Live-verify (not just container-up)

- `GET /` returns the GUI (200).
- `POST /answer {"query":"Wie hoch ist die Arbeitslosenquote in Kiel?"}` returns grounded
  `answer` + `meta.table` + `audioUrl` (proves LLM pipeline + TTS channel work end to end).
- Mic → `/stt` returns a German transcript (proves whisper-cli + model work).
- `POST /context {"query":"…in Hannover?"}` returns a fast, IPA-free spoken blurb.

## Env

See `deploy/.env.template` for the full variable set (names + descriptions, no secrets).
