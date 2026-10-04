<!--
Work grounded in a real run is held to a different bar than work reasoned from
the PRD. The environment table and the evidence section are how a reviewer
tells the two apart, so fill them in even when the change looks obvious.
-->

## What changed

<!-- One or two sentences. Name the PRD section or feature (e.g. F04) it serves. -->

## What actually broke

<!--
The run that made you write this: the input, what Takeoff did, what it should
have done. Paste the plan excerpt, validation error or frame. A feature, doc fix
or refactor? Say so, and delete the environment table below.
-->

## Environment

| | |
|---|---|
| OS / arch | |
| Takeoff commit | |
| FFmpeg build | `ffmpeg -version` first line |
| Transcription model | |
| Director | local model / external provider + version |
| Renderer | browser / remotion + version |

## Evidence

<!-- Test output, golden-frame diffs, egress trace, before/after renders. -->

## Checks

- [ ] Tests for the touched packages pass (`CONTRIBUTING.md`)
- [ ] Product code changed → `docs/` and `README.md` changed and say the same thing (`CLAUDE.md`, *Documentation is part of every feature*; enforced by `docs-sync`, checked with `/verify-docs`)
- [ ] Schema changed → valid and invalid fixtures updated; `docs/example-edit-plan.json` still validates
- [ ] Renderer/scene changed → arbitrary-order seek and golden-frame tests pass
- [ ] UI changed → 1440/1200/900px, 200% zoom, both grounds, keyboard-only checked (`.claude/skills/takeoff-design/`)
- [ ] New dependency, model, font, media or binary → license recorded
- [ ] No user media, project, model weight, cache or credential committed
- [ ] Conventional Commit subject — `feat:` and `fix:` mark a release, `docs:` and `chore:` do not
