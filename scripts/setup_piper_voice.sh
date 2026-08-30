#!/usr/bin/env bash
# Sets up local, offline TTS: a Python venv with piper-tts + a German neural
# voice (downloaded from the public rhasspy/piper-voices model repo on
# Hugging Face). No account, no API key, no cloud calls at synthesis time.
#
# Same pattern as CADS-DEMO-explainer/scripts/setup-voice.sh and
# CADS-DEMO-podcast/scripts/setup_piper_voice.sh, adapted for this repo's
# own voices/ dir and a German voice (this is a German-language call-center
# demo, so the English lessac voice used elsewhere in the portfolio doesn't
# apply here).
set -euo pipefail
cd "$(dirname "$0")/.."

VOICE="${PIPER_VOICE:-de_DE-thorsten-medium}"
LANG_DIR="${VOICE%%-*}"                      # de_DE
NAME_DIR="$(echo "$VOICE" | cut -d- -f2)"    # thorsten
QUALITY="$(echo "$VOICE" | cut -d- -f3)"     # medium
LANG_SHORT="${LANG_DIR%%_*}"                 # de

BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/${LANG_SHORT}/${LANG_DIR}/${NAME_DIR}/${QUALITY}"

echo "==> Python venv (.venv)"
python3 -m venv .venv
./.venv/bin/pip install --quiet --disable-pip-version-check -r requirements.txt

echo "==> Downloading voice: ${VOICE}"
mkdir -p voices
if ! curl -sL --fail -o "voices/${VOICE}.onnx" "${BASE}/${VOICE}.onnx"; then
  echo "FATAL: could not download ${VOICE}.onnx from huggingface.co." >&2
  echo "This is a real network/availability limitation of this environment," >&2
  echo "not a bug in the module. See README.md for the voice's model card." >&2
  rm -f "voices/${VOICE}.onnx"
  exit 1
fi
curl -sL --fail -o "voices/${VOICE}.onnx.json" "${BASE}/${VOICE}.onnx.json"

echo "==> Done. Voice model: voices/${VOICE}.onnx"
echo "    Set PIPER_VOICE_MODEL=voices/${VOICE}.onnx in .env if it differs from the default."
