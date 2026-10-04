# Media and transcription

Two workers read source media:

- `workers/media` (`@takeoff/media`) is a Node/TypeScript library. It wraps
  system FFmpeg and ffprobe.
- `workers/transcribe` is a Python command-line worker. It turns an analysis
  WAV into a `transcript`, and tracks faces in a video (`faces`).

The engine calls both: `ingest` on import, and the worker (through
`uv run --directory workers/transcribe`) in the Prepare stage (faces) and the
Transcribe stage. See
[engine.md](engine.md).

## Requirements

- `ffmpeg` and `ffprobe` on `PATH`. To use other binaries, set `TAKEOFF_FFMPEG`
  and `TAKEOFF_FFPROBE`. A missing binary raises `ffmpeg_missing`.
- `capabilities()` reports the FFmpeg and ffprobe versions, the decoder list,
  and whether the required encoders (`libx264`, `aac`) and filters (`loudnorm`,
  `afftdn`, `sidechaincompress`, `zoompan`, `overlay`, `silencedetect`,
  `astats`, `signalstats`) are present. The result is cached per process.
  `missing` lists any that are absent.
- `diskPreflight(root, bytes)` passes when free space covers `bytes` plus 20%
  headroom.

## Probe

`probe(path)` runs ffprobe and returns the `asset-manifest` `probe` fields plus
three more: `kind`, `startUs` and `hdr`.

- **Kind.** `image` when the container is `image2` or `*_pipe` with video.
  Otherwise `video`, or `audio` when there is no video stream. A cover-art
  stream (`attached_pic`) doesn't count as video.
- **Rotation** is in clockwise degrees (0, 90, 180 or 270). It comes from the
  display matrix (negated) or from the legacy `rotate` tag.
- **VFR** means `r_frame_rate` and `avg_frame_rate` differ by more than 1%.
  `fpsNum`/`fpsDen` come from `avg_frame_rate`, falling back to `r_frame_rate`.
- **`hdr`** is true for a `smpte2084` or `arib-std-b67` transfer.
- **Rejected files.** Dimensions outside 1–16384 per side raise
  `unsupported_dimensions`. A codec that this FFmpeg can't decode raises
  `unsupported_codec`.

## Ingest

`ingest(src, projectRoot, {signal})` imports one source. It never modifies the
source.

1. It probes and hashes the source (SHA-256). It then runs a disk preflight that
   estimates the copy plus proxy and WAV sizes.
2. **Original.** A source already inside the project root, with a relative path
   that matches the contracts `relPath` rule, is referenced in place. Any other
   source is copied to `media/originals/<sha256><ext>`, and the copy is
   hash-verified.
3. **Derivatives** go to `media/derived/<sha256>/`:

| File | Format |
|---|---|
| `proxy.mp4` | Video sources only. H.264 CFR (`libx264 -preset veryfast -crf 23`, `yuv420p`), short side ≤ 540 px and never upscaled, rotation applied. Frame rate is the source rate rounded and capped at 30 (30 when unknown). AAC 128k stereo 48 kHz when there is audio |
| `analysis.wav` | Mono, 16 kHz, PCM s16le. Used for VAD, ASR and silence analysis |
| `master.wav` | Stereo, 48 kHz, PCM s16le. The dialogue master |
| `derived.json` | A map from each file name to its SHA-256 |

Each output is written as `<name>.partial` and renamed only after it succeeds.
A rerun deletes leftover partials and reuses a final file whose hash still
matches `derived.json`. Aborting `signal` kills FFmpeg and removes the partial.
Proxy and WAV time zero is `probe.startUs`. Proxy frame `i` maps to source time
`startUs + i / proxyFps` seconds.

`ingest` returns `{contentHash, relativePath, copied, probe, proxyFps, derived}`.
It doesn't write an asset manifest or touch the project database. The caller
does that through `ProjectStore.importAsset` (see [projects.md](projects.md)).

## Analysis and frames

| Function | What it returns |
|---|---|
| `detectSilence(path, {thresholdDb = −35, minDurationUs = 300000})` | Silent spans in source µs, from `silencedetect` |
| `measureLoudness(path)` | EBU R128 `integratedLufs`, `truePeakDbtp`, `lraLu`, `thresholdLufs` (from the `loudnorm` first pass) |
| `analyzeVoice(path)` | `clippingRatio`, `dcOffset`, `peakDb`, `rmsDb`, `noiseFloorDb` (from `astats`). It measures only. Studio voice processing happens in the renderer's mix ([rendering.md](rendering.md#composition)) |
| `analyzeColor(path, {samples = 8})` | `signalstats` on evenly sampled frames converted to 8-bit `yuv420p`, plus one bounded correction: brightness ±0.08, contrast 1–1.15 (only when both ends have headroom), saturation 1–1.1, midtone balance ±0.1. Callers must not apply it to HDR. The browser renderer applies it per source when `autoColor` is on, skipping HDR |
| `waveformPeaks(path, {buckets = 800})` | A peak envelope in 0..1, decoded mono at 8 kHz |
| `extractFrame(path, us, outPng, {width})` | PNG of the frame whose `[pts, next pts)` contains `us`, rotation applied. At or past the end it raises `invalid_argument` |
| `thumbnail(path, outPng, {width = 320})` | A representative frame chosen from the first 60 |

Every FFmpeg call takes an argument array, never a shell. Inputs and outputs
are passed as `file:<absolute path>`, so FFmpeg can't read a file name as a
protocol or an option. Filter strings contain only constants and numbers that
have been range-checked. Out-of-range numbers raise `invalid_argument`.

### Media error codes

`MediaError` has `code`, `message` and `remedy`, the same shape as the contracts
`ErrorInfo`. Messages name streams and never paths. FFmpeg's stderr is never
included.

| Code | Raised when |
|---|---|
| `not_found` | The source is missing or isn't a regular file |
| `corrupt` | ffprobe fails or returns unreadable output |
| `no_streams` | There is no video or audio stream, or color analysis gets a file without video |
| `unsupported_codec` | This FFmpeg can't decode the stream's codec, or the audio reports zero rate or channels |
| `unsupported_dimensions` | A side is outside 1–16384 |
| `disk_full` | The preflight fails |
| `ffmpeg_missing` | The binary isn't found |
| `ffmpeg_failed` | FFmpeg exits non-zero, produces no measurement, or a copied original fails its hash check |
| `invalid_argument` | A number is out of range, or no frame exists at the requested time |

## Transcription worker

`workers/transcribe` runs Python 3.12 under `uv` and depends on faster-whisper
(`>=1.1,<2`), numpy and opencv-python-headless (`>=4.10,<5`; OpenCV 5 drops the
bundled Haar cascades). Set it up once:

```sh
cd workers/transcribe && uv sync
```

### CLI contract

Run it with `uv run python -m takeoff_transcribe <command>` from
`workers/transcribe`, or from anywhere with
`uv run --project workers/transcribe python -m takeoff_transcribe <command>`.

- Every stdout line is one JSON object. stderr is library noise; don't parse it.
- Exit code 0 means success. Exit code 2 means a typed error.

```text
transcribe --audio <wav> --out <json> [--model base] [--language en]
           [--glossary 'Flutter,Dio'] [--device auto|cpu|cuda]
           [--asset-id <id>] [--source-hash <sha256>]
faces --video <path> --out <json> [--sample-fps 5] [--source-hash <sha256>]
probe
download-model --model <name> --allow-network
```

**`transcribe` input and arguments**

- `--audio` must be a WAV at 16 kHz, PCM s16le. Multi-channel input is
  downmixed. Use `analysis.wav` from ingest, or:

  ```sh
  ffmpeg -i <src> -ar 16000 -c:a pcm_s16le <out.wav>
  ```

- Defaults: `--model base`, `--language en`, `--device auto`.
- `--language` takes `auto` or a Whisper language code.
- `--model` takes only faster-whisper's named sizes, never a path or repo id.
- `--asset-id` must match the contracts `id` pattern. `--source-hash` must be
  64 lowercase hex characters.

**`transcribe` output**

- Progress lines look like
  `{"type":"progress","stage":"load_model"|"vad"|"transcribe","done":n,"total":n}`.
  For the `transcribe` stage, `done` and `total` count source microseconds.
- The `--out` file is a `transcript` contract object. It is written to
  `<out>.partial` and then renamed.
  - Words have ids `w0001…` in source order.
  - Word intervals are integer, half-open, non-overlapping and monotonic, and
    are clamped to the WAV duration.
  - `score` is faster-whisper's raw word probability.
  - `alignment` is `aligned` for word timestamps. It is `estimated` when an ASR
    segment had none, in which case its words are spread evenly.
  - Sentences use ids `s0001…`, one per ASR segment.
  - `assetId` defaults to `a_<first 16 hex chars of sourceHash>`.
  - `sourceHash` defaults to the WAV's SHA-256.
- The last line is `{"type":"result","out","sourceHash","configHash","speechIntervals":[{"startUs","endUs"}]}`.
  Silero VAD speech intervals travel in this line, because the transcript
  schema has no field for them. They are computed with a 300 ms minimum silence
  and 30 ms speech pad (`VAD_REPORT`), so pauses the director cuts (≥ 700 ms)
  show as gaps. faster-whisper's own defaults (2 s and 400 ms), which ASR still
  uses for its `vad_filter`, merged those pauses into speech.
- **Missed speech.** Any VAD interval of at least 500 ms that no word overlaps
  is transcribed again on its own and merged in source order. Whisper can end a
  window early and silently drop later speech (seen with a glossary prompt).
- `configHash` is the SHA-256 of canonical JSON over: backend, faster-whisper
  version, model, compute type, language, glossary, VAD version
  (`silero_vad_v6_s300_p30`), word timestamps, and the decode options (`beam_size: 5`,
  `condition_on_previous_text: false`). The worker caches nothing.

### Faces

`faces` tracks the presenter's face for F06 (face-aware captions) and F08
(face-centred crop and zoom). It runs offline: OpenCV's bundled Haar
frontal-face cascade, no model download.

- **Sampling.** FFmpeg (argument array, `file:` input) samples frames at
  `--sample-fps` (greater than 0, at most 30; the engine uses 5), rotation
  applied, downscaled to 480 px wide for detection. Boxes are scaled back to
  displayed source pixels.
- **Track.** One face in a sample gives its box; more than one is `multiple`;
  none holds the last box for up to 1 s, then is `lost`. Face boxes are
  median-filtered over 5 samples and move only when the centre shifts more than
  5% of the frame or the size changes more than 10%, so entries are piecewise
  constant and half-open. `multiple` and `lost` entries are the full frame at
  confidence 0; face entries carry the fraction of samples that were real
  detections.
- **Output** (written atomically): `{schemaVersion: "1.0", width, height`
  (displayed, rotation applied)`, rotation, sampleFps, detector, samples:
  [{us, faces: [{x, y, w, h, score}]}], track: [{startUs, endUs, x, y, w, h,
  confidence}], status, sourceHash?}`. `status` is `none` (no face ever),
  `multiple_faces`, `lost` or `tracked`. The last stdout line is
  `{"type":"result","out","status","segments"}`.
- **Errors.** `bad_input` for a missing or undecodable video, a bad
  `--sample-fps` or a bad `--source-hash`.

The track is the renderer's `FaceTrack` as is
([rendering.md](rendering.md#renderer-contract)). Haar cannot be fed a drawn
face reliably, so tests cover the smoothing and the no-face path, not detection
on a real face.

### Probe and device

**`probe`** prints `{"type":"capabilities","backend","models":[installed names],"devices","defaultDevice","versions"}`.
It runs offline.

**Device.** `auto` uses CUDA with float16 only when CTranslate2 reports a CUDA
device. Otherwise it uses the CPU with int8. `--device cuda` with no CUDA device
is `bad_input`.

### Offline behaviour

- `transcribe` and `probe` set `HF_HUB_OFFLINE=1` before Hugging Face code is
  imported. `faces` imports no Hugging Face code and uses the cascade file that
  ships inside OpenCV. They load models with `local_files_only=True`.
- A model that isn't installed returns `model_missing`. It never triggers a
  download or a cloud fallback.
- `download-model` is the only command that may use the network, and only with
  `--allow-network`. Without that flag it returns `network_denied`.
- The test suite patches `socket.connect` and `getaddrinfo` to prove that
  `transcribe` and `faces` open no connection.
- Models are faster-whisper weights from the Hugging Face cache (for example
  `Systran/faster-whisper-tiny`). None ship in this repository.

### Worker error codes

Errors print `{"type":"error","code","message","remedy"}` and exit with code 2.
Messages never contain the audio path or transcript text.

| Code | Raised when |
|---|---|
| `model_missing` | The model isn't installed locally, or isn't a known name |
| `no_speech` | There are no words, three identical consecutive segments, or a mean `avg_logprob` below −1.0 with no VAD speech |
| `bad_input` | Bad WAV format, a missing file, an invalid id, hash, language or device, or an unknown model for `download-model` |
| `network_denied` | `download-model` ran without `--allow-network` |
| `internal` | Any other failure. The message carries only the exception class name |

### Checks

```sh
cd workers/transcribe && uv run python -m unittest discover -s tests -v
node --test "workers/media/test/**/*.test.ts"
```

- The media tests need `ffmpeg` and `ffprobe` with `libx264`, and they generate
  their fixtures from lavfi sources.
- The transcription tests need macOS `say`, `ffmpeg`, the cached
  `Systran/faster-whisper-tiny` model and `node`. The speech tests skip without
  `say` or `ffmpeg`.
