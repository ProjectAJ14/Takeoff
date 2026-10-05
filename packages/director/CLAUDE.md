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

- User B-roll before a motion template later in the same sentence is shortened to end before it (still ≥ 1.5 s), never overlapping it.
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
  untranscribed speech is never dropped as dead air; a wordless span under 300 ms
  (below the worker's VAD minimum silence) is dropped regardless. A silence cut whose
  edge falls inside VAD speech moves to the speech boundary; only VAD speech wholly
  inside the cut makes it a review.
- A model picks a hook by index into the options it was shown; `parseChoices`
  resolves that to the option's evidence ids, and `null` means no automatic hook.
- Deterministic: same request and context → same plan. No clock, randomness or I/O
  in `detectors.ts` and `plan.ts`.
- Labels for motion templates and hook text are transcript words verbatim; music
  and SFX appear only when enabled and the caller supplies the asset id.
- Hook options never come from a sign-off sentence ("Thanks for watching", "See you", "That's it").
- Hook options (F13) are complete phrases of ≤9 surviving words: lead-ins and stated
  intent ("So today I want to explain") are stripped, a long sentence is cut at clause
  punctuation or before a clause/phrase start, never ends on a function word, and is
  rejected when the cut would drop a qualifier or negation, or no boundary exists.
- Fillers (F04): `settings.fillerDictionary.preserve` always wins, also over
  caller-supplied candidates; `remove` entries add `high` candidates (built-in markers
  keep their grammatical guard); standalone "Ah," (sentence start) and "Mm" (comma or
  pause) count at every strength. Uncertain alignment or overlap still demotes to `low`.
- Retakes across files (F03): a sentence in an earlier take whose first 4 words (homophones "to/2", "for/4" folded)
  open a sentence in a later take is the same idea. Unfinished prefix or a restart cue ("let me start again") → `high`
  `false_start`; any other difference → `medium` review; identical sentences → nothing. Lexical only, no semantics.
- Purposeful pauses (F05): a pause after an ASR "..."/"—"/":" word, or before a ≤2-word ending that follows a
  non-final word or a question ("the answer is? Nothing."), is a `medium` silence (review), never auto-cut.
- Hard max (F14): a ≤2-word sentence counts as part of the one before it (setup and payoff drop together);
  whole middle sentences are dropped by priority until the frames fit;
  if first + last still do not fit, a `critical` `duration_conflict` marker carries the
  frame numbers and the compiler treats the draft as an export-blocking conflict.
- B-roll (F07) only with ≥1 exact stemmed tag match in a retained sentence: anchored to
  the word, 1.5–4 s inside its sentence, not before 1.5 s, ≤1 per 8 s, never over a
  motion template, each asset once; `full` only for an image with ≥2 tag hits.
- Music (F09) by brief mood (default calm), preferring a track that covers the
  timeline; SFX (F10) a hit on the hook and a whoosh on each template, ≤1 per 5 s.
- `source_clipping` marker when `ctx.voiceAnalysis` reports clipping > 0.1 % or severe.
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
