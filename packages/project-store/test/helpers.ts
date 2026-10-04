import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EditPlan } from '@takeoff/contracts';

export const tmp = () => mkdtempSync(join(tmpdir(), 'takeoff-store-'));
const fixtures = new URL('../../contracts/fixtures/valid/', import.meta.url).pathname;
export const fixture = <T>(rel: string): T => JSON.parse(readFileSync(join(fixtures, rel), 'utf8'));
export function plan(projectId: string, marker: number): EditPlan {
  const p = fixture<EditPlan>('edit-plan/example-edit-plan.json');
  return { ...p, projectId, provenance: { ...p.provenance, seed: marker } };
}
