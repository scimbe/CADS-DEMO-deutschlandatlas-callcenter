"""Tests for callcenter_speech.stt. Real whisper.cpp transcription of real
Piper-synthesized German speech (round-trip), no mocking.

Skips (rather than failing) when whisper.cpp/the model, or Piper (used only
to generate the test fixture audio), aren't set up yet — run
scripts/setup_whisper_cpp.sh and scripts/setup_piper_voice.sh first.
"""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from callcenter_speech.stt import transcribe, TranscribeError, _default_cli_path, _default_model_path  # noqa: E402
from callcenter_speech.tts import synthesize, _default_piper_bin, _default_voice_model  # noqa: E402

WHISPER_READY = _default_cli_path().exists() and _default_model_path().exists()
PIPER_READY = _default_piper_bin().exists() and _default_voice_model().exists()


@unittest.skipUnless(WHISPER_READY, "whisper.cpp not set up — run scripts/setup_whisper_cpp.sh")
@unittest.skipUnless(PIPER_READY, "Piper not set up (needed to generate test fixture audio) — "
                                   "run scripts/setup_piper_voice.sh")
class TestTranscribe(unittest.TestCase):
    def test_transcribe_recognizes_synthesized_german_speech(self):
        fixture = synthesize(
            "Wie hoch ist die Arbeitslosenquote in Bayern?",
            REPO_ROOT / "tests" / "_tmp_stt_fixture.wav",
        )
        try:
            text = transcribe(fixture)
        finally:
            fixture.unlink(missing_ok=True)

        self.assertIsInstance(text, str)
        self.assertGreater(len(text.strip()), 0)
        lowered = text.lower()
        # Loose containment checks — whisper's exact spelling/casing of
        # compound German nouns can vary (e.g. "Arbeitslosenquote" vs
        # "arbeitslosen Quote"), so this checks for the key content words
        # rather than an exact transcript match.
        self.assertIn("bayern", lowered)
        self.assertIn("arbeitslos", lowered)

    def test_transcribe_raises_on_missing_file(self):
        with self.assertRaises(TranscribeError):
            transcribe(REPO_ROOT / "tests" / "does-not-exist.wav")


class TestTranscribeMissingSetup(unittest.TestCase):
    def test_raises_with_setup_hint_when_model_missing(self):
        # tests/test_tts.py's fixture .wav is a convenient stand-in input;
        # this only exercises the missing-model error path, not real STT.
        dummy_audio = REPO_ROOT / "README.md"  # any existing file; never reached before the check
        with self.assertRaises(TranscribeError) as ctx:
            transcribe(dummy_audio, model_path=REPO_ROOT / "vendor" / "does-not-exist.bin")
        self.assertIn("setup_whisper_cpp.sh", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
