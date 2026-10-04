# Contributing to Takeoff

Read [CLAUDE.md](CLAUDE.md) for repository rules and the `CLAUDE.md` in the
package you change. Behaviour and its documentation ship in the same PR.

## Set up development

Before you start, install:

- Node.js 24 or newer
- `ffmpeg` and `ffprobe` with `libx264` on `PATH`. To use other binaries, set
  `TAKEOFF_FFMPEG` and `TAKEOFF_FFPROBE`
- [uv](https://docs.astral.sh/uv/) for the Python transcription worker

```sh
npm install                          # all workspaces; Node runs TypeScript directly, there is no build step
npx playwright install chromium      # Chromium and its headless shell for the renderer
(cd workers/transcribe && uv sync)   # Python 3.12 environment for the transcription worker
npm run check                        # tsc --noEmit + every Node test (packages/* and workers/media)
```

The Python worker has its own tests:

```sh
cd workers/transcribe && uv run python -m unittest discover -s tests -v
```

These tests need macOS `say`, `ffmpeg`, `node` and the cached
`Systran/faster-whisper-tiny` model. To download the model once, run:

```sh
uv run python -m takeoff_transcribe download-model --model tiny --allow-network
```

The speech tests skip when `say` or `ffmpeg` is missing.

To test one package: `node --test "packages/<name>/test/**/*.test.ts"`.
Each package's `CLAUDE.md` lists its own checks.

### Render test and end-to-end route

```sh
node packages/engine/bin/takeoff.js render-test /tmp/takeoff-test.mp4   # seconds: five-second synthetic clip through import, plan, render and QA
node packages/engine/test/e2e/run-e2e.ts                                # ~1 min: the whole CLI route on synthetic speech
```

`render-test` needs FFmpeg and the Playwright Chromium, but no ASR model. It
prints the QA status of each check.

`run-e2e.ts` is not part of `npm test`. It needs macOS `say`, FFmpeg, uv with
the cached `base` model and the Playwright Chromium. It runs `starter-pack`,
`init`, `import`, `edit` with every P0 toggle, `plan`, `render --final`, `qa` and
`export` in a temporary folder, then checks the export: 1080×1920 30 fps
H.264/AAC, decoded frames equal to compiled frames, −14 ±1 LUFS and true peak
≤ −1 dBTP, captions without fillers or the false start, transcript-verbatim
graphics labels, stem lengths and unchanged sources.

- `TAKEOFF_E2E_KEEP=1` keeps the temporary folder, including six PNG frames to
  inspect.
- `TAKEOFF_E2E_OLLAMA=<model>` also runs the Ollama director and checks that a
  missing model falls back to the rules director.

## Choose the right checks

| Change | Required evidence |
|---|---|
| Edit-plan schema or DTOs | Valid and invalid fixtures; both directions tested |
| Compiler or timing | Property tests for half-open intervals, rounding, rational rates, source↔output mapping |
| Renderer or scenes | Arbitrary-order seek test; golden frames in the pinned environment ([rendering.md](docs/rendering.md#determinism-and-golden-frames)); `render-test` |
| Engine, CLI, MCP or HTTP API | `node --test "packages/engine/test/**/*.test.ts"`; `run-e2e.ts` for pipeline changes |
| Media / transcription workers | Synthetic-media integration test; no network in local-only mode |
| Providers or egress | Network-denial trace for local-only mode; transfer record for the provider |
| UI | 1440/1200/900px, 200% zoom, ink and paper, keyboard-only; `.claude/skills/takeoff-design/` checks |
| Docs only | `/verify-docs`; examples checked against source |
| Dependency, model, font, media, binary | License recorded before merge |

Use temporary directories for projects, caches and model paths in tests. Fixtures
must be synthetic or consented media with written redistribution rights. Never
commit user recordings, projects, model weights or credentials.

## Documentation guard

```bash
.github/scripts/check-docs-sync.sh origin/main
```

Fails when `packages/` or `workers/` changed without `README.md` and
a `docs/` page. CI runs it on every PR.

## Commits

Conventional Commits: `feat:` and `fix:` mark releases; `docs:`, `chore:`,
`test:` and `refactor:` do not.
