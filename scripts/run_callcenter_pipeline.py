#!/usr/bin/env python3
"""End-to-end integration: STT -> n8n workflow logic -> TTS.

This is the piece that actually wires together the two tracks that were
built in parallel:

  - ``src/callcenter_speech/`` (STT via whisper.cpp, TTS via Piper) --
    plain-text in, plain-text out, no knowledge of the catalog or n8n.
  - ``n8n/callcenter-workflow.json`` -- plain-text in (a caller question),
    plain-text out (a grounded answer), no knowledge of audio.

Both sides plug into a plain-text contract, so this script is the glue: it
drives real Piper synthesis and real whisper.cpp transcription on one end,
and the real jsCode extracted from the n8n workflow JSON (via
``scripts/n8n_workflow_runtime.mjs``, run as a subprocess) making real live
calls to the ArcGIS Feature Services and the real litellm-proxy on the
other end. No n8n instance is started -- see the workflow runtime script's
own docstring for exactly what that does and does not prove.

Two ways to provide the caller's question:

  --text "..."        Skip caller-side STT; use this text directly as the
                       query (still runs the full workflow + TTS + a
                       round-trip STT check on the spoken answer).

  --synthesize-caller  Actually speak the given --text with Piper first,
                       then transcribe that audio back with whisper.cpp,
                       and feed *that* (STT) transcript into the workflow --
                       this exercises the real caller-audio leg too, not
                       just the agent-answer leg. Useful because this repo
                       doesn't have a live telephony/microphone input yet
                       (see README's "Not yet done"); a real caller
                       utterance file could be dropped in with --audio
                       instead once one exists.

  --audio path.wav     Use a real pre-recorded audio file as the caller
                       question (real STT, not synthesized-then-transcribed).

In all cases the workflow's final answer is both printed as text and
spoken with Piper, and (unless --no-verify-answer) the spoken answer is
transcribed back with whisper.cpp so the grounding claim ("the number in
the spoken answer really came from the live query") can be checked
mechanically, not just by reading the text.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from callcenter_speech import synthesize, transcribe, SynthesizeError, TranscribeError  # noqa: E402


def run_workflow(query: str, *, trace: bool = False) -> dict:
    """Invoke the n8n workflow's real logic (real LLM + real ArcGIS calls)."""
    env = os.environ.copy()
    missing = [k for k in ("LITELLM_BASE_URL", "LITELLM_API_KEY") if not env.get(k)]
    if missing:
        raise RuntimeError(
            f"missing required env var(s) for the workflow's real LLM steps: {', '.join(missing)}"
        )
    cmd = ["node", str(REPO_ROOT / "scripts" / "n8n_workflow_runtime.mjs"), "--query", query]
    print(f"+ {' '.join(cmd[:-1])!r} {query!r}", file=sys.stderr)
    result = subprocess.run(cmd, cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if trace:
        print(result.stderr, file=sys.stderr)
    if result.returncode != 0:
        raise RuntimeError(f"workflow runtime failed (exit {result.returncode}):\n{result.stderr}")
    last_line = [l for l in result.stdout.splitlines() if l.strip()][-1]
    return json.loads(last_line)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--text", help="caller question text")
    parser.add_argument("--audio", type=Path, help="real pre-recorded caller audio file (used instead of --text)")
    parser.add_argument("--synthesize-caller", action="store_true",
                         help="speak --text with Piper, then transcribe it back with whisper.cpp, "
                              "and use THAT (STT) transcript as the actual query -- exercises the caller-audio leg")
    parser.add_argument("--no-verify-answer", action="store_true",
                         help="skip the round-trip STT check on the spoken final answer")
    parser.add_argument("--out-dir", type=Path, default=Path("/tmp"), help="directory for generated WAV files")
    parser.add_argument("--trace", action="store_true", help="print the workflow runtime's step-by-step trace")
    args = parser.parse_args()

    if not args.text and not args.audio:
        parser.error("provide --text or --audio")

    args.out_dir.mkdir(parents=True, exist_ok=True)

    # --- 1. Determine the actual query text the workflow will see ---
    if args.audio:
        print(f"=== STT: transcribing real caller audio {args.audio} ===")
        query = transcribe(args.audio)
        print(f"STT transcript: {query!r}")
    elif args.synthesize_caller:
        caller_wav = args.out_dir / "callcenter-caller-question.wav"
        print(f"=== TTS: synthesizing caller question -> {caller_wav} ===")
        synthesize(args.text, caller_wav)
        print(f"=== STT: transcribing caller audio back -> text ===")
        query = transcribe(caller_wav)
        print(f"Original text : {args.text!r}")
        print(f"STT transcript: {query!r}")
    else:
        query = args.text
        print(f"=== Using caller question text directly (no STT): {query!r} ===")

    # --- 2. Run the real workflow logic (real LLM + real ArcGIS live data) ---
    print(f"\n=== Workflow: {query!r} -> catalog match -> live query -> phrasing ===")
    result = run_workflow(query, trace=args.trace)
    print("Workflow result (meta):")
    print(json.dumps(result.get("meta", {}), indent=2, ensure_ascii=False))
    answer_text = result["text"]
    print(f"\nAnswer text: {answer_text!r}")

    # --- 3. Speak the answer ---
    answer_wav = args.out_dir / "callcenter-answer.wav"
    print(f"\n=== TTS: synthesizing spoken answer -> {answer_wav} ===")
    synthesize(answer_text, answer_wav)
    size = answer_wav.stat().st_size
    print(f"wrote {answer_wav} ({size} bytes)")

    # --- 4. Round-trip verify: transcribe the spoken answer back ---
    if not args.no_verify_answer:
        print("\n=== STT: transcribing spoken answer back (grounding check) ===")
        answer_stt = transcribe(answer_wav)
        print(f"Answer STT transcript: {answer_stt!r}")
        result["_answer_stt_roundtrip"] = answer_stt

    print("\n=== FINAL RESULT ===")
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (SynthesizeError, TranscribeError, RuntimeError) as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
