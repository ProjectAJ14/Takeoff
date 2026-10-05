# packages/renderer-api

Owns the renderer-neutral contract: what a renderer receives, what it returns,
and what a browser scene must implement. Also owns the pure helpers every scene
and layout check shares (safe areas, caption slots, seeded PRNG, easings,
HTML escaping). No renderer lives here. PRD §7.4, §9.1 ScenePackage, §15, F06, F15.

## What lives here

| Path | Contents |
|---|---|
| `src/types.ts` | `Renderer`, `RenderInput` (optional `faceTracks`, `faceZoomMaxUpscale`), `FaceTrack`, `FaceTrackEntry`, `RenderOptions`, `RenderProgress`, `RenderArtifact`, `ResolvedAsset`, `ResolvedFont`, `Scene`, `SceneEnv`, `ScenePackage`, `Rect` (types only) |
| `src/scene-kit.ts` | `platformSafeArea`, `REELS_SHORTS_INSETS`, `captionBox`, `CAPTION_BOX_HEIGHT`, `rectInside`, `rectsOverlap`, `mulberry32`, `clamp`, `frameProgress`, `linear`, `easeInOutCubic`, `easeOutBack`, `escapeHtml` |
| `src/index.ts` | Re-exports both |

Plan, timeline, asset and brand shapes come from `@takeoff/contracts`; never
redefine them here.

## Invariants

- `src/scene-kit.ts` has no imports, no I/O, no clocks and no `Math.random`:
  it is bundled into sandboxed scene pages. Keep it that way.
- Same inputs give the same outputs. `mulberry32(seed)` is pinned by a golden
  test; changing it changes every rendered scene and needs a golden-frame update.
- Easings clamp `t` to [0,1] (NaN maps to 0) and return exactly 0 and 1 at the endpoints.
- `mulberry32` takes only uint32 seeds and throws otherwise; seeds never truncate silently.
- `rectsOverlap` is half-open: touching edges and empty rects overlap nothing.
- `platformSafeArea` rounds insets outward, so the safe rect is integer pixels
  and never larger than the fractions allow. Defaults reserve top 12%, right 12%,
  bottom 20%, left 6% (Reels/Shorts UI); callers pass their own `SafeInsets`.
- `captionBox('safe_face_aware')` falls back to the bottom slot when no face is
  tracked or both slots overlap the face.
- Scenes are seekable in any order: `seek(frame)` draws from params, env and frame
  only. No timers, live CSS transitions, network or unseeded randomness.
- Every caption, hook or label string reaches HTML/SVG through `escapeHtml`.

## Checks

```sh
node --test "packages/renderer-api/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/renderer-api
```

A contract change here is a renderer change: update `packages/renderer-browser`
and the `docs/` rendering page in the same PR.
