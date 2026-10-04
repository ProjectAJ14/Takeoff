# Takeoff Product Requirements Document

Version 1.0 • 4 October 2026 • Status: implementation baseline for prototype and MVP

Takeoff is a local-first application that turns raw talking-head recordings into polished, editable Reels and Shorts. Users add footage, choose editing toggles, and click **Edit Video**. An AI director makes editorial choices in a structured plan; validated deterministic code executes those choices. The result includes an MP4, an editable project, captions, assets, and an explanation of uncertain edits.

The implementation should begin with a narrow, complete workflow rather than a general-purpose professional editor. Reuse media and transcription infrastructure, selectively adapt existing editor components, and build the editorial contract, privacy controls, reliability, and original motion system as product-owned modules. Motion.so and What Ships are inspiration and reference sources, never required services.

## 1 Product vision and positioning

**Vision:** make recording the main work of publishing an educational or creator-style short. Reduce repetitive editing while preserving the speaker's meaning, voice, and ability to change every important decision.

**Product promise:** “Drop in your takes, choose your edits, get a polished short you can still change.” One-click describes orchestration, not a guarantee that every recording needs no review. Quality takes precedence over blindly reaching a duration or adding every effect.

The first audience is solo creators and technical educators producing explanatory talking-head content. The differentiator is original, transcript-aware explanatory motion: a Flutter/Dio/API explanation can become a timed SVG request-flow animation instead of unrelated programmer stock footage. The product combines speech cleanup, creator polish, brand consistency, reference-informed style, and an inspectable timeline.

Position against three categories: manual NLEs require editing expertise; caption/auto-cut tools automate only part of the job; prompt-to-video services often hide the project and depend on hosted generation. This product provides a complete local pipeline, optional external intelligence, and editable outputs. It does not promise virality, replace senior creative judgment, or restore irreparably damaged recordings.

**Business assumptions, not prior decisions:** begin with a downloadable desktop product; keep the core runnable without paid video-editing SaaS. Commercial packaging, application license, paid support, and optional cloud execution remain separate business decisions. A free core does not mean local AI requires no capable hardware, or that optional Codex/Claude usage is free.

## 2 Research provenance and preserved decisions

The referenced chat is [Research Free Video Tools](chatgpt-conversation://6ac2503f-9368-83ee-a646-05d5c1cd572e). The reader returned five turns, no older cursor, and one attachment. The attachment was inspected: its three columns are **Select your video(s) to edit**, **Choose the edits you want**, and **Edit in one click**. It contains bad takes, fillers, silence/dead air, animated captions, AI-found B-roll, own B-roll, zooms, background music, sound effects, studio sound, auto color, text hook, and target length. Its pictured defaults are mostly enabled, with own B-roll and text hook disabled. The product adopts the interaction pattern; its visual identity and cautious defaults are original.

Important recovered decisions:

- Build a talking-head-to-Reel tool with a simple toggle surface and an agent behind it.
- Use local Whisper-family transcription, word timing, FFmpeg processing, browser motion, and a deterministic composition layer.
- Make an intermediate edit plan the boundary between editorial reasoning and execution.
- Keep the project editable; do not deliver only a black-box MP4.
- Investigate AutoBroll as the UI/timeline starting point and NextWork as editorial workflow inspiration. The chat's proposed combination was AutoBroll + NextWork intelligence + Faster-Whisper + FFmpeg + Remotion + HTML/HyperFrames + Claude/Codex.
- Prefer coded HTML/CSS/SVG/GSAP explanations to automating DaVinci as the primary engine.
- Add motion graphics as a toggle; choose them when they explain an abstract concept better than stock B-roll.
- Add reference-video analysis and brand analysis as inputs to the AI director.
- Extract pacing, typography categories, motion language, transitions, composition, and sound characteristics from references, then make original graphics.
- Treat What Ships as launch-video discovery and Motion.so as product inspiration.

The chat also mentioned EverythingAI, FFmpeg Wizard, video-use, VibeClip, Kaestral, claude-motion-design, and bang-motion. OpenCut, official Remotion skills, interchange design, and several architecture details below are included in response to this PRD request, not represented as recovered historical decisions.

**Evidence limits:** older research, if any, was not exposed. Repository README claims were checked but code was not run or audited. Prior statements that every feature was already solved, that all tools were entirely local/free, and that an author's workflow completed in about 90 seconds are not product evidence. The 90-second example is an author report, not our performance commitment. VibeClip/Kaestral and unnamed What Ships launch entries remain research leads rather than selected dependencies.

## 3 Users and use cases

| User | Job | Successful outcome |
|---|---|---|
| Technical educator | Turn a rough explanation into a clear short | Correct terminology, readable captions, original diagrams, clean speech |
| Founder or product marketer | Explain a feature or launch | Consistent branding, actual product assets, strong but accurate hook |
| Coach or knowledge creator | Publish regularly from several takes | Best complete takes, natural pacing, reliable voice cleanup |
| Editor assisting creators | Automate first assembly | Inspectable decisions, locked manual edits, transferable media |
| Privacy-conscious creator | Edit sensitive recordings locally | No footage/transcript upload without explicit project authorization |

Primary journey: one or several recordings totaling up to 10 minutes → one coherent 15–90-second vertical short. Secondary journeys: polish a preselected take without shortening it; assemble multiple retakes; explain a technical concept with motion; repeat a brand style; import own B-roll; adjust a completed draft; use an external coding agent through the same project tools.

## 4 Goals and non-goals

Goals for P0 are a complete offline-capable route, high precision speech cuts, word-timed captions, editable deterministic output, transparent recovery, and a useful short from ordinary clear footage. Target 80% of pilot projects reaching an acceptable draft with no more than five corrective actions; this is a validation hypothesis.

P0 does not include unrestricted long-form editing, collaboration, face/voice cloning, synthetic speaker speech, generative video model training, social publishing, a professional grading suite, full NLE parity, mobile authoring, or lossless NLE round-trip. Multispeaker interviews, music performances, and recordings requiring documentary context are outside automatic shortening scope. Such inputs remain importable where technically supported but require conservative/manual editing.

An optional API service must never become an implicit dependency. Offline capability means installed binaries, cached models, bundled fonts/assets, and a compatible local editorial model. Initial model downloads may require network. With no suitable model, deterministic cleanup/manual editing works, while semantic retake/story/motion planning is explicitly unavailable.

## 5 Product UX and user journeys

### 5.1 First run

1. Open the app without account creation. Select a project directory.
2. A capability check reports available disk, codecs, CPU/GPU, transcription model, local director, renderer, fonts, and optional providers. Offer a small downloadable starter pack with size and license information.
3. Choose **Local only** by default. External providers are opt-in settings, with separate per-project permission describing transcript, sampled frames, audio, or full media transfer.
4. Create an optional brand profile. Skip without penalty.

### 5.2 Create screen

Use the screenshot's three-step arrangement on wide displays, stacked steps on smaller windows. Footage cards show thumbnail, name, duration, status, selection, and take order. Drag/drop and file picker support multiple files. Own B-roll is a separate pool, never silently treated as spoken takes.

The middle column presents plain-language toggles. An info button explains behavior; expanding a row exposes strength/settings. The right column contains target duration, brand, optional reference, a short creative brief, output preset, and **Edit Video**. Advanced settings are collapsed. The primary action is disabled only for a concrete blocking issue, with a visible remedy. Unsupported optional features are visibly unavailable rather than silently ignored.

Recommended new-product defaults: bad takes, fillers, silence, captions, gentle zoom, studio voice, and subtle color on; own/AI B-roll, music, SFX, text hook, and motion off until a preset or user enables them. A **Creator polish** preset can enable licensed local music/SFX and template motion. This differs deliberately from the screenshot to avoid surprising content, downloads, or over-editing.

Target length options: Auto, 15, 30, 45, 60, 90 seconds, custom 10–180. Auto retains a complete coherent story, prefers 30–60 seconds for the short preset, and reports its actual duration. Length is a preference unless the user selects **Hard maximum**. Do not speed speech or invent words to satisfy it.

Reference input accepts user-provided media or a permitted URL. **Analyze style** produces an editable style summary before editing. A What Ships page may point to a video hosted elsewhere; fetching that page is not equivalent to obtaining rights or access to the video. On access failure, offer uploaded reference media or manual style descriptors.

### 5.3 One-click processing

Clicking Edit Video authorizes the selected local pipeline and providers already approved for this project. Do not insert routine editorial confirmation dialogs. Show named stages: Prepare, Transcribe, Clean speech, Plan visuals/audio, Build graphics, Render preview, Check quality. Each stage has progress when measurable, elapsed time otherwise, cancel, and expandable details. Do not invent an overall percentage from unknown stage durations.

Generate the speech-only assembly first internally so visual work uses stable timing. Automatic low-confidence deletions are withheld; the draft can still finish with review markers. Any new provider transfer or charge beyond the approved budget requires a contextual user decision.

### 5.4 Review and refine

Open the result with player, editable transcript, concise change summary, and a collapsed timeline. Highlight removed spans with reasons and a Restore control. Mark uncertain retakes, low-confidence words, poor crops, and missing assets. Offer **Export**, **Adjust**, and **Compare original**.

Adjustments include caption text/style, restoring words, replacing a take, B-roll replacement/removal, scene text, hook, music/SFX gain, zoom/crop, target length, and plain-language requests. A request such as “less zoom, keep my pause before the punchline” creates a validated patch and renders affected segments. Direct edits lock their objects against regeneration by default. Undo/redo and save versions work across agent and manual edits. Revert returns to a previous project revision, never overwrites source recordings.

### 5.5 Timeline and export

P0 timeline: ordered speech clips, trim/split/reorder, overlays/captions, audio lanes, source-to-output timing, selection, mute/volume, and per-object locks. P1 adds richer keyframe handles, ripple edits, snapping, multiple versions, and batch shorts. Every time change recomputes dependent anchors; orphaned overlays are surfaced.

Export presets are versioned, user-editable profiles rather than hardcoded platform policy. P0: 1080×1920, 30 fps, SDR BT.709, MP4/H.264 video and AAC audio if the installed licensed build supports them; 720p draft, SRT/VTT, project bundle, audio stems. Show duration, size estimate, caption burn-in setting, and destination. Validate an exported file before declaring success. Never auto-publish.

### 5.6 Accessibility

All toggles have keyboard operation, visible focus, labels and on/off state independent of color. Caption preview supports contrast checks and reduced motion. Progress announcements are throttled for screen readers. Controls work at 200% zoom. The app's interface and editable transcript remain accessible even when generated output uses animations.

## 6 Feature requirements and acceptance criteria

P0 is MVP release scope; P1 follows measured pilot feedback; P2 covers broader integrations and expensive creative capabilities. Numbers below are proposed acceptance targets to validate on the specified test corpus, not claims about existing software.

### F01 Ingest and normalization P0

Support MP4/MOV with common H.264/HEVC and AAC/PCM combinations when decoding is available. Probe streams, orientation, variable frame rate, duration, color metadata, audio channels, and timestamps. Preserve immutable originals. Create CFR proxies and extracted mono analysis audio; retain explicit mappings to original presentation timestamps. Apply rotation once, never twice. Detect silent/no-audio footage and permit visual-only/manual work.

Acceptance: rotated phone recordings display correctly; mixed frame-rate files assemble without cumulative A/V drift; missing codec gives a specific remedy; source checksums remain unchanged after export; interrupted import resumes or cleans its partial derivative safely.

### F02 Transcription and alignment P0

Use Faster-Whisper as a default CPU/CUDA backend, with original Whisper for reference/compatibility and optional WhisperX forced alignment when timing quality warrants it. Cache one transcript per source/config/model hash. Backend selection must reflect hardware; do not assume CUDA support on Apple Silicon. Evaluate whisper.cpp or another measured native backend for Mac acceleration. Keep word text, source interval, language, speaker label if known, raw score fields, alignment status, and provenance.

Prompt glossary words such as Flutter, Dio, SDK, brand/product names. Scores from different engines are not interchangeable calibrated probabilities. ASR sometimes omits fillers; do not infer exact missing audio from normalized text. VAD supplies speech boundaries; uncertain words use conservative sentence cuts. P0 officially validates English; show other languages as experimental. P1 evaluates selected languages and code-switching, including Hindi/English, on dedicated fixtures. Diarization is optional, not a P0 prerequisite.

Acceptance: on clear English fixture audio, WER ≤10% and 95th-percentile aligned word-boundary error ≤150 ms; speech clips must not depend on precise alignment when it failed. Caption correction does not re-transcribe unchanged media. Model unavailable → download/local selection or manual transcript, never unexpected cloud upload. [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper), [WhisperX](https://github.com/m-bain/whisperX), [Whisper](https://github.com/openai/whisper).

### F03 Bad takes and retakes P0

Combine transcript similarity, sentence restart structure, self-corrections, delivery completeness, audio quality, and chronological context. Group candidate takes by semantic intent. Prefer a complete accurate take, not simply the last or shortest one. Spoken “actually,” repeated phrases for emphasis, and meaningful corrections are not automatic mistakes. Preserve chronology by default; narrative reorder is an explicit advanced option.

Every deletion references source word IDs and carries reason, evidence, risk, and confidence tier. High-confidence incomplete starts/clear duplicate attempts can be cut automatically; ambiguous alternatives remain and receive a review marker. A selected take must include the full idea and qualifiers. Do not splice two different claims into a new statement.

Acceptance: ≥95% precision for auto-deleted retake/false-start spans on a human-labeled corpus; no critical meaning/negation/number changes in the release corpus; restoring a dropped take works in one action. Favor precision over recall.

### F04 Filler removal P0

Detect “um,” “uh,” and contextually empty discourse markers; expose conservative/normal/aggressive strength. “Like” in a comparison and “you know” used substantively remain. Use acoustic/word evidence, conservative padding, and short audio fades at valid seams. Preserve laughter, rhetorical breaths, emphasis, and grammatical connectors. If the filler overlaps useful speech or alignment is uncertain, retain it.

Acceptance: ≥95% precision on marked removable fillers; zero clipped neighboring words in the release fixtures; disabling the toggle preserves those spans unless another independently explained rule applies. Restore and custom preserve/remove dictionaries are supported.

### F05 Silence and dead air P0

Combine VAD, energy/noise floor, word gaps, and rhetorical context. Starting defaults: analyze pauses ≥700 ms; reduce unprotected interior dead air toward 250–400 ms with boundary padding; trim leading/trailing dead air conservatively. Thresholds are configurable and validated empirically. Long purposeful pauses are protected by detection or a user lock. Never use amplitude threshold alone on quiet speakers.

Acceptance: no truncation of annotated speech; interior pauses exceeding the threshold are shortened unless protected; 30–60 ms fades may be used where they do not blur words; continuous playback has no audible seam pops in expert review. Fades must not create accidental overlapping speech.

### F06 Animated captions P0

Create phrase-aware caption groups from surviving speech, normally 2–7 words, at most two lines, with word emphasis optional. Use final output timing. Offer restrained, energetic, and accessible/static styles. Typography, highlight color, animation strength, position, and outline/background are editable. Highlight meaningful words sparingly rather than mechanically emphasizing every token.

Measure rendered glyph bounds, not character counts. Fit within configurable platform safe areas and avoid tracked face/mouth regions when possible. Fall back to a stable safe position when tracking is unreliable. Preserve user corrections and punctuation; do not paraphrase spoken captions. Include SRT/VTT and a word-timed JSON sidecar.

Acceptance: no overflow or overlap with reserved UI areas in automated layout fixtures; ≥95% caption word onsets within 150 ms of aligned speech; readable captions at mobile preview scale; disabled captions produce no text layer or burnt text; omitted-word ASR issues remain visible for correction.

### F07 User B-roll P0 and AI B-roll P1

Own B-roll pool supports video, image, screenshots, tags, and reusable subranges. Use it before external stock when enabled. Match topic, object, and shot suitability; cover speech visually without muting the speaker. Support full-frame, inset, and split layouts. Default to limited density, preserve presenter presence, and prefer no insertion to an irrelevant one.

“AI B-roll” must distinguish selection of existing assets from generation of new footage. P1 includes local semantic selection and opt-in stock adapters such as Pexels. P2 adds optional generated images/video with explicit budget, provenance, and review. A conceptual motion scene is an alternative, not mislabeled stock evidence. Web screenshots must come from approved pages/assets and carry capture/source records; never imply a synthetic diagram is a real product screenshot.

Acceptance: user assets selected before stock for equivalent relevance; downloading prohibited in Local only mode; every external asset has origin/license metadata; failed search leaves a valid talking-head segment; ≥80% relevance in pilot review; placement follows the relevant spoken concept without obscuring protected captions/face.

### F08 Punch and face-aware zooms P0

Use local face/person tracking plus emphasis/shot boundaries. Start with scale 1.0–1.18, configurable maximum 1.25, minimum hold 1.5 seconds, and at most about four punches per 30 seconds for the restrained preset. Smooth center motion and avoid frame-by-frame jitter. If multiple faces, tracking loss, or unsuitable crop, keep a stable wider shot. Derive crop from actual source bounds and final aspect ratio. Do not magnify low-resolution footage beyond a configured quality limit.

Acceptance: annotated face stays within its padded crop in ≥99% of sampled eligible frames; no out-of-source crop; low confidence returns to a stable framing; user crop locks survive regeneration; toggle off removes automatically generated zoom transforms.

### F09 Background music P0 selection and P2 generation

Select a licensed bundled/user track by mood and pacing. “AI” means selection and arrangement in the initial product, not generated music. Duck under speech using a measured envelope, fades, limiter, and sensible initial voice/music balance. Adjust to phrase/scene boundaries; never damage speech timing to chase beats. Provide track replacement, mute, gain, and attribution/license view.

Acceptance: voice remains intelligible, mix meets configured loudness/peak targets, no abrupt music edges, export works offline using bundled or user tracks. No unlicensed trending songs or extracted reference audio. Generated music is optional P2 and subject to model/output terms.

### F10 Sound effects P0

Use a small licensed/local synthesized library. Attach restrained UI clicks, hits, or whooshes to meaningful visual actions. Store onset and measured perceptual peak when available. Default density is capped; no sound on every word. Editable per-event gain/mute and brand policy can ban categories.

Acceptance: event timing within one output frame of intended anchor; no unexplained effects where SFX is off; integrated mix does not clip; optional unavailable effect is omitted with a record.

### F11 Studio-quality voice processing P0

Expose the product label **Studio voice**, explained as cleanup, not guaranteed studio restoration. Analyze clipping, noise, DC offset, loudness, and channel quality. Use conservative high-pass/EQ, denoise where warranted, compression, de-essing where supported, and two-pass normalization. Preserve vocal character; allow bypass and strength. Separate dialogue processing from final mix normalization. Suggested output target: −14 LUFS integrated ±1 LU and true peak ≤−1 dBTP, configurable. Do not amplify silence just to meet loudness. Severe clipping/reverberation receives a warning and an original/processed comparison.

Acceptance: no clipping introduced; target met where signal permits; reviewers prefer intelligibility without strong metallic/pumping artifacts in ≥80% of eligible fixture pairs; disabling studio voice retains original dialogue apart from cut-seam handling and explicitly selected final mix settings.

### F12 Auto color correction P0

Analyze sampled footage for exposure, white balance, contrast, and shot consistency. Apply modest deterministic transforms, preserve skin tones, and avoid crushed blacks or clipped highlights. Corrections are per-source/shot; avoid flickering frame-adaptive adjustments. Brand LUT/look is optional and separate from correction.

P0 delivery is SDR. HDR inputs require explicit managed tone mapping with source metadata retained, or a clear unsupported status; never silently reinterpret HDR as SDR. P1 expands tested color management.

Acceptance: rotated/HDR fixtures do not produce washed-out or double-transformed output; no additional clipping beyond configured tolerance on the test charts; toggle-off bypasses aesthetic correction while retaining necessary output color conversion.

### F13 Text hooks P0

Generate up to three short, truthful options grounded in surviving transcript. Auto selection is optional; editable hook appears within first three seconds. No fabricated claim, unsupported number, or stronger promise than the speaker makes. Hook is an overlay unless a spoken reorder was explicitly planned and validated. Respect brand restrictions and safe areas; do not obscure opening captions.

Acceptance: hook facts trace to transcript/evidence IDs; unsupported candidate rejected; toggle off generates no hook; user-edited hook is preserved; hook language differs from verbatim captions only when clearly an editorial title.

### F14 Target video length P0

Choose complete units of meaning. Preserve opening context, main claim, explanation, caveats necessary for accuracy, and conclusion/CTA if present. First remove errors/dead air, then redundant complete ideas. Compute duration after deterministic compilation. Soft targets allow ±10% or ±2 seconds, whichever is greater. Hard maximum is never exceeded in frames; if essential locked speech does not fit, return a longer draft with an explicit conflict instead of a falsely compliant export. Offer revise target or unlock selections.

Acceptance: no mid-word/mid-clause terminal cut; no speech acceleration unless separately enabled; duration constraint status is explicit; plan contains reasons for dropped story units.

### F15 AI motion graphics P0 templates and P1 generated scenes

Identify explanatory moments: flows, architecture, comparisons, lists, code concepts, data, timelines, product UI. Prefer motion when it improves understanding. P0 ships three original parameterized templates: kinetic text, labeled flow diagram, and comparison/list. P1 permits sandboxed generated HTML/CSS/SVG/GSAP scenes under a bounded scene API. P2 can add rich browser 3D, optional generative assets, and advanced layouts.

Scene requirements: story purpose, evidence-backed labels, start/end, layer list, semantic anchors, typography, easing/motion policy, audio cues, and fallback. Use original visual structure; do not reproduce reference shot sequences, artwork, wording, music, logo treatments, or distinctive animation choreography. Charts use sourced numbers or explicit “Illustrative example” labels.

Example: the transcript “Flutter sends a request through Dio to the server” can show Flutter → Dio → Server with a request packet timed to the phrase. The agent must not imply Dio is a separate network service if it is an in-app HTTP client; diagram labels must preserve the technical relationship.

Acceptance: scenes are time-seekable at arbitrary frames and match out-of-order renders; zero undeclared network requests; no unreadable text/unsafe bounds; verified labels match source claims; ≤3 automated repair attempts before deterministic fallback; graphic removal leaves valid underlying speech and captions.

### F16 Reference style analysis P1

Accept permitted local reference media and allowed URL sources. Extract aggregated pace ranges, shot-duration distribution, typography category/scale, text density, palette relationships, framing, motion/easing categories, transition frequency, audio energy/beat patterns, and confidence. Produce an editable **StyleProfile** with provenance. Avoid retaining or embedding reference media in exports. Reference frames are isolated analysis inputs, not asset candidates.

Brand overrides reference palette/logos; content clarity overrides pace; user locks override the planner. Do not scrape around authentication, access controls, or rate limits. If only a webpage is available, describe what was actually analyzed. General style is a guide; source copyright/terms still apply to accessing and analyzing media.

Acceptance: output uses product/user assets and original templates; project works with reference service unavailable; user can disable any inferred trait; reference audio/artwork never enters exported media without separate asset rights and user selection. [What Ships](https://whatships.com/) provides reference discovery; [Motion.so](https://motion.so/) provides product inspiration.

### F17 Brand profiles P0 manual and P1 website analysis

Store name, palette with roles, licensed font assets, logos, caption style, hook tone, glossary, prohibited claims, motion intensity, safe layouts, music/SFX preferences, CTA templates, and aspect presets. Profile version is frozen into a render snapshot. Website analysis in P1 drafts a profile from an approved URL; show extracted facts/assets for user correction. Do not infer media/font reuse rights from website availability.

Acceptance: one profile applies consistently across captions/hooks/motion; missing font has an explicit bundled fallback; logo aspect preserved; profile updates do not mutate historical renders; factual brand constraints are enforced before rendering.

## 7 Architecture and technology choices

### 7.1 Recommended implementation

**Recommended P0 choice:** Electron desktop shell, React/TypeScript UI, local Node job coordinator, Python transcription/analysis worker, native FFmpeg/ffprobe, SQLite for project/job metadata, filesystem content-addressed assets, and a Chromium/Playwright + FFmpeg renderer as the unrestricted-core candidate. Electron provides a consistent Chromium target for preview and capture at the cost of package size. A Tauri shell is a later option after measuring packaging and sidecar complexity; Rust can be introduced for bottlenecks without moving editorial logic into the UI.

Evaluate Remotion in the first render spike as a productivity-oriented alternative. It offers a shared composition/player/render ecosystem, but its license is conditional and source availability is not the same as a permissive OSS license. Maintain a renderer-neutral plan and a tested Chromium renderer path if commercial terms conflict with the free-core commitment. GSAP is optional; the base templates can use mathematical interpolation/paused Web Animations so correctness does not depend on a particular animation library license.

**Web:** use the same React client connected to a local loopback service for a browser workflow. A pure browser build may offer lightweight proxy/manual editing, but is not the P0 performance baseline for large local footage, Python ASR, and reliable codec support. Hosted web/cloud execution is opt-in P2, with explicit data boundaries. No hosted account backend is required for P0.

### 7.2 Pipeline

```text
Footage + toggles + brand + optional permitted reference
  → probe and immutable ingest
  → proxy/audio extraction + VAD + local transcription/alignment
  → editorial candidates and evidence
  → director produces proposed semantic plan
  → schema/policy/meaning validation
  → timeline compiler creates authoritative frame/sample schedule
  → visual selection and audio planning
  → templates or sandboxed original motion scene generation
  → draft rendering + automated media/layout checks + agent frame inspection
  → bounded repair and revision
  → final render + full-file validation
  → MP4 + editable project + captions + provenance/QA report
```

Source media is never handed to arbitrary generated code. The director can request bounded frames/audio through tools. A job owns an immutable settings/plan snapshot; editing during rendering creates a new revision rather than changing the in-flight output.

### 7.3 Agent-agnostic boundary

The core accepts structured JSON plans and patches, independent of which agent produced them. **DirectorAdapter** exposes capabilities, plan generation, structured repair, and optional image review. Implement a compatible local model adapter first for the offline route, plus provider-neutral external adapters. Codex, Claude, and Cursor can interact through documented CLI/stdio MCP tools where their installed versions support them. Do not assume they all expose identical embeddable runtimes or that a user's subscription licenses application API usage.

Keep prompts and examples portable. Thin optional agent-specific skills describe the same schema and tool contract. The application owns jobs, state, validation, files, and permissions; an agent never owns correctness or arbitrary shell execution. External agent integration is not a prerequisite to use the UI. Unsupported agents can write/export a plan file and invoke the CLI.

### 7.4 Deterministic execution

Normalize video to an explicit output rational frame rate. Use source time in integer microseconds and output time in integer frames; audio executes at integer samples, normally 48 kHz. All intervals are half-open [start,end). Never combine unrelated source and output clocks in one field. The compiler maps retained source ranges into output spans and generates caption/visual/audio anchors.

The renderer receives only a validated compiled plan, resolved asset hashes, pinned fonts, versions, and seed. A scene implements initialize/assetsReady, seek(frame), bounds/metadata, and dispose. GSAP timelines, if used, are paused and sought explicitly. No wall-clock timers, live CSS transitions, unseeded randomness, external fetches, or playback-driven frame progression. Decode video at requested timestamps using a tested synchronization strategy rather than assuming HTML video seeking is exact.

Same plan/environment produces identical frame/sample schedules. Pixel reproducibility is tested within a pinned renderer environment; different GPU/codec/OS implementations are not promised byte-identical output. Use software rendering/reference fixtures for repeatable QA. Motion-blur subframes never blend across cuts. Chunk rendering must agree at boundaries, including audio and animation state.

## 8 Modules and APIs

| Module | Responsibilities | Main outputs |
|---|---|---|
| ProjectStore | Revision history, locks, migrations, autosave, SQLite transactions | ProjectSnapshot, events |
| MediaService | Probe, import, proxies, waveform, sample frames, relink | AssetManifest, source timing map |
| Transcriber | VAD, ASR, optional alignment, glossary, cache | Transcript, word evidence |
| EditorialEngine | Candidate errors, retake groups, semantic units, director adapter | ProposedEditPlan |
| PlanValidator | Schema, assets, bounds, toggle policy, meaning risks, budget | Errors/warnings, approved plan |
| TimelineCompiler | Source/output mapping, anchors, frame/sample schedule | CompiledTimeline |
| VisualPlanner | Own/stock B-roll, crop tracking, caption layout, motion selection | VisualPlan |
| AudioPlanner | Dialogue chain, music, ducking, cue peaks, stems | AudioPlan |
| SceneBuilder | Parameterized templates or bounded scene compilation | ScenePackage |
| RenderService | Draft/final, chunking, encode/mux, cancel, cache | RenderArtifact |
| QAService | Decode checks, frames, bounds, audio, director critique | QAReport and bounded patches |
| ProviderBroker | Egress permissions, credentials, cost caps, retry | ProviderReceipt |
| ExportService | MP4, captions, project bundle, later interchange | ExportManifest |

Local REST or IPC endpoints have versioned DTOs. Loopback HTTP, if used, requires a session token, restricted origin/host checks, and no public bind by default.

| API | Contract |
|---|---|
| POST /v1/projects | Create project; returns ID and revision |
| POST /v1/projects/{id}/assets | Import a picker-authorized path or upload; returns asset/job IDs |
| POST /v1/projects/{id}/jobs | Pipeline stage/profile, baseRevision, idempotency key; returns job |
| GET /v1/jobs/{id} | State, stage progress, recoverable error, artifacts |
| POST /v1/jobs/{id}/cancel | Cooperative cancellation, preserves valid checkpoints |
| GET /v1/projects/{id}/plan | Current validated plan and revision |
| PATCH /v1/projects/{id}/plan | Typed operations with baseRevision; 409 on stale revision |
| POST /v1/projects/{id}/frames | Bounded source/output frame requests; returns local artifact references |
| POST /v1/projects/{id}/qa | Run checks against exact render/plan hash |
| POST /v1/projects/{id}/exports | Snapshot/preset/destination; validates before completion |
| GET /v1/capabilities | Installed models, devices, codecs, provider policies |

MCP/CLI tools mirror these operations: inspect_project, import_assets, transcribe, propose_edit, validate_plan, apply_patch, render_draft, inspect_frames, run_qa, export_project. Tool calls enforce the same authorization and revision rules. No generic run_shell tool is necessary. Plan patches are allowlisted operations such as restore_span, replace_take, set_caption, set_crop, replace_asset, set_gain, and lock_object. New content is never injected via arbitrary executable filter strings.

## 9 Data model and edit-plan schema

### 9.1 Persistent entities

**Project:** ID, name, timestamps, schemaVersion, revision, root, settings, current plan hash, brand/style version IDs, locks, user edits, job history.

**Asset:** ID, kind, content hash, relative original path or external relink descriptor, probe metadata, durationUs, source frame/timebase metadata, rights/provenance, derived hashes, permission scope. Absolute paths and secrets are excluded from portable exports.

**Transcript:** source hash, backend/model/version/config, language, words with stable IDs and sourceStartUs/sourceEndUs, raw confidence/alignment information, speaker labels, sentence/story units, manual corrections. Preserve the raw transcription alongside corrected text.

**EditDecision:** ID, source ranges, operation, reason, evidence IDs, confidence tier, protected meaning flags, manual override, detector/version.

**EditPlan:** schemaVersion, revision, source references, settings snapshot, decisions, ordered retained segments, captions, visuals/scenes, audio events, output requirements, locks, provenance, unresolved review markers.

**CompiledTimeline:** plan hash, rational fps, total frames, sample rate/count, source/output map, tracks with exact frame/sample spans, resolved animation/caption anchors, compiler version.

**ScenePackage:** template/code hash, asset/font manifest, bounded parameters, durationFrames, dimensions, deterministic seed, semantic claims, expected bounds, renderer requirements, fallback.

**Job/RenderArtifact/QAReport:** job identity and idempotency key, inputs/outputs hashes, dependency graph, state/checkpoint, attempts, duration/resource use, render environment, check results, issue severity, validated artifact paths.

**BrandProfile/StyleProfile:** versioned preferences, provenance and permitted assets; style-derived traits remain independent from brand factual constraints.

### 9.2 Normative validation rules

Publish JSON Schema with additionalProperties:false for critical structures, discriminated unions for track types, maximum text/scene/asset counts, and required schema versions. Validate both producer and consumer. Asset IDs must resolve to approved files; spans must fit source bounds; caption word IDs must survive the edit; output tracks must fit duration; gains/transforms must stay within configured limits. Treat unknown enum/version as an error, not an invitation to guess.

Hard errors block render: invalid or missing assets, impossible time ranges, undeclared execution/network, malformed schema, wrong revision, unresolved locked-duration conflict, failed final media integrity. Warnings may allow a draft: uncertain retake, unavailable optional visual, low-confidence crop, incomplete local-model capability. Final export identifies unresolved editorial warnings without claiming they passed.

The semantic plan uses source anchors. The compiler is authoritative for output time. A patch that changes a speech interval invalidates dependent output mappings; it cannot merely shift captions using an assumed fixed offset. Manual absolute output anchors are explicitly marked and flagged if a changed duration makes them invalid.

### 9.3 Example semantic plan

The following valid JSON illustrates a three-second retained utterance with a flow overlay, captions, a zoom, dialogue processing, and an optional music bed. It is intentionally small; production plans contain all words/scenes and source manifest records. Source time is not output time.

```json
{
  "schemaVersion": "1.0",
  "projectId": "project_flutter_01",
  "revision": 7,
  "output": {
    "width": 1080, "height": 1920,
    "fps": {"num": 30, "den": 1},
    "audioSampleRate": 48000,
    "colorSpace": "bt709", "targetFrames": 90,
    "lengthPolicy": "hard_max"
  },
  "settings": {
    "badTakes": true, "fillers": true, "silence": true,
    "captions": true, "userBroll": false, "aiBroll": false,
    "zoom": true, "music": true, "sfx": false,
    "studioVoice": true, "autoColor": false,
    "textHook": false, "motionGraphics": true,
    "networkPolicy": "local_only"
  },
  "assets": [
    {"id": "take_a", "kind": "video", "manifestRef": "assets/take_a.json"},
    {"id": "music_a", "kind": "audio", "manifestRef": "assets/music_a.json"}
  ],
  "transcriptRef": "transcripts/take_a.json",
  "brandProfileRef": "brands/developer_v1.json",
  "styleProfileRef": null,
  "decisions": [
    {
      "id": "decision_01", "assetId": "take_a", "action": "remove",
      "sourceStartUs": 0, "sourceEndUs": 1000000,
      "reason": "Leading non-speech confirmed by VAD",
      "evidenceIds": ["vad_gap_01"], "confidenceTier": "high"
    }
  ],
  "segments": [
    {
      "id": "speech_01", "assetId": "take_a",
      "sourceStartUs": 1000000, "sourceEndUs": 4000000,
      "wordIds": ["w01", "w02", "w03", "w04", "w05", "w06", "w07", "w08", "w09", "w10", "w11"],
      "speed": {"num": 1, "den": 1},
      "cropPolicy": "face_safe_vertical", "locked": false
    }
  ],
  "captions": [
    {
      "id": "caption_01", "segmentId": "speech_01",
      "wordIds": ["w01", "w02", "w03", "w04", "w05"],
      "text": "Flutter sends a request through",
      "template": "restrained", "emphasisWordIds": ["w01"],
      "positionPolicy": "safe_face_aware", "locked": false
    },
    {
      "id": "caption_02", "segmentId": "speech_01",
      "wordIds": ["w06", "w07", "w08", "w09", "w10", "w11"],
      "text": "Dio to the server in seconds.",
      "template": "restrained", "emphasisWordIds": ["w06"],
      "positionPolicy": "safe_face_aware", "locked": false
    }
  ],
  "visuals": [
    {
      "id": "flow_01", "kind": "motion_template",
      "segmentId": "speech_01",
      "anchor": {"wordId": "w01", "edge": "start", "offsetFrames": 0},
      "durationFrames": 90,
      "template": "request_flow_v1",
      "params": {
        "containerLabel": "Flutter app",
        "internalNode": "Dio HTTP client",
        "externalNode": "Server",
        "edgeLabel": "Request"
      },
      "evidenceIds": ["w01", "w04", "w06", "w09"],
      "fallback": "omit", "locked": false
    }
  ],
  "transforms": [
    {
      "id": "zoom_01", "segmentId": "speech_01",
      "anchor": {"wordId": "w06", "edge": "start", "offsetFrames": 0},
      "kind": "punch", "scale": 1.12, "centerPolicy": "tracked_face",
      "transitionFrames": 4, "locked": false
    }
  ],
  "audio": {
    "dialogue": {"profile": "studio_conservative", "seamFadeMs": 30},
    "music": {
      "assetId": "music_a", "startFrame": 0, "durationFrames": 90,
      "gainDb": -24, "duckUnderDialogue": true,
      "fadeInFrames": 6, "fadeOutFrames": 9
    },
    "sfx": [],
    "mixTarget": {"integratedLufs": -14, "truePeakDbtp": -1}
  },
  "reviewMarkers": [],
  "provenance": {"director": "local_adapter", "seed": 42, "promptVersion": "director_v1"}
}
```

The compiler resolves this fixture to speech output frames [0,90) and audio samples [0,144000), with source [1000000,4000000) microseconds. Actual word timing comes from the referenced transcript, not the text string. Caption groups use their word intervals; the flow is rejected if its anchor plus 90 frames extends beyond the timeline. Music is licensed/available through its manifest. The plan validator requires the spoken words, factual claims, asset hashes, and source duration to exist; the example alone is not a runnable media project.

## 10 Visual and audio planning rules

Create a **VisualBrief** after the speech assembly: shot purpose, presenter framing, caption safe areas, visual density, where supporting imagery helps, required evidence, brand/reference traits, and fallback. Default visual hierarchy is speaker/meaning → captions → supporting visual → decoration. Two competing animated layers should not demand attention simultaneously. Use background-only decorative movement sparingly. Preserve enough presenter visibility to feel like the creator's video.

Create an **AudioBrief**: dialogue quality/repair plan, phrase boundaries, music mood and license, speech envelope, beat/drop opportunities, SFX anchors and peak offsets, loudness target, headroom, stems. Speech leads; music adapts. Cut synchronization comes from the compiler, not independent scene/audio LLM guesses. Spectral/energy measurements inform music alignment but do not substitute for listening.

Keep critical factual scenes separate from generic illustrative scenes. Brand/product screenshots require approved source assets. The planner can choose presenter-only, B-roll, screenshot, text emphasis, diagram, or split composition. It records why, and can choose “no visual” when content is already clear.

## 11 QA and frame inspection loop

1. Validate semantic plan and compile exact frame/sample spans before scene construction.
2. Render a 540p/720p draft. Run file decoding, duration, missing-media, audio peak/loudness, caption bounds, face crop, and scene readiness checks.
3. Inspect a contact sheet containing opening hook, every cut boundary before/after, motion start/middle/end, longest caption, and crop-risk frames. Add adaptive samples where motion, occlusion, or tracking confidence changes; do not assume one frame per clip verifies it.
4. An available image-capable director reviews bounded frames for readability, factual labels, composition, awkward transitions, and visual relevance. Audio checks combine signal tests with sampled playback/human fixtures; a frame-only agent cannot certify audio quality.
5. Produce typed issue records with artifact/plan hash, object/frame/span, severity, evidence, and suggested patch. Apply only allowed changes, respect locks, and rerender affected parts.
6. Limit automatic repair to three attempts per issue group and a total project budget/time ceiling. Repeated invalid output uses stable templates/presenter-only fallback. Persist unresolved issues for review.
7. Final output gets full-file decode, stream/duration checks, loudness/peak measurement and selected full-resolution frame inspection. Never label a skipped check as passed.

Critical failures block export completion; quality warnings produce a reviewable draft. Model critique is supplementary evidence, not the only gate. The user always sees what changed and can undo repairs.

## 12 Performance targets and resource budgets

Benchmark with a versioned corpus and pinned environment. Two initial test classes: Apple Silicon laptop with 16 GB RAM and CPU/native local inference; Windows/Linux workstation with 16 GB RAM and an 8 GB supported CUDA GPU. The exact machine, backend, model, precision, and thermal state must be reported. These are provisional targets to ratify during the first spike.

| Scenario | P0 target |
|---|---|
| Open cached project / UI response | ≤2 s / routine controls ≤100 ms p95 |
| First playable proxy for a 5-minute 1080p take | ≤30 s where progressive proxying is supported |
| Transcribe 5 minutes with selected small/base local configuration | ≤5 min laptop, ≤90 s CUDA class; quality gate still applies |
| Speech-only 60-second draft from cached transcript | ≤60 s |
| 720p30 60-second template-polish draft | ≤3 min laptop, ≤2 min workstation after analysis |
| 1080p30 60-second final, ≤3 simple motion scenes | ≤5 min laptop, ≤3 min workstation after analysis |
| Complete 5-minute raw → 60-second template short | ≤12 min laptop, ≤6 min workstation, warm models |
| Revision of captions/color with cached analysis | Never re-transcribe; regenerate only invalidated artifacts |
| Interactive proxy preview | Smooth 30 fps target; quality downshift on slow devices |

Track cold-start/download time separately. CPU-only mode is supported with honest estimates, not identical SLA. P0 app/worker resident RAM target is ≤8 GB excluding OS, with configurable concurrency; model/render combinations exceeding budget are serialized. Disk preflight estimates originals + proxies + frame/temp/render cache with at least 20% headroom. Use streaming/chunked frames instead of storing every uncompressed full-resolution frame when practical. Report estimated storage and allow cache purge without deleting originals.

Cancel acknowledgment ≤2 seconds; worker termination may take longer to safely stop an encoder. External requests have deadlines, bounded retry, and budget caps. More complex generated scenes and optional cloud services are outside the basic latency target and must show separate estimates.

## 13 Failure and recovery behavior

Persist a job DAG with states queued, running, waiting_for_user, succeeded, failed, canceled. Stage outputs commit atomically after validation; partial files have separate names. Cache keys include source hash, settings, model/compiler/renderer version, font/scene/assets, and output profile. Resume only compatible completed checkpoints. Crash recovery never treats a partial MP4 as final.

| Failure | Required behavior |
|---|---|
| Unsupported/corrupt media | Identify file/stream; import other files; preserve originals |
| No speech / empty or hallucinated transcript | Stop semantic cleanup; offer manual/visual route; do not manufacture story |
| Alignment fails | Keep uncertain words; sentence-boundary cuts; flag timing for correction |
| Local model missing/too weak | Capability notice; basic cleanup/manual mode; no cloud switch |
| GPU OOM / device error | Retry with smaller batch/CPU after recording cause; preserve analysis |
| Invalid director plan | Structured repair once per validation cycle, bounded overall; safe baseline fallback |
| Asset download/API error | Retry transient failures with backoff; omit optional asset or use local alternative |
| Motion compile/QA failure | Three repair attempts maximum, then stable template or presenter-only |
| Face tracking failure | Wider stable crop; caption safe-area fallback |
| Target too short for locked content | Explicit duration conflict; retain meaning and offer target revision |
| Disk full | Pause before destructive cleanup; offer cache purge/destination; resume valid chunks |
| Encoder crash | Resume verified chunks or rerender stage; do not rerun ASR |
| App exits / user cancels | Save plan and completed checkpoints; no completed export claim |
| Source moved | Relink by picker and verify content hash; reject mismatched replacement |
| Concurrent agent/manual writes | Reject stale revision and rebase intentional patch; no last-write-wins loss |
| External budget exhausted | Stop new billable calls; use local fallback or request new cap |

External retry must use idempotency where supported; ambiguous paid generation outcomes are reconciled before retry. Packaging contains a diagnostic screen showing versions/capabilities and a redacted support bundle.

## 14 Observability and privacy

Local structured logs include project/job/stage IDs, durations, cache hits, resource peaks, plan validation categories, fallback count, retry count, render FPS, QA outcomes, and optional provider cost receipts. Logs omit raw transcript, frames, prompts, names/paths, and secrets by default. Users can explicitly generate a diagnostic bundle and inspect it before sharing.

Metrics are local by default; opt-in aggregate telemetry has a visible event list and can be disabled. Local-only mode enforces egress denial for media, transcript, frames, and assets during editing, not merely a UI promise. Optional downloads, updates, and provider calls use separate broker scopes; do not claim zero network if those are enabled.

External transfer policy is per provider/project/data type. A transcript-only provider cannot receive frames. An approved frame sampler cannot upload full video. Record what left the machine, purpose, provider, time, estimated cost, and retention-policy link. Provider retention settings must be shown accurately, never inferred from the app's local-first design. Keys live in OS credential storage and are absent from project bundles/logs. Deleting a project distinguishes metadata/derived cache from originals; external retention/deletion is reported separately.

## 15 Security and licensing

Treat filenames, media metadata, transcripts, reference websites, downloaded assets, model responses, and generated scenes as untrusted data. Prompt injection in a webpage/transcript must not alter provider permissions, tool policy, or file access. Only product code may authorize a resource.

Use argument arrays for media processes; never concatenate arbitrary text into shell commands or FFmpeg expressions. Resolve paths beneath approved roots, defend against traversal/symlinks, cap dimensions/duration/decompression/resource use, validate MIME and decoded content, and sandbox media workers as practical. Pin signed dependencies and maintain SBOM/version update policy.

Generated HTML runs in a separate sandboxed browser process with no Node integration, filesystem access, credentials, app IPC, or network; it receives allowlisted local assets through a scoped server. Sanitize SVG external references/scripts and restrict fonts and embedded resources. Scene dependencies are pinned/allowlisted, not auto-installed from LLM suggestions. Escape caption and hook strings in every HTML/SVG renderer.

**License release gate:** pin exact commits/packages/binaries and inspect actual license files, transitive dependencies, model weights, fonts, media, and codec configuration. README license labels below are initial evidence, not a complete compliance audit. Maintain third-party notices and asset provenance. Public availability or “royalty-free” is not unrestricted redistribution. Project code license does not license example music, logos, or screenshots.

- FFmpeg is primarily LGPL, but enabled GPL components change the binary's licensing; some nonfree build combinations cannot be redistributed. Packaging must preserve exact build configuration, corresponding source/notices, and satisfy applicable obligations. Codec patent exposure is a separate distribution issue. [FFmpeg legal guidance](https://ffmpeg.org/legal.html).
- Remotion has conditional free/commercial terms and restrictions on derivative distribution; evaluate product embedding against the exact selected version and deployment. Do not promise a universally free Remotion-powered commercial product. [Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md).
- GSAP uses its own no-charge license; do not label it MIT merely because it is free to use. Review allowed product/distribution use at the pinned version, or keep optional mathematical/WAAPI equivalents. [GSAP license](https://gsap.com/community/standard-license/).
- WhisperX code is currently labeled BSD-2-Clause; alignment/diarization weights and terms are separate. Some diarization workflows require model access acceptance/tokens. Single-speaker P0 avoids that dependency. [WhisperX repository](https://github.com/m-bain/whisperX).
- Stock/API assets require source-specific terms, records, and attribution when applicable. Do not treat search/downloader access as reuse rights. Fonts require embedding/distribution permissions; brand logos need proper user authorization and trademark handling.
- Local model weights, generated music/video, and their commercial output terms need individual review. Optional API licenses are not inherited from an MIT wrapper.

Reference analysis must use permitted access and produce original expression. Preserve a provenance chain and prevent reference media from becoming output assets by accident. No “clone creator exactly” or frame-locked remake mode is part of this product.

## 16 Open-source evaluation and reuse decisions

These are repository/documentation evaluations as of 4 October 2026, not runtime benchmarks. Before importing code, record a commit, inspect modules/tests/license, and execute representative fixtures. The recommendation is selective reuse, not combining every repository into one application.

| Component | Verified scope and license signal | Reuse versus build |
|---|---|---|
| [AutoBroll](https://github.com/andriidrok1/autobroll) | Browser editor, take arrangement, WhisperX captions, B-roll, timeline, MCP, Remotion; MIT. AI analysis currently uses Gemini and stock uses Pexels. | Best initial UI/timeline spike. Adapt clip-anchored edits, undo/autosave and frame tools; replace provider coupling, concurrency and pipeline orchestration. Do not call its existing AI route wholly offline. |
| [NextWork AI Video Editor](https://github.com/nextwork-projects/ai-video-editor) | MIT Claude plugins for creator analysis, retake cleanup, styling and taste; local Whisper/render route, Remotion terms separate. | Reuse workflow/schema/prompt ideas after audit; build agent-neutral adapter, local director, rights-safe aggregated style analysis, persistent jobs. |
| [OpenCut official](https://github.com/OpenCut-app/OpenCut) | MIT; current README describes a rewrite with Rust core and planned editor API/plugins/MCP/headless. Classic version is separate. | Evaluate stable classic components for timeline UX. Do not depend on promised rewrite APIs for P0; pin exact repository/version. “OpenCut” is used by unrelated projects with different licenses. |
| [claude-motion-design](https://github.com/howseen-ai/claude-motion-design) | MIT code, HTML/Playwright/FFmpeg, seek-time rendering, frame probes and sound planning. | Adapt deterministic seeking, draft/probe/QA concepts. Exclude its frame-locked remake workflow; third-party example media has separate rights. |
| [bang-motion](https://github.com/bangtutorial/bang-motion) | MIT browser-motion skill; supports multiple coding agents and HTML scenes. | Adapt original style briefs, scene continuity and video-layer timing patterns; product owns bounded scene API and tests. |
| [Official Remotion skills](https://github.com/remotion-dev/remotion/tree/main/packages/skills) | Official agent best-practice guidance for compositions and animation. | Reference when Remotion adapter is selected; inspect skill-package terms independently before vendoring. Not a runtime dependency. |
| [Remotion motion skill](https://github.com/fernandokaraka/remotion-motion-graphics-skill) | MIT-labeled community skill with still/MP4/alpha export examples. | Optional craft reference; verify notices and actual renderer export capabilities in fixtures. |
| [video-use](https://github.com/browser-use/video-use) | MIT; edit-plan/self-evaluation flow, fillers, grade, fades, animation options. Setup currently asks for ElevenLabs. | Adapt plan/QA ideas and narrowly useful helpers; replace hosted transcription with local contract. No requirement to inherit its agent-specific approval UX. |
| [EverythingAI editor](https://github.com/EverythingAI-Pro/ai-video-editor) | MIT-labeled scripts for cleanup, captions, B-roll and shorts; documented ElevenLabs transcription. | Reference small processing modules and provenance; not an offline base without replacement. No automatic online downloading by default. |
| [FFmpeg Wizard](https://github.com/gregorizeidler/FFmpeg-wizard) | README claims Whisper/GPT/MoviePy editing, face zoom, audio and grade; MIT-labeled. | Inspect face-aware crop/audio helpers; validate quality claims and actual license file. Avoid another orchestration framework in production. |
| [HyperFrames](https://github.com/hyperframes/hyperframes) | Browser-video option mentioned by research; repository exists. Full API/license/runtime fit not audited here. | Optional P1 spike only; no P0 dependency or assumed compatibility. |
| [Whisper](https://github.com/openai/whisper), [Faster-Whisper](https://github.com/SYSTRAN/faster-whisper), [WhisperX](https://github.com/m-bain/whisperX) | Local transcription and optional alignment implementations; MIT/MIT/BSD-2-Clause code labels respectively. | Reuse engines behind one interface; build glossary/cache/confidence/word-ID contract and device selection. |
| [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | Editorial interchange framework and adapters; separate media handling. | Evaluate P1 export adapter, build product-specific loss report and NLE fixtures. Not a rendering engine. |
| VibeClip and Kaestral | Mentioned in source chat; current code/license/access not established in this review. | Product/UX research leads only; no vendoring or required SaaS integration. |

AutoBroll/NextWork are the strongest near-term spikes, not a preapproved fork architecture. Build a thin integration proof before choosing a base. Small/new repositories can inform workflows without being production-quality foundations. Do not import their default API dependencies or self-reported timing claims into requirements.

## 17 Roadmap and implementation sequence

### P0 MVP

Deliver a single local desktop workflow for clear single-speaker English recordings, immutable import, local ASR/VAD/alignment fallback, conservative retake/filler/silence cuts, captions, restrained face zoom, voice cleanup, SDR color, truthful hook, target duration, own B-roll, local music/SFX selection, three original motion templates, manual brand profiles, minimal editable timeline, project revision/locks, draft/final export, QA and resumable jobs. All supported toggles must work end to end; later features are marked unavailable rather than fake-enabled.

Local director must pass structured-plan acceptance fixtures before semantic features ship. A weaker local model can degrade to conservative cuts and fixed templates; the app must explain its capability. External directors are optional and can improve quality, never the only route advertised as core.

Recommended build order:

1. **Contract and media spine:** plan/schema, asset manifest, clocks, project revisions, import/proxy/ffprobe, one clip export and schema fixtures.
2. **Speech assembly:** local ASR/VAD, immutable transcript, retake/filler candidates, compiler, A/V seam QA, restore/undo.
3. **Complete thin vertical slice:** UI toggles → validated plan → captions/basic crop → draft → editable project → MP4.
4. **Polish modules:** studio voice/color, own B-roll, local music/SFX, hooks, brand, three templates, face/caption safe areas.
5. **Hardening:** job recovery, locks, privacy egress tests, packaging/codecs, resource preflight, benchmarks, pilot quality review.

Suggested workstreams after contracts stabilize: application/project UX, media/transcription/compiler, director/visual planning, rendering/audio/QA. Every workstream consumes versioned fixtures and the same schema rather than inventing independent time formats.

### P1

Reference/style analysis; stock adapter; richer generated HTML/SVG scenes; optional provider adapters and external-agent MCP/CLI packaging; website-derived brand drafts; selected multilingual/code-switching validation; richer timeline/keyframes; asset library; batch shorts; measured acceleration options; initial OTIO export and NLE handoff. Require each addition to preserve local fallback and locked edits.

### P2

Optional generative B-roll/music services, advanced local generation where hardware/weights permit, hosted execution with explicit transfer/costs, collaboration, advanced motion/3D, multispeaker workflows, richer color formats, native NLE integrations, and limited round-trip workflows. Sequence depends on measured creator demand, not on feature breadth.

### Initial engineering deliverables

A team can start with packages app, contracts, project-store, director, compiler, renderer-api, renderer-browser, optional renderer-remotion, and workers/media and workers/transcribe. First deliverables are the JSON Schema, valid/invalid fixture plans, a CLI render of a five-second test clip, a source/output mapping test, a local-only import/transcribe/export trace, and a packaging/license inventory. The render spike compares seek accuracy, fonts, video decoding, audio synchronization, memory, preview parity, and commercial embedding suitability for both renderer options. Choose a default from evidence before polishing the full UI.

## 18 Release acceptance gates

| Gate | P0 pass condition |
|---|---|
| Complete workflow | First-run local model setup → raw footage → validated editable draft → MP4 with no paid service/account |
| Screenshot-inspired UX | All prescribed toggle names/purposes represented; one primary action runs enabled supported modules; unavailable modules explained |
| Meaning preservation | No critical semantic changes in labeled release corpus; ≥95% precision in automated retake/filler deletion |
| Caption/crop correctness | Timing/layout/face requirements in F06/F08 pass; safe fallback for uncertain cases |
| Determinism | Same pinned plan/environment yields same schedule and perceptually identical test frames; out-of-order scene seeking passes |
| Media integrity | Full output decode, no missing frames/media, correct dimensions/rotation/color, A/V offset ≤1 output frame at start/end |
| Audio | No introduced clipping/pops; loudness/peak targets pass or explicit source limitation; mute/disable controls honored |
| Editability | Restore, trim, split, reorder, caption correction, visual replacement, gain, undo/redo, locks and reopen all pass |
| Recovery | Kill app/worker during every stage; resume without source loss or repeated valid analysis; disk-full/cancel fixtures pass |
| Privacy/security | Offline trace has no content egress; malicious reference/scene/path fixtures cannot access credentials/files/network |
| Performance | Report actual benchmark against Section 12 targets; unmet targets must change implementation or honest supported scope before launch |
| Licensing | Exact shipped dependencies/models/fonts/media/binaries have license inventory and required notices/source obligations |
| User value | Pilot target: ≥80% acceptable drafts with ≤5 corrective actions; failures categorized and major ones addressed |

No plan-validation failure can be waived by an agent saying the output “looks good.” Release owner records any scope change and updates supported claims and defaults.

## 19 Testing strategy

Use consented or synthetic fixtures with written redistribution rights. Initial corpus: at least 50 source projects, 3–10 minutes each, spanning clean/noisy/quiet/clipped voice, retakes, false starts, meaningful fillers, emphasis repetition, purposeful pauses, accents, technical vocabulary, glasses/head movement, off-center/multiple faces, VFR phone media, rotation, mixed FPS, low-res, HDR, absent audio, and damaged files. Separate normal-scope pass metrics from challenging/out-of-scope degradation fixtures.

Annotators mark removable/retain spans, critical meaning tokens, desired take groupings, word boundaries, relevant visual concepts, face bounds and caption constraints. Two reviewers reconcile ambiguity and identify catastrophic edits independently. Hold out part of the corpus for release evaluation; do not tune against all fixtures. P1 language/diarization testing requires separate data and targets.

- Unit/property tests: half-open intervals, rounding, rational rates, source/output mappings, word anchors, lock propagation, schema rejection, revision conflicts, gain limits, cache invalidation.
- Integration: local ASR → compiler → render → captions/mix, mixed-media proxies, model/device fallback, no-audio case, own B-roll and motion.
- Golden visual tests: pinned fonts/browser/software render, safe areas, typography overflow, arbitrary seek order, cut boundaries, chunk joins. Use perceptual tolerance for codec variation.
- Audio tests: loudness/true peak, seam discontinuity detection, sample counts and drift; human playback for naturalness/denoise artifacts.
- Editorial evaluation: precision/recall for candidate removals, meaning preservation, length/story completeness, hook grounding, visual relevance, brand compliance. Compare conservative baseline and director versions.
- Resilience: crash, cancellation, disk full, missing files, interrupted downloads, OOM, repeated invalid JSON, provider timeout/rate limit, ambiguous generation outcomes.
- Security/privacy: network-denial traces, prompt injection, path traversal, malformed media/SVG, scene sandbox escape probes, log/export secret scans.
- UI/accessibility: keyboard flow, toggle persistence, focused recovery, 200% zoom, assistive labels, long transcript and small-window layouts.
- NLE tests when introduced: export/relink/timebase and effect fallback in pinned actual application versions, not XML validation alone.

CI uses small synthetic media and deterministic plan tests; expensive ASR/render/subjective corpus gates run on release candidates or relevant model/compiler changes. Model/prompt changes are versioned product changes and rerun editorial regressions.

## 20 Metrics

**Primary product metric:** percentage of projects that reach a creator-approved export with at most five corrective actions and within the user's acceptable elapsed time. Collect creator approval locally or by explicit opt-in, not by guessing from an export click.

Supporting metrics: import→draft→export conversion; time to first usable draft and final; correction count/types; restored deletion rate; caption correction rate; project reopen/edit rate; toggle use/disable after review; template vs generated scene acceptance; B-roll relevance; fallback rate; critical semantic errors per evaluated project; crash-free jobs; recovery success; cache reuse; p50/p95 latency/resource use; optional API cost per exported minute. Retention and workflow completion are meaningful only with opt-in measurement.

Safety/quality guardrails: zero known critical meaning errors in release fixtures, no unauthorized egress, no unlicensed packaged assets, no “success” on corrupt outputs. Social views/retention can be voluntarily imported later but are not evidence that a particular edit caused performance or a reason to make unsupported claims.

## 21 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Wrong retake removes qualifiers or changes meaning | High-precision automatic policy, semantic evidence, conservative fallback, restore controls, held-out human corpus |
| ASR omits fillers or mishears technical terms | Glossary, VAD/alignment, raw/corrected transcript, no invented word boundaries, local backend comparison |
| Too many effects produce generic or distracting output | Restrained defaults, density caps, original templates, presenter/meaning hierarchy, pilot feedback |
| Local model cannot match premium director quality | Capability checks, benchmark supported models/hardware, template baseline, optional external director |
| Browser video seek/render mismatch | Explicit decode strategy, rational clocks, pinned environment, frame/chunk/A/V tests |
| Repository or API churn | Adapter boundaries, pinned commits, small selective reuse, no dependency on announced OpenCut APIs |
| Unexpected license cost or redistribution restriction | Renderer abstraction, Chromium/FFmpeg path, exact-version license gate and asset inventory |
| Privacy promise contradicted by hidden calls | Broker-enforced egress policy, sandbox, data-type permission receipts and network tests |
| Expensive/infinite agent loops | Typed tools, retry/time/cost budgets, three repair ceiling, deterministic fallback |
| Desktop package/model size and CPU slowness | Optional model packs, warm workers, cache/proxies, honest device estimates, scoped concurrency |
| Studio label overpromises restoration | Explain enhancement limits, detect clipping/reverb, comparison/bypass, measurable intelligibility target |
| Reference copying or questionable media sourcing | Aggregated traits only, original scene construction, permitted access and provenance, no remake mode |
| User edits lost on regeneration | Object locks, revision checks, explicit patches, immutable snapshots and undo history |
| NLE handoff loses effects | Capability matrix, baked overlays/stems, relink test and machine-readable loss report |

## 22 Future NLE and DaVinci Premiere FCP integration

The native editable project is the authoritative P0 format. P1 exports a portable project bundle with original/linked media, checksums, timeline/source mapping, captions, stems, scene sources, renders, and asset licenses. Include consolidated trimmed media with configurable handles where requested; originals remain separate.

Use an interchange adapter boundary. Evaluate OpenTimelineIO as the neutral editorial representation; it describes edits and references rather than rendering media. Inspect available/pinned adapters before choosing EDL, FCPXML, or other formats. Simple EDL supports limited cuts and cannot preserve a rich graphics timeline. FCPXML/application-specific XML support must be proved in actual target versions. Do not assume one format imports identically into all three NLEs. [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO).

Handoff strategy:

- Transfer speech/B-roll cuts, source ranges, basic transitions, audio placement, and captions where supported.
- Bake unsupported HTML scenes, advanced caption animation, crop tracking, and grades to assets; export alpha-capable overlays or PNG sequences when the chosen renderer/codec supports them.
- Export dialogue/music/SFX stems and original audio so an editor can remix.
- Provide a loss report listing preserved, baked, approximated, and omitted effects, timebase conversions, and relink paths.
- Validate identical edit duration and ≤1-frame cut differences on fixtures in target DaVinci Resolve, Premiere Pro, and Final Cut Pro versions.

P2 may add sanctioned Resolve scripting, Premiere extensions, or FCP handoff tools. Initial integrations are export-first. A full bidirectional round-trip requires stable object IDs, reconciliation semantics, and effect equivalence and is a separate project; it is not implied by an XML export. DaVinci is a destination for professional refinement, not a dependency of core rendering.

## 23 Decisions to resolve during implementation spikes

These are bounded engineering decisions, not reasons to delay the first vertical slice: select the renderer after seek/performance/license tests; determine whether adapting AutoBroll is cheaper than a small original timeline; choose and evaluate the first local director/model pack; ratify device-specific ASR and render targets; settle application distribution/license strategy and binary codec configuration; validate brand font/media bundle rights; confirm P0 language scope from pilot recordings.

Each decision gets a short record with fixtures, measured tradeoffs, selected version, and fallback. The accepted baseline is an editable local talking-head short with conservative cuts, captions, original template motion, and reliable export. New components are accepted only if they strengthen that complete path.
