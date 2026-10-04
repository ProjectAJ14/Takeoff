# Timeline compiler

`packages/compiler` turns a validated edit plan into a `compiled-timeline`.
It is the only code that converts source microseconds into output frames or
samples. It also validates plans and applies patches. Plan, patch and timeline
shapes are defined in [schema.md](schema.md).

```ts
import { validatePlan, compile, applyPatch } from '@takeoff/compiler';

const ctx = { transcripts: { [assetId]: transcript }, manifests: { [assetId]: manifest } };
const { errors, warnings } = validatePlan(plan, ctx);  // errors block render
const timeline = compile(plan, ctx);                     // throws CompileError on any error
const next = applyPatch(plan, patch, ctx);               // new plan at revision + 1, or throws PatchError
```

`ctx` is a `PlanContext`: transcripts keyed by asset id, asset manifests keyed by
asset id, and optional `limits` `{maxPunchScale, minGainDb, maxGainDb}`.

## Clocks and rounding

Functions exported from `src/clock.ts`. Every one uses BigInt and floors:

| Function | Formula |
|---|---|
| `usToFrames(us, fps)` | `floor(us × num / (den × 1e6))` |
| `frameToUs(frame, fps)` | `ceil(frame × den × 1e6 / num)`, the first whole µs at or after the frame starts |
| `framesToSamples(frames, fps)` | `floor(frames × 48000 × den / num)` |
| `usToSamples(us)` | `floor(us × 48000 / 1e6)` |

The interval helpers `contains`, `intersect`, `subtract` and `merge` all treat
intervals as half-open `[start, end)`. In `merge`, touching intervals join.

**Rounding rule, applied per segment:** segment `i` starts at
`usToFrames(the sum of the retained source durations of segments 0..i−1)` and
ends at `usToFrames(that sum + its own duration)`. Because the cumulative sum is
floored, rounding error never accumulates across cuts. The segments sit back to
back with no gaps or overlaps. The last segment ends at `totalFrames`. Each
segment's frame count is within one frame of its source length. Audio sample
positions come from the frame positions through `framesToSamples`, so video and
audio cut at the same instant.

Example at 30 fps (`{num: 30, den: 1}`), with two segments of 1,010,000 µs and
990,000 µs:

| Segment | Cumulative µs before | Frames | Samples |
|---|---|---|---|
| 1 | 0 | `[0, 30)` | `[0, 48000)` |
| 2 | 1,010,000 | `[30, 60)` | `[48000, 96000)` |

Rounding each segment on its own would give segment 2 only 29 frames
(`floor(29.7)`) and a 59-frame total. The cumulative rule gives 60.

Mapping helpers use the same placement:

- `sourceToOutput(plan, assetId, us)` returns the output frame showing that
  source instant, or `null` when the instant is cut. If two segments match,
  the first one wins.
- `outputToSource(plan, frame)` returns `{segmentId, assetId, us}`, or `null`
  past the end.

## `validatePlan`

Validation runs in order and stops at the first stage that reports errors:

1. The plan is checked against the `edit-plan` schema.
2. Every context transcript and manifest is checked against its own schema and
   its key.
3. The semantic rules run.

A message carries ids and numbers only. It never includes transcript text or a
path.

### Hard errors (block render)

| Code | Raised when |
|---|---|
| `schema` | The plan fails the `edit-plan` schema |
| `context_schema` | A context transcript or manifest is malformed, or its key doesn't match its own `assetId` / `id` |
| `duplicate_id` | An id repeats across decisions, segments, captions, visuals, transforms, sfx and review markers, or an asset id repeats |
| `asset_unresolved` | An asset is missing from the plan or has no manifest. Also raised when the manifest kind differs from the plan, or the kind doesn't fit the role: segments and decisions take `video` or `audio`, music and sfx take `audio`, B-roll takes `video` or `image` |
| `impossible_range` | A source span is empty or reversed |
| `source_bounds` | A span ends past the source `durationUs`, the duration is unknown, or an sfx asset has no duration |
| `speed_unsupported` | A segment `speed` isn't 1. No setting enables speed changes yet |
| `word_unresolved` | A segment word id isn't in that asset's transcript |
| `word_outside_segment` | A segment word lies outside the segment span |
| `segment_unresolved` | A caption names a missing segment |
| `caption_word_removed` | A caption word isn't in its segment's `wordIds` |
| `emphasis_word_missing` | A caption emphasises a word it doesn't show |
| `limit_exceeded` | A punch scale is above `min(1.25, limits.maxPunchScale)`, a crop rect leaves the frame, or a gain is outside `[minGainDb, maxGainDb]` (default `[−60, 12]`) |
| `track_exceeds_timeline` | A visual, punch, music cue or sfx falls outside `[0, totalFrames)` or is empty |
| `hard_max_exceeded` | `lengthPolicy` is `hard_max`, `totalFrames > targetFrames`, and the conflict is not declared (see `locked_duration_conflict` below) |

### Warnings (a draft is still allowed)

Warnings travel into `timeline.warnings`.

| Code | Raised when |
|---|---|
| `uncertain_retake` | A decision has `action: "review"` |
| `orphaned_anchor` | An anchored visual, punch or sfx names a word that isn't in its segment, or a crop names a missing segment. The object is left out of the timeline, never moved to a guessed word |
| `segment_below_one_frame` | A segment rounds to zero frames |
| `locked_duration_conflict` | `lengthPolicy` is `hard_max`, `totalFrames > targetFrames`, and either the locked segments alone need more frames than the target allows, or the plan carries a `critical` `duration_conflict` marker (the director could not fit without cutting the essential opening or closing). The draft is allowed and longer; `isExportBlocking(issue)` returns true for this code, so a final export must not use it |
| `soft_target_missed` | `lengthPolicy` is `soft_target` and the miss is greater than both 10% of the target and 2 s, tested exactly in integers |
| `<review marker kind>` | Each plan `reviewMarkers` entry is copied as a warning with its own `kind` as the code |

## `compile` output

`compile` returns a `compiled-timeline` with `compilerVersion` `0.1.0` and
`planHash`. The hash is the SHA-256 of the plan serialised as JSON with sorted
keys. The same plan and context always produce the same timeline. Any hard error
throws `CompileError` (`code: "invalid_plan"`, plus an `issues` list).

| Layer | How it is built |
|---|---|
| `segments` | One per plan segment, with frames and samples from the rounding rule |
| `audioEvents` | One `dialogue` event per segment at 0 dB. Also `music`, from `startFrame` for `durationFrames`, and `sfx`, at the anchor frame for the asset's duration, clamped to `totalSamples` |
| `captions` | Word frames come from each word's source start and end through its segment's placement. The caption spans its words. A patch never shifts a caption by an offset; timing is always recomputed from word ids |
| `visuals` | The anchor word's start or end frame plus `offsetFrames`, held for `durationFrames` |
| `transforms` | A punch starts at its anchor and lasts `durationFrames`; without one, it holds to the end of its segment. A crop covers its whole segment |

A disabled toggle emits no layer, even when the plan holds objects for it:

| Setting off | Layer not emitted |
|---|---|
| `captions` | Captions |
| `zoom` | Punch transforms |
| `music` | The music cue |
| `sfx` | Sfx |
| `motionGraphics` | Motion templates |
| `userBroll` and `aiBroll` both off | B-roll |
| `textHook` | Hook text |

## Patches

`applyPatch(plan, patch, ctx)` is atomic. It works on a copy of the plan, and if
any op fails, it throws and returns nothing. On success it returns a new plan at
`revision + 1`.

| `PatchError.code` | Meaning |
|---|---|
| `invalid_patch` | The patch fails the `patch` schema |
| `stale_revision` | `baseRevision` isn't the plan's current `revision` |
| `locked_object` | An op edits a locked object |
| `not_found` | A target id doesn't exist |
| `invalid_op` | A cut edge falls inside a word, a split point is outside its segment, a reorder index is past the end, or the target has no replaceable asset |
| `invalid_result` | The result has validation errors that the input plan didn't already have |

What each op does:

- `remove_span` cuts the span out of every segment of that asset it touches.
  The first piece keeps the segment id, and later pieces get new unique ids. It
  also appends a `remove` decision with `detector: "user"`.
- `restore_span` inserts the parts of the span that no segment currently keeps
  as new segments, placed in source order. Only the user's own two edges are
  checked against word boundaries.
- `trim_segment`, `split_segment`, `replace_take` and `reorder_segment` edit one
  segment. `split_segment` uses `newSegmentId` for the tail.
- `set_caption` merges the given fields into a caption.
- `set_crop` sets the segment's `cropPolicy` to `manual` and updates or creates
  its crop transform.
- `replace_asset` re-points a B-roll visual, an sfx cue or the music cue. The
  music cue is addressed by its asset id.
- `set_gain` changes an sfx or music gain.
- `remove_visual` deletes a visual.
- `set_hook` sets `settings.hook` to `{autoSelect: false, text}`. It then
  updates the `hook_text` visual, or deletes it when `text` is `null`.
- `set_setting` writes one setting. For `targetSeconds` it also sets
  `output.targetFrames` (`null` stays `null`).
- `lock_object` / `unlock_object` set `locked` on any object found by id.

Locks and anchors:

- Every op that changes segments re-homes caption and anchor words afterwards,
  and so does `restore_span`. A caption whose words now live in one segment is
  re-pointed there; a lock allows that, because the content doesn't change.
- A caption that lost words or now spans several segments is rewritten from
  transcript words (`correctedText`, falling back to `text`), never paraphrased.
  If the caption is locked, the op is refused. A caption whose words were all
  cut is dropped.
- Ids generated for split pieces, restored segments, split captions and crops
  are made unique against every existing id.
- A locked visual, transform or sfx refuses any op that would cut its anchor
  word.

Plan revisions, stale-revision checks on commit, undo and redo are handled by
the project store. See [projects.md](projects.md).

## Checks

```sh
node --test "packages/compiler/test/**/*.test.ts"
```

`test/properties.test.ts` runs interval, rounding and mapping properties over
seeded random plans. A failing case names its seed. The PRD §9.3 example plan
must compile to frames `[0, 90)` and samples `[0, 144000)`.
