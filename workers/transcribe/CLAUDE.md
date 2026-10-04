# workers/transcribe

Python 3.12 worker, managed by `uv`, that turns a 16 kHz analysis WAV into a
`@takeoff/contracts` Transcript: Silero VAD speech intervals, faster-whisper ASR,
and word timing (PRD §6 F02, §13, §14). The engine spawns it as a subprocess
with an argument array and owns caching, jobs and storage.

## What it owns

| Path | Responsibility |
|---|---|
| `takeoff_transcribe/worker.py` | CLI, model loading, VAD, ASR, word/sentence building, typed errors |
| `takeoff_transcribe/__main__.py` | `python -m takeoff_transcribe` entry |
| `tests/test_worker.py` | stdlib `unittest`; synthesises speech with `say` + ffmpeg at test time |
| `pyproject.toml`, `uv.lock`, `.python-version` | Pinned environment; `.venv/` is gitignored |

## CLI contract

Run from this directory: `uv run python -m takeoff_transcribe <command>`.
Every stdout line is one JSON object. Exit 0 on success, 2 on a typed error.
stderr is free-form library noise; do not parse it.

`transcribe --audio <wav> --out <json> [--model base] [--language en|auto]
[--glossary 'Flutter,Dio'] [--device auto|cpu|cuda] [--asset-id <id>]
[--source-hash <sha256>]`

- `--language` must be `auto` or a Whisper code (`en` is the validated P0
  language); `--source-hash` must be 64 lowercase hex; `--asset-id` must match the
  contracts id pattern. `--device cuda` with no CUDA device is `bad_input`.
- Input: WAV, 16 kHz, PCM s16le (multi-channel is downmixed). Anything else is
  `bad_input`: `ffmpeg -i <src> -ar 16000 -c:a pcm_s16le <out.wav>`.
- Progress: `{"type":"progress","stage":"load_model"|"vad"|"transcribe","done":n,"total":n}`;
  `transcribe` counts integer source microseconds.
- Output file: exactly a `transcript` contract object, written to `<out>.partial`
  then renamed. Words have ids `w0001…` in source order, integer half-open
  `[sourceStartUs, sourceEndUs)`, non-overlapping and monotonic; `score` is
  faster-whisper's raw word probability; `alignment` is `aligned` for word
  timestamps, `estimated` when a segment had none (spread evenly). Word ends are
  clamped to the WAV's duration. One sentence per
  ASR segment. `assetId` defaults to `a_<sourceHash[:16]>`; `sourceHash` defaults
  to the WAV's sha256 (pass `--source-hash` to use the original media's hash).
- Last line: `{"type":"result","out","sourceHash","configHash","speechIntervals":[{"startUs","endUs"}]}`.
  Speech intervals travel here because the transcript schema has no field for them.
  They use Silero with 300 ms minimum silence and 30 ms pad (`VAD_REPORT`), so
  pauses the director cuts (≥700 ms) show as gaps; faster-whisper's defaults
  (2 s, 400 ms) merged them. Any VAD interval ≥500 ms that no word covers is
  transcribed again on its own and merged: Whisper can end early and silently
  drop later speech (seen with a glossary prompt).
- `configHash` = sha256 of canonical JSON of backend, faster-whisper version,
  model, compute type, language, glossary, VAD version and decode options
  (`beam_size`, `condition_on_previous_text`). The engine's cache key is
  derived from `sourceHash` + `configHash`; the worker does no caching.

`probe` → one line `{"type":"capabilities","models":[cached names],"devices",
"defaultDevice","versions"}`. Offline.

`download-model --model <name> --allow-network` → the only command that may use
the network (starter-pack setup). Without the flag: `network_denied`.

Errors: `{"type":"error","code","message","remedy"}`; `code` is one of
`model_missing`, `no_speech`, `bad_input`, `network_denied`, or `internal` for
any untyped failure (message carries only the exception class). Messages never
contain the audio path or transcript text.

## Invariants

- **No network in transcribe or probe.** `HF_HUB_OFFLINE=1` is set before
  `huggingface_hub` is imported and models load with `local_files_only=True`.
  A missing model is `model_missing`, never a download or a cloud fallback.
- `--model` accepts only faster-whisper's named sizes; never a path or repo id.
- Device `auto` picks CUDA/float16 only when CTranslate2 reports a CUDA device;
  otherwise CPU/int8. Never assume CUDA on Apple Silicon.
- No speech is a stop, not a guess: no words, three identical consecutive
  segments, or mean `avg_logprob < -1.0` with no VAD speech → `no_speech`.
- Source time is integer microseconds; no float seconds leave the worker.
- Audio is read with stdlib `wave`, not PyAV (PyAV 19 breaks faster-whisper's
  `decode_audio`, and it would be a second FFmpeg build).

## Checks

```sh
cd workers/transcribe
uv sync
uv run python -m unittest discover -s tests -v
```

Tests need macOS `say`, `ffmpeg`, the cached `Systran/faster-whisper-tiny` model
and `node` (to validate output with `@takeoff/contracts`). The speech tests skip
without `say`/`ffmpeg`. A test patches `socket.socket.connect` and `getaddrinfo` to
prove transcribe opens no connection.

Licenses (record in `THIRD_PARTY_NOTICES`): faster-whisper MIT, CTranslate2 MIT,
numpy BSD-3, onnxruntime MIT, Silero VAD MIT (bundled), huggingface_hub and
tokenizers Apache-2.0, PyAV BSD-3 with bundled FFmpeg (LGPL, transitive, unused),
Whisper weights MIT.
