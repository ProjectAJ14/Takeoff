// Deterministic edit candidates from transcript words (+ optional VAD speech).
// Pure functions: no I/O, no clock, no randomness. PRD F03, F04, F05.
import type { ConfidenceTier, DirectorCandidate, DirectorRequest, FillerDictionary, FillerStrength, Id } from '@takeoff/contracts';

export type Word = DirectorRequest['words'][number];
/** A VAD speech interval in source microseconds, half-open. */
export interface SpeechInterval {
  assetId: Id;
  sourceStartUs: number;
  sourceEndUs: number;
}

export const SILENCE_MIN_US = 700_000;
export const SILENCE_KEEP_US = 300_000;
export const SILENCE_PAD_US = 120_000;
export const EDGE_PAD_US = 150_000;
export const RETAKE_WINDOW_US = 10_000_000;
export const RETAKE_MIN_TOKENS = 3;
const ISOLATION_GAP_US = 150_000;

export const norm = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
/** Comparison key for take matching: ASR spells homophones of short words inconsistently ("to"/"2", "for"/"4"). */
const HOMOPHONE: Record<string, string> = { too: 'to', two: 'to', '2': 'to', four: 'for', '4': 'for' };
const matchKey = (text: string) => HOMOPHONE[norm(text)] ?? norm(text);
export const isTerminal = (w: Word): boolean => /[.!?]["')\]]*$/.test(w.text);
const endsPunct = (w: Word): boolean => /[,.;:!?]["')\]]*$/.test(w.text);
export const isHesitation = (w: Word): boolean => /^(u+m+|u+h+|e+r+m+|h+m+|uhm+)$/.test(norm(w.text));

/** ASR spellings of a hesitation that are also words ("Ah, I see", "Mm, yes"): fillers only when standalone. */
const isSoftHesitation = (w: Word): boolean => /^(a+h+|mm+)$/.test(norm(w.text));
const endsComma = (w: Word): boolean => /,["')\]]*$/.test(w.text);

const DETERMINERS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'your', 'his', 'her', 'its', 'our', 'their', 'some', 'every']);
const NEGATION = new Set(['no', 'not', 'never', "don't", "doesn't", "didn't", "can't", "won't", "isn't", "wasn't", 'wait']);
/** A preceding word that makes 'like' a verb or a comparison ("I like", "looks like"). */
const LIKE_GRAMMATICAL_PREV = new Set([
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'would', 'do', "don't", 'did', "didn't", 'really', "i'd", "you'd", "we'd",
  'look', 'looks', 'looked', 'looking', 'feel', 'feels', 'felt', 'sound', 'sounds', 'sounded', 'seem', 'seems',
  'is', 'was', 'are', 'were', 'be', 'been', 'something', 'nothing', 'anything', 'more', 'things', 'stuff', 'just',
]);
const YOU_KNOW_GRAMMATICAL_PREV = new Set(['do', 'did', "don't", "didn't", 'if', 'as', 'would', 'will', 'to', 'now', 'should']);
const YOU_KNOW_GRAMMATICAL_NEXT = new Set(['what', 'how', 'that', 'why', 'where', 'who', 'when', 'this', 'it', 'him', 'her', 'them', 'about', ...DETERMINERS]);

type Tier = ConfidenceTier | null;
/** Strength → tier for each contextual marker once it is isolated and not grammatical. null = not a candidate. */
const CONTEXTUAL: Record<string, { tokens: string[]; tier: Record<FillerStrength, Tier> }> = {
  you_know: { tokens: ['you', 'know'], tier: { conservative: null, normal: 'high', aggressive: 'high' } },
  i_mean: { tokens: ['i', 'mean'], tier: { conservative: null, normal: 'high', aggressive: 'high' } },
  like: { tokens: ['like'], tier: { conservative: null, normal: 'medium', aggressive: 'high' } },
  basically: { tokens: ['basically'], tier: { conservative: null, normal: 'medium', aggressive: 'high' } },
  so: { tokens: ['so'], tier: { conservative: null, normal: 'medium', aggressive: 'high' } },
  actually: { tokens: ['actually'], tier: { conservative: null, normal: null, aggressive: 'medium' } },
};

const sameAsset = (a: Word | undefined, b: Word | undefined) => !!a && !!b && a.assetId === b.assetId;
const sentenceStart = (ws: Word[], k: number) => k === 0 || !sameAsset(ws[k - 1], ws[k]) || isTerminal(ws[k - 1]!);
const boundaryBefore = (ws: Word[], k: number) =>
  sentenceStart(ws, k) || endsPunct(ws[k - 1]!) || ws[k]!.sourceStartUs - ws[k - 1]!.sourceEndUs >= ISOLATION_GAP_US;
const boundaryAfter = (ws: Word[], k: number) =>
  k === ws.length - 1 || !sameAsset(ws[k], ws[k + 1]) || endsPunct(ws[k]!) || ws[k + 1]!.sourceStartUs - ws[k]!.sourceEndUs >= ISOLATION_GAP_US;
const overlapsNeighbour = (ws: Word[], a: number, b: number) =>
  (sameAsset(ws[a - 1], ws[a]) && ws[a - 1]!.sourceEndUs > ws[a]!.sourceStartUs) ||
  (sameAsset(ws[b + 1], ws[b]) && ws[b + 1]!.sourceStartUs < ws[b]!.sourceEndUs);
const isNumberish = (t: string) => /\d/.test(t);

function grammatical(key: string, ws: Word[], a: number, b: number): boolean {
  const prev = a > 0 && sameAsset(ws[a - 1], ws[a]) ? norm(ws[a - 1]!.text) : '';
  const next = b + 1 < ws.length && sameAsset(ws[b], ws[b + 1]) ? norm(ws[b + 1]!.text) : '';
  switch (key) {
    case 'like':
      // A comma after the previous word breaks the verb/comparison link: "it was, like, huge".
      return (LIKE_GRAMMATICAL_PREV.has(prev) && !endsPunct(ws[a - 1]!)) || DETERMINERS.has(next) || isNumberish(next);
    case 'you_know':
      return YOU_KNOW_GRAMMATICAL_PREV.has(prev) || YOU_KNOW_GRAMMATICAL_NEXT.has(next);
    case 'so':
    case 'actually':
      // Mid-sentence 'so' is a connector; mid-sentence 'actually' is usually a correction ("five, actually six").
      // A sentence-initial 'actually' before a negation or number is a correction too.
      return !sentenceStart(ws, a) || (key === 'actually' && (NEGATION.has(next) || isNumberish(next)));
    default:
      return false;
  }
}

/** Ordered by source time within each asset; preserves first-appearance asset order. */
export function orderWords(words: Word[]): Word[] {
  const order = new Map<Id, number>();
  for (const w of words) if (!order.has(w.assetId)) order.set(w.assetId, order.size);
  return [...words].sort((x, y) => order.get(x.assetId)! - order.get(y.assetId)! || x.sourceStartUs - y.sourceStartUs);
}

type Draft = Omit<DirectorCandidate, 'id'>;
const span = (ws: Word[], a: number, b: number) => ws.slice(a, b + 1);
const aligned = (ws: Word[]) => ws.every((w) => w.alignment === 'aligned');

const entryTokens = (entries: string[] = []) => entries.map((e) => e.split(/\s+/).map(norm).filter(Boolean)).filter((t) => t.length);
const matchesAt = (ws: Word[], k: number, tokens: string[]) =>
  k + tokens.length <= ws.length && tokens.every((t, i) => norm(ws[k + i]!.text) === t && sameAsset(ws[k], ws[k + i]));

/** Word ids covered by a custom preserve entry (F04: preserve always wins). */
export function preservedWordIds(words: Word[], preserve: string[] = []): Set<Id> {
  const ws = orderWords(words);
  const out = new Set<Id>();
  for (const tokens of entryTokens(preserve)) {
    for (let k = 0; k < ws.length; k++) if (matchesAt(ws, k, tokens)) for (let i = 0; i < tokens.length; i++) out.add(ws[k + i]!.id);
  }
  return out;
}

export function detectFillers(words: Word[], strength: FillerStrength = 'normal', dict?: FillerDictionary): Draft[] {
  const ws = orderWords(words);
  const out: Draft[] = [];
  const preserved = preservedWordIds(ws, dict?.preserve);
  const remove = entryTokens(dict?.remove);
  for (let k = 0; k < ws.length; k++) {
    let match: { b: number; tier: ConfidenceTier; evidence: string } | null = null;
    if (isHesitation(ws[k]!)) match = { b: k, tier: 'high', evidence: `hesitation '${norm(ws[k]!.text)}'` };
    else if (
      isSoftHesitation(ws[k]!) &&
      (norm(ws[k]!.text).startsWith('a') ? sentenceStart(ws, k) && endsComma(ws[k]!) : boundaryBefore(ws, k) && boundaryAfter(ws, k))
    ) {
      match = { b: k, tier: 'high', evidence: `standalone hesitation '${norm(ws[k]!.text)}'` };
    } else {
      for (const [key, rule] of Object.entries(CONTEXTUAL)) {
        const b = k + rule.tokens.length - 1;
        if (b >= ws.length || !rule.tokens.every((t, i) => norm(ws[k + i]!.text) === t && sameAsset(ws[k], ws[k + i]))) continue;
        const tier = rule.tier[strength];
        if (!tier || !boundaryBefore(ws, k) || !boundaryAfter(ws, b) || grammatical(key, ws, k, b)) break;
        match = { b, tier, evidence: `isolated discourse marker '${rule.tokens.join(' ')}' (${strength})` };
        break;
      }
      // Custom remove entries add candidates; a built-in marker still keeps its grammatical guard ("I like this").
      for (const tokens of match ? [] : remove) {
        if (!matchesAt(ws, k, tokens)) continue;
        const b = k + tokens.length - 1;
        const key = Object.keys(CONTEXTUAL).find((x) => CONTEXTUAL[x]!.tokens.join(' ') === tokens.join(' '));
        if (key && grammatical(key, ws, k, b)) continue;
        match = { b, tier: 'high', evidence: `custom remove entry '${tokens.join(' ')}'` };
        break;
      }
    }
    if (!match || span(ws, k, match.b).some((w) => preserved.has(w.id))) continue;
    const s = span(ws, k, match.b);
    // Uncertain alignment or overlap with neighbouring speech → retain; review only.
    const risky = !aligned(s) || overlapsNeighbour(ws, k, match.b);
    out.push({
      kind: 'filler',
      assetId: ws[k]!.assetId,
      sourceStartUs: ws[k]!.sourceStartUs,
      sourceEndUs: ws[match.b]!.sourceEndUs,
      wordIds: s.map((w) => w.id),
      evidence: risky ? `${match.evidence}; alignment uncertain or overlaps speech` : match.evidence,
      confidenceTier: risky ? 'low' : match.tier,
    });
    k = match.b;
  }
  return out;
}

const DRAMATIC_END = /(\.\.\.|…|—|:)["')\]]*$/;
/** Word k starts the last ≤2 words of its sentence. */
const punchlineAt = (ws: Word[], k: number) => [0, 1].some((i) => sameAsset(ws[k], ws[k + i]) && isTerminal(ws[k + i]!) && ws.slice(k, k + i).every((w) => !isTerminal(w)));

const overlapsSpeech = (speech: SpeechInterval[], assetId: Id, s: number, e: number) =>
  speech.some((v) => v.assetId === assetId && v.sourceStartUs < e && s < v.sourceEndUs);

/**
 * Interior gaps ≥700 ms shrink to ~300 ms (≥120 ms pad each side); leading/trailing dead air keeps 150 ms.
 * Trailing needs the asset duration. Cuts never enter a word or VAD speech at their edges. VAD speech wholly inside the cut → review, not removal.
 */
export function detectSilences(words: Word[], speech: SpeechInterval[] = [], durationsUs: Record<Id, number> = {}): Draft[] {
  const ws = orderWords(words);
  const out: Draft[] = [];
  const pad = Math.max(SILENCE_PAD_US, SILENCE_KEEP_US / 2);
  const push = (assetId: Id, s: number, e: number, around: Word[], evidence: string) => {
    // VAD speech straddling an edge (speech that runs on past the last word, or starts early) moves
    // the edge out of it; only speech wholly inside the gap makes the cut a review.
    for (const v of speech) {
      if (v.assetId !== assetId) continue;
      if (v.sourceStartUs <= s && v.sourceEndUs > s) s = v.sourceEndUs;
      if (v.sourceStartUs < e && v.sourceEndUs >= e) e = v.sourceStartUs;
    }
    if (e - s < SILENCE_PAD_US) return;
    const vad = overlapsSpeech(speech, assetId, s, e);
    const ok = aligned(around) && !vad;
    out.push({
      kind: 'silence',
      assetId,
      sourceStartUs: s,
      sourceEndUs: e,
      wordIds: around.map((w) => w.id),
      evidence: vad ? `${evidence}; VAD reports speech inside the gap` : evidence,
      confidenceTier: ok ? 'high' : 'medium',
    });
  };
  // Gaps are measured from the latest word end so far: an earlier, longer (overlapping) word must not be cut into.
  let speechEnd = 0;
  for (let k = 0; k < ws.length; k++) {
    const w = ws[k]!;
    const prev = ws[k - 1];
    if (!sameAsset(prev, w)) push(w.assetId, 0, w.sourceStartUs - EDGE_PAD_US, [w], 'leading dead air');
    else {
      const gap = w.sourceStartUs - speechEnd;
      if (gap >= SILENCE_MIN_US) {
        const n = out.length;
        push(w.assetId, speechEnd + pad, w.sourceStartUs - pad, [prev!, w], `pause of ${Math.round(gap / 1000)} ms`);
        // F05: a pause the ASR marks ("is... nothing"), or one before a ≤2-word ending that follows a non-final word
        // or a question (ASR punctuation there is unreliable: "the answer is? Nothing.") is likely purposeful, a beat
        // before a punchline: review, never an automatic cut.
        if (out.length > n && (DRAMATIC_END.test(prev!.text) || (punchlineAt(ws, k) && (!isTerminal(prev!) || /\?["')\]]*$/.test(prev!.text))))) {
          if (out[n]!.confidenceTier === 'high') out[n]!.confidenceTier = 'medium';
          out[n]!.evidence += '; possible purposeful pause before a punchline';
        }
      }
    }
    speechEnd = sameAsset(prev, w) ? Math.max(speechEnd, w.sourceEndUs) : w.sourceEndUs;
    const dur = durationsUs[w.assetId];
    if (!sameAsset(w, ws[k + 1]) && dur !== undefined) push(w.assetId, speechEnd + EDGE_PAD_US, dur, [w], 'trailing dead air');
  }
  return out;
}

/**
 * Sentence restarts: the first ≥3 normalized tokens of a phrase repeat within ~10 s.
 * Earlier attempt is a strict prefix (last token may be a cut-off fragment) of a longer later one → high false_start.
 * An earlier attempt that diverges → retake for review. A complete sentence repeated verbatim is emphasis → nothing.
 */
export function detectRetakes(words: Word[]): Draft[] {
  const ws = orderWords(words);
  const out: Draft[] = [];
  const byAsset = new Map<Id, number[]>();
  ws.forEach((w, i) => {
    if (!isHesitation(w)) byAsset.set(w.assetId, [...(byAsset.get(w.assetId) ?? []), i]);
  });
  // Within one asset here; crossTakeRetakes matches across files lexically. ponytail: no semantic similarity, so a
  // reworded retake in another file is not grouped.
  for (const c of byAsset.values()) {
    const t = c.map((i) => matchKey(ws[i]!.text));
    const at = (k: number) => ws[c[k]!]!;
    let a = 0;
    while (a + RETAKE_MIN_TOKENS <= c.length) {
      let found = -1;
      for (let b = a + RETAKE_MIN_TOKENS; b + RETAKE_MIN_TOKENS <= c.length; b++) {
        if (at(b).sourceStartUs - at(a).sourceStartUs > RETAKE_WINDOW_US) break;
        if (t.slice(a, a + RETAKE_MIN_TOKENS).every((tok, i) => tok !== '' && tok === t[b + i])) {
          found = b;
          break;
        }
      }
      // The earlier attempt must be one unit: no sentence end before its last word.
      if (found < 0 || c.slice(a, found - 1).some((i) => isTerminal(ws[i]!))) {
        a++;
        continue;
      }
      const m = found - a;
      const complete = isTerminal(at(found - 1));
      const prefix = t.slice(a, found).every((tok, k) => tok === t[found + k] || (k === m - 1 && !!t[found + k]?.startsWith(tok)));
      const laterLonger = found + m < c.length && !isTerminal(at(found + m - 1));
      if (prefix && complete && !laterLonger) {
        a = found; // emphasis repetition of a complete sentence
        continue;
      }
      const s = ws.slice(c[a], c[found]);
      const falseStart = prefix && laterLonger && !complete;
      out.push({
        kind: falseStart ? 'false_start' : 'retake',
        assetId: at(a).assetId,
        sourceStartUs: at(a).sourceStartUs,
        sourceEndUs: at(found).sourceStartUs,
        wordIds: s.map((w) => w.id),
        evidence: falseStart
          ? `abandoned start; restarted ${m} tokens later`
          : `phrase restarts with the same ${RETAKE_MIN_TOKENS} words but the attempts differ`,
        confidenceTier: falseStart ? (aligned(s) ? 'high' : 'medium') : complete ? 'low' : 'medium',
      });
      a = found;
    }
  }
  return [...out, ...crossTakeRetakes(ws, out)];
}

export const CROSS_TAKE_MIN_TOKENS = 4;
const RESTART_CUES = ['let me start again', 'let me start over', 'let me try again', 'let me try that again', 'start over', 'one more time'];

/**
 * F03 across files: a sentence in an earlier take whose first ≥4 words open a sentence in a later take is an
 * attempt at the same idea. Abandoned (an unfinished strict prefix of the later one, or it says "let me start again") → high
 * false_start; otherwise a retake for review. Identical complete sentences are left alone (no basis to pick one).
 */
function crossTakeRetakes(ws: Word[], found: Draft[]): Draft[] {
  const sentences: Word[][] = [];
  for (let k = 0; k < ws.length; k++) {
    if (sentenceStart(ws, k)) sentences.push([]);
    sentences.at(-1)!.push(ws[k]!);
  }
  const toks = (s: Word[]) => s.filter((w) => !isHesitation(w)).map((w) => matchKey(w.text)).filter(Boolean);
  const assets = [...new Set(ws.map((w) => w.assetId))];
  const out: Draft[] = [];
  for (const s1 of sentences) {
    const t1 = toks(s1);
    if (t1.length < CROSS_TAKE_MIN_TOKENS) continue;
    const [start, end] = [s1[0]!.sourceStartUs, s1.at(-1)!.sourceEndUs];
    if (found.some((d) => d.assetId === s1[0]!.assetId && d.sourceStartUs < end && start < d.sourceEndUs)) continue;
    const later = sentences.find((s2) => assets.indexOf(s2[0]!.assetId) > assets.indexOf(s1[0]!.assetId) &&
      toks(s2).slice(0, CROSS_TAKE_MIN_TOKENS).join(' ') === t1.slice(0, CROSS_TAKE_MIN_TOKENS).join(' '));
    if (!later) continue;
    const t2 = toks(later);
    if (t1.join(' ') === t2.join(' ')) continue;
    const prefix = t1.length < t2.length && t1.every((tok, k) => tok === t2[k] || (k === t1.length - 1 && t2[k]!.startsWith(tok)));
    const joined = ` ${t1.join(' ')} `;
    const cue = RESTART_CUES.find((c) => joined.includes(` ${c} `));
    const abandoned = (prefix && !isTerminal(s1.at(-1)!)) || !!cue;
    out.push({
      kind: abandoned ? 'false_start' : 'retake',
      assetId: s1[0]!.assetId,
      sourceStartUs: start,
      sourceEndUs: end,
      wordIds: s1.map((w) => w.id),
      evidence: abandoned
        ? `abandoned attempt (${cue ? `'${cue}'` : 'incomplete'}); said in full in a later take`
        : `a later take opens the same idea with the same ${CROSS_TAKE_MIN_TOKENS} words`,
      confidenceTier: abandoned ? (aligned(s1) ? 'high' : 'medium') : 'medium',
    });
  }
  return out;
}

export interface DetectOptions {
  fillerStrength?: FillerStrength;
  fillerDictionary?: FillerDictionary;
  speech?: SpeechInterval[];
  durationsUs?: Record<Id, number>;
}

/** All detectors, ids assigned in a stable order: cand_0001… */
export function detectCandidates(words: Word[], opts: DetectOptions = {}): DirectorCandidate[] {
  const drafts = [
    ...detectRetakes(words),
    ...detectFillers(words, opts.fillerStrength, opts.fillerDictionary),
    ...detectSilences(words, opts.speech, opts.durationsUs),
  ];
  return drafts.map((d, i) => ({ id: `cand_${String(i + 1).padStart(4, '0')}`, ...d }));
}
