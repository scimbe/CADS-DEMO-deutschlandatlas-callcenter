"""German speech -> text, via whisper.cpp's `whisper-cli` with a multilingual
ggml model.

Same integration pattern as CADS-DEMO-podcast/src/podcast_producer/
transcribe.py: shell out to the real whisper-cli binary, parse its JSON
output. Deliberately does *not* offer a mock-transcript fallback the way
the podcast demo does for its optional stretch feature — this module's
whole job is STT, so if whisper.cpp is unavailable it fails loudly rather
than pretending to have understood the caller.

Setup: scripts/setup_whisper_cpp.sh (clones+builds whisper.cpp, downloads a
multilingual ggml model into vendor/whisper.cpp/models/).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from . import audio_util

REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_CLI_PATH = REPO_ROOT / "vendor" / "whisper.cpp" / "build" / "bin" / "whisper-cli"
DEFAULT_MODEL_PATH = REPO_ROOT / "vendor" / "whisper.cpp" / "models" / "ggml-base.bin"


class TranscribeError(RuntimeError):
    pass


def _default_cli_path() -> Path:
    env = os.environ.get("WHISPER_CLI_PATH")
    if env:
        return Path(env)
    which = shutil.which("whisper-cli")
    return Path(which) if which else DEFAULT_CLI_PATH


def _default_model_path() -> Path:
    env = os.environ.get("WHISPER_MODEL_PATH")
    return Path(env) if env else DEFAULT_MODEL_PATH


def transcribe(
    audio_file: Path | str,
    *,
    cli_path: Path | str | None = None,
    model_path: Path | str | None = None,
    language: str = "de",
) -> str:
    """Transcribe `audio_file` (any ffmpeg-readable format) to text.

    Resamples to 16kHz mono WAV first (whisper.cpp's required input format),
    runs whisper-cli, and returns the concatenated segment text. Raises
    TranscribeError with a setup hint if whisper-cli/the model are missing,
    or if whisper-cli exits non-zero.
    """
    audio_file = Path(audio_file)
    if not audio_file.exists():
        raise TranscribeError(f"transcribe: audio file not found: {audio_file}")

    cli_path = Path(cli_path) if cli_path else _default_cli_path()
    model_path = Path(model_path) if model_path else _default_model_path()

    missing = []
    if not cli_path.exists():
        missing.append(f"whisper-cli binary not found at {cli_path} (run scripts/setup_whisper_cpp.sh, "
                        f"or set WHISPER_CLI_PATH)")
    if not model_path.exists():
        missing.append(f"whisper.cpp ggml model not found at {model_path} (run scripts/setup_whisper_cpp.sh, "
                        f"or set WHISPER_MODEL_PATH)")
    if missing:
        raise TranscribeError("Real transcription is unavailable:\n  - " + "\n  - ".join(missing))

    with tempfile.TemporaryDirectory(prefix="callcenter-stt-") as tmp:
        tmp_dir = Path(tmp)
        wav_16k = audio_util.to_whisper_wav(audio_file, tmp_dir / "input-16k.wav")

        out_prefix = tmp_dir / "transcript"
        args = [
            str(cli_path),
            "-m", str(model_path),
            "-f", str(wav_16k),
            "-l", language,
            "-oj",
            "-of", str(out_prefix),
            "--no-prints",
        ]
        print(f"+ {' '.join(args)}", file=sys.stderr)
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode != 0:
            raise TranscribeError(f"whisper-cli exited {result.returncode}\n--- stderr ---\n{result.stderr}")
        print(result.stderr, file=sys.stderr)

        json_path = out_prefix.with_suffix(".json")
        if not json_path.exists():
            raise TranscribeError(f"whisper-cli produced no output JSON at {json_path}")
        data = json.loads(json_path.read_text())

    segments = [entry.get("text", "").strip() for entry in data.get("transcription", [])]
    return " ".join(s for s in segments if s).strip()


def _cli() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Transcribe German speech to text with whisper.cpp.")
    parser.add_argument("audio_file", type=Path)
    parser.add_argument("--whisper-cli", default=None)
    parser.add_argument("--model", default=None)
    parser.add_argument("--language", default="de")
    args = parser.parse_args()

    text = transcribe(args.audio_file, cli_path=args.whisper_cli, model_path=args.model, language=args.language)
    print(text)


if __name__ == "__main__":
    _cli()
