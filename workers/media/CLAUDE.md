# workers/media

`@takeoff/media`: every FFmpeg/ffprobe call that reads source media. Probe,
ingest (originals, CFR proxy, analysis and master WAVs), analysis for silence,
loudness, voice (F11) and color (F12), frame extraction, waveform peaks, disk
preflight and FFmpeg capabilities. PRD §6 F01/F11/F12, §12, §13, §15. Node/TS,
no dependencies beyond `@takeoff/contracts` and system FFmpeg.

## What lives here

| Path | Contents |
|---|---|
| `src/run.ts` | `run`/`ffmpeg` spawn helpers (argument arrays, AbortSignal kills the child), `MediaError`, `hashFile` |
| `src/probe.ts` | `probe(path)`, pure `parseProbe(json, decoders)` → `AssetManifest['probe']` + `kind`, `startUs`, `hdr` |
| `src/ingest.ts` | `ingest(src, projectRoot, {signal})` |
| `src/analyze.ts` | `detectSilence`, `measureLoudness`, `analyzeVoice`, `analyzeColor`, `waveformPeaks` |
| `src/frames.ts` | `extractFrame(path, us, outPng, {width})`, `thumbnail(path, outPng)` |
| `src/capabilities.ts` | `capabilities()` (memoised), `diskPreflight(root, bytes)` |

## Decisions

- **Originals.** A source inside the project root whose relative path matches
  contracts `relPath` is referenced in place. Anything else is copied to
  `media/originals/<sha256><ext>` and the copy is hash-verified, because the
  manifest only holds project-relative paths. The source is only ever read.
- **Derivatives** live in `media/derived/<sha256>/`: `proxy.mp4` (H.264 CFR,
  short side ≤540 px, fps = source rounded, capped at 30), `analysis.wav` (mono
  16 kHz s16), `master.wav` (stereo 48 kHz s16), and `derived.json` (name → hash).
- **Rotation** is clockwise degrees (legacy `rotate` tag sense; display matrix
  negated). FFmpeg autorotate applies it once and drops it from the proxy.
- **VFR** = `r_frame_rate` and `avg_frame_rate` differ by more than 1%.

## Invariants

- Media processes take argument arrays; never a shell. Inputs and outputs go
  through `ffInput()` (`file:` + absolute path) so a filename is never read as a
  protocol or option. Filter strings contain only validated numbers and constants.
- Every output is written as `<name>.partial` and renamed after success; failure
  or abort removes the partial. Ingest deletes leftover partials and reuses a
  final only when its hash matches `derived.json`.
- `MediaError` carries `code`, `message`, `remedy` (contracts `ErrorInfo` shape).
  Messages name streams, never paths; FFmpeg stderr is not surfaced.
- Clocks: source time in integer microseconds (`*Us`). Proxy and WAV time zero is
  `probe.startUs`.
- `extractFrame(us)` returns the frame whose half-open `[pts, next pts)` contains
  `us`; at or past the last frame's end it throws `invalid_argument`. Plain
  accurate `-ss` is one frame late mid-frame, so do not "simplify" back to it.
- `analyzeColor` converts to 8-bit `yuv420p` before `signalstats`; 10-bit
  sources otherwise report on a 0–1023 scale and saturate every correction.
- `analyzeColor` corrections are bounded (brightness ±0.08, contrast 1–1.15 only
  with headroom at both ends, saturation 1–1.1, midtones ±0.1). Callers must not
  apply them to HDR (`probe().hdr`).

## Checks

```sh
node --test "workers/media/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep workers/media
```

Tests need `ffmpeg`/`ffprobe` with libx264 on PATH. Fixtures are generated in
`mkdtemp` dirs from lavfi sources; never commit media. A new FFmpeg dependency
(filter, encoder) goes into `REQUIRED_FILTERS`/`REQUIRED_ENCODERS`.
