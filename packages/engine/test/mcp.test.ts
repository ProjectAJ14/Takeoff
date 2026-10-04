import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmp } from './helpers.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');
const TOOL_NAMES = ['inspect_project', 'import_assets', 'transcribe', 'propose_edit', 'validate_plan', 'apply_patch', 'render_draft', 'inspect_frames', 'run_qa', 'export_project'];

test('MCP stdio: initialize, tools/list with exactly the PRD tools, validate_plan, and authorization/revision rules', async () => {
  const { dir, cleanup } = await tmp('takeoff-mcp-');
  const child = spawn(process.execPath, [join(REPO, 'packages/engine/bin/takeoff.js'), 'mcp', '--root', dir], {
    env: { ...process.env, TAKEOFF_APP_DATA: join(dir, 'appdata') },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map<number, (m: any) => void>();
  const stray: string[] = [];
  createInterface({ input: child.stdout! }).on('line', (l) => {
    const m = JSON.parse(l); // every stdout line must be JSON-RPC
    assert.equal(m.jsonrpc, '2.0');
    const w = waiting.get(m.id);
    if (w) w(m);
    else stray.push(l);
  });
  let n = 0;
  const rpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const tool = async (name: string, args: unknown) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { isError: r.result.isError, data: JSON.parse(r.result.content[0].text) };
  };
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.ok(init.result.capabilities.tools);
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const list = await rpc('tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, TOOL_NAMES);
    assert.ok(!names.some((x: string) => /shell|exec/.test(x)), 'no shell tool');
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

    const plan = JSON.parse(readFileSync(join(REPO, 'docs/example-edit-plan.json'), 'utf8'));
    const v = await tool('validate_plan', { plan });
    assert.equal(v.isError, false);
    assert.equal(v.data.ok, true, JSON.stringify(v.data));
    assert.equal(v.data.semantic, 'skipped');
    const bad = await tool('validate_plan', { plan: { ...plan, segments: 'nope' } });
    assert.equal(bad.data.ok, false);

    const shell = await rpc('tools/call', { name: 'run_shell', arguments: { cmd: 'ls' } });
    assert.ok(shell.error, 'run_shell is not a tool');
    for (const name of ['constructor', 'toString', '__proto__']) assert.equal((await rpc('tools/call', { name, arguments: {} })).error?.code, -32602, name);
    const noBase = await tool('apply_patch', { project: dir, patch: { schemaVersion: '1.0', ops: [] } });
    assert.equal(noBase.isError, true);
    assert.equal(noBase.data.code, 'invalid_arguments');
    const outside = await tool('inspect_project', { project: '/etc' });
    assert.equal(outside.isError, true);
    assert.equal(outside.data.code, 'path_not_approved');
    assert.deepEqual(Object.keys(outside.data).sort(), ['code', 'message', 'remedy']);
    assert.equal((await rpc('nope/method')).error.code, -32601);
    assert.deepEqual(stray, []);
  } finally {
    child.stdin!.end();
    await new Promise((r) => child.once('exit', r));
    await cleanup();
  }
});
