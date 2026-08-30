"""Speech I/O for the Deutschlandatlas call-center demo.

Two small, independently testable pieces, each wrapping a real local/offline
engine (no cloud STT/TTS calls) via subprocess — the same pattern already
proven in this portfolio (CADS-DEMO-explainer for Piper, CADS-DEMO-podcast
for both whisper.cpp and Piper):

- ``callcenter_speech.stt.transcribe(audio_file) -> str``
  German speech -> text, via whisper.cpp's ``whisper-cli`` with a
  multilingual ggml model (never an English-only ``.en`` model).

- ``callcenter_speech.tts.synthesize(text, out_wav=None) -> Path``
  Text -> German speech, via Piper with the ``de_DE-thorsten-medium`` voice.

This module is deliberately scoped to speech I/O only. It does not talk to
n8n, does not know about the Deutschlandatlas catalog, and does not decide
what to say — it plugs into a plain-text interface on both sides, built by
a separate track.
"""

from .stt import transcribe, TranscribeError
from .tts import synthesize, SynthesizeError

__all__ = ["transcribe", "TranscribeError", "synthesize", "SynthesizeError"]
