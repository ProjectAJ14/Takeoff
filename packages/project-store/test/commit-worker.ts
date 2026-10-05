// Worker for the multi-connection stale-revision test.
import { parentPort, workerData } from 'node:worker_threads';
import { openProject, StaleRevisionError } from '../src/index.ts';
import { plan } from './helpers.ts';

const { root, base, marker } = workerData as { root: string; base: number; marker: number };
const store = openProject(root);
try {
  store.commitPlan(plan(store.projectId, marker), base, 'agent');
  parentPort!.postMessage('ok');
} catch (e) {
  parentPort!.postMessage(e instanceof StaleRevisionError ? 'stale' : String(e));
} finally {
  store.close();
}
