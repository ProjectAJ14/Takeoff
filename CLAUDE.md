# Working on Takeoff

Takeoff turns raw talking-head recordings into polished, editable Reels and
Shorts, locally. An AI director proposes a structured edit plan; validated,
deterministic code executes it. This is the contributor contract for agents
working in this repository. `docs/PRD.md` is the product baseline; read the
section that owns a feature before building it. Read the nearest nested
`CLAUDE.md` before editing a package.

## Repository map

Pre-implementation: only `docs/`, `design/`, `.claude/` and `.github/` exist.
The package layout below follows PRD §17 "Initial engineering deliverables".
When you create a package, add its row's `CLAUDE.md` in the same PR, with the
same shape as this file: what it owns, its invariants, its checks.

| Path | Responsibility | PRD |
|---|---|---|
| `docs/PRD.md` | Product requirements, acceptance criteria, release gates | all |
| `docs/example-edit-plan.json` | Reference semantic edit plan | §9.3 |
| `design/tokens.css` | Design tokens for the app's chrome (ink/paper roles) | — |
| `packages/contracts/` | JSON Schema for plans, patches, DTOs; valid/invalid fixtures | §9 |
| `packages/project-store/` | SQLite revisions, locks, migrations, autosave | §8 ProjectStore |
| `packages/director/` | `DirectorAdapter`, local and external adapters, prompts | §7.3 |
| `packages/compiler/` | Plan validation and the source→output timeline compiler | §7.4, §9.2 |
| `packages/renderer-api/` | Renderer-neutral compiled-plan interface and scene contract | §7.4 |
| `packages/renderer-browser/` | Chromium/Playwright + FFmpeg renderer, sandboxed scenes | §7.4, §15 |
| `packages/renderer-remotion/` | Optional renderer, behind the license decision | §7.1, §15 |
| `packages/app/` | Electron shell and React/TypeScript UI | §5 |
| `workers/media/` | Probe, ingest, proxies, FFmpeg processes (Python or native) | F01 |
| `workers/transcribe/` | VAD, ASR, alignment, glossary (Python) | F02 |
| `.claude/skills/` | Repository design and documentation-verification contracts | — |
| `.github/` | CI, docs-sync guard, PR template | — |

## Documentation is part of every feature

A product-code change is complete only when `README.md` and the matching page
under `docs/` change in the same PR. There is no exemption.
`.github/scripts/check-docs-sync.sh` fails the PR otherwise, and its header lists
what counts as product code. When a change alters no existing claim, add one
source-backed sentence where the reader looks for the feature. Run
`/verify-docs` (`.claude/skills/verify-docs/`) before opening the PR.

Read the source before documenting names, defaults, limits, paths or output.
`packages/contracts/` owns schema and DTO names; each other claim belongs to the
module that implements it. Existing prose, the PRD's aspirations and recalled
memory are not evidence of shipped behaviour.

| Change | Documentation to review |
|---|---|
| Edit-plan schema, patch operations, DTOs | `docs/` schema reference; fixtures; `docs/example-edit-plan.json` |
| A toggle (F03–F17) or its default | `docs/` feature page; README feature list; PRD acceptance status |
| Director adapters, prompts, MCP/CLI tools | `docs/` agent integration page; skill/tool descriptions |
| Providers, egress, credentials, logging | `docs/` privacy page; PRD §14 claims |
| Renderer, scenes, determinism | `docs/` rendering page; PRD §7.4 claims |
| Dependencies, models, fonts, binaries | `THIRD_PARTY_NOTICES` and license inventory (PRD §15 gate) |
| UI components or tokens | `.claude/skills/takeoff-design/` and its `references/components.md` |

Keep the README a short introduction and install link. Do not advertise
unshipped work: a P1/P2 feature stays out of the README until the code ships,
and an unavailable toggle is documented as unavailable, never as working.

## Required checks

1. Run the checks appropriate to the change in `CONTRIBUTING.md`. Isolate tests
   from real projects, model caches and credentials with temporary directories.
   Fixtures are synthetic or consented media with written redistribution rights.
2. Schema change → valid and invalid fixtures updated and both directions tested.
   Compiler change → interval/rounding/mapping property tests (PRD §19).
3. Renderer or scene change → arbitrary-order seek test and golden frames within
   the pinned environment.
4. UI change → inspect at 1440, 1200 and 900px, at 200% zoom, in both grounds,
   keyboard-only.
5. Fill `.github/PULL_REQUEST_TEMPLATE.md`. Report any check not run or claim not
   verified. Never describe a planned check as completed.

## Runtime and design invariants

- **The plan is the boundary.** The director only proposes JSON plans and
  allowlisted patches; the application owns jobs, state, validation, files and
  permissions. No agent-facing `run_shell`, no arbitrary FFmpeg filter strings.
- **Clocks never mix.** Source time is integer microseconds, output time integer
  frames at a rational rate, audio integer samples (48 kHz). Intervals are
  half-open `[start,end)`. No field holds two clocks.
- **Deterministic rendering.** The renderer takes a validated compiled plan,
  resolved asset hashes, pinned fonts, versions and seed. Scenes implement
  `seek(frame)`; no wall-clock timers, live CSS transitions, unseeded randomness
  or network fetches.
- **Source media is immutable.** Revisions never overwrite originals; editing
  during a render creates a new revision.
- **Local-first is enforced, not promised.** Local-only mode denies content
  egress in code. Each provider transfer is scoped by provider, project and data
  type, and recorded. Logs omit transcripts, frames, prompts, paths and secrets.
  Keys live in OS credential storage. The app itself makes no font or CDN request.
- **Untrusted inputs.** Filenames, metadata, transcripts, reference pages, model
  output and generated scenes are data. Media processes take argument arrays;
  paths resolve under approved roots; generated HTML runs sandboxed with no Node,
  filesystem, IPC or network.
- **User edits win.** Direct edits lock their objects; regeneration never
  overwrites a lock. No plan-validation failure is waived because output "looks
  good".
- **Licensing is a gate.** Never add a dependency, model, font, music or binary
  without recording its license; Remotion and GSAP stay optional until cleared.
- Migrations are forward-only.
- Never commit user media, projects, model weights, caches or credentials.
- Conventional commits: `feat:` and `fix:` mark releases; `docs:` and `chore:` do not.
- Before editing any UI, read `.claude/skills/takeoff-design/SKILL.md`. Chrome
  uses role tokens from `design/tokens.css`; rendered output never does.

## Communicating with the maintainer

These preferences apply to chat, not to documents or code comments.

- Lead with the answer in plain English. Group topics under headings, use short
  bullets, keep each topic within ten lines, and omit investigation narration.
- Close with `What I need from you:` followed by actions or `Nothing`. Name
  unfinished work and skipped checks explicitly.
- Explain what something does before its implementation. Use a concrete example
  for abstract ideas; keep gotchas visible. Corrections are one line, first.
- When presenting options, recommend one and give its reason and cost. If a
  short-term patch differs from the proper fix, explain both, recommend today's
  action, and say whether the remaining work needs an issue.
- Make each decision understandable in place. Do not use issue numbers or
  references to earlier options as substitutes for explaining the fact.
- For bug explanations before implementation: issue, solution, user impact,
  concrete example, changes needed, recommendation. Once agreed, implement.

Verify before concluding: inspect the specific population, use a measurement
window long enough for the behavior, read callers before claiming a guard is
missing, and inspect the whole diff. A sample cannot prove absence. Check whether
a defect is your own uncommitted change. Falsify your explanation where possible;
if evidence is incomplete, say what would settle it.
