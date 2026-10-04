# Feature status

What the code does today for each editing toggle (F03–F17). Nothing here is
available to an end user yet:

- There is no app and no end-to-end pipeline.
- Nothing renders or exports video. The browser renderer is in progress (see
  [rendering.md](rendering.md)).

"Library" below means the behaviour exists as tested package code that can only
be called from code.

The toggles are the `settings` booleans in an edit plan (see
[schema.md](schema.md#edit-plan)). They have no defaults in code: the schema
requires every one to be set explicitly. Ingest (F01) and transcription (F02)
are covered in [media.md](media.md).

| ID | Feature | Setting | Status | What exists now |
|---|---|---|---|---|
| F03 | Bad takes and retakes | `badTakes` | Library | Retake and false-start detection within one asset (`detectRetakes`). Only `high` false starts are cut automatically; others become review decisions with an `uncertain_retake` marker. Grouping takes across files is unavailable |
| F04 | Filler removal | `fillers`, `fillerStrength` | Library | Hesitations and context-checked discourse markers at three strengths (`detectFillers`) |
| F05 | Silence and dead air | `silence` | Library | Gaps ≥ 700 ms cut to a 300 ms pause; leading and trailing dead air trimmed to 150 ms (`detectSilences`). `@takeoff/media` `detectSilence` measures silence with FFmpeg |
| F06 | Animated captions | `captions` | Library: plan and timing only | The director groups caption words. The compiler times them from word ids. `captionBox` places them in the safe area. Caption rendering is unavailable until the browser renderer lands |
| F07 | User B-roll | `userBroll` | Schema and compiler only | `broll` visuals validate and compile, but nothing selects or places B-roll and nothing renders it |
| F07 | AI B-roll | `aiBroll` | Unavailable | No code |
| F08 | Punch zooms | `zoom` | Library: plan and timing only | Center punch zooms on emphasis words (1.08–1.15, 1.5 s hold, ≤4 per 30 s). The compiler caps scale at 1.25. Face-aware zooms (`tracked_face`) are unavailable because there is no face tracking. Nothing renders zooms |
| F09 | Background music | `music` | Library: plan only | A music cue is added only when the caller supplies a licensed asset id (−18 dB, ducking flag, fades). There is no music library, selection or mixing. Generated music is unavailable |
| F10 | Sound effects | `sfx` | Library: plan only | One `whoosh` cue per motion template when the caller supplies an asset id. There is no sfx library or mixing |
| F11 | Studio voice | `studioVoice` | Measurement only | `analyzeVoice` and `measureLoudness` measure clipping, DC offset, noise floor and loudness. The plan records the `studio_conservative` or `bypass` profile. Voice processing itself is unavailable |
| F12 | Auto color correction | `autoColor` | Measurement only | `analyzeColor` computes one bounded per-source correction. Nothing applies it yet |
| F13 | Text hooks | `textHook`, `hook` | Library: plan only | Up to three verbatim-derived hook options with evidence word ids. Patches can set or clear the hook (`set_hook`). Nothing renders the hook |
| F14 | Target video length | `targetSeconds` (+ `output.targetFrames`, `lengthPolicy`) | Library | The director drops low-priority middle sentences to meet the target. The compiler enforces `hard_max` (`hard_max_exceeded`, `locked_duration_conflict`) and warns on a missed `soft_target`. Speed changes are unavailable (`speed_unsupported`) |
| F15 | Motion graphics | `motionGraphics` | Library: plan only | Deterministic triggers for `request_flow_v1` and `comparison_list_v1`. The schema also accepts `kinetic_text_v1`. No scene renders any template yet. Generated scenes are unavailable |
| F16 | Reference style analysis | (none) | Unavailable | Only the `style-profile` schema exists. There is no analysis code |
| F17 | Brand profiles | (none) | Schema only | The `brand-profile` schema exists. The director reads `brand.glossary` and `brand.prohibitedClaims` from a director request. There is no brand editor or storage. Website analysis is unavailable |

## Network policy

`settings.networkPolicy` (`local_only` \| `approved_providers`) is enforced in
code in two places today:

- `ExternalDirector` refuses `local_only` projects before handing any request
  to its transport.
- The transcription worker never uses the network outside
  `download-model --allow-network`.

The provider broker that would send requests for `approved_providers` doesn't
exist yet.
