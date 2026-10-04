# Feature status

What the code does today for each editing toggle (F03–F17).

- **CLI route: works.** The `takeoff` CLI (and the MCP tools and HTTP API behind
  it) runs the whole local route: import, transcribe, edit, render, QA and
  export. `packages/engine/test/e2e/run-e2e.ts` runs it on synthetic footage with
  every P0 toggle on. See [agents.md](agents.md) and [engine.md](engine.md).
- **Desktop app: in progress.**

Status words below:

- **Works**: reachable through the CLI and rendered into the export.
- **Partial**: works, with the limits named.
- **Unavailable**: no code.

The toggles are the `settings` booleans in an edit plan (see
[schema.md](schema.md#edit-plan)). They have no defaults in code: the first
`init`/`edit` (or `propose_edit`) must set every one. `takeoff capabilities`
reports each feature as `available`, `experimental` or `unavailable` for the
machine it runs on, with a reason. Ingest (F01) and transcription (F02) are in
[media.md](media.md).

| ID | Feature | Setting | Status | What exists now |
|---|---|---|---|---|
| F03 | Bad takes and retakes | `badTakes` | Partial | Retakes and false starts within one asset (`detectRetakes`). Only `high` false starts are cut automatically; others become review decisions with an `uncertain_retake` marker. With an Ollama model the director may accept medium candidates. Grouping takes across files is unavailable. Capabilities: `experimental` without an Ollama model |
| F04 | Filler removal | `fillers`, `fillerStrength` | Works | Hesitations and context-checked discourse markers at three strengths (`detectFillers`), cut from video and audio |
| F05 | Silence and dead air | `silence` | Works | Gaps ≥ 700 ms cut to a 300 ms pause; leading and trailing dead air trimmed to 150 ms; cut edges move out of VAD speech (`detectSilences`) |
| F06 | Animated captions | `captions` | Partial | Captions are grouped by the director, timed from word ids, fitted on measured glyph bounds to ≤ 2 lines in the safe caption box, and burned in with `restrained`, `energetic` or `static` templates (the director uses `restrained`; edit defaults' `captionTemplate` over HTTP picks another) and active-word highlight ([rendering.md](rendering.md#scenes-and-templates)). Export writes SRT, VTT and word-timed JSON. A caption that leaves its box is switched to `static` by QA repair. `safe_face_aware` uses the bottom slot because there is no face tracking |
| F07 | User B-roll | `userBroll` | Partial: render only | The renderer composites `broll` visuals (`full`, `inset`, `split`) from an image or video. Nothing selects or places B-roll: the director adds none and no patch op adds a visual. Capabilities: `unavailable` |
| F07 | AI B-roll | `aiBroll` | Unavailable | No code |
| F08 | Punch zooms | `zoom` | Partial | Centre punch zooms on emphasis words (1.08–1.15, 1.5 s hold, ≤ 4 per 30 s), eased in over 4 frames, scale capped at 1.25 (edit defaults' `zoomMaxScale` lowers the cap over HTTP). Face-aware zooms (`tracked_face`) zoom on the centre: there is no face tracking. Capabilities: `experimental` |
| F09 | Background music | `music` | Works, after the starter pack | Music comes from the project's `music` pool or else the generated starter-pack library (`Takeoff original, generated`). It loops under the whole timeline at −18 dB with fades and is ducked under dialogue with a sidechain compressor. The library pick is always its first bed (`bed_calm`). No mood selection; no AI-generated music. Capabilities: `unavailable` until a library is installed |
| F10 | Sound effects | `sfx` | Partial | One cue per motion template at −12 dB, from the project's `sfx` pool or the library. The library pick is always its first effect, so the `whoosh` cue plays `sfx_ui_click` |
| F11 | Studio voice | `studioVoice` | Works | High-pass 80 Hz, FFT denoise, de-esser and compressor, then two-pass `loudnorm` to the plan's target (−14 LUFS, −1 dBTP) and a limiter 1 dB under the true-peak target. QA measures loudness and true peak. Silence is never normalised |
| F12 | Auto color correction | `autoColor` | Works (SDR) | `analyzeColor` computes one bounded correction per source, applied as `eq` and `colorbalance`. HDR sources are left uncorrected |
| F13 | Text hooks | `textHook`, `hook` | Works | Up to three verbatim-derived hook options with evidence word ids; the chosen one renders as a 3 s `hook_text` box at the top of the safe area. `set_hook` patches set or clear it |
| F14 | Target video length | `targetSeconds` (+ `output.targetFrames`, `lengthPolicy`) | Works | The director drops low-priority middle sentences to meet the target. The compiler enforces `hard_max` and warns on a missed `soft_target`. Speed changes are unavailable (`speed_unsupported`) |
| F15 | Motion graphics | `motionGraphics` | Partial | `request_flow_v1` and `comparison_list_v1` fire on deterministic word patterns with transcript-verbatim labels and render as seekable scenes. `kinetic_text_v1` renders when a plan has one, but the director never adds it. Generated scenes are unavailable |
| F16 | Reference style analysis | (none) | Unavailable | Only the `style-profile` schema exists |
| F17 | Brand profiles | (none) | Partial: HTTP API only | `POST /v1/projects/{id}/brands` stores versioned profiles, and edit defaults with a `brandProfileId` make Edit Video use its glossary, prohibited claims, palette and (when the family is one of the bundled fonts) fonts. The CLI and MCP cannot save or select one. Website analysis is unavailable |

## Network policy

Every project is Local only unless its provider policy says otherwise, and no
shipped command can change that yet. [privacy.md](privacy.md) lists what the code
enforces and what it does not.
