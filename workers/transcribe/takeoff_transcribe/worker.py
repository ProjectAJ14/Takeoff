"""Takeoff transcription worker: VAD + faster-whisper ASR + word timing (PRD F02).

Offline by default: HF_HUB_OFFLINE=1 is set before huggingface_hub is imported and
models load with local_files_only=True. Only `download-model --allow-network` may
reach the network. Every stdout line is one JSON object.
"""

import argparse
import copy
import hashlib
import json
import os
import platform
import re
import sys
from datetime import UTC, datetime

SAMPLE_RATE = 16000
BACKEND = "faster_whisper"
VAD_VERSION = "silero_vad_v6_s300_p30"
# Reported speech intervals must expose pauses the director cuts (>=700 ms). faster-whisper's
# defaults (2 s min silence, 400 ms pad) merge them into one interval, so every pause looked like speech.
MISSED_SPEECH_US = 500_000  # VAD speech at least this long with no word is re-transcribed
VAD_REPORT = {"min_silence_duration_ms": 300, "speech_pad_ms": 30}
ALIGNMENT_VERSION = "whisper_word_timestamps"
# ponytail: fixed heuristics; tune against the F02 fixture set when it exists.
REPEAT_LIMIT = 3  # this many identical consecutive segments = hallucination loop
LOW_LOGPROB = -1.0  # mean segment avg_logprob below this, with no VAD speech, = noise
DECODE = {"beam_size": 5, "condition_on_previous_text": False}  # off limits repetition loops
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")  # contracts common.schema id
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")


class WorkerError(Exception):
    def __init__(self, code: str, message: str, remedy: str):
        super().__init__(message)
        self.code, self.message, self.remedy = code, message, remedy


def emit(event: dict) -> None:
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def sec_to_us(s: float) -> int:
    return max(0, round(s * 1_000_000))


def resolve_device(device: str) -> tuple[str, str]:
    """auto -> cuda/float16 only when CTranslate2 sees a CUDA device, else cpu/int8."""
    import ctranslate2

    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    if device == "cuda":
        if ctranslate2.get_cuda_device_count() == 0:
            raise WorkerError("bad_input", "no CUDA device is available", "Use --device auto or cpu.")
        return "cuda", "float16"
    if device == "cpu":
        return "cpu", "int8"
    raise WorkerError("bad_input", f"unknown device {device!r}", "Use --device auto, cpu or cuda.")


def read_wav(path: str):
    """The analysis WAV contract: 16 kHz PCM s16le (channels are downmixed).

    Read with stdlib `wave` rather than PyAV: no second FFmpeg build in the worker.
    """
    import wave

    import numpy as np

    try:
        with wave.open(path, "rb") as w:
            if w.getframerate() != SAMPLE_RATE or w.getsampwidth() != 2:
                raise WorkerError("bad_input", "analysis WAV must be 16 kHz PCM s16le",
                                  "Re-extract with: ffmpeg -i <src> -ar 16000 -c:a pcm_s16le <out.wav>")
            data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").reshape(-1, w.getnchannels())
    except (wave.Error, EOFError, OSError) as e:
        raise WorkerError("bad_input", "audio is not a readable WAV", "Re-extract the analysis WAV.") from e
    return data.mean(axis=1).astype(np.float32) / 32768.0


def model_missing(model: str) -> WorkerError:
    from faster_whisper import available_models

    fix = f"download-model --model {model} --allow-network from starter-pack setup, " if model in available_models() else ""
    return WorkerError(
        "model_missing",
        f"model {model!r} is not installed locally",
        f"Run {fix}pick an installed model (see probe), or enter a manual transcript.",
    )


def load_model(model: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel, available_models

    # Names only: a path or repo id here would let input choose what code/weights load.
    if model not in available_models():
        raise model_missing(model)
    try:
        return WhisperModel(model, device=device, compute_type=compute_type, local_files_only=True)
    except Exception as e:  # LocalEntryNotFoundError when absent; RuntimeError when files are incomplete
        raise model_missing(model) from e


def is_hallucination(segments: list, has_vad_speech: bool) -> bool:
    texts = [s.text.strip().lower() for s in segments]
    run = 1
    for a, b in zip(texts, texts[1:]):
        run = run + 1 if a and a == b else 1
        if run >= REPEAT_LIMIT:
            return True
    if segments and not has_vad_speech:
        mean = sum(s.avg_logprob for s in segments) / len(segments)
        if mean < LOW_LOGPROB:
            return True
    return False


def shift_segment(seg, offset_s: float):
    """A copy of a segment (and its words) moved by `offset_s` seconds: for a slice transcribed on its own."""
    def moved(x):
        x = copy.copy(x)
        x.start, x.end = x.start + offset_s, x.end + offset_s
        return x
    out = moved(seg)
    out.words = [moved(w) for w in seg.words] if seg.words else seg.words
    return out


def build_words(segments: list, end_us: int | None = None) -> tuple[list[dict], list[dict]]:
    """Words get stable ids w0001.. in source order; one sentence per ASR segment.

    Intervals are half-open [start, end) in integer microseconds, non-overlapping and
    monotonic: a word starting before the previous word ended is pushed to that end.
    Ends are clamped to the media duration `end_us` when given.
    """
    words: list[dict] = []
    sentences: list[dict] = []
    prev_end = 0
    for seg in segments:
        if seg.words:
            items = [(w.word, w.start, w.end, w.probability, "aligned") for w in seg.words]
        else:  # no word timing: spread the segment evenly and say so
            toks = seg.text.split()
            step = (seg.end - seg.start) / max(1, len(toks))
            items = [(t, seg.start + i * step, seg.start + (i + 1) * step, None, "estimated") for i, t in enumerate(toks)]
        first = len(words)
        for text, start, end, score, alignment in items:
            text = text.strip()[:100]
            if not text:
                continue
            s = max(sec_to_us(start), prev_end)
            e = sec_to_us(end) if end_us is None else min(sec_to_us(end), end_us)
            e = max(e, s + 1)
            words.append({
                "id": f"w{len(words) + 1:04d}",
                "text": text,
                "correctedText": None,
                "sourceStartUs": s,
                "sourceEndUs": e,
                "score": score,
                "alignment": alignment,
                "speaker": None,
            })
            prev_end = e
        if len(words) > first:
            span = words[first:]
            sentences.append({
                "id": f"s{len(sentences) + 1:04d}",
                "startWordId": span[0]["id"],
                "endWordId": span[-1]["id"],
                "rawText": " ".join(w["text"] for w in span)[:2000],
                "correctedText": None,
            })
    return words, sentences


def transcribe(audio: str, model: str, language: str, glossary: list[str], device: str,
               asset_id: str | None = None, source_hash: str | None = None) -> tuple[dict, list[dict]]:
    """Returns (transcript, speechIntervals). Raises WorkerError with a typed code."""
    os.environ["HF_HUB_OFFLINE"] = "1"
    if source_hash is not None and not SHA256_RE.match(source_hash):
        raise WorkerError("bad_input", "--source-hash must be 64 lowercase hex characters", "Pass the asset's sha256.")
    if asset_id is not None and not ID_RE.match(asset_id):
        raise WorkerError("bad_input", "--asset-id is not a valid contract id", "Pass the asset's id from the project.")
    if not os.path.isfile(audio):
        raise WorkerError("bad_input", "audio file not found", "Pass an existing analysis WAV with --audio.")
    pcm = read_wav(audio)
    import faster_whisper
    from faster_whisper.tokenizer import _LANGUAGE_CODES
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    if language != "auto" and language not in _LANGUAGE_CODES:
        raise WorkerError("bad_input", f"unsupported language {language[:16]!r}",
                          "Use auto or a Whisper language code such as en (English is the validated P0 language).")

    device, compute_type = resolve_device(device)
    glossary = [g.strip() for g in glossary if g.strip()]
    source_hash = source_hash or sha256_file(audio)
    config = {
        "backend": BACKEND, "version": faster_whisper.__version__, "model": model,
        "computeType": compute_type, "language": language, "glossary": glossary,
        "vad": VAD_VERSION, "wordTimestamps": True, "decode": DECODE,
    }
    config_hash = sha256_text(json.dumps(config, sort_keys=True, separators=(",", ":")))

    emit({"type": "progress", "stage": "load_model", "done": 0, "total": 1})
    whisper = load_model(model, device, compute_type)
    emit({"type": "progress", "stage": "load_model", "done": 1, "total": 1})

    total_us = len(pcm) * 1_000_000 // SAMPLE_RATE

    emit({"type": "progress", "stage": "vad", "done": 0, "total": 1})
    speech = [
        {"startUs": c["start"] * 1_000_000 // SAMPLE_RATE, "endUs": c["end"] * 1_000_000 // SAMPLE_RATE}
        for c in get_speech_timestamps(pcm, VadOptions(**VAD_REPORT), sampling_rate=SAMPLE_RATE)
    ]
    emit({"type": "progress", "stage": "vad", "done": 1, "total": 1})

    def asr(audio_pcm):
        return whisper.transcribe(
            audio_pcm,
            language=None if language == "auto" else language,
            initial_prompt=", ".join(glossary) or None,
            word_timestamps=True,
            vad_filter=True,
            **DECODE,
        )

    segs_iter, info = asr(pcm)
    segments = []
    for seg in segs_iter:
        segments.append(seg)
        emit({"type": "progress", "stage": "transcribe", "done": min(sec_to_us(seg.end), total_us), "total": total_us})
    # Whisper can end a window early and silently drop later speech (seen with a glossary prompt:
    # everything after a 2 s pause vanished). VAD speech that no word covers is transcribed again alone.
    for iv in speech:
        if iv["endUs"] - iv["startUs"] < MISSED_SPEECH_US or any(
                sec_to_us(w.start) < iv["endUs"] and iv["startUs"] < sec_to_us(w.end) for s in segments for w in (s.words or [])):
            continue
        a = iv["startUs"] * SAMPLE_RATE // 1_000_000
        b = iv["endUs"] * SAMPLE_RATE // 1_000_000
        segments.extend(shift_segment(seg, a / SAMPLE_RATE) for seg in asr(pcm[a:b])[0])
    segments.sort(key=lambda seg: seg.start)
    emit({"type": "progress", "stage": "transcribe", "done": total_us, "total": total_us})

    words, sentences = build_words(segments, total_us)
    if not words or is_hallucination(segments, bool(speech)):
        raise WorkerError(
            "no_speech",
            "no usable speech was recognised",
            "Skip semantic cleanup for this clip; use the manual or visual-only route.",
        )

    transcript = {
        "schemaVersion": "1.0",
        "assetId": asset_id or f"a_{source_hash[:16]}",
        "sourceHash": source_hash,
        "backend": BACKEND,
        "model": model,
        "version": faster_whisper.__version__,
        "configHash": config_hash,
        "language": info.language if language == "auto" else language,
        "words": words,
        "sentences": sentences,
        "provenance": {
            "createdAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "glossaryHash": sha256_text("\n".join(glossary)) if glossary else None,
            "vad": VAD_VERSION,
            "alignment": ALIGNMENT_VERSION,
        },
    }
    return transcript, speech


def probe() -> dict:
    os.environ["HF_HUB_OFFLINE"] = "1"
    import ctranslate2
    import faster_whisper
    from faster_whisper.utils import available_models, download_model

    installed = []
    for name in available_models():
        try:
            download_model(name, local_files_only=True)
            installed.append(name)
        except Exception:
            pass
    devices = ["cpu"] + (["cuda"] if ctranslate2.get_cuda_device_count() > 0 else [])
    return {
        "type": "capabilities",
        "backend": BACKEND,
        "models": installed,
        "devices": devices,
        "defaultDevice": resolve_device("auto")[0],
        "versions": {
            "python": platform.python_version(),
            "fasterWhisper": faster_whisper.__version__,
            "ctranslate2": ctranslate2.__version__,
            "vad": VAD_VERSION,
        },
    }


def download(model: str) -> dict:
    os.environ["HF_HUB_OFFLINE"] = "0"  # read when huggingface_hub is first imported
    from faster_whisper.utils import available_models, download_model

    if model not in available_models():
        raise WorkerError("bad_input", f"unknown model {model!r}", "Choose one of: " + ", ".join(available_models()))
    emit({"type": "progress", "stage": "download", "done": 0, "total": 1})
    download_model(model)
    emit({"type": "progress", "stage": "download", "done": 1, "total": 1})
    return {"type": "result", "model": model}


def write_atomic(path: str, data: dict) -> None:
    partial = path + ".partial"
    with open(partial, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(partial, path)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="takeoff_transcribe")
    sub = p.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("transcribe")
    t.add_argument("--audio", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--model", default="base")
    t.add_argument("--language", default="en")
    t.add_argument("--glossary", default="")
    t.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    t.add_argument("--asset-id")
    t.add_argument("--source-hash")
    sub.add_parser("probe")
    d = sub.add_parser("download-model")
    d.add_argument("--model", required=True)
    d.add_argument("--allow-network", action="store_true")
    args = p.parse_args(argv)

    try:
        if args.cmd == "transcribe":
            transcript, speech = transcribe(
                args.audio, args.model, args.language, args.glossary.split(","), args.device,
                args.asset_id, args.source_hash,
            )
            write_atomic(args.out, transcript)
            emit({"type": "result", "out": args.out, "sourceHash": transcript["sourceHash"],
                  "configHash": transcript["configHash"], "speechIntervals": speech})
        elif args.cmd == "probe":
            emit(probe())
        else:
            if not args.allow_network:
                raise WorkerError("network_denied", "download-model needs --allow-network",
                                  "Re-run with --allow-network from starter-pack setup.")
            emit(download(args.model))
    except WorkerError as e:
        emit({"type": "error", "code": e.code, "message": e.message, "remedy": e.remedy})
        return 2
    except Exception as e:  # untyped failure still ends in one typed line; class name only, no paths/text
        emit({"type": "error", "code": "internal", "message": f"worker failed ({type(e).__name__})",
              "remedy": "Retry with --device cpu or another installed model."})
        return 2
    return 0
