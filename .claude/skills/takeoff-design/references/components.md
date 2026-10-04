# Component recipes

Recipes for Takeoff's interface. Every value names a token from
`design/tokens.css`. Button, chip and card match the Eklavya recipes so both
products read as one family. The rest are recipes for the editor. Once
`packages/app` exists, these become its components; update this file in the
same PR as any component change.

## Button — `.btn`

Square, verb-first. Inter 600 14px, padding 10px 18px, `border-radius: 0`,
transitions 160ms on `--ease`.

| Variant | Fill / text | Hover | Use |
|---|---|---|---|
| `.btn--brand` | `--spot` / `--spot-ink` | unchanged | The one primary action on screen: **Edit Video**, **Export** |
| `.btn--ghost` | none / `--ink`, 1px `--line-2` border | `--panel` fill | Secondary: **Adjust**, **Compare original** |
| `.btn--quiet` | `--panel` / `--ink` | `--mass` fill | Inline actions: **Restore**, **Replace**, **Unlock** |

The primary button is disabled only for a concrete blocking issue, with the
remedy as visible text beside it (PRD 5.2).

## Micro-label — `.label`

Mono 11px, uppercase, `--tracking-caps-wide`, `--faint` (or `--spot` for the
active step). Replaces pill eyebrows and column headings.

## Chip — `.chip`

Mono 12px, `--spot` text on `--spot-soft`, 1px `--spot` border, 3px 10px, square.
Holds machine names verbatim: preset names, operation names (`restore_span`),
aspect presets.

## Card — `.card`

`--panel`, 1px `--line` border, 20px padding, square, no shadow. Head Inter 600
15px `--ink`; body 14px/1.6 `--dim`.

## Footage card — `.footage`

A `.card` with a 16:9 thumbnail well (`--stage-bg`), then file name in mono 13px
`--ink` (middle-truncated), duration in mono `--faint` with tabular numerals,
status as icon + word, a take-order number disc (40px, `50%`, `--spot-soft` /
`--spot`). Selected: 1px `--spot` border and `aria-pressed="true"`. B-roll cards
sit in their own labelled pool, never mixed with takes.

## Toggle row — `.toggle-row`

The create screen's middle column. Each row is a `--panel` block split by `--line`
hairlines, 14px 16px padding: Lucide icon 16px `--dim`, toggle name Inter 500 14px
`--ink`, an info button, and a square switch on the right.

- Switch: 36×20px, square track, 1px `--line-2` border; on = `--spot` fill with
  `--spot-ink` knob and the word "On" in mono 10px; off = `--mass` with "Off".
  `role="switch"`, `aria-checked`.
- Expanding a row reveals strength/settings below a `--line` hairline.
- Unavailable: name in `--faint-2`, switch disabled, reason in 12px `--faint` on
  its own line ("Needs a local director model — Set up").

## Stage steps — `.stages`

The processing view (PRD 5.3): Prepare, Transcribe, Clean speech, Plan
visuals/audio, Build graphics, Render preview, Check quality. A vertical sequence
on a 2px `--mass` spine; number discs as in Eklavya's `.steps`. Each step: name,
then measured progress bar (2px `--spot` on `--mass`, square) **or** elapsed mono
timecode, then a Cancel ghost button and an expandable details well (`--code-bg`,
mono 12px). Done = `--spot` solid disc; failed = `--error` mark + word + remedy.

## Timeline — `.timeline`

- Ruler: `--ruler-h`, mono 10px `--faint` tabular timecode, ticks in `--line-2`.
- Lanes: `--track-h` each on `--panel`, split by `--line`; 120px header with mono
  label + Lucide icon + lock and mute icon buttons.
- Clip: `--mass` fill, 1px `--line-2` border, square; name in Inter 12px `--ink`,
  clipped. Selected: 1px `--spot` border, 2px inset. Locked: lock icon + no trim
  handles. Uncertain: 2px `--warning` underline + icon. Trim handles grow to
  `--hit-min` on hover.
- Playhead: 1px `--spot` line with a 10px circular knob; never eased.
- Removed span (when shown): `--cut` fill with a reason tooltip.

## Transcript — `.transcript`

Inter 14.5px/1.65 `--ink` on `--bg`. Current word: `--spot-soft` background.
Removed words: `--cut` fill + line-through + `--dim`; focus/hover shows the reason
and a **Restore** button. Low-confidence words: `--warning` dotted underline and
an accessible description. Speaker-pause markers: mono `--faint` "· 1.2s".

## Change summary — `.summary`

A `.card` listing what changed in numbers ("Removed 14 fillers · 22s silence ·
2 retakes replaced") then "Needs review" items, each a link that seeks the stage
and selects the object.

## Dialog — `.dialog`

`--panel`, 1px `--line-2`, `--shadow-lg`, square, 24px padding, max 520px. Used
only for provider-transfer or cost decisions and destructive actions, never for
routine editorial confirmation (PRD 5.3). The transfer dialog names provider,
data type, purpose and estimated cost in a mono key/value table.

## Ground toggle — `.ground`

As in Eklavya: two labelled buttons in a 1px `--line-2` frame, mono 11px
uppercase; `aria-pressed="true"` inverts. Lives in Settings, not the toolbar.
