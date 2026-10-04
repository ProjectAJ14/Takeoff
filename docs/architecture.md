# Architecture

How Takeoff's packages fit together, and the implementation decisions taken
against PRD §7 and §23. Each package's `CLAUDE.md` owns its own detail; this page
owns the boundaries between them.

## Runtime and tooling

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript, run directly by Node ≥ 24 type stripping | No build step for Node packages; `tsc --noEmit` type-checks |
| Syntax limit | Erasable syntax only (`erasableSyntaxOnly`): no `enum`, no parameter properties, no `namespace` | Required by Node type stripping |
| Imports | Relative imports end in `.ts`; packages import each other as `@takeoff/<name>` | Each package's `exports` points at `src/index.ts` |
| Workspace | npm workspaces (`packages/*`, `workers/media`) | Ships with Node; one lockfile |
| Tests | `node:test` + `node:assert/strict`, files `test/**/*.test.ts` | No test framework dependency |
| Schema validation | JSON Schema 2020-12 with Ajv | Producer and consumer validate the same schema (PRD §9.2) |
| Database | `node:sqlite` | Built into Node; no native module |
| Python | `workers/transcribe`, managed by `uv`, Python 3.12 | faster-whisper wheels |
| Media | System FFmpeg/ffprobe, spawned with argument arrays | PRD §15 |
| Overlay renderer | Chromium through Playwright, frames piped to FFmpeg | PRD §7.1 unrestricted-core candidate |
| Desktop shell | Electron + React, bundled by Vite | PRD §7.1 |
| Local director | Rule-based baseline always; Ollama on `127.0.0.1` when a model is installed | Offline route (PRD §4, §7.3) |

## Package graph

```text
contracts ◄── every package
compiler      ◄── contracts
project-store ◄── contracts
renderer-api  ◄── contracts
director      ◄── contracts
workers/media ◄── contracts
renderer-browser ◄── renderer-api, contracts, workers/media
engine        ◄── all of the above + workers/transcribe (subprocess)
app           ◄── engine (HTTP over loopback), contracts (types only)
```

`packages/engine/` is the job coordinator PRD §8 describes as several services
(EditorialEngine orchestration, PlanValidator wiring, RenderService, QAService,
ProviderBroker, ExportService) plus the versioned loopback HTTP API, the
`takeoff` CLI and the MCP stdio server. They share one process and one job store,
so they are one package.

## Clocks

| Clock | Unit | Field suffix | Example |
|---|---|---|---|
| Source | integer microseconds | `Us` | `sourceStartUs` |
| Output video | integer frames at a rational rate `{num, den}` | `Frame` / `Frames` | `startFrame` |
| Output audio | integer samples at 48 kHz | `Sample` / `Samples` | `startSample` |

All intervals are half-open `[start, end)`. Conversion happens only in
`packages/compiler`; frames from microseconds use `floor(us * num / (den * 1e6))`
on the cumulative retained duration, so per-segment rounding never accumulates.

## Data flow

```text
import ─► probe + proxy + analysis WAV (workers/media)
       ─► VAD + ASR + word timing (workers/transcribe)
       ─► candidates: fillers, silences, retakes (director/rules)
       ─► director proposes EditPlan (rules or Ollama or external)
       ─► validatePlan (contracts schema + compiler semantic rules)
       ─► compile → CompiledTimeline (compiler)
       ─► render overlays (renderer-browser, Chromium seek(frame))
       ─► compose video + audio (FFmpeg filter graph built from validated numbers)
       ─► QA (decode, duration, loudness, caption bounds) ─► export
```

The director never sees a path or a shell. It receives transcript words, candidate
evidence and settings, and returns JSON that is validated before anything runs.

## Package pages

[schema.md](schema.md) (contracts) · [timeline.md](timeline.md) (compiler) ·
[projects.md](projects.md) (project-store) · [media.md](media.md) (media and
transcription workers) · [director.md](director.md) · [rendering.md](rendering.md)
· [engine.md](engine.md) · [agents.md](agents.md) (CLI, MCP, HTTP API)
· [privacy.md](privacy.md) · [features.md](features.md) (feature status)
