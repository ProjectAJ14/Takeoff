import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Capabilities, EditPlan, Job } from '@takeoff/contracts';
import {
  TOGGLES, announceDelay, availability, creatorPolish, defaultEdits, editBlocker, effectiveSettings, foldJob, lengthPolicy, move, parseTarget,
  sourceCutAt, summarize, summaryLine, timelineClips, transcriptItems,
} from '../src/renderer/logic.ts';
import { POOLS, allowedRequest, csp, isMediaPath, isPool, testHooksEnabled } from '../src/main/policy.ts';

const caps = (over: Record<string, Capabilities['features'][number]['status']> = {}): Capabilities => ({
  schemaVersion: '1.0', appVersion: '0.1.0', networkPolicy: 'local_only', models: [], devices: [], codecs: { decode: [], encode: [] }, providers: [],
  features: (['F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15', 'F16', 'F17'] as const).map((id) => ({ id, status: over[id] ?? 'available', reason: over[id] ? `reason ${id}` : null })),
});

test('toggle names and PRD 5.2 defaults', () => {
  assert.deepEqual(TOGGLES.map((t) => t.name), ['Bad takes', 'Fillers', 'Silence/dead air', 'Animated captions', 'AI-found B-roll', 'Own B-roll', 'Zooms', 'Background music', 'Sound effects', 'Studio voice', 'Auto color', 'Text hook', 'Motion graphics']);
  const s = defaultEdits().settings;
  for (const k of ['badTakes', 'fillers', 'silence', 'captions', 'zoom', 'studioVoice', 'autoColor'] as const) assert.equal(s[k], true, k);
  for (const k of ['aiBroll', 'userBroll', 'music', 'sfx', 'textHook', 'motionGraphics'] as const) assert.equal(s[k], false, k);
  assert.equal(s.networkPolicy, 'local_only');
  const p = creatorPolish(defaultEdits()).settings;
  assert.ok(p.music && p.sfx && p.motionGraphics && !p.textHook && p.badTakes);
});

test('unavailable toggles are shown with a reason and sent as off', () => {
  const c = caps({ F09: 'unavailable', F08: 'experimental' });
  const byKey = (k: string) => TOGGLES.find((t) => t.key === k)!;
  assert.equal(availability(byKey('aiBroll'), c).status, 'unavailable', 'P1 is unavailable whatever the machine reports');
  assert.deepEqual(availability(byKey('music'), c), { status: 'unavailable', reason: 'reason F09' });
  assert.equal(availability(byKey('zoom'), c).status, 'experimental');
  const eff = effectiveSettings({ ...defaultEdits().settings, music: true, aiBroll: true }, c);
  assert.equal(eff.music, false);
  assert.equal(eff.aiBroll, false);
  assert.equal(eff.zoom, true);
});

test('target length options, custom bounds and length policy', () => {
  assert.deepEqual(parseTarget('auto', ''), { seconds: null, error: null });
  assert.deepEqual(parseTarget('45', ''), { seconds: 45, error: null });
  for (const bad of ['', '9', '181', '30.5', 'x']) assert.ok(parseTarget('custom', bad).error, bad);
  assert.deepEqual(parseTarget('custom', ' 10 '), { seconds: 10, error: null });
  assert.equal(parseTarget('custom', '180').seconds, 180);
  assert.equal(lengthPolicy(null, true), 'none');
  assert.equal(lengthPolicy(30, true), 'hard_max');
  assert.equal(lengthPolicy(30, false), 'soft_target');
});

test('Edit Video is blocked only for a concrete issue, with a remedy', () => {
  const ok = { projectFolder: '/p', selectedTakes: 1, importing: false, targetError: null, caps: caps() };
  assert.equal(editBlocker(ok), null);
  assert.match(editBlocker({ ...ok, caps: null })!, /Checking/);
  assert.match(editBlocker({ ...ok, caps: caps({ F02: 'unavailable' }) })!, /starter pack/);
  assert.match(editBlocker({ ...ok, caps: caps({ F01: 'unavailable' }) })!, /FFmpeg/);
  assert.match(editBlocker({ ...ok, projectFolder: null })!, /project folder/);
  assert.match(editBlocker({ ...ok, selectedTakes: 0 })!, /take/);
  assert.match(editBlocker({ ...ok, importing: true })!, /import/);
  assert.equal(editBlocker({ ...ok, targetError: 'Enter seconds' }), 'Enter seconds');
  assert.equal(editBlocker({ ...ok, caps: caps({ F09: 'unavailable' }) }), null, 'an optional feature never blocks');
});

test('take order moves stay in bounds', () => {
  assert.deepEqual(move(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(move(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(move(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(move(['a', 'b'], 1, 1), ['a', 'b']);
});

test('stage views: honest progress, done/failed states, throttled announcements', () => {
  const job = (stage: Job['stage'], state: Job['state'], progress: number | null): Job => ({ schemaVersion: '1.0', id: 'j', projectId: 'p', stage, profile: 'draft', state, progress, baseRevision: 0, idempotencyKey: 'k', attempts: 1, createdAt: '', updatedAt: '', error: null, artifacts: [] });
  let v = foldJob(null, job('Transcribe', 'running', null), 1000);
  assert.deepEqual(v.map((x) => x.state), ['done', 'running', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(v[1]!.progress, null, 'no invented percentage');
  v = foldJob(v, job('Transcribe', 'running', 0.4), 2000);
  assert.equal(v[1]!.progress, 0.4);
  assert.equal(v[1]!.startedAt, 1000, 'stage start kept');
  v = foldJob(v, job('Render preview', 'failed', null), 3000);
  assert.equal(v[5]!.state, 'failed');
  assert.equal(v[1]!.endedAt, 3000);
  assert.ok(foldJob(v, job('Check quality', 'succeeded', null), 4000).every((x) => x.state === 'done'));
  assert.equal(announceDelay(null, 0), 0);
  assert.equal(announceDelay(1000, 2000), 4000);
  assert.equal(announceDelay(1000, 7000), 0);
});

const W = (id: string, s: number, text = id, alignment: 'aligned' | 'estimated' = 'aligned') => ({ id, text, correctedText: null, sourceStartUs: s, sourceEndUs: s + 300_000, score: null, alignment, speaker: null });
const plan = {
  output: { fps: { num: 30, den: 1 } },
  segments: [
    { id: 'g1', assetId: 'a', sourceStartUs: 0, sourceEndUs: 1_000_000, wordIds: ['a.w1', 'a.w2'], locked: false },
    { id: 'g2', assetId: 'a', sourceStartUs: 2_000_000, sourceEndUs: 3_000_000, wordIds: ['a.w4'], locked: true },
  ],
  decisions: [
    { id: 'd1', assetId: 'a', action: 'remove', sourceStartUs: 1_000_000, sourceEndUs: 1_400_000, reason: 'filler: um', detector: 'rules.filler.v1' },
    { id: 'd2', assetId: 'a', action: 'remove', sourceStartUs: 1_500_000, sourceEndUs: 2_000_000, reason: 'silence: 0.5s', detector: 'rules.silence.v1' },
  ],
  captions: [{ id: 'c1', wordIds: ['a.w1', 'a.w2'], text: 'Hello there', locked: false }],
  visuals: [],
  audio: { music: null, sfx: [] },
  reviewMarkers: [{ id: 'm1', refs: ['g2'] }],
} as unknown as EditPlan;
const transcripts = [{ assetId: 'a', words: [W('a.w1', 0, 'Hello'), W('a.w2', 500_000, 'there', 'estimated'), W('a.w3', 1_000_000, 'um'), W('a.w4', 2_100_000, 'friend')] }];

test('transcript read-out: kept words, removed spans with reasons and restore spans, low confidence', () => {
  const items = transcriptItems(plan, transcripts);
  assert.deepEqual(items.map((i) => (i.kind === 'word' ? i.text : `[${i.words.join(' ')}|${i.reason}]`)), ['Hello', 'there', '[um|filler: um]', '[|silence: 0.5s]', 'friend']);
  const cut = items[2]!;
  assert.ok(cut.kind === 'removed' && cut.startUs === 1_000_000 && cut.endUs === 1_400_000);
  assert.ok(items[1]!.kind === 'word' && items[1]!.lowConfidence);
  // A restored silence (now inside a segment) is no longer listed.
  const restored = { ...plan, segments: [...plan.segments, { id: 'g3', assetId: 'a', sourceStartUs: 1_500_000, sourceEndUs: 2_000_000, wordIds: [], locked: false }] } as EditPlan;
  assert.equal(transcriptItems(restored, transcripts).filter((i) => i.kind === 'removed').length, 1);
  const s = summarize(plan);
  assert.equal(s.fillers, 1);
  assert.equal(s.silenceSeconds, 0.5);
  assert.equal(s.review, 1);
  assert.equal(summaryLine(s), 'Removed 1 filler · 0.5s of silence');
});

test('timeline geometry and word-safe cut points', () => {
  const g = timelineClips(plan, transcripts);
  assert.equal(g.total, 2);
  const seg2 = g.clips.find((c) => c.id === 'g2')!;
  assert.deepEqual([seg2.start, seg2.end, seg2.locked, seg2.uncertain], [1, 2, true, true]);
  const cap = g.clips.find((c) => c.id === 'c1')!;
  assert.deepEqual([cap.lane, cap.start, cap.end], ['captions', 0, 0.8]);
  // 0.6 s falls inside "there" (0.5–0.8 s): the cut moves to its nearer edge.
  assert.equal(sourceCutAt(plan, transcripts, 'g1', 0.6, 0), 500_000);
  assert.equal(sourceCutAt(plan, transcripts, 'g1', 0.45, 0), 450_000);
  assert.equal(sourceCutAt(plan, transcripts, 'g1', 1.5, 0), null, 'outside the segment');
});

test('shell policy: loopback-only requests, strict CSP, media token path, pools', () => {
  for (const u of ['app://takeoff/index.html', 'http://127.0.0.1:5000/v1/x', 'http://localhost:1/x', 'blob:app://takeoff/1', 'data:image/png;base64,AA']) assert.ok(allowedRequest(u), u);
  for (const u of ['https://fonts.googleapis.com/css', 'http://example.com/', 'https://127.0.0.1.evil.com/', 'app://other/x', 'file:///etc/passwd', 'ws://127.0.0.1:1/', 'not a url']) assert.ok(!allowedRequest(u), u);
  const c = csp(4321);
  assert.match(c, /connect-src http:\/\/127\.0\.0\.1:4321(;|$)/);
  assert.doesNotMatch(c, /unsafe-(inline|eval)/);
  assert.ok(isMediaPath(`/v1/projects/p1/media/${'a'.repeat(64)}`));
  assert.ok(!isMediaPath('/v1/projects/p1/plan'));
  assert.ok(isPool('takes') && isPool('broll') && !isPool('music') && !isPool('__proto__'));
});

test('test hooks never run in a packaged app', () => {
  assert.equal(testHooksEnabled(true, 'test', ['x', '--test']), false);
  assert.equal(testHooksEnabled(false, undefined, ['x']), false);
  assert.equal(testHooksEnabled(false, 'test', ['x']), true);
  assert.equal(testHooksEnabled(false, undefined, ['x', '--test']), true);
});

test('picker kinds: brand fonts and logos accept only their file types', () => {
  assert.ok(isPool('font') && isPool('logo') && !isPool('toString'));
  assert.deepEqual([...POOLS.font], ['woff2', 'woff', 'ttf', 'otf']);
  assert.deepEqual([...POOLS.logo], ['png', 'jpg', 'jpeg']);
});
