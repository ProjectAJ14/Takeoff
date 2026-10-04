# Rendering

**Status:** the renderer-neutral contract (`packages/renderer-api`) is in place.
The browser renderer (`packages/renderer-browser`: Chromium through Playwright,
with frames piped to FFmpeg) is **in progress**. Nothing renders frames, overlays
or an MP4 yet.

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
- Every caption, hook or label string reaches HTML or SVG through
  `escapeHtml`.

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

## Checks

```sh
node --test "packages/renderer-api/test/**/*.test.ts"
```

A contract change here is also a renderer change. Once the browser renderer
lands, its arbitrary-order seek test and its golden frames are required as well.
