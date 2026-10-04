import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contractKinds, validate, type ContractKind } from '../src/index.ts';

const root = new URL('../fixtures/', import.meta.url).pathname;
const repoRoot = new URL('../../../', import.meta.url).pathname;
const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

for (const kind of contractKinds) {
  const valid = files(join(root, 'valid', kind));
  const invalid = files(join(root, 'invalid', kind));

  test(`${kind}: has valid and invalid fixtures`, () => {
    assert.ok(valid.length > 0, 'no valid fixture');
    assert.ok(invalid.length > 0, 'no invalid fixture');
  });
  for (const f of valid) {
    test(`${kind}: valid/${f} passes`, () => {
      const r = validate(kind, read(join(root, 'valid', kind, f)));
      assert.ok(r.ok, JSON.stringify(!r.ok && r.errors, null, 2));
    });
  }
  for (const f of invalid) {
    test(`${kind}: invalid/${f} fails`, () => {
      const r = validate(kind, read(join(root, 'invalid', kind, f)));
      assert.equal(r.ok, false);
      if (!r.ok) assert.ok(r.errors.length > 0 && r.errors.every((e) => typeof e.path === 'string' && e.message));
    });
  }
}

test('docs/example-edit-plan.json validates and matches its fixture copy', () => {
  const doc = read(join(repoRoot, 'docs/example-edit-plan.json'));
  assert.ok(validate('edit-plan', doc).ok);
  assert.deepEqual(read(join(root, 'valid/edit-plan/example-edit-plan.json')), doc);
});

test('every fixture directory names a known kind', () => {
  for (const side of ['valid', 'invalid']) {
    for (const dir of readdirSync(join(root, side))) assert.ok(contractKinds.includes(dir as ContractKind), `${side}/${dir}`);
  }
});

test('errors carry a JSON pointer path and name the extra property', () => {
  const r = validate('edit-plan', read(join(root, 'invalid/edit-plan/extra-property.json')));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.path === '' && e.message.includes('(extra)')));
  const t = validate('edit-plan', read(join(root, 'invalid/edit-plan/float-microseconds.json')));
  if (!t.ok) assert.ok(t.errors.some((e) => e.path === '/segments/0/sourceEndUs'));
});

test('unknown kind throws', () => {
  assert.throws(() => validate('nope' as ContractKind, {}), /unknown contract kind/);
});
