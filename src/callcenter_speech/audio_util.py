"""Thin, explicit wrapper around the ffmpeg/ffprobe binaries.

Every audio-format operation in this module goes through here so there is
exactly one place that shells out to ffmpeg, and every call is logged
(command + return code) so failures are debuggable from stderr alone.
Same pattern as CADS-DEMO-podcast/src/podcast_producer/ffmpeg_util.py.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

WHISPER_SAMPLE_RATE = 16000  # whisper.cpp requires 16kHz mono PCM WAV input


class FfmpegError(RuntimeError):
    """Raised when an ffmpeg/ffprobe subprocess exits non-zero."""


def _find(binary: str) -> str:
    path = shutil.which(binary)
    if path is None:
        raise FfmpegError(
            f"required binary '{binary}' not found on PATH. Install ffmpeg "
            f"(provides both ffmpeg and ffprobe)."
        )
    return path


def run(args: list[str]) -> subprocess.CompletedProcess:
    """Run a subprocess, echo the command to stderr, raise on failure."""
    print(f"+ {' '.join(args)}", file=sys.stderr)
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise FfmpegError(
            f"command failed (exit {result.returncode}): {' '.join(args)}\n"
            f"--- stderr ---\n{result.stderr}"
        )
    return result


def ffmpeg(args: list[str]) -> subprocess.CompletedProcess:
    return run([_find("ffmpeg"), "-y", "-hide_banner", "-loglevel", "error", *args])


def probe_duration_seconds(path: Path) -> float:
    result = run([
        _find("ffprobe"), "-v", "error",
        "-show_entries", "format=duration", "-of", "csv=p=0", str(path),
    ])
    return float(result.stdout.strip())


def to_whisper_wav(src: Path, dst: Path) -> Path:
    """Convert any ffmpeg-readable audio to 16kHz mono PCM16 WAV.

    Telephony audio (e.g. 8kHz mu-law from a call leg) and Piper's own
    22.05kHz output both need this before whisper-cli will accept them.
    """
    ffmpeg(["-i", str(src), "-ar", str(WHISPER_SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", str(dst)])
    return dst
