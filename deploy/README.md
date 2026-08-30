# Deploying the Deutschlandatlas Sprach-Callcenter

A **self-contained** container image for durable hosting of the voice call-center GUI.

## What runs

`gui/server.mjs` (pure Node, no npm deps) serving the caller GUI on `PORT` (default 8791),
bound to `CC_HOST` (default `0.0.0.0` in the image). It shells out to:

- **whisper.cpp** `whisper-cli` (built in the image, pinned tag `b4938`, multilingual `ggml-base`) for STT
- **local Piper** (`/opt/piper/piper`) with the bundled **de_DE-thorsten-medium** voice for the Thorsten TTS
- **`node scripts/n8n_workflow_runtime.mjs`** for the live Deutschlandatlas ArcGIS/catalog pipeline

**No ct-agent channel, no grant, no cross-host audio dependency.** The only external runtime
dependency is the litellm-proxy (LLM), via `LITELLM_*`.

**Footprint is static** — STT temp files are deleted per request; TTS WAVs go to a capped temp dir
(pruned to the last 100); the speculation cache is in-memory (capped at 80). Nothing grows unboundedly.
Image is dominated by `ggml-base` (~141 MB) + the Thorsten voice (~60 MB).

## Build

```bash
# from the repo root (build context must include gui/, scripts/, catalog.json, deploy/)
docker build -f deploy/Dockerfile -t cads-callcenter:latest .
# buildx sets TARGETARCH automatically; for a cross-build pick the platform explicitly:
#   docker buildx build --platform linux/amd64 -f deploy/Dockerfile -t cads-callcenter:latest --load .
```

The build fetches, from the network: whisper.cpp (GitHub, tag b4938) + its base model
(huggingface.co), the Piper standalone release (GitHub), and the Thorsten voice (huggingface.co).

## Run

```bash
cp deploy/.env.template .env   # fill in LITELLM_* only
docker run --rm --env-file .env -p 8791:8791 cads-callcenter:latest
```

Then front `:8791` with your tunnel / the `callcenter-<hash>.bunsenbrenner.org` subdomain
(coordinated with core). The GUI already carries the required support/legal footer.

## Live-verify (not just container-up)

- `GET /` returns the GUI (200).
- `POST /answer {"query":"Wie hoch ist die Arbeitslosenquote in Kiel?"}` returns grounded
  `answer` + `meta.table` + an `audioUrl` of the form `/tts/<id>.wav` (proves LLM pipeline + local Piper).
- `GET` that `/tts/<id>.wav` returns `audio/wav` (proves TTS serving).
- Mic → `/stt` returns a German transcript (proves whisper-cli + model).
- `POST /context {"query":"…in Hannover?"}` returns a fast, IPA-free spoken blurb (`/tts/<id>.wav`).

## Env

See `deploy/.env.template`. In this self-contained build you only need `LITELLM_*`.
