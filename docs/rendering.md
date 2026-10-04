# Rendering

**Status:** working. `packages/renderer-api` defines the renderer-neutral
contract. `packages/renderer-browser` implements it: a sandboxed headless
Chromium (Playwright) seeks the overlay scenes frame by frame, and the PNG frames
are piped into one FFmpeg process that composes the cuts, crop, punch zoom,
colour, B-roll and audio mix into an MP4. The engine calls it for every draft and
final render (see [engine.md](engine.md)). The optional Remotion renderer
(`packages/renderer-remotion`) does not exist.

## Renderer contract

`packages/renderer-api/src/types.ts` defines types only:

```ts
interface Renderer {
  readonly id: string;
  render(input: RenderInput, opts: RenderOptions): Promise<RenderArtifact>;
}
```

**`RenderInput`** is everything a render may use:

- `compiled`: the `CompiledTimeline`.
- `plan`: the `EditPlan`.
- `assets`: a map from id to `{path, hash, manifest}`. Each path is absolute and
  already resolved under an approved root by the engine.
- `fonts`: `{family, path, hash}` entries pointing at pinned local font files.
- `brand`: a `BrandProfile` or `null`.
- `seed`.
- `versions`: pinned component versions, for example `compiler`, `chromium`,
  `ffmpeg`.

**`RenderOptions`** are `outPath`, `profile` (`draft` \| `final`), an optional
`signal`, and an optional `onProgress({frame, totalFrames})`. When `signal`
aborts, `render` must reject with an `AbortError` and leave no partial file at
`outPath`.

**`RenderArtifact`** records the output's `path`, `sha256` and `bytes`. It also
records what produced it: `profile`, `planHash`, `width`, `height`, `fps`,
`durationFrames`, `rendererId`, `seed` and `versions`.

## Scene interface

A scene draws one overlay (a motion template, hook text or captions) as a pure
function of its params, the environment and the frame number.

```ts
interface Scene<P> {
  initialize(params: P, env: SceneEnv): void;  // env: {width, height, fps, seed}
  assetsReady(): Promise<void>;                 // fonts and local assets decoded; awaited before the first seek
  seek(frame: number): void;                    // integer, scene-relative, 0-based; any order
  bounds(): Rect[];                             // visible text/graphics boxes at the last seek, for safe-area QA
  dispose(): void;
}
```

`ScenePackage` records everything needed to reproduce one scene render:

- `template` (a template id, or `generated`)
- `codeHash`
- asset and font hashes
- `params`
- `durationFrames`, `width`, `height`, `seed`
- `claims`, each `{text, evidenceIds}`
- `expectedBounds`
- `requirements`
- `fallback`

## Determinism rules

These rules are written into the contract. They apply to every renderer and
scene:

- A renderer receives a validated compiled plan plus resolved, hashed inputs. It
  receives nothing else.
- No network access. Renderers never fetch fonts.
- No wall clock: no `Date`, no `performance` timing, no timers.
- No live CSS transitions.
- No unseeded randomness.
- `seek(frame)` draws only from params, env and frame, so frames can be sought
  in any order.
- Scenes run sandboxed, with no Node, filesystem, IPC or network.
- Every caption, hook or label string reaches HTML or SVG as text only:
  through `escapeHtml`, or, in the browser renderer, through `textContent`.

## Scene kit

`src/scene-kit.ts` has no imports, no I/O, no clock and no `Math.random`, so it
can be bundled into sandboxed scene pages.

| Export | Behaviour |
|---|---|
| `REELS_SHORTS_INSETS` | Reserved fractions of the frame: top 0.12, right 0.12, bottom 0.20, left 0.06 |
| `platformSafeArea(w, h, insets?)` | The largest integer rect clear of those insets. Insets round outward, so the area never grows. Throws `RangeError` on bad sizes or insets |
| `captionBox(w, h, position, face?, insets?)` | A caption block of `CAPTION_BOX_HEIGHT` (0.16 of frame height) inside the safe area. `safe_top` uses the top slot and `safe_bottom` the bottom slot. `safe_face_aware` uses the bottom slot unless it overlaps `face` while the top slot doesn't, then the top slot. With no face, it uses the bottom slot |
| `rectInside`, `rectsOverlap` | Overlap is half-open: touching edges and empty rects overlap nothing |
| `mulberry32(seed)` | Seeded PRNG returning values in [0, 1). Accepts uint32 seeds only and throws otherwise. Its sequence is pinned by a golden test |
| `clamp`, `frameProgress(frame, start, duration)` | Both clamp to [0, 1]. NaN maps to the lower bound |
| `linear`, `easeInOutCubic`, `easeOutBack` | Clamp `t` and return exactly 0 and 1 at the endpoints |
| `escapeHtml(text)` | Escapes `& < > " '` |


## Browser renderer

`packages/renderer-browser` exports `BrowserRenderer` (id `browser-chromium`,
version `0.1.0`), `renderStill`, `generateLibraryAudio` and `RenderError`.

```ts
import { BrowserRenderer } from '@takeoff/renderer-browser';

const art = await new BrowserRenderer().render(input, { outPath, profile: 'draft', signal, onProgress });
// art: RenderArtifact + overlay {captionBounds, violations}, timings, overlayCaptures
```

It needs `ffmpeg`/`ffprobe` with libx264 (or `TAKEOFF_FFMPEG`/`TAKEOFF_FFPROBE`)
and the Playwright Chromium headless shell.

### Render steps

1. **Check the input.** `compiled` and `plan` must match their schemas,
   `planHash(plan)` must equal `compiled.planHash`, `seed` must be a uint32 and
   the timeline must have at least one frame. An `outPath` (or its
   `.partial.mp4`) equal to any asset, proxy or font path is refused. All of
   these fail as `invalid_input` before anything runs.
2. **Colour (F12).** With `autoColor` on, `analyzeColor` runs once per video
   source. HDR sources (`smpte2084`, `arib-std-b67` transfer) get no correction.
3. **Loudness pass 1 (F11).** With `studioVoice` on and a dialogue profile other
   than `bypass`, FFmpeg measures the full mix with `loudnorm` (JSON). A pass
   that prints no measurement fails the render as `ffmpeg_failed`.
4. **Compose.** One FFmpeg process reads the sources and the overlay PNG stream
   on stdin (`image2pipe`) and writes `<outPath>.partial.mp4`.
5. **Validate.** `ffprobe -count_frames` must report the render size, exactly
   `totalFrames` video frames, and an audio stream with time base `1/48000` and
   exactly `totalSamples` samples. Otherwise the render fails as
   `validation_failed`.
6. **Rename** the partial to `outPath` and hash it.

`RenderError.code` is `invalid_input`, `ffmpeg_failed` or `validation_failed`.
Messages carry codes and numbers, never paths, transcript text or FFmpeg stderr.

**Cancel.** Aborting `signal` closes Chromium, kills FFmpeg with SIGKILL and
deletes the partial. `outPath` is only ever written by the final rename. If
FFmpeg exits early, frame capture stops.

### Output profiles

| | `draft` | `final` |
|---|---|---|
| Size | 540 px wide at the compiled aspect, height rounded to even (540×960 for 9:16) | The compiled size (1080×1920 in the engine) |
| Video source | Each asset's CFR proxy when the engine passes `proxyPath`, else the original | The original |
| x264 | `-preset veryfast -crf 28` | `-preset medium -crf 18` |

Both profiles write H.264 `yuv420p` tagged BT.709 (primaries, transfer, matrix)
in TV range at the compiled frame rate, AAC 192 kb/s at 48 kHz, MP4 with
`+faststart`. Audio always reads the original source.

The engine's export profile `draft_720` renders with the `draft` profile, so its
video is 540×960, not 720 wide.

### Sandbox

Each render launches a fresh headless Chromium:

- **Context.** `offline: true`, service workers blocked, downloads off,
  viewport at the render size with device scale factor 1, `reducedMotion:
  reduce`, locale `en-US`, timezone `UTC`.
- **Routes allowlist.** `context.route('**/*')` fulfils only `GET` requests to
  `http://takeoff.scene` for files held in memory: `/index.html`, `/runtime.js`
  and `/fonts/*`. Every other request, and every WebSocket, is aborted.
- **Violations.** Each aborted request is recorded as an `undeclared_network`
  violation with the origin only, never the full URL (a URL could carry
  transcript text). The engine's QA turns it into a critical issue.
- **No bridge.** There is no `exposeFunction` or `exposeBinding`. Node drives the
  page with `page.evaluate` only.
- **Untrusted text.** Captions, hook text and template labels reach the page as
  `page.evaluate` data and the DOM through `textContent`. CSS holds only internal
  font family names, numbers, and colours that match `^#[0-9a-fA-F]{6}$`.

The scene runtime (`src/runtime.ts`) is bundled once per process by esbuild into
an IIFE (`target: chrome120`). Its SHA-256 is recorded as `versions.sceneRuntime`.

This is page-level isolation, not an OS sandbox: the renderer leaves Playwright's
`chromiumSandbox` at its default (`false`), so Chromium runs with `--no-sandbox`.
The scenes are product code; generated scenes do not exist.

### Fonts and colours

- **Default face:** Inter 600 and 800 from `@fontsource/inter`, served from
  `/fonts/` as `TakeoffSans`. The page makes no font or CDN request.
- **Brand fonts:** a brand profile's `caption` font (or its `body` font) and its
  `heading` font are used only when a `RenderInput.fonts` entry has the same
  family. The file must be `.woff2`, `.woff`, `.ttf` or `.otf` and match its
  pinned SHA-256, or the render throws. The engine passes its bundled fonts
  (Inter 400/700, Archivo 700, JetBrains Mono 400), so a brand font renders only
  if its family is one of those.
- **Font check:** every font load is awaited before the first seek. A font that
  did not load is a `font_missing` violation.
- **Palette:** `DEFAULT_PALETTE` is text `#FFFFFF`, highlight `#FFD23F`, accent
  `#2F6FEB`, background `#111111`. A brand profile's palette roles replace these
  when they are valid hex colours. `captionStyle.highlightColor` takes priority
  for the highlight.

### Scenes and templates

Every scene is a pure function of its spec, the environment and the frame: no
timers, `Date`, CSS transitions or `Math.random`. Each `seek` writes every style
it uses, so any seek order gives the same DOM. Captions draw above scenes. Sizes
below are fractions of the render height unless noted; "safe area" is
`platformSafeArea`.

| Scene | Params from the plan | Layout and motion | Fit rule (violation when it can't fit) |
|---|---|---|---|
| Caption `restrained` | caption `text`, word timing, `emphasisWordIds`, `positionPolicy` | In `captionBox` for its position. White text with a black stroke. Fades in over 3 frames. The active word and emphasis words use the highlight colour | Font from 4.5% down to 2.2%, 1 px steps, until the measured glyph rects fit in ≤ 2 lines inside the box (`caption_overflow`) |
| Caption `energetic` | same | Pops from 0.85 to 1 over 6 frames (`easeOutBack`). The active word gets a highlight background | Same, inside 90% of the box to leave room for the pop |
| Caption `static` | same | Dark box `rgba(0,0,0,0.62)`, no fade, no per-word highlight; emphasis words still use the highlight colour | Same as restrained |
| `hook_text` | `text` | Highlight-coloured box across the top of the safe area. Fades in over 4 frames, out over 6, and settles 2% downward over 8 frames | Font 4% → 2%; height ≤ 25% of the safe area (`scene_text_overflow`) |
| `kinetic_text_v1` | `lines` | Lines enter staggered (2–8 frames apart) with `easeOutBack`; the last line uses the highlight colour; each line tilts by a seeded ±2° (`mulberry32` of the render seed and the visual id, via FNV-1a); 6-frame exit fade | Font 6% → 2.5%; each line ≤ 85% of the safe width, block ≤ 50% of the safe height |
| `request_flow_v1` | `containerLabel`, `internalNode`, `externalNode`, `edgeLabel` | SVG: container, internal node, external node, then the edge draws and a packet travels it once. Timing is written for 60 frames and compressed for shorter scenes; 6-frame exit fade | Each label shrinks until it fits its box, down to max(1.2% of height, 40% of its start size) |
| `comparison_list_v1` | `title`, `items` | Dark panel; the title settles in, then items slide in staggered (3–15 frames apart); 6-frame exit fade | Font 3.4% → 1.6%; panel ≤ 60% of the safe height |

Per-word timing (active-word highlight) is used only while the caption's text
still splits into as many words as it has word ids. After an edit that changes
that, the caption shows as one block.

There is no face tracking: `safe_face_aware` captions take the bottom slot, and
`tracked_face` punch zooms zoom on the centre.

**Safe-area checks.** After each seek, a caption's measured bounds must lie
inside its `captionBox`, and a scene's inside the safe area. The first breach per
object is a `caption_outside_safe_area` or `scene_outside_safe_area` violation.
The artifact's `overlay.captionBounds` holds each caption's union of bounds over
the render. The renderer reports; the engine's QA decides.

### Frame dedupe

`seek(frame)` returns a key: the `outerHTML` of every active layer. A frame with
the same key as the previous one reuses its PNG instead of taking a new
screenshot, and a frame with no active layer reuses one transparent PNG.
`overlayCaptures` counts the screenshots taken. Only one PNG is held in memory,
and stdin backpressure is honoured.

### Composition

The filter graph contains only fixed filter names, stream labels and numbers that
passed integer or range checks. Paths are separate `-i file:<abs>` arguments, and
no plan or transcript string enters the graph (`test/compose.test.ts`).

**Video**

- **Cuts.** Each segment seeks its source 1 s early, then samples it on the
  output grid (`fps=…:round=up`: output frame k shows the source frame containing
  `sourceStartUs + k/fps`). It is padded by repeating the last frame and trimmed to
  exactly its compiled frame count, then all segments are concatenated and
  restamped.
- **Crop.** The largest output-aspect rect inside the plan's `crop` transform
  rect (or the whole frame), centred, as fractions of the displayed (rotated)
  source. The FFmpeg expression also clamps `x ≤ iw-ow` and `y ≤ ih-oh`, so a
  crop never leaves the source. Then a bicubic scale to the render size.
- **Colour (F12).** `eq` (brightness ±0.08, contrast 1–1.15, saturation 1–1.1)
  and `colorbalance` (rm/gm/bm ±0.1) with the per-source correction.
- **Punch zoom (F08).** `zoomAt(frame)` eases in over the transform's
  `transitionFrames` with `easeInOutCubic`, then holds until the span ends. Scale
  is capped at 1.25. Frames are grouped into runs of equal zoom; each run is a
  centre crop by 1/zoom scaled back up (no `zoompan`).
- **B-roll (F07).** A `broll` visual is laid over its frames from its own source
  range (an image loops). Layouts: `full` (whole frame), `split` (top half),
  `inset` (70% × 30% of the frame, centred at the top of the safe area). Each
  fills its box and is cropped to it. Nothing in the product places B-roll yet
  (see [features.md](features.md)).
- **Overlay.** The PNG stream is laid on top, then converted to BT.709 TV-range
  `yuv420p`.

**Audio**

1. **Dialogue.** Each segment's audio is cut from the original by sample
   (48 kHz stereo) and padded to its exact length. Seams get `afade`s of
   `seamFadeMs` (at most half the segment), except at the start of the first
   segment and the end of the last. A source without audio contributes silence.
2. **Studio voice (F11)**, when on and not `bypass`: `highpass=f=80`, `afftdn`
   (noise reduction 10 for `studio_conservative`, 20 for `studio_strong`,
   noise floor −40 dB), `deesser`, `acompressor` (threshold 0.125, ratio 2.5,
   attack 20 ms, release 250 ms).
3. **Music (F09).** The track loops, is trimmed to the cue's length, fades in and
   out over the cue's frames, takes its gain, and starts at its compiled sample.
4. **Ducking.** With `duckUnderDialogue`, the music goes through
   `sidechaincompress` keyed by the dialogue (threshold 0.03, ratio 8, attack
   15 ms, release 300 ms).
5. **SFX (F10).** Each event is trimmed, gained and delayed to its compiled
   sample.
6. **Mix.** `amix` without normalisation.
7. **Loudness pass 2.** When pass 1 measured something, `loudnorm` applies the
   measured values with `linear=true` toward the plan's `mixTarget`
   (`integratedLufs`, `truePeakDbtp`, LRA 11). A pass-1 result of `-inf` or at or
   below −70 LUFS (silence) is not normalised.
8. **Limiter.** `alimiter` at 1 dB (`TP_MARGIN_DB`) under the true-peak target,
   always. It limits sample peaks, so the margin keeps inter-sample peaks and AAC
   overshoot under the target.
9. **Length.** Padded and trimmed to exactly `totalSamples`.

### Artifact

`BrowserRenderArtifact` adds three fields to the renderer-api `RenderArtifact`:

- `overlay`: `captionBounds` and `violations` (`undeclared_network`,
  `caption_outside_safe_area`, `scene_outside_safe_area`, `caption_overflow`,
  `scene_text_overflow`, `font_missing`).
- `timings`: `colorMs`, `loudnessMs`, `composeMs`, `totalMs`.
- `overlayCaptures`.

`versions` adds `rendererBrowser`, `chromium` (the browser version), `ffmpeg`
(from `ffmpeg -version`) and `sceneRuntime` to the caller's versions.

### `renderStill`

`renderStill(input, frame, {profile = 'draft', signal})` returns one composed
output frame (source, crop, zoom, B-roll and overlay) as an RGB PNG `Buffer`.
`frame` must be in `[0, totalFrames)`. The engine does not call it: its QA
contact sheet extracts frames from the rendered MP4 instead.

## Determinism and golden frames

- **Pixels don't depend on seek order.** Chromium launches with software raster
  (`--disable-gpu`), `--force-color-profile=srgb`, no LCD text, no font hinting,
  `--run-all-compositor-stages-before-draw` and no partial raster. The test seeks
  frames `[40, 3, 77, 3, 40]` and compares them with a sequential render.
- **Golden frames.** `test/golden/overlay-20.png` and `overlay-70.png` were made
  in the pinned environment: macOS arm64 (`darwin-arm64`), Playwright 1.63.0,
  Chromium headless shell 153.0.8010.12, Node 26.7.0, FFmpeg 9.0.1. A frame
  passes when its SHA-256 matches `overlay-frames.json`, or else when its mean
  absolute RGBA difference from the golden PNG is at most 1.
- **Regenerate** only in the pinned environment, on purpose:
  `UPDATE_GOLDEN=1 node --test packages/renderer-browser/test/overlay.test.ts`.

## Generated library audio

`generateLibraryAudio(outDir)` synthesises Takeoff's own music and SFX with
FFmpeg `lavfi` sources (`sine`, seeded `anoisesrc`) from fixed recipes. Files are
48 kHz stereo 16-bit WAV muxed bit-exact, so the same FFmpeg build writes the
same bytes. It also writes `library.json` with each item's id, kind, category,
duration and SHA-256.

| Id | Kind | Category | Length |
|---|---|---|---|
| `bed_calm` | music | `calm` | 40 s |
| `bed_pulse` | music | `focused` | 45 s |
| `bed_bright` | music | `upbeat` | 32 s |
| `sfx_ui_click` | sfx | `ui_click` | 0.06 s |
| `sfx_hit` | sfx | `hit` | 0.45 s |
| `sfx_whoosh` | sfx | `whoosh` | 0.7 s |

Every item's license is `Takeoff original, generated` (`LIBRARY_LICENSE`): the
audio is created by this code, not sampled from any third-party recording. The
engine's starter pack runs it (see [engine.md](engine.md#starter-pack)).

## Checks

```sh
node --test "packages/renderer-api/test/**/*.test.ts"
node --test "packages/renderer-browser/test/**/*.test.ts"
node packages/engine/bin/takeoff.js render-test /tmp/takeoff-test.mp4   # five-second clip through the whole engine
```

The renderer tests need FFmpeg with libx264 and the Playwright Chromium headless
shell. Media is generated at test time from `lavfi` in temporary folders. A
renderer or scene change keeps the arbitrary-order seek test and the golden
frames passing.
