import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateLibraryAudio, LIBRARY_LICENSE } from '../src/index.ts';
import { ffprobeJson, tempDir } from './helpers.ts';

test('library audio is deterministic, licensed, 48 kHz stereo WAV with 2-3 beds of 30-60 s and the three SFX categories', async () => {
  const [a, b] = [await tempDir(), await tempDir()];
  const m1 = await generateLibraryAudio(a);
  const m2 = await generateLibraryAudio(b);
  assert.deepEqual(m1, m2);
  assert.deepEqual(JSON.parse(await readFile(join(a, 'library.json'), 'utf8')), m1);
  const music = m1.items.filter((i) => i.kind === 'music');
  assert.ok(music.length >= 2 && music.length <= 3);
  assert.deepEqual(m1.items.filter((i) => i.kind === 'sfx').map((i) => i.category).sort(), ['hit', 'ui_click', 'whoosh']);
  for (const it of m1.items) {
    assert.equal(it.license, LIBRARY_LICENSE);
    const s = (ffprobeJson(join(a, it.file), '-show_entries', 'stream=sample_rate,channels,codec_name:format=duration') as { streams: Array<{ sample_rate: string; channels: number; codec_name: string }>; format: { duration: string } });
    assert.deepEqual([s.streams[0]!.sample_rate, s.streams[0]!.channels, s.streams[0]!.codec_name], ['48000', 2, 'pcm_s16le']);
    const sec = Number(s.format.duration);
    assert.ok(Math.abs(sec * 1e6 - it.durationUs) < 2000, `${it.id} ${sec}`);
    if (it.kind === 'music') assert.ok(sec >= 30 && sec <= 60, it.id);
  }
});
