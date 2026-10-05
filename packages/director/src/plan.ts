// RulesDirector: builds a complete EditPlan from a DirectorRequest with deterministic rules.
// Model-backed directors reuse buildPlan and may only pass DirectorChoices over product-made ids.
import type {
  Caption,
  Decision,
  DirectorCandidate,
  DirectorRequest,
  EditPlan,
  Id,
  MotionTemplateVisual,
  PlanAssetRef,
  PlanProvenance,
  PunchTransform,
  ReviewMarker,
  Segment,
  SfxCategory,
  SfxCue,
  Visual,
} from '@takeoff/contracts';
import {
  EDGE_PAD_US,
  detectCandidates,
  isHesitation,
  isTerminal,
  norm,
  orderWords,
  preservedWordIds,
  type SpeechInterval,
  type Word,
} from './detectors.ts';

/** Inputs the DirectorRequest DTO does not carry. All optional; the engine supplies what it knows. */
export interface DirectorContext {
  seed?: number;
  /** VAD speech intervals; protect gaps that contain untranscribed speech. */
  speech?: SpeechInterval[];
  /** Source durations; needed to trim trailing dead air. */
  durationsUs?: Record<Id, number>;
  /** Plan asset refs; default `assets/<id>.json` per word asset. */
  assets?: PlanAssetRef[];
  /** Legacy single music asset; used when `musicTracks` is absent. */
  musicAssetId?: Id;
  /** Legacy single SFX asset, used as a whoosh; `sfxAssets` takes precedence. */
  sfxAssetId?: Id;
  /** F11 analysis per source asset; clipping above 0.1 % (or `severe`) adds a `source_clipping` marker. */
  voiceAnalysis?: Record<Id, VoiceAnalysis>;
  /** F07 user B-roll pool, tags from filename words + user tags (see `brollTags`). */
  broll?: BrollAsset[];
  /** F09 licensed library/user tracks with mood tags. */
  musicTracks?: MusicTrack[];
  /** F10 licensed effects, one category each. */
  sfxAssets?: SfxAsset[];
  /** Creative brief; only its mood keywords are read (music). */
  brief?: string;
}

export interface VoiceAnalysis {
  /** Fraction of clipped samples, 0..1 (0.001 = 0.1 %). */
  clippingRatio: number;
  severe?: boolean;
}
export interface BrollAsset {
  id: Id;
  kind: 'video' | 'image';
  tags: string[];
  /** Required for video (the span must stay inside the source); ignored for images. */
  durationUs?: number | null;
}
export interface MusicTrack {
  id: Id;
  moods: string[];
  durationUs?: number | null;
}
export interface SfxAsset {
  id: Id;
  category: SfxCategory;
}

/** The only things a model may decide. Every id must already exist in the product-made plan inputs. */
export interface DirectorChoices {
  acceptCandidateIds?: Id[];
  rejectCandidateIds?: Id[];
  emphasisWordIds?: Id[];
  /** Evidence ids of a product-made hook option (see `hookOptionsFor`); null = the model chose no hook. */
  hookEvidenceIds?: Id[] | null;
}

export interface HookOption {
  text: string;
  evidenceIds: Id[];
}

const MAX_CAPTION_WORDS = 7;
const CAPTION_LINE_CHARS = 32;
const CAPTION_LINES = 2;
const CAPTION_PAUSE_US = 300_000;
const ZOOM_HOLD_US = 1_500_000;
const ZOOM_WINDOW_US = 30_000_000;
const ZOOMS_PER_WINDOW = 4;
const ZOOM_SCALES = [1.08, 1.12, 1.15];
const HOOK_US = 3_000_000;
const VISUAL_MAX_US = 10_000_000;
const CLIPPING_RATIO = 0.001;
const BROLL_MIN_US = 1_500_000;
const BROLL_MAX_US = 4_000_000;
const BROLL_GAP_US = 8_000_000;
const BROLL_OPENING_US = 1_500_000;
const SFX_GAP_US = 5_000_000;
const DEFAULT_MOOD = 'calm';
/** Brief words that name a mood without using a track's own tag. */
const MOOD_SYNONYMS: Record<string, string> = { relaxed: 'calm', chill: 'calm', gentle: 'calm', energetic: 'upbeat', fun: 'upbeat', happy: 'upbeat', hype: 'upbeat', focused: 'focus', study: 'focus', tutorial: 'focus' };
/** Filename words that say nothing about the content. */
const GENERIC_TAGS = new Set(['img', 'image', 'screenshot', 'screen', 'shot', 'video', 'clip', 'broll', 'final', 'copy', 'edit', 'take', 'mov', 'mp4', 'png', 'jpg', 'jpeg']);

const STOP = new Set(['the', 'a', 'an', 'it', 'this', 'that', 'he', 'she', 'they', 'we', 'you', 'i', 'my', 'your', 'our', 'its', 'their']);
const LEAD_IN = new Set(['so', 'basically', 'actually', 'well', 'okay', 'ok', 'like', 'and', 'but', 'now']);
const PRIORITY = new Set(['not', 'never', 'no', "don't", "can't", "won't", "isn't", 'but', 'however', 'only', 'unless', 'except', 'must']);
const FLOW_VERBS = new Set(['sends', 'send', 'calls', 'call', 'requests', 'request', 'hits', 'queries', 'fetches', 'posts']);
const FLOW_PREPS = new Set(['through', 'via', 'using']);
const FLOW_EDGES = new Set(['request', 'requests', 'call', 'calls', 'query', 'queries']);
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];

const clean = (t: string) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const label = (ws: Word[]) => ws.map((w) => clean(w.text)).filter(Boolean).join(' ').slice(0, 60).trim();
const pad4 = (n: number) => String(n).padStart(4, '0');
const isNumberish = (w: Word) => /\d/.test(w.text);

function framesFloor(us: number, fps: { num: number; den: number }) {
  return Math.floor((us * fps.num) / (fps.den * 1e6));
}
function framesCeil(us: number, fps: { num: number; den: number }) {
  return Math.ceil((us * fps.num) / (fps.den * 1e6));
}

/** Simple suffix-strip stem, so "servers" matches "server" and "caching" matches "cach(e)". */
const stem = (t: string) => {
  const x = norm(t).replace(/'s$/, '');
  if (x.length <= 3) return x;
  return x.endsWith('ies') ? `${x.slice(0, -3)}y` : x.replace(/(?<!s)s$/, '').replace(/(ing|ed|e)$/, '');
};

/** B-roll tags from a file name (extension and generic words dropped) plus user tags, lower-case, unique. */
export function brollTags(fileName: string, userTags: string[] = []): string[] {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '');
  const words = [...base.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u), ...userTags.flatMap((t) => t.split(/\s+/))];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GENERIC_TAGS.has(w)))];
}

/** Sentences by terminal punctuation, never spanning assets. */
/**
 * ASR can drop the full stop at a long pause ('…to the server Now let's…') and stretch the next word over the
 * silence, so the pause is measured from word gaps and from VAD. A capitalised word after one starts a sentence.
 */
const SENTENCE_GAP_US = 1_000_000;
function pausedBefore(prev: Word, w: Word, speech: SpeechInterval[]): boolean {
  if (w.sourceStartUs - prev.sourceEndUs >= SENTENCE_GAP_US) return true;
  let t = prev.sourceEndUs;
  for (const v of speech.filter((x) => x.assetId === w.assetId && x.sourceEndUs > t && x.sourceStartUs < w.sourceEndUs).sort((a, b) => a.sourceStartUs - b.sourceStartUs)) {
    if (v.sourceStartUs - t >= SENTENCE_GAP_US) return true;
    t = Math.max(t, v.sourceEndUs);
  }
  return false;
}
const startsAfterPause = (prev: Word, w: Word, speech: SpeechInterval[]) =>
  /^[A-Z]/.test(w.text) && !/^I\b/.test(w.text) && pausedBefore(prev, w, speech);

function splitSentences(ws: Word[], speech: SpeechInterval[] = []): Word[][] {
  const out: Word[][] = [];
  let cur: Word[] = [];
  for (const w of ws) {
    if (cur.length && (cur[0]!.assetId !== w.assetId || startsAfterPause(cur[cur.length - 1]!, w, speech))) cur = [];
    if (cur.length === 0) out.push(cur);
    cur.push(w);
    if (isTerminal(w)) cur = [];
  }
  return out.filter((s) => s.length);
}

const SLIVER_US = 300_000;

interface Range {
  assetId: Id;
  s: number;
  e: number;
}

/** Retained spans: each asset's base span minus removals, keeping spans that hold whole words or VAD speech. */
function buildSegments(ws: Word[], removals: Range[], durationsUs: Record<Id, number>, speech: SpeechInterval[] = []): Segment[] {
  const segs: Segment[] = [];
  const assets = [...new Set(ws.map((w) => w.assetId))];
  for (const assetId of assets) {
    const aw = ws.filter((w) => w.assetId === assetId);
    const end = durationsUs[assetId] ?? Math.max(...aw.map((w) => w.sourceEndUs)) + EDGE_PAD_US;
    const vad = (s: number, e: number) => speech.some((v) => v.assetId === assetId && v.sourceStartUs < e && s < v.sourceEndUs);
    const merged: Range[] = [];
    for (const r of removals.filter((x) => x.assetId === assetId).sort((x, y) => x.s - y.s)) {
      const last = merged[merged.length - 1];
      if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
      else merged.push({ ...r });
    }
    let cursor = 0;
    const kept: Array<[number, number]> = [];
    for (const r of merged) {
      if (r.s > cursor) kept.push([cursor, Math.min(r.s, end)]);
      cursor = Math.max(cursor, r.e);
    }
    if (cursor < end) kept.push([cursor, end]);
    for (const [s, e] of kept) {
      const wordIds = aw.filter((w) => w.sourceStartUs >= s && w.sourceEndUs <= e).map((w) => w.id);
      // A span between two cuts with no words is dead air, unless VAD heard untranscribed speech there.
      // Below VAD's 300 ms minimum silence a pause reads as speech, so a shorter wordless sliver is dead air.
      if (e > s && (wordIds.length || (e - s >= SLIVER_US && vad(s, e)))) {
        segs.push({
          id: `seg_${pad4(segs.length + 1)}`,
          assetId,
          sourceStartUs: s,
          sourceEndUs: e,
          wordIds,
          speed: { num: 1, den: 1 },
          cropPolicy: 'face_safe_vertical',
          locked: false,
        });
      }
    }
  }
  return segs;
}

const totalUs = (segs: Segment[]) => segs.reduce((n, s) => n + s.sourceEndUs - s.sourceStartUs, 0);

/** Output-relative microseconds for each retained word (before frame conversion, which the compiler owns). */
function outputTimes(segs: Segment[], byId: Map<Id, Word>) {
  const map = new Map<Id, { start: number; end: number; segmentId: Id }>();
  let cum = 0;
  for (const seg of segs) {
    for (const id of seg.wordIds) {
      const w = byId.get(id)!;
      map.set(id, { start: cum + w.sourceStartUs - seg.sourceStartUs, end: cum + w.sourceEndUs - seg.sourceStartUs, segmentId: seg.id });
    }
    cum += seg.sourceEndUs - seg.sourceStartUs;
  }
  return map;
}

function fitsLines(texts: string[]): boolean {
  let lines = 1;
  let len = 0;
  for (const t of texts) {
    if (len === 0) len = t.length;
    else if (len + 1 + t.length <= CAPTION_LINE_CHARS) len += 1 + t.length;
    else (lines++, (len = t.length));
  }
  return lines <= CAPTION_LINES;
}

/** Phrase-aware groups of 2–7 words, ≤2 lines of ~32 chars, breaking at punctuation and pauses. */
function groupCaptionWords(words: Word[]): Word[][] {
  const groups: Word[][] = [];
  let g: Word[] = [];
  for (const w of words) {
    const prev = g[g.length - 1];
    const phraseEnd = !!prev && (/[,.;:!?]["')\]]*$/.test(prev.text) || w.sourceStartUs - prev.sourceEndUs >= CAPTION_PAUSE_US);
    if (g.length && (g.length >= MAX_CAPTION_WORDS || !fitsLines([...g, w].map((x) => x.text)) || (g.length >= 2 && phraseEnd))) {
      groups.push(g);
      g = [];
    }
    g.push(w);
  }
  if (g.length) groups.push(g);
  // A lone word joins the previous group when it fits.
  for (let i = groups.length - 1; i > 0; i--) {
    const merged = [...groups[i - 1]!, ...groups[i]!];
    if (groups[i]!.length !== 1) continue;
    if (merged.length <= MAX_CAPTION_WORDS && fitsLines(merged.map((x) => x.text))) groups.splice(i - 1, 2, merged);
    // Otherwise borrow the previous group's last word, so neither group is a single word.
    else if (groups[i - 1]!.length > 2) groups[i]!.unshift(groups[i - 1]!.pop()!);
  }
  return groups;
}

/** A hook never ends on one of these; the phrase is cut before them instead. */
const HOOK_FUNCTION = new Set([
  'to', 'a', 'an', 'the', 'that', 'how', 'and', 'or', 'but', 'of', 'for', 'with', 'in', 'on', 'at', 'by', 'from', 'as', 'is',
  'are', 'was', 'my', 'your', 'our', 'their', 'its', 'this', 'which', 'who', 'what', 'why', 'when', 'where', 'if', 'so', 'because', 'than', 'then',
]);
/** Clause/phrase starts: a long sentence is cut before one of these. */
const HOOK_BOUNDARY = new Set([
  'and', 'but', 'or', 'so', 'because', 'which', 'who', 'when', 'while', 'where', 'why', 'if', 'then', 'that', 'to', 'of', 'for',
  'with', 'in', 'on', 'at', 'by', 'from', 'using', 'via', 'through', 'into', 'about', 'than',
]);
/** Qualifiers whose loss would make the hook a stronger claim than the speaker made. */
const QUALIFIERS = new Set([...PRIORITY, 'most', 'some', 'sometimes', 'usually', 'often', 'may', 'might', 'can', 'could', 'if', 'almost', 'mostly', 'probably']);
const INTENT = [['i', 'want', 'to'], ["i'm", 'going', 'to'], ['im', 'going', 'to'], ["we're", 'going', 'to'], ['let', 'me'], ["i'll"], ["we'll"]];
const INTENT_VERBS = new Set(['explain', 'show', 'tell', 'talk', 'cover', 'walk']);
const INTENT_TAIL = new Set(['you', 'about', 'through']);
const HOOK_MAX_WORDS = 9;

function hookTitle(sentence: Word[]): HookOption | null {
  let ws = sentence.filter((w) => !isHesitation(w));
  const n = () => ws.map((w) => norm(w.text));
  // Leading discourse markers and stated intent ("So today I want to explain how …" → "how …").
  while (ws.length && (LEAD_IN.has(n()[0]!) || n()[0] === 'today')) ws = ws.slice(1);
  const intent = INTENT.find((p) => p.every((t, i) => n()[i] === t));
  if (intent) {
    ws = ws.slice(intent.length);
    if (INTENT_VERBS.has(n()[0]!)) ws = ws.slice(1);
    while (ws.length && INTENT_TAIL.has(n()[0]!)) ws = ws.slice(1);
  }
  let cut = ws.length;
  if (ws.length > HOOK_MAX_WORDS) {
    // Cut after the last clause punctuation, else before the last clause/phrase start, within the limit.
    const t = n();
    const punct = ws.slice(0, HOOK_MAX_WORDS).findLastIndex((w, i) => i >= 1 && /[,;:]["')\]]*$/.test(w.text));
    const boundary = t.slice(0, HOOK_MAX_WORDS + 1).findLastIndex((x, i) => i >= 2 && HOOK_BOUNDARY.has(x));
    cut = punct >= 0 ? punct + 1 : boundary;
    if (cut < 0) return null;
    // Dropping a qualifier or negation would overstate the claim.
    if (t.slice(cut).some((x) => QUALIFIERS.has(x))) return null;
  }
  ws = ws.slice(0, cut);
  while (ws.length && HOOK_FUNCTION.has(norm(ws[ws.length - 1]!.text))) ws = ws.slice(0, -1);
  if (ws.length < 2) return null;
  const text = ws.map((w) => w.text).join(' ').replace(/[,.;:!?]+$/u, '').trim();
  return text && text.length <= 120 ? { text, evidenceIds: ws.map((w) => w.id) } : null;
}

/** Up to three verbatim-derived titles: opening sentence, first fact-bearing sentence, closing sentence. */
/** Sign-offs are never a hook ("Thanks for watching."). */
const SIGN_OFF = /^(thanks?|thank you|see you|bye|goodbye|subscribe|that's (it|all))\b/;

function hookOptions(sentences: Word[][], glossary: Set<string>, prohibited: string[]): HookOption[] {
  sentences = sentences.filter((s) => !SIGN_OFF.test(s.map((w) => norm(w.text)).join(' ')));
  const factual = sentences.find((s) => s.some((w) => isNumberish(w) || glossary.has(norm(w.text))));
  const out: HookOption[] = [];
  for (const s of [sentences[0], factual, sentences[sentences.length - 1]]) {
    const o = s && hookTitle(s);
    const banned = o && prohibited.some((p) => o.text.toLowerCase().includes(p.toLowerCase()));
    // Grounding guard: the title is exactly its evidence words, so no number or claim comes from elsewhere.
    const grounded = o && o.text === o.evidenceIds.map((id) => s.find((w) => w.id === id)?.text ?? '\u0000').join(' ').replace(/[,.;:!?]+$/u, '');
    if (o && grounded && !banned && !out.some((x) => x.text === o.text)) out.push(o);
  }
  return out;
}

/** Hook options over the words a plan retains (F13: at most three, each traced to word ids). */
export function hookOptionsFor(req: DirectorRequest, plan: EditPlan, speech: SpeechInterval[] = []): HookOption[] {
  const kept = new Set(plan.segments.flatMap((s) => s.wordIds));
  const sentences = splitSentences(orderWords(req.words), speech)
    .map((s) => s.filter((w) => kept.has(w.id)))
    .filter((s) => s.length);
  return hookOptions(sentences, new Set((req.brand?.glossary ?? []).map(norm)), req.brand?.prohibitedClaims ?? []);
}

type TemplatePick = Pick<MotionTemplateVisual, 'template' | 'params'> & { evidence: Word[] };

/** Deterministic triggers only; labels are transcript words. Returns null when nothing matches. */
function matchTemplate(s: Word[], prev: Word[] | undefined, next: Word[][]): TemplatePick | null {
  const n = s.map((w) => norm(w.text));
  const after = (i: number) => {
    let k = i;
    while (k < s.length && STOP.has(n[k]!)) k++;
    return k < s.length ? k : -1;
  };
  // A sends/calls/requests … through B … to C → request_flow_v1
  const v = n.findIndex((t, i) => FLOW_VERBS.has(t) && i > 0 && !STOP.has(n[i - 1]!));
  if (v > 0) {
    const p = n.findIndex((t, i) => i > v && FLOW_PREPS.has(t));
    const b = p > 0 ? after(p + 1) : -1;
    const to = b > 0 ? n.findIndex((t, i) => i > b && t === 'to') : -1;
    const c = to > 0 ? after(to + 1) : -1;
    if (c > 0) {
      const e = n.findIndex((t, i) => i > v && i < p && FLOW_EDGES.has(t));
      const edge = e > 0 ? s[e]! : s[v]!;
      const params = { containerLabel: label([s[v - 1]!]), internalNode: label([s[b]!]), externalNode: label([s[c]!]), edgeLabel: label([edge]) };
      if (Object.values(params).every(Boolean) && new Set([params.containerLabel, params.internalNode, params.externalNode]).size === 3) {
        return { template: 'request_flow_v1', params, evidence: [s[v - 1]!, s[v]!, edge, s[b]!, s[c]!] };
      }
    }
  }
  // X vs Y / X compared to Y → comparison_list_v1
  const t = n.findIndex((x, i) => x === 'vs' || x === 'versus' || (x === 'compared' && n[i + 1] === 'to'));
  if (t > 0) {
    const y = after(t + (n[t] === 'compared' ? 2 : 1));
    if (y > 0 && !STOP.has(n[t - 1]!)) {
      const items = [label([s[t - 1]!]), label([s[y]!])];
      const title = label(s.slice(t - 1, y + 1));
      if (items.every(Boolean) && items[0] !== items[1] && title) return { template: 'comparison_list_v1', params: { title, items }, evidence: s.slice(t - 1, y + 1) };
    }
  }
  // first … second (… third) across this and the next two sentences → comparison_list_v1
  const f = n.indexOf('first');
  if (f >= 0) {
    const pool = [s.slice(f), ...next.slice(0, 2)];
    const items: string[] = [];
    const evidence: Word[] = [];
    for (const ord of ORDINALS) {
      let hit: Word[] | null = null;
      for (const ps of pool) {
        const k = ps.findIndex((w) => norm(w.text) === ord);
        if (k < 0) continue;
        const body: Word[] = [];
        for (const w of ps.slice(k + 1)) {
          if (body.length >= 3) break;
          body.push(w);
          if (/[,.;:!?]["')\]]*$/.test(w.text) && body.length > 0 && body.some((x) => !STOP.has(norm(x.text)))) break;
        }
        hit = body.length ? [ps[k]!, ...body] : null;
        break;
      }
      if (!hit) break;
      const l = label(hit.slice(1));
      if (!l) break;
      items.push(l);
      evidence.push(...hit);
    }
    if (items.length >= 2) {
      // Title: words before 'first', or a short lead-in sentence ("There are two steps."), else the ordinal itself.
      const lead = f > 0 ? s.slice(Math.max(0, f - 5), f) : prev && prev.length <= 6 ? prev : [];
      const title = label(lead) || label([s[f]!]);
      return { template: 'comparison_list_v1', params: { title, items: items.slice(0, 6) }, evidence };
    }
  }
  return null;
}

/** Candidates the plan acts on: the request's own, else detected here; only kinds whose toggle is on. */
export function candidatesFor(req: DirectorRequest, ctx: DirectorContext = {}): DirectorCandidate[] {
  const { settings } = req;
  const dict = settings.fillerDictionary;
  const all = req.candidates.length
    ? req.candidates
    : detectCandidates(req.words, { fillerStrength: settings.fillerStrength, fillerDictionary: dict, speech: ctx.speech, durationsUs: ctx.durationsUs });
  // F04: a custom preserve entry wins even over candidates the caller detected without the dictionary.
  const preserved = preservedWordIds(req.words, dict?.preserve);
  return all.filter((c) =>
    c.kind === 'filler' ? settings.fillers && !c.wordIds.some((id) => preserved.has(id)) : c.kind === 'silence' ? settings.silence : settings.badTakes,
  );
}

/** Deterministic plan for any request. `choices` come from a model and are filtered to known ids here. */
export function buildPlan(
  req: DirectorRequest,
  ctx: DirectorContext = {},
  choices: DirectorChoices = {},
  provenance: PlanProvenance = { director: 'rules', seed: ctx.seed ?? 0, promptVersion: null },
): EditPlan {
  const { settings, output } = req;
  const fps = output.fps;
  const ws = orderWords(req.words);
  const byId = new Map(ws.map((w) => [w.id, w]));
  const candidates = candidatesFor(req, ctx);
  const accept = new Set(choices.acceptCandidateIds ?? []);
  const reject = new Set(choices.rejectCandidateIds ?? []);

  const decisions: Decision[] = [];
  const reviewMarkers: ReviewMarker[] = [];
  const removals: Range[] = [];
  for (const c of candidates) {
    // High → remove unless the director rejects it; a director may accept medium, never low.
    const remove = c.confidenceTier === 'high' ? !reject.has(c.id) : c.confidenceTier === 'medium' && accept.has(c.id);
    const action = remove ? 'remove' : c.confidenceTier === 'high' ? 'keep' : 'review';
    const evidenceIds = [...new Set(c.wordIds)];
    decisions.push({
      id: `decision_${c.id}`,
      assetId: c.assetId,
      action,
      sourceStartUs: c.sourceStartUs,
      sourceEndUs: c.sourceEndUs,
      wordIds: evidenceIds,
      reason: `${c.kind}: ${c.evidence}`,
      evidenceIds,
      confidenceTier: c.confidenceTier,
      detector: `rules.${c.kind}.v1`,
    });
    if (remove) removals.push({ assetId: c.assetId, s: c.sourceStartUs, e: c.sourceEndUs });
    if (action === 'review' && (c.kind === 'retake' || c.kind === 'false_start')) {
      reviewMarkers.push({ id: `marker_${c.id}`, kind: 'uncertain_retake', severity: 'warning', message: `Possible retake: ${c.evidence}`, refs: [`decision_${c.id}`] });
    } else if (action === 'review' && c.wordIds.some((id) => byId.get(id)?.alignment !== 'aligned')) {
      reviewMarkers.push({ id: `marker_${c.id}`, kind: 'alignment_uncertain', severity: 'info', message: `Kept: ${c.evidence}`, refs: [`decision_${c.id}`] });
    }
  }

  const durations = ctx.durationsUs ?? {};
  let segments = ws.length ? buildSegments(ws, removals, durations, ctx.speech) : [];

  // F14 target length: drop whole low-priority middle sentences after cleanup; never the first or last.
  // A ≤2-word sentence ("Nothing.") is the payoff of the one before it: they are dropped together, never split.
  const sentences = splitSentences(ws, ctx.speech).reduce<Word[][]>((acc, s) => {
    const prev = acc.at(-1);
    if (prev && s.length <= 2 && prev[0]!.assetId === s[0]!.assetId) prev.push(...s);
    else acc.push([...s]);
    return acc;
  }, []);
  const limit =
    output.lengthPolicy !== 'none' && output.targetFrames
      ? { us: (output.targetFrames * fps.den * 1e6) / fps.num, hard: output.lengthPolicy === 'hard_max' }
      : settings.targetSeconds
        ? { us: settings.targetSeconds * 1e6, hard: false }
        : null;
  if (limit && segments.length) {
    const over = (us: number) =>
      limit.hard ? framesFloor(us, fps) > output.targetFrames! : us > limit.us + Math.max(limit.us * 0.1, 2e6);
    const glossary = new Set((req.brand?.glossary ?? []).map(norm));
    const priority = (s: Word[]) => s.filter((w) => isNumberish(w) || glossary.has(norm(w.text)) || PRIORITY.has(norm(w.text))).length;
    const dropped = new Set<number>();
    // ponytail: rebuilds segments per dropped sentence (O(sentences²)); fine for short-form lengths.
    while (over(totalUs(segments))) {
      const kept = new Set(segments.flatMap((s) => s.wordIds));
      const pick = sentences
        .map((s, i) => ({ s, i, p: priority(s) }))
        .filter(({ s, i }) => i > 0 && i < sentences.length - 1 && !dropped.has(i) && s.some((w) => kept.has(w.id)))
        .sort((a, b) => a.p - b.p || b.i - a.i)[0];
      if (!pick) break;
      dropped.add(pick.i);
      const nxt = sentences[pick.i + 1];
      const last = pick.s[pick.s.length - 1]!;
      const e = nxt && nxt[0]!.assetId === last.assetId ? nxt[0]!.sourceStartUs : last.sourceEndUs;
      const ids = pick.s.map((w) => w.id);
      removals.push({ assetId: last.assetId, s: pick.s[0]!.sourceStartUs, e });
      decisions.push({
        id: `decision_length_${pad4(dropped.size)}`,
        assetId: last.assetId,
        action: 'remove',
        sourceStartUs: pick.s[0]!.sourceStartUs,
        sourceEndUs: e,
        wordIds: ids,
        reason: `Target length: dropped a complete middle sentence with the lowest priority score (${pick.p})`,
        evidenceIds: ids,
        confidenceTier: 'medium',
        detector: 'rules.target_length.v1',
      });
      segments = buildSegments(ws, removals, durations, ctx.speech);
    }
    if (over(totalUs(segments))) {
      reviewMarkers.push({
        id: 'marker_duration_conflict',
        kind: 'duration_conflict',
        severity: limit.hard ? 'critical' : 'warning',
        // A critical marker tells the compiler this over-length draft is a declared conflict (export stays blocked).
        message: limit.hard
          ? `Essential opening and closing speech needs ${framesFloor(totalUs(segments), fps)} frames (${(totalUs(segments) / 1e6).toFixed(1)} s); the hard maximum is ${output.targetFrames} frames (${(limit.us / 1e6).toFixed(1)} s). Revise the target or unlock selections.`
          : `Retained speech is ${(totalUs(segments) / 1e6).toFixed(1)} s; target is ${(limit.us / 1e6).toFixed(1)} s. Revise the target or remove content.`,
        refs: segments.map((s) => s.id),
      });
    }
  }

  const out = outputTimes(segments, byId);
  const total = totalUs(segments);
  const totalFrames = framesFloor(total, fps);
  const retained = (s: Word[]) => s.filter((w) => out.has(w.id));
  const keptSentences = sentences.map(retained).filter((s) => s.length);
  const sentenceStarts = new Set(sentences.map((s) => s[0]!.id));
  const glossary = new Set((req.brand?.glossary ?? []).map(norm));

  // F06 captions (also the emphasis source for zooms).
  const modelEmphasis = choices.emphasisWordIds ? new Set(choices.emphasisWordIds) : null;
  const rank = (w: Word) =>
    isNumberish(w) ? 0 : glossary.has(norm(w.text)) ? 1 : /^\p{Lu}/u.test(w.text) && !sentenceStarts.has(w.id) && !/^i\b/i.test(w.text) ? 2 : 9;
  const captions: Caption[] = [];
  for (const seg of segments) {
    for (const g of groupCaptionWords(seg.wordIds.map((id) => byId.get(id)!))) {
      const pick = modelEmphasis ? g.find((w) => modelEmphasis.has(w.id)) : g.filter((w) => rank(w) < 9).sort((a, b) => rank(a) - rank(b))[0];
      captions.push({
        id: `caption_${pad4(captions.length + 1)}`,
        segmentId: seg.id,
        wordIds: g.map((w) => w.id),
        text: g.map((w) => w.text).join(' ').slice(0, 200),
        template: 'restrained',
        emphasisWordIds: pick ? [pick.id] : [],
        positionPolicy: 'safe_face_aware',
        locked: false,
      });
    }
  }

  // F08 punch zooms on emphasis words: ≥1.5 s hold, ≤4 per 30 s, no overlap.
  const transforms: PunchTransform[] = [];
  if (settings.zoom) {
    const holdFrames = Math.max(1, framesCeil(ZOOM_HOLD_US, fps));
    const starts: number[] = [];
    for (const id of captions.flatMap((c) => c.emphasisWordIds)) {
      const t = out.get(id)!;
      const last = starts[starts.length - 1];
      if (last !== undefined && t.start < last + ZOOM_HOLD_US) continue;
      if (starts.filter((s) => s > t.start - ZOOM_WINDOW_US).length >= ZOOMS_PER_WINDOW) continue;
      if (t.start + ZOOM_HOLD_US > total) continue;
      starts.push(t.start);
      transforms.push({
        id: `zoom_${pad4(transforms.length + 1)}`,
        segmentId: t.segmentId,
        anchor: { wordId: id, edge: 'start', offsetFrames: 0 },
        kind: 'punch',
        scale: ZOOM_SCALES[(transforms.length + (provenance.seed % 3)) % 3]!,
        centerPolicy: 'center',
        transitionFrames: 4,
        durationFrames: holdFrames,
        locked: false,
      });
    }
  }

  const visuals: Visual[] = [];
  const first = segments[0];
  // F13 hook: verbatim-derived title over the opening, with evidence word ids.
  if (settings.textHook && first) {
    const options = hookOptions(keptSentences, glossary, req.brand?.prohibitedClaims ?? []);
    const userText = settings.hook?.text ?? null;
    const want = choices.hookEvidenceIds;
    const picked = want ? options.find((o) => o.evidenceIds.join() === want.join()) : undefined;
    // A model may pick a product-made option or none; an option its cuts invalidated falls back to the first.
    const chosen = picked ?? (want === null && !userText ? undefined : options[0]);
    const autoOff = settings.hook?.autoSelect === false && !userText;
    if (chosen && !autoOff) {
      visuals.push({
        id: 'hook_0001',
        kind: 'hook_text',
        segmentId: first.id,
        anchor: { wordId: first.wordIds[0]!, edge: 'start', offsetFrames: 0 },
        durationFrames: Math.max(1, Math.min(framesCeil(HOOK_US, fps), totalFrames || 1)),
        text: userText ?? chosen.text,
        evidenceIds: chosen.evidenceIds,
        fallback: 'omit',
        locked: !!userText,
      });
    }
  }

  // F15 motion templates: only on a deterministic trigger.
  // One animated layer at a time (PRD §10): a template starts after the hook and any earlier template end.
  let busyUntilUs = visuals.length ? HOOK_US : 0;
  const motionSpans: Array<[number, number]> = [];
  if (settings.motionGraphics) {
    keptSentences.forEach((s, i) => {
      const m = matchTemplate(s, keptSentences[i - 1], keptSentences.slice(i + 1));
      if (!m || visuals.length >= 100) return;
      const evidenceIds = [...new Set(m.evidence.map((w) => w.id))];
      if (visuals.some((v) => v.kind === 'motion_template' && v.evidenceIds.some((id) => evidenceIds.includes(id)))) return;
      const startT = out.get(m.evidence[0]!.id)!;
      const endUs = Math.max(...m.evidence.map((w) => out.get(w.id)!.end), out.get(s[s.length - 1]!.id)!.end);
      if (startT.start < busyUntilUs) return;
      const durUs = Math.min(Math.max(endUs - startT.start, ZOOM_HOLD_US), VISUAL_MAX_US, Math.max(total - startT.start, 1));
      busyUntilUs = startT.start + durUs;
      motionSpans.push([startT.start, startT.start + durUs]);
      visuals.push({
        id: `motion_${pad4(visuals.length + 1)}`,
        kind: 'motion_template',
        segmentId: startT.segmentId,
        anchor: { wordId: m.evidence[0]!.id, edge: 'start', offsetFrames: 0 },
        durationFrames: Math.max(1, framesCeil(durUs, fps)),
        template: m.template,
        params: m.params,
        evidenceIds,
        fallback: 'presenter_only',
        locked: false,
      } as MotionTemplateVisual);
    });
  }

  // F07 own B-roll: ≥1 exact (stemmed) tag match in a retained sentence, else nothing. Never in the opening,
  // never over a motion template, ≤1 per 8 s, 1.5–4 s inside its sentence.
  const brollUsed: BrollAsset[] = [];
  if (settings.userBroll && ctx.broll?.length) {
    let lastStart = -Infinity;
    for (const s of keptSentences) {
      if (visuals.length >= 100) break;
      const stems = s.map((w) => stem(w.text));
      let best: { a: BrollAsset; hits: string[] } | null = null;
      for (const a of ctx.broll) {
        if (brollUsed.includes(a) || (a.kind === 'video' && !a.durationUs)) continue;
        const tags = [...new Set(a.tags.filter((t) => !STOP.has(norm(t)) && !HOOK_FUNCTION.has(norm(t))).map(stem).filter((t) => t.length >= 3))];
        const hits = tags.filter((t) => stems.includes(t));
        if (hits.length && (!best || hits.length > best.hits.length)) best = { a, hits };
      }
      if (!best) continue;
      const anchor = s[stems.findIndex((t) => best.hits.includes(t))]!;
      const t0 = out.get(anchor.id)!;
      const room = Math.min(out.get(s[s.length - 1]!.id)!.end, total) - t0.start;
      // A motion template starting later in the sentence shortens the B-roll to end before it (never overlaps).
      const nextMotion = Math.min(Infinity, ...motionSpans.filter(([a]) => a > t0.start).map(([a]) => a));
      const durUs = Math.min(BROLL_MAX_US, room, nextMotion - t0.start, best.a.kind === 'video' ? best.a.durationUs! : Infinity);
      if (t0.start < BROLL_OPENING_US || t0.start < lastStart + BROLL_GAP_US || durUs < BROLL_MIN_US) continue;
      if (motionSpans.some(([a, b]) => t0.start < b && a < t0.start + durUs)) continue;
      lastStart = t0.start;
      brollUsed.push(best.a);
      const strong = best.hits.length >= 2;
      const hitWords = s.filter((w, i) => best.hits.includes(stems[i]!));
      visuals.push({
        id: `broll_${pad4(visuals.length + 1)}`,
        kind: 'broll',
        segmentId: t0.segmentId,
        anchor: { wordId: anchor.id, edge: 'start', offsetFrames: 0 },
        durationFrames: Math.max(1, framesFloor(durUs, fps)),
        assetId: best.a.id,
        sourceStartUs: 0,
        sourceEndUs: durUs,
        layout: best.a.kind === 'image' && strong ? 'full' : 'inset',
        reason: `User B-roll tags match spoken words: ${best.hits.join(', ')}`.slice(0, 200),
        evidenceIds: [...new Set(hitWords.map((w) => w.id))],
        fallback: 'presenter_only',
        locked: false,
      });
    }
  }

  // F09 music: a licensed track picked by mood from the brief (default calm), spanning the timeline with fades.
  let musicId: Id | undefined;
  if (settings.music && ctx.musicTracks?.length) {
    const briefWords = (ctx.brief ?? '').toLowerCase().split(/[^\p{L}]+/u);
    const moods = new Set(ctx.musicTracks.flatMap((t) => t.moods.map((m) => m.toLowerCase())));
    const wanted = briefWords.map((w) => (moods.has(w) ? w : MOOD_SYNONYMS[w])).find((m) => m && moods.has(m)) ?? DEFAULT_MOOD;
    const fits = (t: MusicTrack) => (t.durationUs ?? 0) >= total;
    const mood = ctx.musicTracks.filter((t) => t.moods.some((m) => m.toLowerCase() === wanted));
    const pool = mood.length ? mood : ctx.musicTracks;
    musicId = (pool.find(fits) ?? pool[0]!).id;
  } else if (settings.music) musicId = ctx.musicAssetId;
  const music =
    musicId && totalFrames > 0
      ? {
          assetId: musicId,
          startFrame: 0,
          durationFrames: totalFrames,
          gainDb: -18,
          duckUnderDialogue: true,
          fadeInFrames: Math.min(framesCeil(500_000, fps), Math.floor(totalFrames / 4)),
          fadeOutFrames: Math.min(framesCeil(1_000_000, fps), Math.floor(totalFrames / 4)),
        }
      : null;

  // F10 SFX: one per meaningful visual event — a hit on the hook, a whoosh on each motion template — ≤1 per 5 s.
  const sfx: SfxCue[] = [];
  if (settings.sfx) {
    const byCategory = (c: SfxCategory) => ctx.sfxAssets ? ctx.sfxAssets.find((x) => x.category === c)?.id : c === 'whoosh' ? ctx.sfxAssetId : undefined;
    let last = -Infinity;
    const events = visuals
      .filter((v) => v.kind === 'hook_text' || v.kind === 'motion_template')
      .map((v) => ({ v, at: out.get(v.anchor.wordId)?.start ?? 0, category: (v.kind === 'hook_text' ? 'hit' : 'whoosh') as SfxCategory }))
      .sort((a, b) => a.at - b.at);
    for (const { v, at, category } of events) {
      const assetId = byCategory(category);
      if (!assetId || at < last + SFX_GAP_US) continue;
      last = at;
      sfx.push({ id: `sfx_${pad4(sfx.length + 1)}`, assetId, anchor: v.anchor, category, gainDb: -12, visualId: v.id, locked: false });
    }
  }

  // F11: severe source clipping is flagged for an original/processed comparison.
  let clip = 0;
  for (const assetId of [...new Set(segments.map((g) => g.assetId))]) {
    const va = ctx.voiceAnalysis?.[assetId];
    if (!va || !(va.severe || va.clippingRatio > CLIPPING_RATIO)) continue;
    reviewMarkers.push({
      id: `marker_clipping_${pad4(++clip)}`,
      kind: 'source_clipping',
      severity: 'warning',
      message: 'Severe clipping in the source; compare original and processed',
      refs: segments.filter((g) => g.assetId === assetId).map((g) => g.id),
    });
  }

  const assetIds = [...new Set(ws.map((w) => w.assetId))];
  const used: PlanAssetRef[] = [
    ...brollUsed.map((b) => ({ id: b.id, kind: b.kind, manifestRef: `assets/${b.id}.json` })),
    ...[music?.assetId, ...sfx.map((x) => x.assetId)].filter((id): id is Id => !!id).map((id) => ({ id, kind: 'audio' as const, manifestRef: `assets/${id}.json` })),
  ];
  const base: PlanAssetRef[] = ctx.assets ?? assetIds.map((id) => ({ id, kind: 'video' as const, manifestRef: `assets/${id}.json` }));
  // Chosen B-roll, music and SFX join the caller's asset list when it does not already name them.
  const assets = [...base];
  for (const a of used) if (!assets.some((x) => x.id === a.id)) assets.push(a);

  return {
    schemaVersion: '1.0',
    projectId: req.projectId,
    revision: req.revision,
    output,
    settings,
    assets,
    transcriptRef: null,
    brandProfileRef: null,
    styleProfileRef: null,
    decisions,
    segments,
    captions: settings.captions ? captions : [],
    visuals,
    transforms,
    audio: {
      dialogue: { profile: settings.studioVoice ? 'studio_conservative' : 'bypass', seamFadeMs: 40 },
      music,
      sfx,
      mixTarget: { integratedLufs: -14, truePeakDbtp: -1 },
    },
    reviewMarkers,
    provenance,
  };
}
