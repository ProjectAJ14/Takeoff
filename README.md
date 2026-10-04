# Takeoff

Drop in your takes, choose your edits, get a polished short you can still change.

Takeoff is a local-first desktop app that turns raw talking-head recordings into
editable vertical Reels and Shorts. An AI director proposes a structured edit
plan; validated, deterministic code executes it. You get an MP4, captions, and a
project you can keep editing.

**Status:** early implementation. There is no app, renderer or export yet, so
Takeoff can't produce a video today. What works now is a set of tested
libraries that can only be called from code:

| Package | What it does today |
|---|---|
| `packages/contracts` | JSON Schemas, types and `validate()` for plans, patches, transcripts and DTOs |
| `packages/compiler` | Plan validation, the source→output timeline compiler and patch application |
| `packages/project-store` | A SQLite project store: revisions with undo, redo and revert; jobs; crash recovery |
| `packages/director` | Filler, silence and retake detection; the rules director; adapters for a local Ollama model and an external model |
| `packages/renderer-api` | The renderer and scene contract, safe areas, a seeded PRNG and easings |
| `workers/media` | FFmpeg probe, ingest (proxy and WAVs), loudness, voice and color analysis, frame extraction |
| `workers/transcribe` | Offline faster-whisper transcription with VAD and word timing (Python CLI) |

The browser renderer, the engine (jobs, CLI, MCP, HTTP API) and the desktop app
are being built and are not usable yet. [docs/features.md](docs/features.md)
shows each feature's status honestly.

## Documentation

- [Feature status](docs/features.md)
- [Architecture](docs/architecture.md)
- [Schema reference](docs/schema.md)
- [Timeline compiler](docs/timeline.md)
- [Projects and jobs](docs/projects.md)
- [Media and transcription](docs/media.md)
- [Director and agent integration](docs/director.md)
- [Rendering](docs/rendering.md)
- Product baseline: [docs/PRD.md](docs/PRD.md)
- Licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

- Contributing and setup: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent and repository rules: [CLAUDE.md](CLAUDE.md)
- Interface design system: [.claude/skills/takeoff-design/SKILL.md](.claude/skills/takeoff-design/SKILL.md), values in [design/tokens.css](design/tokens.css)
