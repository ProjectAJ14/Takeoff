# packages/compiler

Owns clock conversion, semantic plan validation, the source→output timeline
compiler and patch application. It is authoritative for output time (PRD §9.2):
nothing else turns source microseconds into frames or samples. PRD §7.4, §9.2,
§9.3, F06 (caption timing), F14 (length), §19.

## What lives here

| Path | Contents |
|---|---|
| `src/clock.ts` | `usToFrames`, `frameToUs`, `framesToSamples`, `usToSamples`, `SAMPLE_RATE`; half-open `Interval` ops `contains`, `intersect`, `subtract`, `merge` |
| `src/compile.ts` | `validatePlan(plan, ctx)` → `{errors, warnings}`; `compile(plan, ctx)` → `CompiledTimeline` or throws `CompileError`; `sourceToOutput`, `outputToSource`, `planHash` |
| `src/patch.ts` | `applyPatch(plan, patch, ctx)` → new plan at `revision + 1`, or throws `PatchError` (`invalid_patch`, `stale_revision`, `locked_object`, `not_found`, `invalid_op`, `invalid_result`) |

`ctx` is `{ transcripts: {assetId → Transcript}, manifests: {assetId → AssetManifest}, limits? }`.
Plan, transcript, manifest, patch and timeline shapes come from `@takeoff/contracts`.

## Invariants

- Segment `i` starts at frame `floor(cumulative retained µs before i × num / (den × 1e6))`
  and plays from its `sourceStartUs`, video and audio alike. Rounding never
  accumulates; a segment's frame count is within one frame of its source length.
  Samples are `floor(frames × 48000 × den / num)`. All arithmetic is BigInt.
- Output is back-to-back: no gaps, no overlaps, last segment ends at `totalFrames`.
- Word anchors resolve through the final mapping. A patch never shifts captions by an
  offset; the compiler recomputes them from word IDs.
- Hard errors (block render): `schema`, `context_schema`, `asset_unresolved`,
  `impossible_range`, `source_bounds`, `word_unresolved`, `word_outside_segment`,
  `segment_unresolved`, `caption_word_removed`, `emphasis_word_missing`,
  `track_exceeds_timeline`, `limit_exceeded`, `duplicate_id`, `speed_unsupported`,
  `hard_max_exceeded` (over a hard max with no declared essential-speech conflict).
  Warnings (draft allowed, carried in the timeline): `orphaned_anchor` (object left
  out), `uncertain_retake`, `soft_target_missed`, `segment_below_one_frame`, and each
  plan review marker by its kind.
- `locked_duration_conflict` is a warning that blocks only final export
  (`isExportBlocking(issue)`): over a hard max when locked speech alone exceeds it, or
  the plan carries a `critical` `duration_conflict` marker (the director could not fit
  without cutting essential opening/closing speech). PRD F14: a longer draft, never a
  falsely compliant export.
- Assets fit their role (`asset_unresolved` otherwise): segments and decisions use
  video or audio, music and sfx use audio, B-roll uses video or image. An image has
  no duration, so it never carries a source span that skips the bounds check.
- Soft target (F14): warned when the miss exceeds both 10% and 2 s, tested exactly in
  integers. Clock helpers floor (BigInt `/` truncates; `floorDiv` corrects negatives).
- Punch scale never exceeds 1.25, whatever `limits` says. Gains default to [-60, 12] dB.
- Disabled toggles emit no layer: captions, zoom, music, sfx, motion graphics, B-roll, hook.
- `applyPatch` is atomic, refuses a stale `baseRevision`, edits of locked objects
  (except `lock_object`/`unlock_object`; re-pointing a locked object to the segment
  that now holds its own word is allowed; orphaning a locked object's anchor word is
  refused) and cut edges inside a word, including a restore's own edges. Every op that
  changes segments, `restore_span` included, re-homes caption and anchor words.
  Generated ids (split pieces, restored segments, split captions, crops) are made
  unique against all existing ids. It rejects results with errors the input plan
  did not already have.
- Messages carry ids and numbers only, never transcript text or paths.
- `compile` is deterministic; `planHash` is SHA-256 of key-sorted JSON.

## Checks

```sh
node --test "packages/compiler/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/compiler
```

A compiler change keeps `test/properties.test.ts` passing (interval, rounding and
mapping properties over seeded random plans; a failure names its seed) and the
PRD §9.3 fixture compiling to frames [0,90) and samples [0,144000).
