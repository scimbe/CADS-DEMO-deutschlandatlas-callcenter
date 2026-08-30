# Deutschlandatlas Sprach-Callcenter — self-contained container for durable hosting.
#
# The GUI backend (gui/server.mjs) is pure Node (no npm deps). It shells out to:
#   - whisper.cpp `whisper-cli` for server-side STT (built here, pinned tag b4938, multilingual ggml-base)
#   - local **Piper** (`piper`) with the bundled de_DE-thorsten-medium voice for the Thorsten TTS  <-- self-contained, NO channel/grant
#   - `node scripts/n8n_workflow_runtime.mjs` for the live Deutschlandatlas ArcGIS/catalog pipeline (Node builtins)
#
# Footprint is STATIC: STT temp files are deleted per request; TTS WAVs go to a capped temp dir
# (pruned to the last 100); the speculation cache is in-memory (capped). Nothing accumulates unboundedly.
#
# Fully self-contained — no ct-agent channel, no grant, no cross-host dependency. Only external
# runtime dep is the litellm-proxy (LLM) for the pipeline, via LITELLM_* env.

ARG TARGETARCH

# ---- stage 1: build whisper.cpp + fetch whisper model, piper binary, and the Thorsten voice ----
FROM node:22-bookworm AS build
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*

# whisper.cpp (Linux build) + multilingual base model
WORKDIR /build
RUN git clone --branch b4938 --depth 1 https://github.com/ggml-org/whisper.cpp.git
WORKDIR /build/whisper.cpp
RUN cmake -B build -S . -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build -j "$(nproc)" --config Release --target whisper-cli \
 && bash models/download-ggml-model.sh base

# Piper standalone release (bundles espeak-ng data — avoids the pip espeak-ng data gap)
WORKDIR /opt
RUN case "${TARGETARCH}" in \
      amd64) PARCH=x86_64 ;; arm64) PARCH=aarch64 ;; *) PARCH=x86_64 ;; esac; \
    curl -fsSL -o piper.tar.gz \
      "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_${PARCH}.tar.gz" \
 && tar xzf piper.tar.gz && rm piper.tar.gz
# de_DE-thorsten-medium voice (onnx + config)
RUN mkdir -p /opt/voices && cd /opt/voices \
 && curl -fsSL -o de_DE-thorsten-medium.onnx \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx" \
 && curl -fsSL -o de_DE-thorsten-medium.onnx.json \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium/de_DE-thorsten-medium.onnx.json"

# ---- stage 2: runtime ----
FROM node:22-bookworm-slim AS runtime
# ffmpeg is required by gui/server.mjs's transcribe() — it resamples the uploaded audio to
# 16kHz mono before handing it to whisper-cli. Missing this made /stt silently return an
# empty transcript (ffmpeg exec failed, non-zero exit swallowed by the try/catch) — caught
# by actually running the built Linux image and testing a real STT round-trip, not just
# confirming whisper-cli + the model were present.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# app code — GUI + the live pipeline runtime + the catalog
COPY gui ./gui
COPY scripts ./scripts
COPY catalog.json ./catalog.json

# whisper-cli + model. Copying the whole build/bin/ dir, not just the whisper-cli binary:
# it's dynamically linked against libwhisper.so/libggml*.so (built as shared libs by this
# cmake build), which live alongside it — copying only the executable left it unable to
# even start ("error while loading shared libraries: libwhisper.so.1: cannot open shared
# object file"), caught by actually invoking whisper-cli in the built image, not just
# confirming the file was present.
COPY --from=build /build/whisper.cpp/build/bin  /opt/whisper-cli-bin
COPY --from=build /build/whisper.cpp/models/ggml-base.bin  /app/models/ggml-base.bin
# piper (standalone, with its bundled libs/espeak-ng-data) + the Thorsten voice
COPY --from=build /opt/piper   /opt/piper
COPY --from=build /opt/voices  /app/voices
RUN chmod +x /opt/whisper-cli-bin/whisper-cli /opt/piper/piper

# non-secret defaults; secrets come from --env-file at run time (see deploy/.env.template)
ENV CC_HOST=0.0.0.0 \
    PORT=8791 \
    CC_TTS=1 \
    CC_WHISPER_MODEL=/app/models/ggml-base.bin \
    CC_WHISPER_CLI=whisper-cli \
    CC_PIPER_BIN=/opt/piper/piper \
    CC_PIPER_MODEL=/app/voices/de_DE-thorsten-medium.onnx \
    PATH=/opt/whisper-cli-bin:${PATH} \
    LD_LIBRARY_PATH=/opt/whisper-cli-bin:/opt/piper \
    NODE_ENV=production

EXPOSE 8791
USER node
CMD ["node", "gui/server.mjs"]
