# packages/contracts

Owns every schema and DTO name in Takeoff: JSON Schema 2020-12 files, the
hand-written TypeScript types that mirror them, and one `validate(kind, value)`
entry point. Every other package imports `@takeoff/contracts`; none defines its
own plan, patch, transcript or DTO shape. PRD §8, §9, §11, §13, §14.

## What lives here

| Path | Contents |
|---|---|
| `src/schemas/*.schema.json` | One schema per kind; `common.schema.json` holds shared `$defs` (clocks, ids, hashes, paths) |
| `src/types.ts` | Exported TS types, one per schema; keep in step with the schema |
| `src/index.ts` | `schemas`, `commonSchema`, `contractKinds`, `ContractTypes`, `validate()` (Ajv 2020, strict, allErrors, discriminator) |
| `fixtures/valid/<kind>/` | Documents that must validate; `edit-plan/example-edit-plan.json` is a byte-equal copy of `docs/example-edit-plan.json` |
| `fixtures/invalid/<kind>/` | One broken rule per file; the filename names the rule |

Kinds: `edit-plan`, `patch`, `transcript`, `asset-manifest`, `compiled-timeline`,
`brand-profile`, `style-profile`, `job`, `qa-report`, `provider-receipt`,
`export-manifest`, `capabilities`, `create-project-request`/`-response`,
`import-assets-request`/`-response`, `create-job-request`, `director-request`,
`director-response`.

## Invariants

- `EditPlan.brandProfileRef` is a project-relative path or one stored brand version `brands/<id>@<version>` (version ≥ 1); fixtures `valid/edit-plan/all-visual-kinds.json` and `invalid/edit-plan/brand-ref-version-zero.json`.
- Every top-level document requires `schemaVersion: "1.0"`. Unknown versions and
  unknown enum values are errors, never guesses.
- Critical objects use `additionalProperties: false`. Visuals (`kind`),
  transforms (`kind`), patch ops (`op`) and import items (`source`) are
  discriminated unions; motion-template `params` are typed per template.
- Clocks never mix: `*Us` integer source microseconds, `*Frame(s)` integer output
  frames, `*Sample(s)` integer samples at 48 kHz. Times are integers ≥ 0, except
  `anchor.offsetFrames`, a signed delta bounded ±900. Rationals are `{num, den}`, both ≥ 1.
- Portable paths (`relPath`) are project-relative: no leading `/`, drive letter,
  backslash or `..` segment. Only `import-assets-request.path` carries a
  picker-authorised local path; the engine resolves it under approved roots.
- Patches are allowlisted typed operations. No op carries code, shell or filter strings.
- Schema checks only. Cross-field semantics (end > start, spans inside source
  duration, caption words surviving cuts, asset IDs resolving) belong to
  `packages/compiler`. Clock conversion helpers belong there too, not here.
- `settings.fillerDictionary` is `{preserve, remove}`, each ≤200 strings of 1–40 chars;
  B-roll visuals may carry an optional `reason` (≤200 chars).
- Max counts bound visuals (100), segments and captions (2000), assets (500),
  caption words (12), hook options (3), patch ops (200).

## Checks

```sh
node --test "packages/contracts/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/contracts
```

A schema change updates the schema, `src/types.ts`, at least one valid fixture
and one invalid fixture for the new rule, and `docs/` schema reference. If you
change `docs/example-edit-plan.json`, copy it into `fixtures/valid/edit-plan/`.
