---
name: takeoff-design
description: Visual design system for Takeoff's own interface — the desktop app (create screen, processing, review, timeline, export), first run, and any Takeoff-branded page. Use whenever building, restyling or reviewing Takeoff UI so colour, type, shape, motion, iconography and voice stay consistent. Not for the user's rendered video: captions, hooks and motion scenes follow the BrandProfile.
---

# Takeoff design system

Takeoff's chrome is the Eklavya design system applied to a video editor: a warm
ink ground, one verdigris accent, square hairline chrome, Archivo display against
tiny wide-tracked mono, Inter for everything you read. The chrome recedes so the
footage reads. The only bright thing in the window should be the user's video.

**Values live in `design/tokens.css`.** This file states the rules; the CSS states
the numbers. When they disagree the CSS is right and this file is stale — fix it
here. Component recipes are in `references/components.md`.

## Two systems, one boundary

| | Takeoff chrome | Rendered output |
|---|---|---|
| What | Panels, controls, timeline, transcript, dialogs | Captions, hooks, motion scenes, lower thirds in the MP4 |
| Look from | `design/tokens.css` (this skill) | The user's `BrandProfile` and the original templates (PRD F06, F13, F15, F17) |
| Fonts | Bundled Archivo / Inter / JetBrains Mono | Brand fonts with an explicit bundled fallback |

A renderer, scene or template importing `design/tokens.css` is a bug. A chrome
component reading a BrandProfile colour is a bug, except to preview it on the stage.

## Rules at a glance

| # | Rule | A violation looks like |
|---|---|---|
| 1 | Components name a **role** token, never a scale step or raw colour | `color: #A29C93`, `background: var(--vd-300)` |
| 2 | The chrome is **square** | `border-radius: 8px` on a button, card, toggle row, clip or input |
| 3 | **Hairlines, not shadows** | `box-shadow` on a panel that does not float |
| 4 | Three families, through their variables, **bundled** | `font-family: system-ui`, a Google Fonts `@import` |
| 5 | **One accent hue**; state colours only for real state | a blue link, coloured timeline lanes, a red "new" badge |
| 6 | No emoji; sentence case; Lucide line icons | `🎬 Edit Video` |
| 7 | No grayscale font smoothing | `-webkit-font-smoothing: antialiased` |
| 8 | Motion on `--ease`, 120–320ms, reduced motion honoured | a bouncing progress bar |
| 9 | Visible focus, keyboard-operable controls, state not by colour alone | a toggle whose only "on" signal is green |
| 10 | Text ≥ 4.5:1 on its ground in **both** grounds | `--faint-2` for readable copy |
| 11 | Ink is the default and never follows the OS | a `prefers-color-scheme` switch |
| 12 | The stage stays dark on both grounds | the preview letterbox turning cream on paper |

## Grounds and colour

`data-mode` on `<html>` is `ink` (default) or `paper`; each ground redefines the
same role tokens.

| Role | Use |
|---|---|
| `--bg` | Window ground. Regions split by a `--line-2` hairline, never by a background change |
| `--panel` | Create-screen columns, inspector, timeline lanes, cards |
| `--mass` | Clips, wells, inline code, filled-button hover |
| `--ink` / `--dim` / `--faint` | Primary text / body and secondary / captions, micro-labels, timecode |
| `--faint-2` | Disabled and placeholder **only** — fails 4.5:1 by design |
| `--line` / `--line-2` | Hairline inside a block / frame edges, control borders, lane dividers |
| `--spot`, `--spot-ink`, `--spot-soft` | The accent; text on a spot fill; tints |
| `--warning` | Uncertain edits awaiting review, low-confidence words, crops to check |
| `--error` | Failed stage, invalid plan, missing asset. Always with a word or mark |
| `--cut` | Removed-span fill in transcript and timeline. Always with strike-through and a reason |
| `--stage-*` | The preview viewport only (see Exceptions) |

- **Verdigris is the only hue.** Spend it on: the playhead, the selected clip's
  border, the **Edit Video** button, the active step, link text, "on" toggles. A
  `--vd-*` step in a component is a bug.
- **Lanes are not colour-coded.** Video, captions, B-roll, motion, music and SFX
  lanes all sit on `--panel` with clips on `--mass`; the lane's mono label and a
  Lucide icon name it. Colour is reserved for state: selected (`--spot`), uncertain
  (`--warning`), removed (`--cut`), error (`--error`).
- A new colour need is a new role in **both** ground blocks of `tokens.css`, never
  a literal in the component.

### Exceptions

- **The stage.** The preview is a picture of video, and video is judged against
  black, so `--stage-bg`, `--stage-safe` and `--stage-text` are fixed on both
  grounds. Nothing outside the preview may use them.
- **Waveforms and thumbnails** are data, not chrome: waveform bars may use
  `--radius-sm` and `--dim`; thumbnails show the user's pixels untouched.

## Type

- **Archivo** (`--font-disp`, 600/800/900) for display; **Inter** (`--font-body`,
  400/500/600) for text; **JetBrains Mono** (`--font-mono`, 400/500/600) for
  timecode, durations, file names, schema/operation names, stage labels and
  micro-labels. Always through the variables. All three are bundled (SIL OFL);
  the app makes no font request.
- Display (weight 900, `--tracking-display`, `--leading-display`) appears only on
  first run, empty states and export complete. The working editor uses Inter 14px
  for controls and 14.5px/1.65 for transcript prose.
- Timecode is mono with `font-variant-numeric: tabular-nums` so it does not jitter
  during playback.
- Micro-labels: mono 10–11.5px, uppercase via CSS, `--tracking-caps` to
  `--tracking-caps-wide`, in `--faint` or `--spot`.
- Sentence case everywhere; the product's own toggle names stay verbatim (PRD 5.2).

## Shape, space and layout

- 4px grid: `--space-1` (4) … `--space-24` (96).
- **Create screen:** three columns at ≥1200px (footage · edits · output), stacked
  steps below. **Review:** stage left, transcript right, collapsed timeline below.
  Check every screen at 1440, 1200 and 900px wide, at 200% zoom, in both grounds.
- **Square chrome.** Buttons, cards, toggle rows, clips, chips, inputs, tables and
  dialogs are `border-radius: 0`. Circles only for dots, step numbers and the
  playhead knob; `--radius-pill` only for scrollbar thumbs.
- **Hairlines, not shadows.** `--shadow-lg` only for things that float (menus,
  popovers, dialogs, the drag ghost of a clip).
- Backgrounds are flat. No rule grid, no glow: the editor is a work surface.

## Motion

- `--ease` on 120 / 200 / 320ms. Micro-interactions 140–200ms. No bounce, no spring.
- Progress is honest: a stage shows a bar only when progress is measurable,
  elapsed time otherwise, and never an invented overall percentage (PRD 5.3).
- The playhead and scrubbing are never eased: they track the frame exactly.
- `prefers-reduced-motion: reduce` collapses chrome animation. It never alters the
  user's render; the caption preview offers its own reduced-motion check.

## States, focus and icons

- Focus is `--ring` via `:focus-visible`. Never remove it without a replacement.
- Hover moves an outlined control's colour or border to `--spot`, and steps a
  filled one (`--panel` → `--mass`). A selected segment inverts: `--ink` fill,
  `--bg` text.
- Every control is a real `<button>`, `<a>` or `<input>`. Toggles are
  `role="switch"` with `aria-checked`; on/off is also a word ("On"/"Off").
  Unavailable toggles are visibly disabled with the reason inline, never hidden.
- Removed spans: `--cut` fill + `line-through` + reason on hover/focus + a
  **Restore** button. Uncertain: `--warning` underline + an icon + a word.
- Icons: Lucide line icons only, inlined — stroke `currentColor`, width 2, round
  caps and joins; 16px in buttons and lanes, 20px in a 40px `--spot-soft` tile.

## Voice

Direct, concise, technically credible. Lead with the outcome; verbs first on
buttons ("Edit Video", "Restore", "Export", "Compare original"). Numbers over
adjectives ("Removed 14 fillers, 22s of silence"). Address the user as "you".
Never promise virality or a perfect one-click result; say what changed and what
needs review. The product promise stays verbatim: "Drop in your takes, choose
your edits, get a polished short you can still change."

## Before you ship a surface

- `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|--vd-' <file>` outside `design/tokens.css`
  returns nothing, or only a documented exception.
- `grep -n 'border-radius' <file>` shows 0, 50%, or a documented exception.
- `grep -n 'fonts.googleapis\|@import url(http' <file>` returns nothing.
- Toggle ink/paper; tab through every control; run once with reduced motion and
  once at 200% zoom.
