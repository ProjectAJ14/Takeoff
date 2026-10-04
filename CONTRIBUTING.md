# Contributing to Takeoff

Read [CLAUDE.md](CLAUDE.md) for repository rules and the `CLAUDE.md` in the
package you change. Behaviour and its documentation ship in the same PR.

## Set up development

Nothing to build yet. Each package adds its setup block here when it lands
(PRD §17 build order: contracts and media spine first).

## Choose the right checks

| Change | Required evidence |
|---|---|
| Edit-plan schema or DTOs | Valid and invalid fixtures; both directions tested |
| Compiler or timing | Property tests for half-open intervals, rounding, rational rates, source↔output mapping |
| Renderer or scenes | Arbitrary-order seek test; golden frames in the pinned environment |
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
