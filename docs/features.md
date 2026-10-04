# Feature status

What the code does today for each editing toggle (F03–F17).

- **CLI route: works.** The `takeoff` CLI (and the MCP tools and HTTP API behind
  it) runs the whole local route: import, transcribe, edit, render, QA and
  export. `packages/engine/test/e2e/run-e2e.ts` runs it on synthetic footage with
  every P0 toggle on, a tagged B-roll image and a brand with a logo. See
  [agents.md](agents.md) and [engine.md](engine.md).
- **Desktop app: works on macOS from a source checkout.** First run, create,
  processing, review and export run against the same engine. There is no
  installer yet. See [app.md](app.md).

Status words below:

- **Works**: reachable through the CLI or the app and rendered into the export.
- **Partial**: works, with the limits named.
- **Unavailable**: no code.

The toggles are the `settings` booleans in an edit plan (see
[schema.md](schema.md#edit-plan)). They have no defaults in the engine: the first
`init`/`edit` (or `propose_edit`, or the app's Create screen) must set every one.
`takeoff capabilities` reports each feature as `available`, `experimental` or
`unavailable` for the machine it runs on, with a reason. Ingest (F01) and
transcription (F02) are in [media.md](media.md).

| ID | Feature | Setting | Status | What exists now |
|---|---|---|---|---|
| F03 | Bad takes and retakes | `badTakes` | Partial | Within one take: retakes and false starts (`detectRetakes`). Across takes: a sentence in an earlier take whose first 4 words open a sentence in a later take is a lexical match; an unfinished attempt or one with a restart cue ("let me start again") is a `high` false start and is cut, any other difference is a review. Only `high` candidates are cut automatically; the rest become review decisions with an `uncertain_retake` marker. No semantic matching: a reworded retake in another take is not grouped. With an Ollama model the director may accept medium candidates. Capabilities: `experimental` without an Ollama model |
| F04 | Filler removal | `fillers`, `fillerStrength`, `fillerDictionary` | Works | Hesitations (including a standalone "Ah," or "Mm") and context-checked discourse markers at three strengths (`detectFillers`), cut from video and audio. A custom dictionary (`settings.fillerDictionary`, up to 200 entries each of "always keep" and "always cut") overrides them: a keep entry always wins, a cut entry adds a candidate. The app edits it in the Fillers row |
| F05 | Silence and dead air | `silence` | Works | Gaps ≥ 700 ms cut to a 300 ms pause; leading and trailing dead air trimmed to 150 ms; cut edges move out of VAD speech (`detectSilences`). A pause before a short punchline ("the answer is… nothing") becomes a review, never an automatic cut |
| F06 | Animated captions | `captions` | Partial | Captions are grouped by the director, timed from word ids, fitted on measured glyph bounds to ≤ 2 lines in the safe caption box, and burned in with `restrained`, `energetic` or `static` templates and an active-word highlight ([rendering.md](rendering.md#scenes-and-templates)). Export writes SRT, VTT and word-timed JSON. A caption that leaves its box is switched to `static` by QA repair. `safe_face_aware` captions move to the top slot when a tracked face covers the bottom slot; without a confident face track they stay at the bottom |
| F07 | User B-roll | `userBroll` | Works | Your own images and clips from the `broll` pool, placed only where a tag (words from the file name, plus tags you add with `import --tags` or in the app) matches a spoken word in a kept sentence: 1.5–4 s, not in the first 1.5 s, at most one per 8 s, never over a motion graphic, each asset once. `inset` layout, or `full` for an image with two or more tag matches. Each placement records why (`reason`) |
| F07 | AI B-roll | `aiBroll` | Unavailable | No code. The app shows the toggle disabled |
| F08 | Punch zooms | `zoom` | Partial | Punch zooms on emphasis words (1.08–1.15, 1.5 s hold, ≤ 4 per 30 s), eased in over 4 frames, scale capped at 1.25. With face tracking (the worker's `faces` command, OpenCV Haar, offline) the 9:16 crop centres on the face. Generated zooms still use `centerPolicy: center`: a face-centred (`tracked_face`) zoom happens only in a plan that asks for one, and is capped at source resolution, so a 1080p landscape source gets none. Face detection is not tested on real faces (only the smoothing and the no-face path are) |
| F09 | Background music | `music` | Works, after the starter pack | A track from the project's `music` pool, else from the generated starter-pack library (`bed_calm`, `bed_pulse`, `bed_bright`, license `Takeoff original, generated`). It is picked by mood from the brief and the brand's moods (default calm), preferring a track long enough to cover the timeline. It runs under the whole timeline at −18 dB with 0.5 s / 1 s fades and is ducked under dialogue. No AI-generated music. Capabilities: `unavailable` until a library is installed |
| F10 | Sound effects | `sfx` | Works, after the starter pack | A `hit` on the hook and a `whoosh` on each motion graphic, at most one per 5 s, at −12 dB, from the project's `sfx` pool or the library. A category the brand bans is never used |
| F11 | Studio voice | `studioVoice` | Works | High-pass 80 Hz, FFT denoise, de-esser and compressor, then two-pass `loudnorm` to the plan's target (−14 LUFS, −1 dBTP) and a limiter 1 dB under the true-peak target. QA measures loudness and true peak. Silence is never normalised. Source clipping above 0.1 % adds a `source_clipping` review marker |
| F12 | Auto color correction | `autoColor` | Works (SDR) | `analyzeColor` computes one bounded correction per source, applied as `eq` and `colorbalance`. HDR sources are left uncorrected |
| F13 | Text hooks | `textHook`, `hook` | Works | Up to three options taken verbatim from what you said, each at most 9 words, cut at a clause boundary, never a sign-off, never ending on a function word, and dropped rather than overstated when a cut would lose a qualifier. The chosen one renders as a 3 s `hook_text` box. The app's review screen lists the options and allows a free edit (`set_hook`) |
| F14 | Target video length | `targetSeconds` (+ `output.targetFrames`, `lengthPolicy`) | Partial | The director drops low-priority middle sentences (a ≤ 2-word payoff goes with its setup) to meet the target. When the opening and closing alone exceed a hard maximum, the result is a longer draft with a critical `duration_conflict` marker and a `locked_duration_conflict` warning. The compiler marks that warning export-blocking (`isExportBlocking`), but the engine's export does not check it yet, so such a draft can still be exported. Speed changes are unavailable (`speed_unsupported`) |
| F15 | Motion graphics | `motionGraphics` | Partial | `request_flow_v1` and `comparison_list_v1` fire on deterministic word patterns with transcript-verbatim labels and render as seekable scenes. `kinetic_text_v1` renders when a plan has one, but the director never adds it. Generated scenes are unavailable |
| F16 | Reference style analysis | (none) | Unavailable | Only the `style-profile` schema exists |
| F17 | Brand profiles | (none) | Works (manual) | Used today: palette and caption highlight colour, a font file, a logo, glossary (ASR terms), music moods, banned music/SFX categories and prohibited claims. The brand's caption template and position, hook tone and motion intensity are stored but not applied (the caption style comes from the Create screen's Captions row or edit defaults' `captionTemplate`). Versions are immutable: a plan names `brands/<id>@<version>`, so a later version never changes an old render. A missing font file falls back to Inter and the render report says so. The logo is drawn in the top-right of the safe area. A hook or graphic label containing a prohibited phrase is removed, or, when locked, blocks the render. Set one with `takeoff brand`, the HTTP API or the app. Website analysis is unavailable |

## Network policy

Every project is Local only unless its provider policy says otherwise. Only the
desktop app's Settings screen can change that policy; no CLI, MCP or HTTP call
can. [privacy.md](privacy.md) lists what the code enforces and what it does not.
