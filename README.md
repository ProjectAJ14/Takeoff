# Takeoff

Drop in your takes, choose your edits, get a polished short you can still change.

Takeoff turns raw talking-head recordings into editable vertical Reels and
Shorts, locally. An AI director proposes a structured edit plan; validated,
deterministic code executes it. You get an MP4, captions, audio stems and a
project you can keep editing.

**Status:**

- **CLI route: works end to end, locally.** The `takeoff` CLI imports takes,
  transcribes them offline, cuts fillers, silences and false starts, adds
  captions, zooms, a hook, motion graphics, music and sound effects, renders,
  checks quality and exports a 1080×1920 MP4. Agents can drive the same steps
  through MCP or a loopback HTTP API.
- **Desktop app: in progress.**

[docs/features.md](docs/features.md) shows each feature's status, including
what is partial or unavailable.

## Quickstart

You need macOS (the only platform tested so far), Node.js 24+, `ffmpeg`/`ffprobe` with libx264, and
[uv](https://docs.astral.sh/uv/). Setup details are in
[CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm install
npx playwright install chromium                  # the renderer's browser (also installs the headless shell)
(cd workers/transcribe && uv sync)               # the transcription worker
alias takeoff="node $PWD/packages/engine/bin/takeoff.js"

takeoff starter-pack --allow-network   # one-time: Whisper base model (if missing) + generated music/SFX
takeoff render-test /tmp/takeoff-test.mp4

takeoff init ~/Videos/MyReel --name "My reel"
takeoff import ~/Videos/MyReel ~/Videos/take1.mov
takeoff edit ~/Videos/MyReel --target auto --toggles '{"badTakes":true,"fillers":true,"silence":true,"captions":true,"userBroll":false,"aiBroll":false,"zoom":true,"music":true,"sfx":true,"studioVoice":true,"autoColor":true,"textHook":true,"motionGraphics":true,"networkPolicy":"local_only","fillerStrength":"normal"}'
takeoff export ~/Videos/MyReel ~/Videos/exports
```

`takeoff --help` lists every command. Everything runs on your machine; the
starter pack's model download is the only network step, and it runs only when
you pass `--allow-network`.

## Documentation

- [Feature status](docs/features.md)
- [Agent integration: CLI, MCP and HTTP API](docs/agents.md)
- [Engine: jobs, QA, export](docs/engine.md)
- [Privacy and egress](docs/privacy.md)
- [Rendering](docs/rendering.md)
- [Architecture](docs/architecture.md)
- [Schema reference](docs/schema.md)
- [Timeline compiler](docs/timeline.md)
- [Projects and jobs](docs/projects.md)
- [Media and transcription](docs/media.md)
- [Director](docs/director.md)
- Product baseline: [docs/PRD.md](docs/PRD.md)
- Licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

- Contributing and setup: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent and repository rules: [CLAUDE.md](CLAUDE.md)
- Interface design system: [.claude/skills/takeoff-design/SKILL.md](.claude/skills/takeoff-design/SKILL.md), values in [design/tokens.css](design/tokens.css)
