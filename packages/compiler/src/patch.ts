// Allowlisted patch operations over an EditPlan (PRD 8, 9.2). Patches are atomic:
// any failing op leaves the input plan untouched and nothing is returned.
import { validate, type Caption, type EditPlan, type Id, type PatchOp, type PlanPatch, type Segment } from '@takeoff/contracts';
import { intersect, merge, subtract, usToFrames, type Interval } from './clock.ts';
import { own, validatePlan, type Issue, type PlanContext } from './compile.ts';

export type PatchErrorCode = 'invalid_patch' | 'stale_revision' | 'locked_object' | 'not_found' | 'invalid_op' | 'invalid_result';

export class PatchError extends Error {
  code: PatchErrorCode;
  issues: Issue[];
  constructor(code: PatchErrorCode, message: string, issues: Issue[] = []) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    this.issues = issues;
  }
}

interface Lockable {
  locked?: boolean;
}
const mutable = (o: Lockable, id: Id): void => {
  if (o.locked) throw new PatchError('locked_object', `${id} is locked; unlock it first`);
};
const spanOf = (g: { sourceStartUs: number; sourceEndUs: number }): Interval => ({ start: g.sourceStartUs, end: g.sourceEndUs });

function findObject(p: EditPlan, id: Id): Lockable | undefined {
  const lists: Array<Array<Lockable & { id: Id }>> = [p.decisions, p.segments, p.captions, p.visuals, p.transforms, p.audio.sfx];
  for (const list of lists) {
    const o = list.find((x) => x.id === id);
    if (o) return o;
  }
  // The music cue has no id of its own; it is addressed by its asset id.
  return p.audio.music?.assetId === id ? p.audio.music : undefined;
}

function need<T>(o: T | undefined, id: Id): T {
  if (o === undefined) throw new PatchError('not_found', `no object ${id}`);
  return o;
}

/**
 * Apply `patch` to `plan`. Returns a new plan at revision + 1.
 * Rejects a malformed patch, a stale baseRevision, any edit of a locked object
 * (lock_object/unlock_object excepted) and any result with errors the input did not already have.
 */
export function applyPatch(plan: EditPlan, patch: unknown, ctx: PlanContext): EditPlan {
  const v = validate('patch', patch);
  if (!v.ok) throw new PatchError('invalid_patch', 'patch fails schema', v.errors.map((e) => ({ code: 'schema', message: `${e.path || '/'}: ${e.message}`, refs: [] })));
  const pt: PlanPatch = v.value;
  if (pt.baseRevision !== plan.revision) throw new PatchError('stale_revision', `patch is based on revision ${pt.baseRevision}; plan is at ${plan.revision}`);

  const key = (i: Issue) => `${i.code}|${i.refs.join(',')}`;
  const before = new Set(validatePlan(plan, ctx).errors.map(key));
  const p = structuredClone(plan);
  pt.ops.forEach((op, i) => applyOp(p, op, i, ctx));
  p.revision += 1;
  const fresh = validatePlan(p, ctx).errors.filter((e) => !before.has(key(e)));
  if (fresh.length) throw new PatchError('invalid_result', `patch would make the plan invalid: ${fresh.map((e) => e.code).join(', ')}`, fresh);
  return p;
}

function applyOp(p: EditPlan, op: PatchOp, index: number, ctx: PlanContext): void {
  const transcriptWords = (assetId: Id) => own(ctx.transcripts, assetId)?.words ?? [];
  const wordsIn = (assetId: Id, i: Interval): Id[] =>
    transcriptWords(assetId)
      .filter((w) => w.sourceStartUs >= i.start && w.sourceEndUs <= i.end)
      .sort((a, b) => a.sourceStartUs - b.sourceStartUs)
      .map((w) => w.id);
  const keepWords = (g: Segment, i: Interval): Id[] => {
    const inside = new Set(wordsIn(g.assetId, i));
    return g.wordIds.filter((id) => inside.has(id));
  };
  const seg = (id: Id) => need(p.segments.find((g) => g.id === id), id);
  // PRD F14: a cut edge never lands inside a word.
  const noMidWord = (assetId: Id, ...edges: number[]) => {
    const w = transcriptWords(assetId).find((w) => edges.some((at) => w.sourceStartUs < at && at < w.sourceEndUs));
    if (w) throw new PatchError('invalid_op', `${op.op} edge falls inside word ${w.id}`);
  };
  // Owning asset of each segment before the op, so reconcile can re-home caption and anchor words.
  const assetBefore = new Map(p.segments.map((g) => [g.id, g.assetId]));
  // Words on screen before the op, so reconcile can refuse to orphan a locked object's anchor.
  const heldBefore = new Set(p.segments.flatMap((g) => g.wordIds.map((w) => `${g.assetId}\n${w}`)));
  const done = () => reconcile(p, assetBefore, heldBefore, ctx, fresh);
  // Generated ids never collide with an existing object id (a collision would fail duplicate_id).
  const taken = new Set<Id>([p.decisions, p.segments, p.captions, p.visuals, p.transforms, p.audio.sfx, p.reviewMarkers].flatMap((l) => l.map((o) => o.id)));
  const fresh = (base: Id): Id => {
    let id = base;
    for (let n = 1; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    return id;
  };

  switch (op.op) {
    case 'lock_object':
    case 'unlock_object':
      need(findObject(p, op.objectId), op.objectId).locked = op.op === 'lock_object';
      return;

    case 'remove_span': {
      const cut = spanOf(op);
      noMidWord(op.assetId, cut.start, cut.end);
      const out: Segment[] = [];
      for (const g of p.segments) {
        if (g.assetId !== op.assetId || !intersect(spanOf(g), cut)) {
          out.push(g);
          continue;
        }
        mutable(g, g.id);
        subtract(spanOf(g), cut).forEach((piece, k) =>
          out.push({ ...g, id: k ? fresh(`${g.id}_${piece.start}`) : g.id, sourceStartUs: piece.start, sourceEndUs: piece.end, wordIds: keepWords(g, piece) }),
        );
      }
      p.segments = out;
      p.decisions.push({
        id: `user_cut_r${p.revision + 1}_${index}`,
        assetId: op.assetId,
        action: 'remove',
        sourceStartUs: op.sourceStartUs,
        sourceEndUs: op.sourceEndUs,
        reason: op.reason,
        evidenceIds: [],
        confidenceTier: 'high',
        detector: 'user',
      });
      return done();
    }

    case 'restore_span': {
      const retained = merge(p.segments.filter((g) => g.assetId === op.assetId).map(spanOf));
      const pieces = retained.reduce<Interval[]>((acc, r) => acc.flatMap((x) => subtract(x, r)), [spanOf(op)]);
      // Only the user's own edges are new cut points; the others meet already-retained segments.
      for (const piece of pieces) noMidWord(op.assetId, ...[piece.start, piece.end].filter((e) => e === op.sourceStartUs || e === op.sourceEndUs));
      for (const piece of pieces) {
        const same = p.segments.filter((g) => g.assetId === op.assetId);
        const next = p.segments.findIndex((g) => g.assetId === op.assetId && g.sourceStartUs >= piece.end);
        const last = same.length ? p.segments.lastIndexOf(same.at(-1)!) : -1;
        const at = next >= 0 ? next : last >= 0 ? last + 1 : p.segments.length;
        p.segments.splice(at, 0, {
          id: fresh(`${op.assetId}_restored_${piece.start}`),
          assetId: op.assetId,
          sourceStartUs: piece.start,
          sourceEndUs: piece.end,
          wordIds: wordsIn(op.assetId, piece),
          speed: { num: 1, den: 1 },
          cropPolicy: same[0]?.cropPolicy ?? 'face_safe_vertical',
          locked: false,
        });
      }
      // Restored words bring orphaned anchors back to their segment.
      return done();
    }

    case 'replace_take': {
      const g = seg(op.segmentId);
      mutable(g, g.id);
      Object.assign(g, { assetId: op.assetId, sourceStartUs: op.sourceStartUs, sourceEndUs: op.sourceEndUs, wordIds: op.wordIds });
      return done();
    }

    case 'trim_segment': {
      const g = seg(op.segmentId);
      mutable(g, g.id);
      noMidWord(g.assetId, op.sourceStartUs, op.sourceEndUs);
      Object.assign(g, { sourceStartUs: op.sourceStartUs, sourceEndUs: op.sourceEndUs, wordIds: wordsIn(g.assetId, spanOf(op)) });
      return done();
    }

    case 'split_segment': {
      const g = seg(op.segmentId);
      mutable(g, g.id);
      const at = op.atSourceUs;
      if (at <= g.sourceStartUs || at >= g.sourceEndUs) throw new PatchError('invalid_op', `split point is outside segment ${g.id}`);
      noMidWord(g.assetId, at);
      const tail: Segment = { ...g, id: op.newSegmentId, sourceStartUs: at, wordIds: keepWords(g, { start: at, end: g.sourceEndUs }) };
      Object.assign(g, { sourceEndUs: at, wordIds: keepWords(g, { start: g.sourceStartUs, end: at }) });
      p.segments.splice(p.segments.indexOf(g) + 1, 0, tail);
      return done();
    }

    case 'reorder_segment': {
      const g = seg(op.segmentId);
      mutable(g, g.id);
      if (op.toIndex >= p.segments.length) throw new PatchError('invalid_op', `index ${op.toIndex} is past the last segment`);
      p.segments.splice(p.segments.indexOf(g), 1);
      p.segments.splice(op.toIndex, 0, g);
      return;
    }

    case 'set_caption': {
      const c = need(p.captions.find((x) => x.id === op.captionId), op.captionId);
      mutable(c, c.id);
      const { op: _, captionId: __, ...fields } = op;
      Object.assign(c, fields);
      return;
    }

    case 'set_crop': {
      const g = seg(op.segmentId);
      mutable(g, g.id);
      g.cropPolicy = 'manual';
      const t = p.transforms.find((x) => x.kind === 'crop' && x.segmentId === g.id);
      if (t) {
        mutable(t, t.id);
        if (t.kind === 'crop') t.rect = op.rect;
      } else p.transforms.push({ id: fresh(`crop_${g.id}`), segmentId: g.id, kind: 'crop', rect: op.rect, locked: false });
      return;
    }

    case 'replace_asset': {
      const target = p.visuals.find((x) => x.id === op.targetId) ?? p.audio.sfx.find((x) => x.id === op.targetId) ??
        (p.audio.music?.assetId === op.targetId ? p.audio.music : undefined);
      const o = need(target, op.targetId);
      mutable(o, op.targetId);
      if ('kind' in o && o.kind !== 'broll') throw new PatchError('invalid_op', `${op.targetId} has no replaceable asset`);
      (o as { assetId: Id }).assetId = op.assetId;
      return;
    }

    case 'set_gain': {
      const o = need(p.audio.sfx.find((x) => x.id === op.targetId) ?? (p.audio.music?.assetId === op.targetId ? p.audio.music : undefined), op.targetId);
      mutable(o, op.targetId);
      o.gainDb = op.gainDb;
      return;
    }

    case 'set_setting': {
      (p.settings as unknown as Record<string, unknown>)[op.key] = op.value;
      // Keep the frame target in step with the seconds the user chose (null = automatic length).
      if (op.key === 'targetSeconds') {
        p.output.targetFrames = op.value === null ? null : usToFrames(Math.round(op.value * 1_000_000), p.output.fps);
      }
      return;
    }

    case 'remove_visual': {
      const v = need(p.visuals.find((x) => x.id === op.visualId), op.visualId);
      mutable(v, v.id);
      p.visuals.splice(p.visuals.indexOf(v), 1);
      return;
    }

    case 'set_hook': {
      p.settings.hook = { autoSelect: false, text: op.text };
      const v = p.visuals.find((x) => x.kind === 'hook_text');
      if (!v || v.kind !== 'hook_text') return;
      mutable(v, v.id);
      if (op.text === null) p.visuals.splice(p.visuals.indexOf(v), 1);
      else Object.assign(v, { text: op.text, evidenceIds: op.evidenceIds });
      return;
    }

    default: {
      const never: never = op;
      throw new PatchError('invalid_op', `operation ${(never as { op: string }).op} is not allowlisted`);
    }
  }
}

/**
 * After segments change, re-home caption and anchor words to the segment that now holds them.
 * A caption that lost words or now spans several segments is rewritten (refused when locked);
 * one whose words were all cut is dropped.
 * Timing is never shifted here: the compiler recomputes output time from word IDs (PRD 9.2).
 */
function reconcile(p: EditPlan, assetBefore: Map<Id, Id>, heldBefore: Set<string>, ctx: PlanContext, fresh: (base: Id) => Id): void {
  const ownerOf = (assetId: Id | undefined, wordId: Id) =>
    p.segments.find((g) => g.assetId === assetId && g.wordIds.includes(wordId))?.id;

  const captions: Caption[] = [];
  for (const c of p.captions) {
    const asset = assetBefore.get(c.segmentId);
    const groups = new Map<Id, Id[]>();
    for (const id of c.wordIds) {
      const owner = ownerOf(asset, id);
      if (owner) groups.set(owner, [...(groups.get(owner) ?? []), id]);
    }
    const [only] = groups;
    if (groups.size === 1 && only![1].length === c.wordIds.length) {
      // All words survive in one segment: re-point the reference only. Content is untouched, so a lock allows it.
      c.segmentId = only![0];
      captions.push(c);
      continue;
    }
    mutable(c, c.id);
    const words = new Map((own(ctx.transcripts, asset ?? '')?.words ?? []).map((w) => [w.id, w]));
    [...groups].forEach(([segmentId, wordIds], k) =>
      captions.push({
        ...c,
        id: k ? fresh(`${c.id}_${k}`) : c.id,
        segmentId,
        wordIds,
        // Spoken captions are rebuilt from the transcript, never paraphrased (PRD F06).
        text: wordIds.map((id) => words.get(id)?.correctedText ?? words.get(id)?.text ?? '').join(' '),
        emphasisWordIds: c.emphasisWordIds.filter((id) => wordIds.includes(id)),
      }),
    );
  }
  p.captions = captions;

  for (const o of [...p.visuals, ...p.transforms]) {
    if (!('anchor' in o)) continue;
    const asset = assetBefore.get(o.segmentId);
    const owner = ownerOf(asset, o.anchor.wordId);
    // Re-pointing to the segment that now holds the same word changes no content, so a lock allows it.
    // A cut anchor word stays orphaned for the validator to flag; it is not moved to a guessed word.
    // Orphaning drops the object from the output, so a lock refuses it like any other edit.
    if (owner) o.segmentId = owner;
    else if (heldBefore.has(`${asset}\n${o.anchor.wordId}`)) mutable(o, o.id);
  }
  // Sfx anchors resolve against any segment (compile.ts anchorTarget with no segment).
  const heldNow = new Set(p.segments.flatMap((g) => g.wordIds));
  const anyBefore = new Set([...heldBefore].map((k) => k.slice(k.indexOf('\n') + 1)));
  for (const x of p.audio.sfx) if (!heldNow.has(x.anchor.wordId) && anyBefore.has(x.anchor.wordId)) mutable(x, x.id);
}
