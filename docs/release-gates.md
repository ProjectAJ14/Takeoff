# Release gates

Where each PRD §18 release gate stands, with the test or script that is the
evidence. "Met" means the evidence covers the whole pass condition; "partially
met" names what is missing. Nothing here is waived because output looks good.

Status words: **met**, **partially met**, **not met**, **not done**.

| Gate | PRD pass condition (short) | Status | Evidence | What is missing |
|---|---|---|---|---|
| Complete workflow | First-run model setup → raw footage → validated draft → MP4, no paid service | Partially met | CLI: `packages/engine/test/e2e/run-e2e.ts` (starter pack, import, edit with every P0 toggle, brand, B-roll, `render --final`, export). App: `packages/app/test/e2e/ui-e2e.ts` drives first run to export | The app route has no installer, so "first run" means a source checkout. `ui-e2e.ts` is not run in CI |
| Screenshot-inspired UX | Every toggle name and purpose shown; one primary action; unavailable modules explained | Partially met | `packages/app/test/electron.smoke.test.ts` (13 toggles as keyboard-operable switches, first-run statuses); `logic.test.ts` (availability, disabled toggles sent as `false`) | The manual pass at 1440/1200/900 px, 200% zoom, both grounds and keyboard only needs a reviewer; `ui-e2e.ts` saves the screenshots but nobody has signed them off |
| Meaning preservation | No critical semantic change on a labeled corpus; ≥ 95% precision in automatic retake/filler deletion | Not met | Detector unit tests (`packages/director/test/detectors.test.ts`, `plan.test.ts`); `packages/engine/test/e2e/hard-case-e2e.ts` (negation, number, "I like this", cross-take false start, punchline pause) on synthetic speech | No labeled release corpus exists, so precision has not been measured |
| Caption/crop correctness | F06/F08 timing, layout and face requirements; safe fallback when uncertain | Partially met | Caption fit and safe-area checks (`packages/renderer-browser/test/`); face framing and the byte-identical no-face path (`face.test.ts`); track smoothing and the no-face CLI (`workers/transcribe/tests/test_faces.py`); QA `face_crop` (`packages/engine/test/wiring.test.ts`) | Face detection is not tested on real faces. Generated punch zooms do not use `tracked_face` |
| Determinism | Same plan and environment → same schedule and frames; out-of-order seeking passes | Met in the pinned environment | `packages/renderer-browser/test/overlay.test.ts`: golden frames and the `[40, 3, 77, 3, 40]` seek order | Golden frames exist only for macOS arm64 |
| Media integrity | Full decode, no missing frames, correct size/rotation/colour, A/V offset ≤ 1 frame | Partially met | QA checks `decode`, `duration_frames`, `dimensions`, `frame_rate`, `color_tags`, `audio_samples` ([engine.md](engine.md#qa)); `run-e2e.ts` uses a rotated portrait MP4 and checks decoded frames = compiled frames | A/V offset at start and end is not measured directly; `audio_samples` checks the total length to within one frame |
| Audio | No introduced clipping or pops; loudness/peak targets met or a stated source limit; mute controls honoured | Partially met | `run-e2e.ts` (−14 ±1 LUFS, true peak ≤ −1 dBTP); `hard-case-e2e.ts` (no sample step at any seam of the dialogue stem or mix); `source_clipping` marker (`plan.test.ts`) | Only synthetic speech; no listening test |
| Editability | Restore, trim, split, reorder, caption fix, visual replacement, gain, undo/redo, locks, reopen | Partially met | Patch ops and locks (`packages/compiler/test/`, `packages/project-store/test/store.test.ts`, `packages/engine/test/`); `ui-e2e.ts` covers restore, undo, caption edit and lock in the app | Trim, split, reorder, visual replacement and reopen are not driven through the app by any test |
| Recovery | Kill app/worker in every stage; resume without source loss or repeated analysis; disk-full and cancel fixtures | Partially met | `packages/engine/test/recovery.test.ts`: SIGKILL of the CLI during Transcribe and during Render preview, rerun from cache, no partial recorded, source hash unchanged; cancel mid-render; disk full at export | Only two of the seven stages are killed; the desktop app is never killed |
| Privacy/security | Offline trace shows no content egress; malicious reference/scene/path fixtures cannot reach credentials, files or network | Partially met | `packages/engine/test/egress.test.ts`: zero non-loopback attempts over the whole local route, and the external director refused in `local_only`; renderer request audit (`undeclared_network`); Chromium sandbox on; approved-path tests | The trace is in-process only (subprocesses are covered by their own tests, not one OS-level trace). Reference pages and generated scenes do not exist yet, so their fixtures do not either |
| Performance | Report a benchmark against §12; unmet targets change the implementation or the claims | Partially met | `scripts/benchmark.ts`; results in [benchmarks.md](benchmarks.md): every measured row passed on one Apple M4 Pro | The motion-scene rows rendered no motion scenes; no Windows/Linux/CUDA machine; UI response, preview frame rate, cancel time and RAM not measured |
| Licensing | Exact shipped dependencies, models, fonts, media and binaries inventoried with notices | Partially met | [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | Rows marked **verify** are unconfirmed, including the GPL `libx264`/`libx265` libraries inside the PyAV and OpenCV wheels. The final inventory depends on what a package ships |
| User value | Pilot: ≥ 80% acceptable drafts with ≤ 5 corrective actions | Not met | — | Not run: needs a real pilot with real recordings |
| Packaging | (PRD §17 deliverable, needed to ship) | Not done | — | Distribution and license decision pending (PRD §23): no installer, signing or update channel |

## Known issue that affects a gate

- **F14 hard maximum.** When the opening and closing speech alone exceed a hard
  maximum, the plan is a longer draft with a `locked_duration_conflict` warning.
  The compiler's `isExportBlocking` marks it as blocking final export, but
  `Engine.exportProject` does not call it, so such a draft exports with the
  warning listed in `unresolvedWarnings`.
