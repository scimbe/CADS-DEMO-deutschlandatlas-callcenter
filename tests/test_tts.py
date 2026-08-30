"""Tests for callcenter_speech.tts. Real Piper synthesis, no mocking.

Skips (rather than failing) when Piper/the voice model aren't set up yet —
run scripts/setup_piper_voice.sh first. This mirrors the "never silently
substitute a mock" rule from CADS-DEMO-podcast: a skip says "not set up",
never a fabricated pass.
"""

import sys
import unittest
import wave
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from callcenter_speech.tts import synthesize, SynthesizeError, _default_piper_bin, _default_voice_model  # noqa: E402

PIPER_READY = _default_piper_bin().exists() and _default_voice_model().exists()


@unittest.skipUnless(PIPER_READY, "Piper not set up — run scripts/setup_piper_voice.sh")
class TestSynthesize(unittest.TestCase):
    def test_synthesize_produces_real_wav_audio(self):
        out = synthesize(
            "Willkommen beim Deutschlandatlas Callcenter.",
            REPO_ROOT / "tests" / "_tmp_synth.wav",
        )
        self.assertTrue(out.exists())
        self.assertGreater(out.stat().st_size, 1000, "output WAV suspiciously small for real speech")

        with wave.open(str(out), "rb") as w:
            self.assertGreater(w.getnframes(), 0)
            duration = w.getnframes() / w.getframerate()
        self.assertGreater(duration, 0.5, "a full sentence should produce more than half a second of audio")
        out.unlink()

    def test_synthesize_to_default_temp_path(self):
        out = synthesize("Ein kurzer Test.")
        try:
            self.assertTrue(out.exists())
            self.assertGreater(out.stat().st_size, 0)
        finally:
            out.unlink(missing_ok=True)

    def test_synthesize_rejects_empty_text(self):
        with self.assertRaises(SynthesizeError):
            synthesize("")


class TestSynthesizeMissingSetup(unittest.TestCase):
    def test_raises_with_setup_hint_when_model_missing(self):
        with self.assertRaises(SynthesizeError) as ctx:
            synthesize("hallo", model=REPO_ROOT / "voices" / "does-not-exist.onnx")
        self.assertIn("setup_piper_voice.sh", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
