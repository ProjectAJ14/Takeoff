# Schema reference

Every document Takeoff stores, sends to a director, or passes between packages
has a JSON Schema in `packages/contracts/src/schemas/`. The TypeScript types in
`packages/contracts/src/types.ts` mirror them by hand. If the two ever disagree,
the schema wins. This page lists the field names exactly as they appear in the
schemas. For how the compiler uses a plan, see [timeline.md](timeline.md).

## Validate a document

```ts
import { validate, contractKinds } from '@takeoff/contracts';

const r = validate('edit-plan', JSON.parse(text));
if (r.ok) use(r.value);                  // typed as EditPlan
else for (const e of r.errors) console.log(e.path, e.message);
```

- `validate(kind, value)` runs Ajv 2020-12 with `strict`, `allErrors` and
  `discriminator` enabled. It returns `{ ok: true, value }` or
  `{ ok: false, errors }`. Each error has a JSON Pointer `path` (`''` for the
  root) and a `message`. A rejected extra property puts its name in the message.
- An unknown `kind` throws `unknown contract kind`.
- `validate` checks the schema only. Semantic rules, such as whether a span fits
  inside its source, are listed under
  [What the compiler checks](#what-the-compiler-checks-instead).

The 19 kinds (`contractKinds`) are `edit-plan`, `patch`, `transcript`,
`asset-manifest`, `compiled-timeline`, `brand-profile`, `style-profile`, `job`,
`qa-report`, `provider-receipt`, `export-manifest`, `capabilities`,
`create-project-request`, `create-project-response`, `import-assets-request`,
`import-assets-response`, `create-job-request`, `director-request` and
`director-response`.

Each kind has at least one valid fixture in
`packages/contracts/fixtures/valid/<kind>/` and at least one invalid fixture in
`fixtures/invalid/<kind>/`. Each invalid file breaks one rule, and its file name
says which rule. `docs/example-edit-plan.json` must validate, and it must stay
byte-equal to `fixtures/valid/edit-plan/example-edit-plan.json`.

```sh
node --test "packages/contracts/test/**/*.test.ts"
```

## Shared rules (`common.schema.json`)

| Definition | Rule |
|---|---|
| `schemaVersion` | Must be the constant `"1.0"`. Every top-level document needs it. |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`, so an id can't hold `/` or spaces |
| `idList` | Up to 1000 unique `id`s |
| `us` / `frame` / `sample` / `count` / `revision` | Integer, 0 to 2^53−1 |
| `rational` | `{num, den}`, both integers from 1 to 2147483647 |
| `sha256` | 64 lowercase hex characters |
| `relPath` | 1–512 chars of `[A-Za-z0-9._/-]`, with no leading `/`, no drive letter, no backslash and no `..` segment |
| `timestamp` | UTC ISO-8601 ending in `Z`, with optional fractional seconds up to 9 digits |
| `hexColor` | `#RRGGBB` |
| `shortText` / `message` | 1–200 / 1–2000 characters |
| `version` | 1–64 chars, `^[A-Za-z0-9][A-Za-z0-9_.+-]*$` |
| `code` | `^[a-z][a-z0-9_]{0,63}$` |
| `httpsUrl` | `https://` only, up to 2048 chars |
| `gainDb` | Number from −60 to 12 |
| `error` | `{code, message, remedy}` |
| `warning` | `{code, message, refs}` |

Enums: `severity` is `critical` \| `warning` \| `info`. `confidenceTier` is
`high` \| `medium` \| `low`. `assetKind` is `video` \| `audio` \| `image`.
`networkPolicy` is `local_only` \| `approved_providers`. `checkStatus` is `passed`
\| `failed` \| `skipped` \| `not_run`. `jobStage` is `Prepare`, `Transcribe`,
`Clean speech`, `Plan visuals/audio`, `Build graphics`, `Render preview`,
`Check quality` or `Export`. `featureId` runs from `F01` to `F17`.
`providerDataType` is `transcript`, `frames`, `audio`, `video`, `asset_query`,
`asset_download`, `prompt` or `brand_page`.

Critical objects set `additionalProperties: false`, so an unknown field is an
error. An unknown enum value is also an error.

## Clocks

No field mixes two clocks. The suffix tells you the unit.

| Suffix | Clock | Example |
|---|---|---|
| `Us` | Source time in integer microseconds | `sourceStartUs` |
| `Frame` / `Frames` | Output video time in integer frames at `output.fps` | `startFrame`, `durationFrames` |
| `Sample` / `Samples` | Output audio time in integer samples at 48 kHz | `startSample` |

Every interval is half-open: `[start, end)`. Every time is an integer ≥ 0, with
one exception: `anchor.offsetFrames` is a signed delta between −900 and 900.
`output.audioSampleRate` and `compiled-timeline.sampleRate` must both be the
constant `48000`.

## `edit-plan`

An edit plan is the whole edit as data. It has these required top-level
fields: `schemaVersion`, `projectId`, `revision`, `output`, `settings`,
`assets` (max 500), `transcriptRef`, `styleProfileRef` (each a `relPath` or
`null`), `brandProfileRef` (a `relPath`, one stored brand version
`brands/<id>@<version>` with version ≥ 1, or `null`), `decisions` (max 5000), `segments` (max 2000),
`captions` (max 2000), `visuals` (max 100), `transforms` (max 500), `audio`,
`reviewMarkers` (max 1000) and `provenance`. The full example is
[example-edit-plan.json](example-edit-plan.json).

| Object | Fields and limits |
|---|---|
| `output` | `width`, `height` (16–7680), `fps` (rational), `audioSampleRate` (`48000`), `colorSpace` (`bt709`), `targetFrames` (≥1 or `null`), `lengthPolicy` (`hard_max` \| `soft_target` \| `none`) |
| `settings` | Required booleans: `badTakes`, `fillers`, `silence`, `captions`, `userBroll`, `aiBroll`, `zoom`, `music`, `sfx`, `studioVoice`, `autoColor`, `textHook`, `motionGraphics`. Also required: `networkPolicy`. Optional: `fillerStrength` (`conservative` \| `normal` \| `aggressive`), `targetSeconds` (integer 1–3600 or `null`), `hook` `{autoSelect, text}` (text 1–120 chars or `null`), `fillerDictionary` `{preserve, remove}` (each ≤ 200 strings of 1–40 chars; preserve wins) |
| `assets[]` | `id`, `kind`, `manifestRef` (`relPath`) |
| `decisions[]` | `id`, `assetId`, `action` (`remove` \| `keep` \| `review`), `sourceStartUs`, `sourceEndUs`, `reason`, `evidenceIds`, `confidenceTier`. Optional: `wordIds`, `detector`, `locked` |
| `segments[]` | `id`, `assetId`, `sourceStartUs`, `sourceEndUs`, `wordIds`, `speed` (rational), `cropPolicy` (`face_safe_vertical` \| `center` \| `manual`), `locked` |
| `captions[]` | `id`, `segmentId`, `wordIds` (1–12 unique), `text` (1–200), `template` (`restrained` \| `energetic` \| `static`), `emphasisWordIds` (≤12), `positionPolicy` (`safe_face_aware` \| `safe_bottom` \| `safe_top`), `locked` |
| `anchor` | `wordId`, `edge` (`start` \| `end`), `offsetFrames` (−900 to 900) |
| `visuals[]` | Discriminated by `kind`. Every visual has `id`, `segmentId`, `anchor`, `durationFrames` (1–108000), `evidenceIds`, `fallback` (`omit` \| `presenter_only` \| `static_card`) and `locked` |
| ↳ `motion_template` | `template` plus typed `params`: `kinetic_text_v1` takes `{lines}` (1–4 labels). `request_flow_v1` takes `{containerLabel, internalNode, externalNode, edgeLabel}`. `comparison_list_v1` takes `{title, items}` (2–6 items). A label is 1–60 chars |
| ↳ `broll` | `assetId`, `sourceStartUs`, `sourceEndUs`, `layout` (`full` \| `inset` \| `split`). Optional `reason` (1–200 chars): why it was placed |
| ↳ `hook_text` | `text` (1–120 chars) and `evidenceIds` (at least 1) |
| `transforms[]` | Discriminated by `kind`. A `punch` has `id`, `segmentId`, `anchor`, `scale` (1–1.25), `centerPolicy` (`tracked_face` \| `center`), `transitionFrames` (0–60), optional `durationFrames` and `locked`. A `crop` has `id`, `segmentId`, `rect` `{x, y, width, height}` (fractions of the source frame) and `locked` |
| `audio` | `dialogue` `{profile: studio_conservative \| studio_strong \| bypass, seamFadeMs: 0–100}`. `music` is `null` or `{assetId, startFrame, durationFrames, gainDb, duckUnderDialogue, fadeInFrames, fadeOutFrames, locked?}`, with fades of 0–600 frames. `sfx[]` (max 100) holds `{id, assetId, anchor, category: ui_click \| hit \| whoosh, gainDb, visualId?, locked}`. `mixTarget` is `{integratedLufs: −40 to −5, truePeakDbtp: −12 to 0}` |
| `reviewMarkers[]` | `id`, `kind` (`uncertain_retake`, `meaning_risk`, `alignment_uncertain`, `duration_conflict`, `low_confidence_crop`, `visual_unavailable`, `orphaned_anchor`, `unsupported_claim`, `source_clipping`), `severity`, `message`, `refs` |
| `provenance` | `director` (`version`), `seed` (uint32), `promptVersion` (`version` or `null`) |

## `patch`

A patch is `{schemaVersion, baseRevision, ops}` with 1 to 200 ops. Each op is a
closed object, and the `op` field picks which one. No op carries code, a shell
command or an FFmpeg filter string. The invalid fixtures `run-shell-op` and
`ffmpeg-filter-string` prove that.

| `op` | Fields |
|---|---|
| `restore_span` | `assetId`, `sourceStartUs`, `sourceEndUs` |
| `remove_span` | `assetId`, `sourceStartUs`, `sourceEndUs`, `reason` |
| `replace_take` | `segmentId`, `assetId`, `sourceStartUs`, `sourceEndUs`, `wordIds` |
| `set_caption` | `captionId`, plus at least one of `text`, `wordIds`, `emphasisWordIds`, `template`, `positionPolicy` |
| `set_crop` | `segmentId`, `rect` |
| `replace_asset` | `targetId`, `assetId` |
| `set_gain` | `targetId`, `gainDb` |
| `lock_object` / `unlock_object` | `objectId` |
| `set_setting` | `key` and `value`, typed per key: a boolean toggle, `networkPolicy`, `fillerStrength`, `targetSeconds` or `hook` |
| `reorder_segment` | `segmentId`, `toIndex` (0–1999) |
| `split_segment` | `segmentId`, `atSourceUs`, `newSegmentId` |
| `trim_segment` | `segmentId`, `sourceStartUs`, `sourceEndUs` |
| `remove_visual` | `visualId` |
| `set_hook` | `text` (1–120 or `null`), `evidenceIds` |

[timeline.md](timeline.md#patches) describes what each op does.

## `transcript`

| Field | Rule |
|---|---|
| `assetId`, `sourceHash`, `configHash` | `id`, `sha256`, `sha256` |
| `backend` | `faster_whisper` \| `whisper` \| `whisperx` \| `whisper_cpp` \| `manual` |
| `model`, `version` | `version` strings |
| `language` | `^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$` |
| `words[]` (max 100000) | `id`, `text` (1–100, raw ASR text, never overwritten), `correctedText` (or `null`), `sourceStartUs`, `sourceEndUs`, `score` (number or `null`, a raw engine score rather than a calibrated probability), `alignment` (`aligned` \| `estimated` \| `failed`), `speaker` (or `null`) |
| `sentences[]` (max 20000) | `id`, `startWordId`, `endWordId`, `rawText`, `correctedText` |
| `provenance` | `createdAt`, `glossaryHash` (or `null`), `vad` (or `null`), `alignment` (or `null`) |

## `asset-manifest`

| Field | Rule |
|---|---|
| `id`, `kind`, `contentHash`, `relativePath` | `relativePath` is a `relPath`, so it is always project-relative |
| `probe` | `durationUs` (or `null`). `video` is `null` or `{width, height (1–16384), rotation (0/90/180/270), fpsNum, fpsDen (or null), vfr, codec, colorTransfer, colorPrimaries, pixFmt}`. `audio` is `null` or `{sampleRate (1–768000), channels (1–64), codec}` |
| `derived` | `proxy`, `analysisWav`: each a `sha256` or `null` |
| `rights` | `origin` (`user` \| `bundled` \| `stock` \| `generated`), `license`, `attribution`, `sourceUrl` (an `https` URL or `null`) |
| `provenance` | `importedAt`, `importer` |
| `permissionScope` | `networkPolicy` |

## `compiled-timeline`

The compiler produces this; nothing else does. Its required fields are
`schemaVersion`, `planHash`, `compilerVersion`, `fps`, `width`, `height`,
`totalFrames`, `sampleRate` (`48000`), `totalSamples`, `segments`, `captions`,
`visuals`, `transforms`, `audioEvents` and `warnings`.

| Array | Item fields |
|---|---|
| `segments` | `segmentId`, `assetId`, `sourceStartUs`, `sourceEndUs`, `outputStartFrame`, `outputEndFrame`, `outputStartSample`, `outputEndSample` |
| `captions` | `captionId`, `startFrame`, `endFrame`, `words[]` (1–12 `{wordId, startFrame, endFrame}`) |
| `visuals` | `visualId`, `kind`, `startFrame`, `endFrame` |
| `transforms` | `transformId`, `kind` (`punch` \| `crop`), `startFrame`, `endFrame` |
| `audioEvents` (max 5000) | `id`, `kind` (`dialogue` \| `music` \| `sfx`), `assetId`, `startSample`, `endSample`, `gainDb` |
| `warnings` | `warning` objects |

## Other kinds

| Kind | Purpose and notable rules |
|---|---|
| `job` | `id`, `projectId`, `stage`, `profile` (`draft` \| `final`), `state` (`queued`, `running`, `waiting_for_user`, `succeeded`, `failed`, `canceled`), `progress` (0–1, or `null` when the stage can't be measured), `baseRevision`, `idempotencyKey`, `attempts`, `createdAt`, `updatedAt`, `error` (`error` or `null`), `artifacts[]` (`{kind, ref, hash}`, max 100) |
| `create-job-request` | `stage`, `profile`, `baseRevision`, `idempotencyKey` (`^[A-Za-z0-9_-]{8,128}$`) |
| `create-project-request` / `-response` | Request: `name`, optional full `settings`. Response: `projectId`, `revision` |
| `import-assets-request` / `-response` | Request `items` (1–100) are `{source: "path", path}` (1–4096 chars) or `{source: "upload", uploadId}`. This `path` is the only field in any schema that holds a local path; the engine resolves it under approved roots. Response `items` are `{assetId, jobId}` |
| `director-request` | `projectId`, `revision`, `output`, `settings`, `words[]` (`{id, assetId, text, sourceStartUs, sourceEndUs, alignment}`), `candidates[]` (`{id, kind: filler \| silence \| retake \| false_start, assetId, sourceStartUs, sourceEndUs, wordIds, evidence, confidenceTier}`), and `brand` (`{name, hookTone, motionIntensity, glossary, prohibitedClaims}` or `null`). There is no path field |
| `director-response` | `decisions`, `segments`, `captions`, `visuals`, `transforms`, `reviewMarkers`, `provenance` (same rules as in `edit-plan`), plus `hookOptions` (max 3, each `{text, evidenceIds}` with at least 1 evidence id) |
| `brand-profile` | Palette (1–16 roles), fonts (≤6, each with `license`), logos, `captionStyle`, `hookTone`, glossary, `prohibitedClaims`, `motionIntensity`, `safeLayouts`, music and sfx bans, `ctaTemplates`, `aspectPresets`. `provenance.sourceUrl` must be `https` |
| `style-profile` | Pace, shot-duration percentiles in `Us`, typography, text density, palette, framing, motion, `transitionsPerMinute`, audio, `confidence` (0–1), `disabledTraits` |
| `qa-report` | `issues[]` (`{id, severity, check, objectRef, frame, span, evidence, suggestedPatch?}`, where `suggestedPatch` must be a valid `patch`) and `checks[]` (`{name, status, detail}`) |
| `provider-receipt` | `provider`, `dataType`, `purpose`, `sentAt`, `bytes`, `estimatedCostUsd` (0–100000 or `null`), `retentionPolicyUrl` (`https` or `null`) |
| `export-manifest` | `preset` (`mp4` / `h264` / `aac` / `bt709`, `burnCaptions`), `durationFrames`, `outputs[]` (1–50 of `video`, `srt`, `vtt`, `caption_json`, `project_bundle` or `stem`, each with a `relPath`, `sha256` and `bytes`), `checks`, `unresolvedWarnings` |
| `capabilities` | `appVersion`, `networkPolicy`, `models[]` (kind `asr`, `vad`, `alignment` or `director`), `devices[]` (`cpu`, `cuda` or `metal`), `codecs`, `providers[]`, and `features[]` (≤17 `{id, status: available \| experimental \| unavailable, reason}`) |

## What the schema checks

- Shapes, required fields, closed objects and enums.
- Integer clocks and numeric bounds: punch `scale` from 1 to 1.25, `gainDb` from
  −60 to 12, crop rect values from 0 to 1, and `offsetFrames` within ±900.
- Count caps: 100 visuals, 2000 segments and 2000 captions, 500 assets, 12
  caption words, 3 hook options and 200 patch ops.
- Portable paths and lowercase hashes.
- Motion-template `params` that match their `template`.

## What the compiler checks instead

These rules need more than one field or outside context, so they belong to
`validatePlan` in `packages/compiler`:

- `end > start` for every span.
- Spans that fit inside the source duration.
- Asset ids that resolve to a manifest, with a kind that fits the role.
- Word ids that exist in the transcript and lie inside their segment.
- Caption words that survive the cut.
- Anchors that resolve.
- Tracks that fit the timeline.
- Locked speech compared against a hard maximum length.

[timeline.md](timeline.md#validateplan) lists every error code.
