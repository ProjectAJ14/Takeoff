import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCandidates, detectFillers, detectRetakes, detectSilences, type Word } from '../src/index.ts';
import { words } from './helpers.ts';

const texts = (ws: Word[], ids: string[]) => ids.map((id) => ws.find((w) => w.id === id)!.text).join(' ');

test('fillers: hesitations are always high-confidence candidates', () => {
  const ws = words('This is, um, great uh stuff erm really hmm.');
  for (const strength of ['conservative', 'normal', 'aggressive'] as const) {
    const f = detectFillers(ws, strength);
    assert.deepEqual(f.map((c) => texts(ws, c.wordIds)), ['um,', 'uh', 'erm', 'hmm.']);
    assert.ok(f.every((c) => c.confidenceTier === 'high' && c.kind === 'filler'));
  }
});

test('fillers: grammatical "like" is never a candidate', () => {
  for (const s of ['I like this a lot.', 'It looks like, a cat.', 'We would like to go.', 'It is like, the best.', 'Something like, 5 seconds.']) {
    for (const strength of ['conservative', 'normal', 'aggressive'] as const) {
      assert.deepEqual(detectFillers(words(s), strength), [], `${s} @ ${strength}`);
    }
  }
});

test('fillers: isolated "like" depends on strength', () => {
  const ws = words('It was, like, huge.');
  assert.deepEqual(detectFillers(ws, 'conservative'), []);
  assert.equal(detectFillers(ws, 'normal')[0]!.confidenceTier, 'medium');
  assert.equal(detectFillers(ws, 'aggressive')[0]!.confidenceTier, 'high');
});

test('fillers: "you know" substantive stays, isolated goes', () => {
  assert.deepEqual(detectFillers(words('Do you know, the answer?'), 'aggressive'), []);
  assert.deepEqual(detectFillers(words('And you know what I mean.'), 'aggressive'), []);
  const ws = words('It is fast, you know, really fast.');
  const f = detectFillers(ws, 'normal');
  assert.equal(f.length, 1);
  assert.equal(texts(ws, f[0]!.wordIds), 'you know,');
  assert.equal(f[0]!.confidenceTier, 'high');
});

test('fillers: "actually" corrections are kept; sentence-initial marker only at aggressive', () => {
  assert.deepEqual(detectFillers(words('It takes five, actually, six seconds.'), 'aggressive'), []);
  assert.deepEqual(detectFillers(words('Actually, no, that is wrong.'), 'aggressive'), []);
  assert.deepEqual(detectFillers(words('Actually, let us start.'), 'normal'), []);
  assert.equal(detectFillers(words('Actually, let us start.'), 'aggressive')[0]!.confidenceTier, 'medium');
});

test('fillers: mid-sentence "so" is a connector', () => {
  assert.deepEqual(detectFillers(words('It is so, fast.'), 'aggressive'), []);
  assert.equal(detectFillers(words('So, here we go.'), 'aggressive').length, 1);
});

test('fillers: uncertain alignment or overlap is retained as low tier', () => {
  const ws = words('This is ~um great.');
  assert.equal(detectFillers(ws)[0]!.confidenceTier, 'low');
  const overlapping = words('This is um great.');
  overlapping[2]!.sourceEndUs = overlapping[3]!.sourceStartUs + 10_000;
  assert.equal(detectFillers(overlapping)[0]!.confidenceTier, 'low');
});

test('silences: interior gap ≥700 ms shrinks to 300 ms; short gaps stay; cuts never enter a word', () => {
  const ws = words('One two. [1000] Three four. [500] Five.');
  const s = detectSilences(ws, [], { take_a: 10_000_000 });
  const interior = s.filter((c) => c.evidence.startsWith('pause'));
  assert.equal(interior.length, 1);
  const [prev, next] = interior[0]!.wordIds.map((id) => ws.find((w) => w.id === id)!);
  assert.equal(interior[0]!.sourceStartUs, prev!.sourceEndUs + 150_000);
  assert.equal(interior[0]!.sourceEndUs, next!.sourceStartUs - 150_000);
  assert.equal(next!.sourceStartUs - prev!.sourceEndUs - (interior[0]!.sourceEndUs - interior[0]!.sourceStartUs), 300_000);
  const lead = s.find((c) => c.evidence === 'leading dead air')!;
  assert.deepEqual([lead.sourceStartUs, lead.sourceEndUs], [0, ws[0]!.sourceStartUs - 150_000]);
  const trail = s.find((c) => c.evidence === 'trailing dead air')!;
  assert.deepEqual([trail.sourceStartUs, trail.sourceEndUs], [ws.at(-1)!.sourceEndUs + 150_000, 10_000_000]);
  for (const c of s) for (const w of ws) assert.ok(c.sourceEndUs <= w.sourceStartUs || c.sourceStartUs >= w.sourceEndUs, 'cut inside a word');
  assert.ok(s.every((c) => c.confidenceTier === 'high'));
});

test('silences: VAD speech inside a gap downgrades to review', () => {
  const ws = words('One two. [1500] Three.');
  const gapMid = ws[1]!.sourceEndUs + 700_000;
  const s = detectSilences(ws, [{ assetId: 'take_a', sourceStartUs: gapMid, sourceEndUs: gapMid + 100_000 }]);
  assert.equal(s.find((c) => c.evidence.startsWith('pause'))!.confidenceTier, 'medium');
});

test('silences: VAD speech running past a word edge moves the cut, it does not make it a review', () => {
  const ws = words('One two. [1500] Three.');
  const runOn = ws[1]!.sourceEndUs + 200_000; // VAD hears the tail of "two" 200 ms past the word end
  const s = detectSilences(ws, [{ assetId: 'take_a', sourceStartUs: ws[0]!.sourceStartUs, sourceEndUs: runOn }], { take_a: ws[2]!.sourceEndUs + 2_000_000 });
  const pause = s.find((c) => c.evidence.startsWith('pause'))!;
  assert.equal(pause.confidenceTier, 'high');
  assert.equal(pause.sourceStartUs, runOn);
  assert.equal(pause.sourceEndUs, ws[2]!.sourceStartUs - 150_000);
  const trail = detectSilences(ws, [{ assetId: 'take_a', sourceStartUs: ws[2]!.sourceStartUs, sourceEndUs: ws[2]!.sourceEndUs + 300_000 }], { take_a: ws[2]!.sourceEndUs + 2_000_000 })
    .find((c) => c.evidence === 'trailing dead air')!;
  assert.equal(trail.confidenceTier, 'high');
  assert.equal(trail.sourceStartUs, ws[2]!.sourceEndUs + 300_000);
});

test('retakes: abandoned strict-prefix start is a high false_start', () => {
  const ws = words('So the main thing is, so the main thing is that Dio is fast.');
  const r = detectRetakes(ws);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, 'false_start');
  assert.equal(r[0]!.confidenceTier, 'high');
  assert.equal(texts(ws, r[0]!.wordIds), 'So the main thing is,');
  assert.equal(r[0]!.sourceEndUs, ws[5]!.sourceStartUs);
});

test('retakes: cut-off last word still counts as a prefix', () => {
  const ws = words('We send the requ- we send the request to Dio.');
  assert.equal(detectRetakes(ws)[0]!.kind, 'false_start');
});

test('retakes: emphasis repetition is not a mistake', () => {
  assert.deepEqual(detectRetakes(words('This is huge. This is huge.')), []);
  assert.deepEqual(detectRetakes(words('It is really really really good.')), []);
  assert.deepEqual(detectRetakes(words('Never give up.')), []);
});

test('retakes: diverging attempts become review candidates, not removals', () => {
  const r = detectRetakes(words('The best way is Riverpod, the best way is Bloc for big apps.'));
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, 'retake');
  assert.notEqual(r[0]!.confidenceTier, 'high');
});

test('retakes: repeats more than ~10 s apart are ignored', () => {
  assert.deepEqual(detectRetakes(words('So the main thing [11000] so the main thing is Dio.')), []);
});

test('detectCandidates: stable ids, schema-shaped candidates', () => {
  const ws = words('Um so the main, so the main thing is Dio. [900] Done.');
  const c = detectCandidates(ws);
  assert.deepEqual(c.map((x) => x.id), c.map((_, i) => `cand_${String(i + 1).padStart(4, '0')}`));
  assert.deepEqual(detectCandidates(ws), c);
});

test('silences: a gap is measured from the latest word end, never cutting into an overlapping longer word', () => {
  const ws: Word[] = [
    { id: 'a', assetId: 't', text: 'Long', sourceStartUs: 0, sourceEndUs: 3_000_000, alignment: 'aligned' },
    { id: 'b', assetId: 't', text: 'short', sourceStartUs: 500_000, sourceEndUs: 800_000, alignment: 'aligned' },
    { id: 'c', assetId: 't', text: 'next.', sourceStartUs: 3_900_000, sourceEndUs: 4_200_000, alignment: 'aligned' },
  ];
  const cuts = detectSilences(ws, [], { t: 6_000_000 });
  assert.deepEqual(cuts.map((c) => [c.sourceStartUs, c.sourceEndUs]), [[3_150_000, 3_750_000], [4_350_000, 6_000_000]]);
});

test('fillers: standalone "Ah," and "Mm" are candidates at every strength; the words in context are not', () => {
  const ws = words('Ah, this is it. [500] Mm, [300] okay then. Uh, done.');
  for (const strength of ['conservative', 'normal', 'aggressive'] as const) {
    const f = detectFillers(ws, strength);
    assert.deepEqual(f.map((c) => texts(ws, c.wordIds)), ['Ah,', 'Mm,', 'Uh,'], strength);
    assert.ok(f.every((c) => c.confidenceTier === 'high'));
  }
  // Mid-sentence "ah", "Ah" without a comma, and "mm" glued to speech stay.
  for (const s of ['Say ah, then stop.', 'Ah I see it.', 'It is mm good.']) assert.deepEqual(detectFillers(words(s), 'aggressive'), [], s);
  // Still retained when alignment is uncertain.
  assert.equal(detectFillers(words('~Ah, this is it.'))[0]!.confidenceTier, 'low');
});

test('fillers: custom dictionary — preserve always wins, remove adds candidates', () => {
  const ws = words('This is, um, literally the best. It was, like, huge.');
  const remove = detectFillers(ws, 'normal', { preserve: [], remove: ['Literally'] });
  assert.deepEqual(remove.map((c) => texts(ws, c.wordIds)), ['um,', 'literally', 'like,']);
  assert.equal(remove[1]!.confidenceTier, 'high');
  const keep = detectFillers(ws, 'aggressive', { preserve: ['um', 'like', 'literally'], remove: ['literally'] });
  assert.deepEqual(keep, [], 'preserve beats built-in and custom remove');
  // Multi-word entries; a remove entry under uncertain alignment is only a review.
  const multi = words('It is sort of ~literally done.');
  const m = detectFillers(multi, 'normal', { preserve: [], remove: ['sort of', 'literally'] });
  assert.deepEqual(m.map((c) => [texts(multi, c.wordIds), c.confidenceTier]), [['sort of', 'high'], ['literally', 'low']]);
  // A remove entry naming a built-in marker keeps its grammatical guard.
  assert.deepEqual(detectFillers(words('I like this a lot.'), 'normal', { preserve: [], remove: ['like'] }), []);
  // detectCandidates threads the dictionary.
  assert.ok(detectCandidates(ws, { fillerDictionary: { preserve: ['um'], remove: [] } }).every((c) => texts(ws, c.wordIds) !== 'um,'));
});

test('retakes across takes: an abandoned attempt in take 1 that take 2 says in full is a high false_start', () => {
  const t1 = words('The secret to fast builds is, um, the secret is, uh, hmm, let me start again.', 'take_1', 0, 'a');
  const t2 = words('The secret to fast builds is caching every step. I like this approach.', 'take_2', 0, 'b');
  const r = detectRetakes([...t1, ...t2]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0]!.kind, r[0]!.confidenceTier, r[0]!.assetId], ['false_start', 'high', 'take_1']);
  assert.deepEqual([r[0]!.sourceStartUs, r[0]!.sourceEndUs], [t1[0]!.sourceStartUs, t1.at(-1)!.sourceEndUs]);
  // Unfinished prefix (take ends mid-sentence) also counts; a complete different ending is only a review.
  assert.equal(detectRetakes([...words('The secret to fast builds', 'take_1', 0, 'a'), ...t2])[0]!.confidenceTier, 'high');
  const diverge = detectRetakes([...words('The secret to fast builds is luck.', 'take_1', 0, 'a'), ...t2]);
  assert.deepEqual([diverge[0]!.kind, diverge[0]!.confidenceTier], ['retake', 'medium']);
  // ASR heard "to" as "2" in one take.
  const homophone = words('The Secret 2 Fast Builds is, um, let me start again.', 'take_1', 0, 'a');
  assert.equal(detectRetakes([...homophone, ...t2])[0]!.confidenceTier, 'high');
});

test('retakes across takes: identical sentences, short overlaps and later-to-earlier matches are not retakes', () => {
  const t2 = words('The secret to fast builds is caching every step.', 'take_2', 0, 'b');
  assert.deepEqual(detectRetakes([...words('The secret to fast builds is caching every step.', 'take_1', 0, 'a'), ...t2]), []);
  assert.deepEqual(detectRetakes([...words('The secret is, let me start again.', 'take_1', 0, 'a'), ...t2]), [], 'only 2 shared words');
  // Take order is story order: a complete earlier take is never removed for a later partial one.
  const reversed = detectRetakes([...t2, ...words('The secret to fast builds', 'take_1', 0, 'a')]);
  assert.ok(reversed.every((c) => c.confidenceTier !== 'high'), 'at most a review');
});

test('silences: a purposeful pause before a punchline is a review, a pause between sentences is cut', () => {
  for (const s of ['And the answer is... [1200] nothing. Thanks.', 'And the answer is [1200] nothing. Thanks.', 'And the answer is [1200] absolutely nothing.', 'And the answer is? [1000] Nothing. Thanks.']) {
    const ws = words(s);
    const p = detectSilences(ws).find((c) => c.evidence.startsWith('pause'))!;
    assert.equal(p.confidenceTier, 'medium', s);
    assert.match(p.evidence, /purposeful/);
  }
  for (const s of ['So what does it cost? [1200] And the answer is nothing.', 'We store every [1200] result by its hash.']) {
    assert.equal(detectSilences(words(s)).find((c) => c.evidence.startsWith('pause'))!.confidenceTier, 'high', s);
  }
});
