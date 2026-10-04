"""Worker tests. Media is synthesised at test time (macOS `say` + ffmpeg); nothing is committed.

Uses the locally cached faster-whisper `tiny` model; the worker never downloads.
"""

import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from takeoff_transcribe import worker

WORKER_DIR = Path(__file__).resolve().parents[1]
REPO = WORKER_DIR.parents[1]
HAS_TOOLS = bool(shutil.which("say") and shutil.which("ffmpeg"))


def run_cli(*args: str) -> tuple[int, list[dict]]:
    p = subprocess.run([sys.executable, "-m", "takeoff_transcribe", *args],
                       cwd=WORKER_DIR, capture_output=True, text=True, timeout=300)
    return p.returncode, [json.loads(line) for line in p.stdout.splitlines()]


@unittest.skipUnless(HAS_TOOLS, "needs macOS say and ffmpeg")
class TranscribeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="takeoff-transcribe-")
        aiff = os.path.join(cls.tmp, "t.aiff")
        cls.speech = os.path.join(cls.tmp, "speech.wav")
        cls.silence = os.path.join(cls.tmp, "silence.wav")
        subprocess.run(["say", "-o", aiff, "Flutter sends a request through Dio to the server"], check=True)
        ff = ["ffmpeg", "-loglevel", "error", "-y"]
        subprocess.run([*ff, "-i", aiff, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", cls.speech], check=True)
        subprocess.run([*ff, "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "4",
                        "-c:a", "pcm_s16le", cls.silence], check=True)
        cls.paused = os.path.join(cls.tmp, "paused.wav")  # speech, 1.5 s digital silence, speech
        subprocess.run([*ff, "-i", cls.speech, "-f", "lavfi", "-t", "1.5", "-i", "anullsrc=r=16000:cl=mono", "-i", cls.speech,
                        "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1", "-c:a", "pcm_s16le", cls.paused], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_speech_words_are_timed_half_open_and_schema_valid(self):
        out = os.path.join(self.tmp, "speech.json")
        code, events = run_cli("transcribe", "--audio", self.speech, "--model", "tiny", "--language", "en",
                               "--glossary", "Flutter,Dio", "--device", "auto", "--out", out)
        self.assertEqual(code, 0, events[-1])
        self.assertTrue(all(e["type"] == "progress" for e in events[:-1]))
        result = events[-1]
        self.assertEqual(result["type"], "result")
        self.assertTrue(result["speechIntervals"])
        for iv in result["speechIntervals"]:
            self.assertIsInstance(iv["startUs"], int)
            self.assertLess(iv["startUs"], iv["endUs"])

        t = json.loads(Path(out).read_text())
        self.assertEqual(t["sourceHash"], worker.sha256_file(self.speech))
        self.assertEqual(t["configHash"], result["configHash"])
        words = t["words"]
        self.assertTrue(any("flutter" in w["text"].lower() for w in words), [w["text"] for w in words])
        self.assertEqual([w["id"] for w in words], [f"w{i:04d}" for i in range(1, len(words) + 1)])
        prev_end = 0
        for w in words:
            self.assertIsInstance(w["sourceStartUs"], int)
            self.assertIsInstance(w["sourceEndUs"], int)
            self.assertLess(w["sourceStartUs"], w["sourceEndUs"])  # half-open, non-empty
            self.assertGreaterEqual(w["sourceStartUs"], prev_end)  # monotonic, no overlap
            self.assertEqual(w["alignment"], "aligned")
            prev_end = w["sourceEndUs"]
        self.assertFalse(os.path.exists(out + ".partial"))

        if shutil.which("node"):  # producer and consumer validate the same schema (PRD 9.2)
            js = ("import {validate} from '@takeoff/contracts';import {readFileSync} from 'node:fs';"
                  "const r=validate('transcript',JSON.parse(readFileSync(process.argv[1],'utf8')));"
                  "if(!r.ok){console.error(JSON.stringify(r.errors));process.exit(1)}")
            p = subprocess.run(["node", "--input-type=module", "-e", js, out], cwd=REPO, capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr)

    def test_vad_intervals_expose_a_pause(self):
        out = os.path.join(self.tmp, "paused.json")
        code, events = run_cli("transcribe", "--audio", self.paused, "--model", "tiny", "--language", "en", "--out", out)
        self.assertEqual(code, 0, events[-1])
        ivs = events[-1]["speechIntervals"]
        first_end = worker.read_wav(self.speech).__len__() * 1_000_000 // worker.SAMPLE_RATE
        # Some interval boundary falls inside the pause, leaving >=1 s with no reported speech.
        gaps = [b["startUs"] - a["endUs"] for a, b in zip(ivs, ivs[1:])]
        self.assertTrue(any(g >= 1_000_000 for g in gaps), ivs)
        self.assertTrue(any(a["endUs"] <= first_end + 200_000 for a in ivs), ivs)

    def test_vad_speech_whisper_skipped_is_transcribed_again(self):
        # Whisper ends after the first phrase; VAD heard speech at 2.0-3.5 s that no word covers.
        W = lambda text, s, e: SimpleNamespace(word=text, start=s, end=e, probability=0.9)
        S = lambda text, s, e, ws: SimpleNamespace(text=text, start=s, end=e, avg_logprob=-0.2, words=ws)
        calls = []

        class Fake:
            def transcribe(self, pcm, **kw):
                calls.append(len(pcm))
                if len(calls) == 1:
                    return iter([S(" one two", 0.1, 0.9, [W(" one", 0.1, 0.5), W(" two", 0.5, 0.9)])]), SimpleNamespace(language="en")
                return iter([S(" three", 0.1, 0.6, [W(" three", 0.1, 0.6)])]), SimpleNamespace(language="en")

        vad = [{"start": 0, "end": 16000}, {"start": 32000, "end": 56000}]
        with mock.patch.object(worker, "load_model", return_value=Fake()), \
             mock.patch("faster_whisper.vad.get_speech_timestamps", return_value=vad), \
             mock.patch.object(worker, "emit"):
            t, _ = worker.transcribe(self.silence, "tiny", "en", [], "cpu")
        self.assertEqual(calls, [64000, 24000])
        self.assertEqual([(w["text"], w["sourceStartUs"]) for w in t["words"]], [("one", 100000), ("two", 500000), ("three", 2100000)])

    def test_silence_is_no_speech(self):
        out = os.path.join(self.tmp, "silence.json")
        code, events = run_cli("transcribe", "--audio", self.silence, "--model", "tiny", "--out", out)
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["code"], "no_speech")
        self.assertFalse(os.path.exists(out))

    def test_unknown_or_uncached_model_is_model_missing(self):
        for model in ("bogus", "../../etc", "tiny.en-not-a-model"):
            code, events = run_cli("transcribe", "--audio", self.speech, "--model", model,
                                   "--out", os.path.join(self.tmp, "x.json"))
            self.assertEqual(code, 2)
            self.assertEqual(events[-1]["code"], "model_missing")
            self.assertTrue(events[-1]["remedy"])

    def test_untrusted_flags_are_typed_bad_input(self):
        out = os.path.join(self.tmp, "bad.json")
        for extra in (["--language", "EN"], ["--language", "xx"], ["--source-hash", "nothex"],
                      ["--asset-id", "../bad"]):
            code, events = run_cli("transcribe", "--audio", self.speech, "--model", "tiny", "--out", out, *extra)
            self.assertEqual((code, events[-1]["code"]), (2, "bad_input"), extra)
        self.assertFalse(os.path.exists(out))

    def test_cuda_without_device_is_bad_input_not_model_missing(self):
        with mock.patch("ctranslate2.get_cuda_device_count", return_value=0):
            with self.assertRaises(worker.WorkerError) as cm:
                worker.resolve_device("cuda")
        self.assertEqual(cm.exception.code, "bad_input")

    def test_transcribe_makes_no_network_connection(self):
        attempts = []

        def deny(*args, **kwargs):
            attempts.append(args)
            raise OSError("network denied by test")

        with mock.patch.object(socket.socket, "connect", deny), \
             mock.patch.object(socket.socket, "connect_ex", deny), \
             mock.patch.object(socket, "getaddrinfo", deny), \
             mock.patch.object(worker, "emit", lambda e: None):
            transcript, speech = worker.transcribe(self.speech, "tiny", "en", ["Flutter", "Dio"], "cpu")
        self.assertEqual(attempts, [])
        self.assertTrue(transcript["words"])
        self.assertTrue(speech)


class UnitTest(unittest.TestCase):
    def test_download_requires_allow_network(self):
        code, events = run_cli("download-model", "--model", "tiny")
        self.assertEqual(code, 2)
        self.assertEqual(events[-1]["code"], "network_denied")

    def test_probe_reports_capabilities(self):
        code, events = run_cli("probe")
        self.assertEqual(code, 0)
        self.assertIn("cpu", events[0]["devices"])
        self.assertIsInstance(events[0]["models"], list)

    def test_overlapping_words_are_clamped_monotonic(self):
        W = lambda text, s, e: SimpleNamespace(word=text, start=s, end=e, probability=0.5)
        segs = [SimpleNamespace(text="a b", start=0.0, end=1.0, words=[W(" a", 0.0, 0.5), W(" b", 0.4, 0.4)]),
                SimpleNamespace(text="c d", start=1.0, end=2.0, words=None)]
        words, sentences = worker.build_words(segs)
        self.assertEqual([(w["sourceStartUs"], w["sourceEndUs"]) for w in words],
                         [(0, 500000), (500000, 500001), (1000000, 1500000), (1500000, 2000000)])
        self.assertEqual([w["alignment"] for w in words], ["aligned", "aligned", "estimated", "estimated"])
        self.assertEqual([(s["startWordId"], s["endWordId"]) for s in sentences], [("w0001", "w0002"), ("w0003", "w0004")])

    def test_word_ends_clamp_to_media_duration(self):
        W = lambda text, s, e: SimpleNamespace(word=text, start=s, end=e, probability=0.5)
        segs = [SimpleNamespace(text="a b", start=0.0, end=2.5, words=[W(" a", 0.0, 1.0), W(" b", 1.0, 2.5)])]
        words, _ = worker.build_words(segs, 2_000_000)
        self.assertEqual(words[-1]["sourceEndUs"], 2_000_000)

    def test_unexpected_failure_is_one_typed_error_line(self):
        out = io.StringIO()
        with mock.patch.object(worker, "transcribe", side_effect=RuntimeError("/secret/path said hello")), \
             mock.patch.object(sys, "stdout", out):
            code = worker.main(["transcribe", "--audio", "x.wav", "--out", "x.json"])
        event = json.loads(out.getvalue().splitlines()[-1])
        self.assertEqual((code, event["code"]), (2, "internal"))
        self.assertNotIn("secret", json.dumps(event))

    def test_repeated_segments_are_hallucination(self):
        S = lambda text, lp=-0.2: SimpleNamespace(text=text, avg_logprob=lp)
        self.assertTrue(worker.is_hallucination([S("Thank you."), S("thank you."), S("Thank you.")], True))
        self.assertFalse(worker.is_hallucination([S("Thank you."), S("Bye."), S("Thank you.")], True))
        self.assertTrue(worker.is_hallucination([S("hm", -1.5)], False))
        self.assertFalse(worker.is_hallucination([S("hm", -1.5)], True))


if __name__ == "__main__":
    unittest.main()
