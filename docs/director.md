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
| `assets` | Asset refs. Default: `assets/<id>.json`, `video` for word assets. Chosen B-roll, music and SFX are appended when missing |
| `broll` | F07 user B-roll pool: `{id, kind: video \| image, tags, durationUs}`. `brollTags(fileName, userTags)` makes tags from the file name's words (extension, numbers, words under 3 letters and generic words such as `clip` or `screenshot` dropped) plus user tags |
| `musicTracks` | F09 licensed tracks `{id, moods, durationUs}` |
| `sfxAssets` | F10 licensed effects `{id, category}` |
| `brief` | Creative brief; only its mood words are read |
| `voiceAnalysis` | F11 clipping per source asset `{clippingRatio, severe?}` |
| `musicAssetId`, `sfxAssetId` | Legacy single assets, used when `musicTracks` / `sfxAssets` are absent (`sfxAssetId` as a whoosh) |

## Detectors

`detectCandidates(words, {fillerStrength, fillerDictionary, speech, durationsUs})` returns
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

A standalone "Ah," (at a sentence start, followed by a comma) or "Mm" (between
punctuation or pauses) is also a `high` hesitation at every strength; "Ah I see"
or "it is mm good" is not.

**Custom dictionary** (`settings.fillerDictionary`, `{preserve, remove}`, each at
most 200 entries of 1–40 characters; an entry may be several words):

- A `preserve` entry always wins: words it covers are never a filler candidate,
  including candidates the caller supplied without the dictionary.
- A `remove` entry adds a `high` candidate wherever it occurs. When the entry is a
  built-in marker (`like`), that marker keeps its grammatical guard, so "I like
  this" stays.

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
- **Purposeful pauses.** A pause after a word the ASR ends with `...`, `…`, `—`
  or `:`, or before a sentence ending of at most 2 words that follows a
  non-final word or a question ("the answer is? Nothing."), is lowered to
  `medium`: a review, never an automatic cut.
- `@takeoff/media` `detectSilence` is a separate FFmpeg `silencedetect`
  measurement. The director doesn't use it.

### Retakes and false starts (F03)

**Within one take**, with hesitations ignored, a candidate fires when the first
3 normalised tokens of a phrase appear again within 10 s. The earlier attempt
must not contain a sentence end before its last word. Short homophones are
folded ("to", "too", "two", "2"; "for", "four", "4").

| Pattern | Result |
|---|---|
| The earlier attempt is a prefix (its last token may be cut off), the later one is longer, and the earlier one is unfinished | `false_start`: `high` if aligned, else `medium` |
| A complete sentence repeated verbatim | Treated as emphasis: no candidate |
| The attempts diverge | `retake`: `low` if the earlier one was a complete sentence, else `medium` |

The candidate span runs from the first word of the earlier attempt to the start
of the later attempt.

**Across takes** (take order is story order): a sentence of at least 4 words in
an earlier take whose first 4 tokens open a sentence in a later take is an
attempt at the same idea. The candidate covers the earlier sentence.

| Pattern | Result |
|---|---|
| The earlier sentence is an unfinished strict prefix of the later one, or contains a restart cue ("let me start again", "start over", "one more time", …) | `false_start`: `high` if aligned, else `medium` |
| Identical sentences | No candidate |
| Any other difference | `retake`, `medium` (review) |

Matching is lexical only: a reworded retake is not grouped, and a complete
earlier take is never removed for a later partial one.

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
  first and last sentences are never dropped, and a sentence of at most 2 words
  ("Nothing.") is dropped together with the one before it, never on its own. A
  soft target counts as over when the plan exceeds the target by more than 10%
  and by more than 2 s. If the plan is still over after that, it adds a
  `duration_conflict` marker: `critical` for a hard maximum (its message gives
  the frames needed and the maximum), `warning` otherwise. The compiler turns a
  critical one into the export-blocking `locked_duration_conflict` warning
  ([timeline.md](timeline.md#validateplan)).
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
  - Sign-offs ("Thanks for watching", "See you", "That's it") are never used.
  - Lead-ins ("so", "basically", "today", …), hesitations and stated intent
    ("I want to explain", "let me show you") are removed.
  - An option is at most 9 words and 120 characters. A longer sentence is cut
    after its last clause punctuation, else before its last clause or phrase
    start ("and", "because", "to", …) within the limit. It is rejected when no
    such boundary exists, or when the cut would drop a qualifier or negation
    ("most", "might", "not", …).
  - An option never ends on a function word, and its text is exactly its
    evidence words, so no word comes from elsewhere.
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
- **User B-roll (F07)**, when `userBroll` is on and `ctx.broll` has assets.
  - Only a kept sentence with at least one exact tag match (after a simple
    suffix-strip stem, so "servers" matches "server") gets B-roll; the asset with
    the most matches wins. No match, no B-roll.
  - Anchored to the first matching word, 1.5–4 s and inside its sentence, not in
    the first 1.5 s of output, at most one per 8 s, each asset once, and never
    over a motion template (one starting later in the sentence shortens it).
  - Layout `inset`, or `full` for an image with two or more tag matches. A video
    plays from its start. `reason` says which tags matched; `evidenceIds` are the
    matching words.
- **Music (F09)**, when `music` is on. With `ctx.musicTracks`, the mood is the
  first brief word that names a track mood (or a synonym such as "chill" for
  calm, "energetic" for upbeat), default `calm`; among that mood's tracks (or all
  tracks when none has it) the first long enough to cover the timeline wins.
  Music covers the whole timeline at −18 dB, ducked, with fades of 0.5 s in and
  1 s out (each at most a quarter of the timeline).
- **SFX (F10)**, when `sfx` is on: a `hit` on the hook and a `whoosh` on each
  motion template, at most one per 5 s, at −12 dB. An event with no asset of its
  category gets nothing rather than a wrong sound.
- **Source clipping (F11).** A source whose `voiceAnalysis` reports clipping
  above 0.1 % (or `severe`) adds a `source_clipping` warning marker over its
  segments.
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
