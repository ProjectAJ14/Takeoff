# workers/transcribe

Python 3.12 worker, managed by `uv`, that turns a 16 kHz analysis WAV into a
`@takeoff/contracts` Transcript: Silero VAD speech intervals, faster-whisper ASR,
and word timing (PRD §6 F02, §13, §14). The engine spawns it as a subprocess
with an argument array and owns caching, jobs and storage.

## What it owns

| Path | Responsibility |
|---|---|
| `takeoff_transcribe/worker.py` | CLI, model loading, VAD, ASR, word/sentence building, typed errors |
| `takeoff_transcribe/faces.py` | F06/F08 face tracking: ffprobe dims/rotation, Haar detection on FFmpeg-sampled frames, `build_track` smoothing (pure) |
| `takeoff_transcribe/__main__.py` | `python -m takeoff_transcribe` entry |
| `tests/test_worker.py` | stdlib `unittest`; synthesises speech with `say` + ffmpeg at test time |
| `tests/test_faces.py` | `build_track` on synthetic detections; the `faces` CLI on lavfi `testsrc2` (no face) and a rotated copy |
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

`faces --video <path> --out <json> [--sample-fps 5] [--source-hash <sha256>]`
→ last line `{"type":"result","out","status","segments"}`. Offline: OpenCV's
bundled Haar frontal-face cascade, no model download. FFmpeg (argument array,
`file:` input) samples frames at `--sample-fps` (0 < fps ≤ 30), autorotated and
downscaled to 480 px wide for detection; boxes are scaled back. Output file
(atomic): `{schemaVersion:"1.0", width, height (displayed, rotation applied),
rotation (0|90|180|270, clockwise like the asset manifest), sampleFps, detector,
samples:[{us, faces:[{x,y,w,h,score}]}], track:[{startUs,endUs,x,y,w,h,confidence}],
status, sourceHash?}`. `score` is the cascade's raw level weight. Track: one face
per sample → its box; > 1 face → `multiple`; none → held for ≤ 1 s, then `lost`.
Boxes are median-filtered over 5 samples and held until the centre moves > 5% of
the frame or size changes > 10%, so entries are piecewise constant and half-open.
`multiple`/`lost` entries are the full frame at confidence 0; face entries carry
the fraction of samples that were real detections. `status`: `none` (no face
ever), `multiple_faces`, `lost`, else `tracked`. The object is the renderer-api
`FaceTrack` (`RenderInput.faceTracks[assetId]`) as is.

`probe` → one line `{"type":"capabilities","models":[cached names],"devices",
"defaultDevice","versions"}`. Offline.

`download-model --model <name> --allow-network` → the only command that may use
the network (starter-pack setup). Without the flag: `network_denied`.

Errors: `{"type":"error","code","message","remedy"}`; `code` is one of
`model_missing`, `no_speech`, `bad_input`, `network_denied`, or `internal` for
any untyped failure (message carries only the exception class). Messages never
contain the audio path or transcript text.

## Invariants

- **No network in transcribe, faces or probe.** `HF_HUB_OFFLINE=1` is set before
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
prove transcribe and faces open no connection. Haar cannot be fed a drawn face
reliably, so real-face detection is not unit-tested; the smoothing is.

Licenses (record in `THIRD_PARTY_NOTICES`): faster-whisper MIT, CTranslate2 MIT,
numpy BSD-3, onnxruntime MIT, Silero VAD MIT (bundled), huggingface_hub and
tokenizers Apache-2.0, PyAV BSD-3 with bundled FFmpeg (LGPL, transitive, unused),
Whisper weights MIT, opencv-python-headless (pinned < 5: OpenCV 5 drops the
bundled Haar cascades) Apache-2.0 with bundled FFmpeg (LGPL, unused here: frames
come from the system ffmpeg), `haarcascade_frontalface_default.xml` Intel License
Agreement (BSD-3-style, Copyright (C) 2000 Intel Corporation, from its file header).
