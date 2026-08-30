# Deutschlandatlas Sprach-Callcenter — container image for durable hosting.
#
# The GUI backend (gui/server.mjs) is pure Node (no npm deps). It shells out to:
#   - whisper.cpp `whisper-cli` for server-side STT (built here, pinned tag b4938, multilingual ggml-base)
#   - `ct-agent channel` (audio_generation) for Thorsten TTS  -> needs a Linux ct-agent binary + a channel grant
#   - `node scripts/n8n_workflow_runtime.mjs` for the live Deutschlandatlas ArcGIS/catalog pipeline (Node builtins)
#
# Footprint is STATIC: STT temp files are deleted per request, TTS audio is streamed through (never stored),
# the speculation cache is in-memory (capped). Nothing accumulates per call.
#
# TWO deps the build context must supply (see deploy/README.md):
#   1. deploy/vendor/ct-agent   — a ct-agent binary for the TARGET os/arch (the dev binary is macOS/arm64, unusable here)
#   2. the audio_generation channel grant/keys at runtime (env, coordinated with Maintainer labor) — NOT baked in

# ---- stage 1: build whisper.cpp (Linux) + fetch the multilingual base model ----
FROM node:22-bookworm AS whisper-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN git clone --branch b4938 --depth 1 https://github.com/ggml-org/whisper.cpp.git
WORKDIR /build/whisper.cpp
RUN cmake -B build -S . -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j "$(nproc)" --config Release --target whisper-cli
# multilingual base model (NOT an .en model — the callcenter needs multilingual for German)
RUN bash models/download-ggml-model.sh base

# ---- stage 2: runtime ----
FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# app code — GUI + the live pipeline runtime + the indicator catalog
COPY gui ./gui
COPY scripts ./scripts
COPY catalog.json ./catalog.json

# whisper-cli + model from the build stage
COPY --from=whisper-build /build/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /build/whisper.cpp/models/ggml-base.bin  /app/models/ggml-base.bin

# ct-agent binary for the TARGET os/arch — supplied by the build context (see deploy/README.md).
# Placed at deploy/vendor/ct-agent; make it executable.
COPY deploy/vendor/ct-agent /usr/local/bin/ct-agent
RUN chmod +x /usr/local/bin/ct-agent /usr/local/bin/whisper-cli

# non-secret defaults; everything secret comes from --env-file at run time (see deploy/.env.template)
ENV CC_HOST=0.0.0.0 \
    PORT=8791 \
    CC_TTS=1 \
    CC_WHISPER_MODEL=/app/models/ggml-base.bin \
    CC_WHISPER_CLI=whisper-cli \
    CT_AGENT_BIN=/usr/local/bin/ct-agent \
    NODE_ENV=production

EXPOSE 8791
# run as the stock non-root node user
USER node
CMD ["node", "gui/server.mjs"]
