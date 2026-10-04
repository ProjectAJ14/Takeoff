# packages/renderer-browser

`@takeoff/renderer-browser`: the P0 renderer. `BrowserRenderer` implements the
renderer-api `Renderer`: a sandboxed Chromium (Playwright headless shell) seeks
overlay scenes frame by frame, and the PNG frames are piped into a single FFmpeg
composition of the source cuts, crop, punch zoom, colour, B-roll and audio mix.
PRD §5.5, §6 F06–F13, F15 (P0 templates), §7.4, §11 steps 2/7, §15, §19.

## What lives here

| Path | Contents |
|---|---|
| `src/render.ts` | `BrowserRenderer`, `renderStill(input, frame, {profile})`, `RenderError`; output validation; `BrowserRenderArtifact` (renderer-api artifact + `overlay` report, `timings`, `overlayCaptures`) |
| `src/overlay.ts` | `openOverlay` (sandboxed page session), `buildOverlay` (page spec + allowlisted files), `renderSize`, `sceneRuntime`/`sceneRuntimeHash`, `DEFAULT_PALETTE` |
| `src/runtime.ts` | Page code, bundled by esbuild to an IIFE: caption scene (restrained, energetic, static), `hook_text`, `kinetic_text_v1`, `request_flow_v1`, `comparison_list_v1` |
| `src/spec.ts` | Types shared by Node and the page (`OverlaySpec`, `SeekResult`, `PageViolation`) |
| `src/compose.ts` | FFmpeg filter-graph builders: `videoGraph` (incl. brand logo), `audioGraph`, `measureGraph`, `stemGraph` (all from the shared mix `buses`), `zoomAt`/`punchAt`, `cropFractions`; face framing `segmentFace`, `faceInOutput`, `faceSamples` (QA) |
| `src/library.ts` | `generateLibraryAudio(outDir)`: 3 music beds (32–45 s) and `ui_click`/`hit`/`whoosh` SFX as WAV plus `library.json`, license `Takeoff original, generated` |

`renderStems(input, outDir)` writes dialogue/music/sfx WAVs of exactly `totalSamples` from the same buses as the mix
(seam fades, Studio voice chain, music fades/gain/ducking, SFX placement; before loudness normalisation).
`BrowserRenderInput.logo` (`{path, hash}`, PNG/JPEG, hash and magic bytes checked → else `invalid_input`) is drawn
aspect-kept inside 20% × 6% of the frame at the safe area's top-right corner, under the overlay (a hook covers it while shown).
The artifact's `faces` lists QA face samples (mid frame of each tracked segment, rect after crop and punch).

`RenderInput.assets[id]` may carry `proxyPath` (`BrowserResolvedAsset`): draft
video reads it; audio and final video always read the original.

## Pipeline

1. Validate `compiled` and `plan` against contracts schemas; `planHash(plan)` must equal `compiled.planHash`.
2. F12: `analyzeColor` per video source when `autoColor` is on; HDR transfers are skipped (never silently treated as SDR).
3. F11: when `studioVoice` is on and the profile is not `bypass`, pass 1 measures the full mix with `loudnorm` (JSON); pass 2 applies the measured values (`linear=true`). Silence (`-inf`) is never normalised; a measurement pass that prints no loudnorm JSON fails the render (`ffmpeg_failed`) rather than shipping un-normalised audio.
4. One FFmpeg process: per segment `-ss` input → `fps=…:round=up` (output frame k shows the source frame containing `sourceStartUs + k/fps`) → crop to the output aspect from source fractions → scale → `eq`/`colorbalance` → `tpad` + `trim` to exactly the compiled frame count; concat; punch zoom as runs of constant zoom (`split` + `trim` + centre `crop` + `scale`, no `zoompan`); B-roll (`full`, `inset`, `split`) overlaid with `enable='between(n,a,b)'`; overlay PNG stream (`image2pipe`); BT.709 yuv420p; libx264 (draft `veryfast` crf 28, final `medium` crf 18); `+faststart`.
5. Audio: per segment `atrim` by samples with seam `afade` of `seamFadeMs` (not at the start of the first or end of the last); Studio voice `highpass=80, afftdn, deesser, acompressor`; music looped, faded, gained, `sidechaincompress`-ducked under dialogue; SFX by `adelay` at their compiled sample; `amix` (no normalisation); loudnorm pass 2; `alimiter` 1 dB (`TP_MARGIN_DB`) under the true-peak target, since it limits sample peaks and AAC adds inter-sample overshoot; `apad`/`atrim` to exactly `totalSamples`.
6. Write `<outPath>.partial.mp4`, decode it fully with ffprobe (`-count_frames`), require frames == `totalFrames` and audio samples == `totalSamples`, then rename.

## Invariants

- **Sandbox.** Fresh context: `offline`, service workers blocked, downloads off. `context.route('**/*')` fulfils only GETs for the in-memory allowlist (`/index.html`, `/runtime.js`, `/fonts/*`) on `http://takeoff.scene`; everything else, and every WebSocket, is aborted and recorded as an `undeclared_network` violation (origin only, never the full URL). No `exposeFunction`/`exposeBinding`; Node drives the page with `page.evaluate` only.
- **Untrusted text** (captions, hook, template labels, font family names) reaches the page as `page.evaluate` data and the DOM through `textContent` only. CSS gets internal font family names, product numbers and colours that passed `^#[0-9a-fA-F]{6}$`.
- **Brand fonts** come only from `RenderInput.fonts` and must match their pinned SHA-256; the default face is Inter 600/800 from `@fontsource/inter`. The page makes no font or CDN request.
- **Scenes are pure functions of frame.** No timers, `Date`, CSS transitions/animations or `Math.random`; motion uses renderer-api easings and `mulberry32(seed ⊕ id)`. Every `seek` writes every style it uses, so any seek order gives the same DOM. Launch flags force software raster and `--run-all-compositor-stages-before-draw`, so seek order never changes pixels either.
- **Dedupe key** is the `outerHTML` of active layers: equal keys reuse the previous PNG; frames with no active layer reuse one transparent PNG. One PNG is in memory at a time; stdin backpressure is honoured.
- **Filter graphs** contain only fixed filter names, labels and numbers that passed `int`/`dec` range checks. Paths are separate `-i file:<abs>` arguments. No plan or transcript string enters a graph (`test/compose.test.ts`).
- **Crop never leaves the source:** fractions are clamped inside the plan crop (or the full frame) and the FFmpeg expression clamps `x ≤ iw-ow`, `y ≤ ih-oh`. Punch scale is capped at 1.25.
- **Cancel** (`AbortSignal`) closes Chromium, SIGKILLs FFmpeg (SIGTERM can hang on an open stdin pipe) and deletes the partial. `outPath` is written only by the final rename, and an `outPath` (or its partial) equal to any asset, proxy or font path is refused as `invalid_input` before anything runs (lexical compare, not realpath). If FFmpeg exits early the capture loop stops.
- **Layout QA.** Caption fit shrinks the font until the measured glyph rects fit ≤ 2 lines inside `captionBox` (energetic keeps a 10% margin for the pop and active-word scale). The artifact reports per-caption union bounds and violations: `undeclared_network` (hard failure), `caption_outside_safe_area`, `scene_outside_safe_area`, `caption_overflow`, `scene_text_overflow`, `font_missing`. The renderer reports; QA decides.
- **Face awareness (F06/F08)** is driven only by `RenderInput.faceTracks` (validated: integer half-open spans, boxes inside their frame, aspect matching the asset's displayed orientation, else `invalid_input`). Per segment the track entry overlapping most of its source range is used; confidence < 0.5 or no track keeps today's behaviour. The 9:16 crop centres on the face x, clamped inside the plan crop. A `tracked_face` punch crops around the face centre (clamped inside the frame) and its scale is capped so output pixels per source pixel ≤ `faceZoomMaxUpscale` (default 1; a 1080p landscape source into 1080x1920 therefore gets no face zoom). `safe_face_aware` captions resolve to `safe_top` when the face (in render pixels, before punch) overlaps the bottom slot and not the top. Without `faceTracks` the graph and overlay are byte-identical to before (`test/face.test.ts`).
- Messages and errors carry codes and numbers, never paths, transcript text or FFmpeg stderr.

## Golden environment

`test/golden/overlay-{20,70}.png` and `overlay-frames.json` were produced on
macOS 26.6.2 arm64, Playwright 1.63.0, chromium headless shell 153.0.8010.12
(`chromium_headless_shell-1243`), Node 26.7.0, FFmpeg 9.0.1. Outside that
environment the comparison falls back to mean absolute RGBA difference ≤ 1.
Regenerate only in the pinned environment, deliberately:
`UPDATE_GOLDEN=1 node --test packages/renderer-browser/test/overlay.test.ts`.

## Checks

```sh
node --test "packages/renderer-browser/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/renderer-browser
```

Tests need `ffmpeg`/`ffprobe` with libx264 and the Playwright chromium headless
shell. Media is generated at test time from lavfi in `mkdtemp` dirs. A scene or
renderer change keeps the arbitrary-order seek test and the golden frames
passing, and updates the `docs/` rendering page in the same PR.
