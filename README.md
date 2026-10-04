# Takeoff

Drop in your takes, choose your edits, get a polished short you can still change.

Takeoff turns raw talking-head recordings into editable vertical Reels and
Shorts, locally. An AI director proposes a structured edit plan; validated,
deterministic code executes it. You get an MP4, captions, audio stems and a
project you can keep editing.

**What works today (macOS, from a source checkout):**

- **Desktop app.** First run, create, processing, review and export, on the same
  engine as the CLI. No installer yet. See [docs/app.md](docs/app.md).
- **CLI, MCP and HTTP API.** Import takes, transcribe offline, cut fillers,
  silences and false starts (also across takes), add captions, face-framed
  crops, zooms, a hook, motion graphics, your own tagged B-roll, music and sound
  effects, apply a brand (colours, font, logo), render, check quality and export
  a 1080×1920 MP4.

[docs/features.md](docs/features.md) shows each feature's status, including
what is partial or unavailable. [docs/release-gates.md](docs/release-gates.md)
shows what is still missing before a release. With **Hard maximum** on, a final
export never runs longer than the target: if your locked speech cannot fit, you
get a longer draft with the conflict stated, and final export refuses it.

## Install

You need macOS (the only platform tested so far), Node.js 24+, `ffmpeg`/`ffprobe`
with libx264, and [uv](https://docs.astral.sh/uv/). Details are in
[CONTRIBUTING.md](CONTRIBUTING.md).

```sh
npm install
npx playwright install chromium            # the renderer's browser (also installs the headless shell)
(cd workers/transcribe && uv sync)         # the transcription and face-tracking worker
```

## Run the desktop app

```sh
npm run dev -w @takeoff/app                # build, then start Electron
```

The first-run screen offers the starter pack; it downloads the Whisper `base`
model only when you allow it.

## Run the CLI

```sh
alias takeoff="node $PWD/packages/engine/bin/takeoff.js"

takeoff starter-pack --allow-network   # one-time: Whisper base model (if missing) + generated music/SFX
takeoff render-test /tmp/takeoff-test.mp4

takeoff init ~/Videos/MyReel --name "My reel"
takeoff import ~/Videos/MyReel ~/Videos/take1.mov
takeoff import ~/Videos/MyReel ~/Videos/server-rack.png --pool broll --tags 'server,network'
takeoff edit ~/Videos/MyReel --target auto --toggles '{"badTakes":true,"fillers":true,"silence":true,"captions":true,"userBroll":true,"aiBroll":false,"zoom":true,"music":true,"sfx":true,"studioVoice":true,"autoColor":true,"textHook":true,"motionGraphics":true,"networkPolicy":"local_only","fillerStrength":"normal"}'
takeoff export ~/Videos/MyReel ~/Videos/exports
```

`takeoff --help` lists every command, including `brand`. Everything runs on
your machine; the starter pack's model download is the only network step, and
it runs only when you pass `--allow-network`.

## Documentation

- [Feature status](docs/features.md)
- [Desktop app](docs/app.md)
- [Agent integration: CLI, MCP and HTTP API](docs/agents.md)
- [Engine: jobs, faces, brands, QA, export](docs/engine.md)
- [Privacy and egress](docs/privacy.md)
- [Rendering](docs/rendering.md)
- [Benchmarks](docs/benchmarks.md) and [release gates](docs/release-gates.md)
- [Architecture](docs/architecture.md)
- [Schema reference](docs/schema.md)
- [Timeline compiler](docs/timeline.md)
- [Projects and jobs](docs/projects.md)
- [Media, transcription and face tracking](docs/media.md)
- [Director](docs/director.md)
- Product baseline: [docs/PRD.md](docs/PRD.md)
- Licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

- Contributing and setup: [CONTRIBUTING.md](CONTRIBUTING.md)
- Agent and repository rules: [CLAUDE.md](CLAUDE.md)
- Interface design system: [.claude/skills/takeoff-design/SKILL.md](.claude/skills/takeoff-design/SKILL.md), values in [design/tokens.css](design/tokens.css)
