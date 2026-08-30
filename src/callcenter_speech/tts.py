"""Text -> German speech, via Piper (local, offline neural TTS), stock voice
``de_DE-thorsten-medium``.

Same integration pattern as CADS-DEMO-explainer/src/tts/generate.mjs and
CADS-DEMO-podcast/src/podcast_producer/announce.py: shell out to the real
`piper` binary with the narration text on stdin, write a WAV file. No cloud
TTS call, no voice cloning — a real, generic, CC0-licensed voice model.

Setup: scripts/setup_piper_voice.sh (creates .venv, installs piper-tts,
downloads the German voice into voices/).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_PIPER_BIN = REPO_ROOT / ".venv" / "bin" / "piper"
DEFAULT_VOICE_MODEL = REPO_ROOT / "voices" / "de_DE-thorsten-medium.onnx"


class SynthesizeError(RuntimeError):
    pass


def _default_piper_bin() -> Path:
    env = os.environ.get("PIPER_BIN")
    if env:
        return Path(env)
    which = shutil.which("piper")
    return Path(which) if which else DEFAULT_PIPER_BIN


def _default_voice_model() -> Path:
    env = os.environ.get("PIPER_VOICE_MODEL")
    return Path(env) if env else DEFAULT_VOICE_MODEL


def synthesize(
    text: str,
    out_wav: Path | str | None = None,
    *,
    piper_bin: Path | str | None = None,
    model: Path | str | None = None,
) -> Path:
    """Synthesize `text` (German) to a WAV file, return its path.

    Raises SynthesizeError with a setup hint if piper/the voice model are
    missing, or if piper exits non-zero, or if it somehow writes no audio.
    """
    if not text or not text.strip():
        raise SynthesizeError("synthesize: empty text")

    piper_bin = Path(piper_bin) if piper_bin else _default_piper_bin()
    model = Path(model) if model else _default_voice_model()

    missing = []
    if not piper_bin.exists():
        missing.append(f"piper binary not found at {piper_bin} (run scripts/setup_piper_voice.sh, "
                        f"or set PIPER_BIN)")
    if not model.exists():
        missing.append(f"piper voice model not found at {model} (run scripts/setup_piper_voice.sh, "
                        f"or set PIPER_VOICE_MODEL)")
    if missing:
        raise SynthesizeError("Piper TTS unavailable:\n  - " + "\n  - ".join(missing))

    if out_wav is None:
        fd, tmp_path = tempfile.mkstemp(suffix=".wav", prefix="callcenter-tts-")
        os.close(fd)
        out_wav = Path(tmp_path)
    else:
        out_wav = Path(out_wav)
        out_wav.parent.mkdir(parents=True, exist_ok=True)

    args = [str(piper_bin), "--model", str(model), "--output_file", str(out_wav)]
    print(f"+ echo {text!r} | {' '.join(args)}", file=sys.stderr)
    result = subprocess.run(args, input=text, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise SynthesizeError(f"piper failed (exit {result.returncode}): {result.stderr[-2000:]}")
    if not out_wav.exists() or out_wav.stat().st_size == 0:
        raise SynthesizeError(f"piper produced no audio: {out_wav}")
    return out_wav


def _cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Synthesize German text to speech with Piper.")
    parser.add_argument("text", help="text to speak")
    parser.add_argument("out_wav", nargs="?", default=None, help="output WAV path (default: a temp file)")
    parser.add_argument("--piper-bin", default=None)
    parser.add_argument("--model", default=None)
    args = parser.parse_args()

    out = synthesize(args.text, args.out_wav, piper_bin=args.piper_bin, model=args.model)
    print(str(out))


if __name__ == "__main__":
    _cli()
