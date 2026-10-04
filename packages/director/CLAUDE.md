# packages/director

Owns the editorial director: deterministic edit candidates, the rules baseline
plan, the model-backed adapters and the propose → validate → repair → fallback
loop. Input is a `DirectorRequest`, output is an `EditPlan` (both from
`@takeoff/contracts`). PRD §6 F03–F06, F08, F13–F15, §7.3, §10, §13, §15.

## What lives here

| Path | Contents |
|---|---|
| `src/detectors.ts` | `detectFillers`, `detectSilences`, `detectRetakes`, `detectCandidates`: pure functions over words + optional VAD speech |
| `src/plan.ts` | `buildPlan` (the rules plan), `candidatesFor`, `hookOptionsFor`, `DirectorContext`, `DirectorChoices` |
| `src/director.ts` | `DirectorAdapter`, `RulesDirector`, `OllamaDirector`, `ExternalDirector`, `directPlan`, prompt builders |
| `src/prompts/director_v1.md` | Portable system prompt; `PROMPT_VERSION` names it in plan provenance |

Rule constants (silence ≥700 ms → 300 ms gap with ≥120 ms pads, 150 ms edge pad,
retake window 10 s / 3 tokens, captions 2–7 words and 2×32 chars, punch 1.08–1.15
with 1.5 s hold and ≤4 per 30 s) are named at the top of each file.

## Invariants

- Only `high` candidates are removed automatically. `medium` and `low` become
  `review` decisions; retakes under review also get an `uncertain_retake` marker.
  A model may accept a `medium` candidate or reject a `high` one, nothing more.
- A model never produces timings, text, settings or ids. `OllamaDirector` and
  `ExternalDirector` send product-made candidates, words (`id`, `text`) and hook
  options, then pass the parsed `DirectorChoices` back through `buildPlan`, which
  drops every id it did not create.
- The transcript goes to a model as JSON inside `<untrusted_data>`, with `<`
  escaped so no word can close the fence. Parse errors never echo model text.
- `OllamaDirector` talks to `127.0.0.1` only; the host is a constant, the port is
  the only option. `ExternalDirector` makes no network call: it hands a Messages
  API body to an injected `send` (the engine's ProviderBroker) and refuses
  `local_only` projects before calling it.
- `directPlan` rejects any plan that changes `projectId`, `revision`, `settings`
  or `output`, then runs the injected validator, allows one repair, and falls
  back to `buildPlan`. `provenance` records director, seed and prompt version.
- Segments are each asset's span minus removals. A span left between two cuts is
  kept only if it holds whole words or overlaps VAD speech (`ctx.speech`), so
  untranscribed speech is never dropped as dead air.
- A model picks a hook by index into the options it was shown; `parseChoices`
  resolves that to the option's evidence ids, and `null` means no automatic hook.
- Deterministic: same request and context → same plan. No clock, randomness or I/O
  in `detectors.ts` and `plan.ts`.
- Labels for motion templates and hook text are transcript words verbatim; music
  and SFX appear only when enabled and the caller supplies the asset id.
- Output-time numbers here (zoom spacing, visual durations) are estimates from
  retained source spans; the compiler stays authoritative for output time.

## Checks

```sh
node --test "packages/director/test/**/*.test.ts"
npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/director
```

A detector or rule change adds a positive and a negative word-list test (for
example "I like this" stays). A prompt change bumps the file name and
`PROMPT_VERSION`. Tests use synthetic words and a loopback `node:http` stub for
Ollama; they never reach a real model or provider.
