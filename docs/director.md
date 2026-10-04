# Director

`packages/director` proposes edit plans. Product code detects the candidates and
builds every timing, text label and id. A model, when one is used, only makes
choices over ids that the product already created. Every plan then goes through
validation before anything uses it.

The engine calls the director during Edit Video and picks the adapter (see
[engine.md](engine.md#director-selection)). Outside agents don't call the
director directly: they use the `takeoff` CLI, the MCP tools or the HTTP API,
documented in [agents.md](agents.md). As a library it is called like this:

```ts
import { directPlan, OllamaDirector, RulesDirector } from '@takeoff/director';
import { validatePlan } from '@takeoff/compiler';

const result = await directPlan(
  request,                                                  // a director-request
  [new OllamaDirector({ model: '<installed model>' }), new RulesDirector()],
  (plan) => validatePlan(plan, ctx).errors.map((e) => ({ path: '', message: e.code })),
  { seed: 0, durationsUs, speech },
);
// result: { plan, director, fallback, errors, attempts }
```

## `DirectorAdapter`

```ts
interface DirectorAdapter {
  id: string;
  capabilities(): Promise<{ available; semantic; imageReview; reason? }>;
  propose(req: DirectorRequest, ctx?: DirectorContext): Promise<EditPlan>;
  repair(req, plan, errors: ValidationIssue[], ctx?): Promise<EditPlan>;
}
```

`DirectorContext` carries the inputs that the `director-request` doesn't hold:

| Field | Purpose |
|---|---|
| `seed` | Default 0. Recorded in provenance and used to rotate zoom scales |
| `speech` | VAD intervals that protect untranscribed speech |
| `durationsUs` | Source durations, needed to trim trailing dead air |
| `assets` | Asset refs. Default: `assets/<id>.json`, `video` for word assets, `audio` for music and sfx |
| `musicAssetId`, `sfxAssetId` | Caller-supplied licensed assets |

## Detectors

`detectCandidates(words, {fillerStrength, speech, durationsUs})` returns
candidates with ids `cand_0001…`, ordered retakes first, then fillers, then
silences. All detectors are pure functions with no I/O, clock or randomness.
Thresholds are named constants in `src/detectors.ts`.

### Fillers (F04)

Hesitations (`um`, `uh`, `erm`, `hm`, `uhm` and stretched variants) are `high`
at every strength. Discourse markers become candidates only when they are
isolated: at a sentence start, after punctuation, or with a gap of at least
150 ms on each side. They must also not be grammatical in context.

| Marker | `conservative` | `normal` (default) | `aggressive` | Treated as grammatical (not a filler) when |
|---|---|---|---|---|
| `you know` | — | high | high | After "do", "if", "as", … or before "what", "how", "that", a determiner, … |
| `i mean` | — | high | high | — |
| `like` | — | medium | high | After "I", "you", "looks", "is", "something", … (with no comma between), or before a determiner or number |
| `basically` | — | medium | high | — |
| `so` | — | medium | high | Not at the start of a sentence |
| `actually` | — | — | medium | Not at the start of a sentence, or before a negation or number |

If a filler's alignment isn't `aligned`, or it overlaps a neighbouring word,
it is downgraded to `low`.

### Silences (F05)

- **Interior gaps.** A gap of at least 700 ms, measured from the latest word end
  so far, is cut down to a 300 ms pause: 150 ms is kept on each side.
- **Leading dead air.** The cut runs from 0 to 150 ms before the first word.
- **Trailing dead air.** The cut runs from 150 ms after the last word to the
  end of the source. This runs only when `durationsUs` is known.
- **VAD edges.** VAD speech that straddles a cut's edge (speech running on past
  the last word, or starting before the next) moves that edge to the speech
  boundary. A cut left shorter than 120 ms is dropped.
- **Tier.** `high` when the surrounding words are aligned and no VAD speech
  falls wholly inside the cut. Otherwise `medium`.
- `@takeoff/media` `detectSilence` is a separate FFmpeg `silencedetect`
  measurement. The director doesn't use it.

### Retakes and false starts (F03)

Retakes are matched only within one asset, with hesitations ignored. A
candidate fires when the first 3 normalised tokens of a phrase appear again
within 10 s. The earlier attempt must not contain a sentence end before its last
word.

| Pattern | Result |
|---|---|
| The earlier attempt is a prefix (its last token may be cut off), the later one is longer, and the earlier one is unfinished | `false_start`: `high` if aligned, else `medium` |
| A complete sentence repeated verbatim | Treated as emphasis: no candidate |
| The attempts diverge | `retake`: `low` if the earlier one was a complete sentence, else `medium` |

The candidate span runs from the first word of the earlier attempt to the start
of the later attempt.

## Rules director

`RulesDirector` (id `rules`) calls `buildPlan(req, ctx)`. Its output is
deterministic: the same request and context always produce the same plan.
`repair` simply rebuilds the plan.

- **Candidates.** The plan uses the request's own `candidates` when there are
  any; otherwise it runs the detectors. Each candidate is kept only if its
  toggle is on: `fillers`, `silence`, or `badTakes` (for retakes and false
  starts).
- **Decisions.**
  - A `high` candidate is removed, unless a model rejects it; then its action
    is `keep`.
  - A `medium` candidate is removed only if a model accepts it. Otherwise its
    action is `review`.
  - A `low` candidate always gets `review`.
  - A retake or false start under review adds an `uncertain_retake` marker
    (severity `warning`). Any other candidate under review that has
    non-aligned words adds an `alignment_uncertain` marker (severity `info`).
- **Segments** (`seg_0001…`) are each asset's span minus the merged removals.
  The span ends at `durationsUs`, or at the last word plus 150 ms. A piece left
  between cuts is kept only if it holds whole words, or is at least 300 ms long
  and overlaps VAD speech. A shorter wordless sliver is dropped as dead air.
- **Target length (F14).** The limit comes from `output.targetFrames` when
  `lengthPolicy` isn't `none`; otherwise it comes from `settings.targetSeconds`
  as a soft target. While the plan is over the limit, the director drops the
  complete middle sentence with the lowest priority score. A sentence scores
  for numbers, glossary terms, and words such as "not", "only" or "must". The
  first and last sentences are never dropped. A soft target counts as over when
  the plan exceeds the target by more than 10% and by more than 2 s. If the
  plan is still over after that, it adds a `duration_conflict` marker:
  `critical` for a hard maximum, `warning` otherwise.
- **Captions (F06).**
  - Groups of 2–7 words that fit 2 lines of 32 characters, breaking at
    punctuation or at a pause of at least 300 ms.
  - Template `restrained`, position `safe_face_aware`.
  - One emphasis word per caption: the model's pick, or else a number, then a
    glossary term, then a capitalised word that doesn't start a sentence.
  - With `captions` off, the plan carries no captions.
- **Punch zooms (F08)**, when `zoom` is on.
  - One zoom per emphasis word, at least 1.5 s apart, at most 4 per 30 s.
  - Each holds for 1.5 s, with `transitionFrames: 4` and
    `centerPolicy: "center"`.
  - Scales cycle through 1.08, 1.12 and 1.15, offset by `seed % 3`.
- **Hook (F13)**, when `textHook` is on.
  - Up to 3 options, taken from the opening sentence, the first sentence with a
    number or glossary term, and the closing sentence.
  - Each option has lead-ins ("so", "basically", …) and hesitations removed, is
    at most 8 words or 120 characters, and keeps the word ids it came from.
  - Options that contain a brand `prohibitedClaims` string are dropped.
  - The `hook_0001` visual lasts 3 s. User text from `settings.hook.text`
    replaces the option and locks the visual. With `autoSelect: false` and no
    user text, there is no hook.
- **Motion templates (F15)**, when `motionGraphics` is on. Templates fire only
  on deterministic word patterns:
  - `request_flow_v1`: "A sends / calls / requests … through / via / using B …
    to C".
  - `comparison_list_v1`: "X vs / versus / compared to Y", or "first … second
    (… third)" across this sentence and the next two.
  - Labels are transcript words used verbatim.
  - Only one animated layer shows at a time. A template starts after the hook
    and after any earlier template ends, and lasts 1.5–10 s.
  - Fallback is `presenter_only`.
- **Music and sfx (F09, F10).** These are added only when their toggle is on
  and the caller supplies `ctx.musicAssetId` or `ctx.sfxAssetId`.
  - Music covers the whole timeline at −18 dB, with ducking on and fades of
    `min(15, total/4)` frames in and `min(30, total/4)` frames out.
  - Sfx adds one `whoosh` at −12 dB per motion template.
- **Audio.** The dialogue profile is `studio_conservative` when `studioVoice`
  is on, otherwise `bypass`. `seamFadeMs` is 40. The mix target is −14 LUFS
  and −1 dBTP.
- **Provenance** is `{director: "rules", seed, promptVersion: null}`.

## Model-backed directors

Both model-backed adapters use the same loop:

1. Build the rules plan.
2. Send the model the candidates (`id`, `kind`, `tier`, `wordIds`, `evidence`),
   the words (`id`, `text`) and the hook options (`index`, `text`).
3. Parse the reply into `DirectorChoices`.
4. Rebuild the plan with `buildPlan`, passing in those choices.

A model may only:

- accept `medium` candidates;
- reject `high` candidates;
- choose emphasis word ids;
- choose a hook by index, or `null` for no hook.

`parseChoices` drops any id that the product didn't create. A model never writes
timings, text, settings or ids.

- **Prompt.** The system prompt is `src/prompts/director_v1.md`, and
  `PROMPT_VERSION` is `director_v1`. A prompt change means a new file name and
  a new version.
- **Untrusted data.** The user message is the data as JSON inside
  `<untrusted_data>…</untrusted_data>`, with every `<` escaped. No word can
  close the fence.
- **Reply handling.**
  - A reply over 1,000,000 characters is refused.
  - Code fences are stripped before parsing.
  - A reply that isn't JSON throws `director reply is not JSON`, without
    echoing the model's text.

### `OllamaDirector` (loopback only)

- **Host.** The host is the constant `127.0.0.1`. Only the port can be set
  (default `11434`).
- **Requests.** `capabilities()` calls `/api/tags` with a 2 s timeout and
  checks that the model, or `<model>:latest`, is installed. `propose` calls
  `/api/chat` with `format: "json"`, `temperature: 0` and the seed. Redirects
  are refused, and the default timeout is 120 s.
- **Provenance.** The director is recorded as `ollama-<model>`.

### `ExternalDirector` (boundary only)

- **No network of its own.** It builds an Anthropic Messages API body
  (`model`, `max_tokens` default 2048, `temperature: 0`, `system`, `messages`)
  and passes it to an injected `send` function. That function belongs to the
  engine's provider broker, which owns transport, credentials and egress
  records.
- **Local-only projects.** It throws
  `external director refused: project is local_only` before calling `send`
  when `settings.networkPolicy` is `local_only`.
- **Provenance.** The director is recorded as `external-<provider>-<model>`.

## Validate, repair, fall back

`directPlan(req, adapters, validate, ctx)` picks the first adapter whose
`capabilities().available` is true. If that adapter isn't `rules`:

1. **Propose.** The plan is checked against the boundary rules first: the
   director must not change `projectId`, `revision`, `settings` or `output`.
   Then the injected validator runs.
2. **Repair once.** On failure, the adapter gets up to 20 issues, each cut to
   200 characters. The prompt adds "when unsure, accept fewer candidates". If
   `propose` threw, there is nothing to repair, and this step is skipped.
3. **Fall back.** If the plan still fails, the rules plan from `buildPlan` is
   validated and returned with `fallback: true`.

`attempts` records each stage's director and issues. `errors` holds the issues
of the plan that was returned; it is empty when that plan passed.

## Checks

```sh
node --test "packages/director/test/**/*.test.ts"
```

Tests use synthetic words and a loopback `node:http` stub in place of Ollama.
They never reach a real model or provider. A detector change adds a positive
and a negative word-list test.
