// PRD §18 privacy gate: a network-denial trace of the whole local route, in process.
//
// Every way this process can open a connection is wrapped and any non-loopback destination is
// recorded: net.Socket#connect (which fetch/undici, http, https and tls all reach), tls.connect,
// dns.lookup (callback and promise), http/https.request and globalThis.fetch. The route runs with
// the real browser renderer, real FFmpeg, QA and a final export, in `local_only`.
//
// Not covered here, by design: subprocesses. FFmpeg gets only local paths. Chromium runs with
// Playwright's --disable-background-networking in an `offline` context, and the renderer's own
// request audit is asserted below (QA `undeclared_network`). The transcribe worker is faked here;
// the real worker sets HF_HUB_OFFLINE=1 itself and its suite
// (workers/transcribe/tests, "transcribe opens no connection") patches socket.connect and
// getaddrinfo to prove it, so that half of the trace lives in Python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadBrowserRenderer, type KeyLookup } from '../src/index.ts';
import { fixture, pipeline } from './helpers.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '::ffff:127.0.0.1']);
const isLocal = (host: unknown) => host === undefined || host === null || host === '' || LOOPBACK.has(String(host)) || /^127\./.test(String(host));

/** Installs the guard; returns the recorded non-loopback attempts and a restore function. */
function egressGuard(): { attempts: string[]; restore: () => void } {
  const attempts: string[] = [];
  const note = (via: string, host: unknown) => void (isLocal(host) || attempts.push(`${via}:${String(host)}`));
  const hostOf = (args: unknown[]): unknown => {
    let a = args[0];
    if (Array.isArray(a)) a = a[0]; // net.connect passes its normalised [options, cb]
    if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return args[1] ?? 'localhost';
    if (typeof a === 'string') return undefined; // IPC path
    const o = (a ?? {}) as { host?: string; hostname?: string; path?: string };
    return o.path && !o.host ? undefined : (o.host ?? o.hostname ?? 'localhost');
  };
  const urlHost = (u: unknown) => {
    try {
      return new URL(u instanceof Request ? u.url : String(u)).hostname;
    } catch {
      return String(u);
    }
  };
  const saved: Array<[object, string, unknown]> = [];
  const wrap = <T extends object>(obj: T, key: keyof T & string, host: (args: unknown[]) => unknown) => {
    const orig = obj[key] as (...a: unknown[]) => unknown;
    saved.push([obj, key, orig]);
    (obj as Record<string, unknown>)[key] = function (this: unknown, ...args: unknown[]) {
      note(key, host(args));
      return orig.apply(this, args);
    };
  };
  wrap(net.Socket.prototype, 'connect', hostOf);
  wrap(tls, 'connect', hostOf);
  wrap(dns, 'lookup', (a) => a[0]);
  wrap(dns.promises, 'lookup', (a) => a[0]);
  for (const m of [http, https]) {
    wrap(m, 'request', (a) => (typeof a[0] === 'string' || a[0] instanceof URL ? urlHost(a[0]) : hostOf(a)));
    wrap(m, 'get', (a) => (typeof a[0] === 'string' || a[0] instanceof URL ? urlHost(a[0]) : hostOf(a)));
  }
  wrap(globalThis, 'fetch', (a) => urlHost(a[0]));
  return { attempts, restore: () => saved.reverse().forEach(([o, k, f]) => ((o as Record<string, unknown>)[k] = f)) };
}

test('guard sees a non-loopback attempt and ignores loopback (the trace can fail)', async () => {
  const g = egressGuard();
  try {
    await fetch('http://192.0.2.1:9/', { signal: AbortSignal.timeout(50) }).catch(() => undefined);
    await new Promise((r) => net.connect(9, '127.0.0.1').on('error', r).on('connect', r));
    await new Promise((r) => dns.lookup('example.invalid', r));
  } finally {
    g.restore();
  }
  assert.ok(g.attempts.includes('fetch:192.0.2.1'), JSON.stringify(g.attempts));
  assert.ok(g.attempts.includes('lookup:example.invalid'), JSON.stringify(g.attempts));
  assert.ok(!g.attempts.some((x) => x.includes('127.0.0.1')));
});

const rendererSrc = pathToFileURL(join(import.meta.dirname, '..', '..', 'renderer-browser', 'src', 'index.ts')).href;

test('local route (import → pipeline with the real renderer → final export) makes zero non-loopback attempts', { timeout: 300_000 }, async () => {
  const fx = await fixture({ engine: { loadRenderer: () => loadBrowserRenderer(rendererSrc) } });
  // The overlay's Chromium must run with its OS sandbox (renderer-browser overlay.ts).
  const launch = chromium.launch;
  const launches: Array<boolean | undefined> = [];
  chromium.launch = (o) => (launches.push(o?.chromiumSandbox), launch.call(chromium, o));
  const g = egressGuard();
  try {
    const r = await pipeline(fx, 'egress-local');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.equal(r.qa?.checks.find((c) => c.name === 'undeclared_network')?.status, 'passed', 'renderer audited its own requests');
    const dest = join(fx.root, '..', 'dest');
    await mkdir(dest);
    const x = await fx.engine.exportProject({ profile: 'final_1080', destinationDir: dest, burnCaptions: true, idempotencyKey: 'egress-export' });
    assert.equal(x.job.state, 'succeeded', JSON.stringify(x.error));
  } finally {
    g.restore();
    chromium.launch = launch;
    await fx.cleanup();
  }
  assert.deepEqual(g.attempts, []);
  assert.ok(launches.length > 0 && launches.every((s) => s === true), `chromiumSandbox per launch: ${JSON.stringify(launches)}`);
});

test('local_only: the external director is refused by the broker before any key lookup or connection', async () => {
  let keyLookups = 0;
  const getKey: KeyLookup = async () => (keyLookups++, 'unused');
  // No fetch override: the broker would use the real (guarded) globalThis.fetch.
  const fx = await fixture({ engine: { getKey, director: { kind: 'external', provider: 'anthropic', model: 'claude-x' } } });
  const g = egressGuard();
  try {
    const r = await pipeline(fx, 'egress-external');
    assert.equal(r.job.state, 'succeeded', JSON.stringify(r.error));
    assert.equal(fx.engine.getPlan()!.plan.provenance.director, 'rules', 'fell back to rules');
    assert.equal(fx.engine.store.listEvents('provider_receipt').length, 0);
    await assert.rejects(fx.engine.broker.send('anthropic', 'transcript', 'edit plan proposal', { text: 'x' }), { code: 'egress_denied' });
  } finally {
    g.restore();
    await fx.cleanup();
  }
  assert.equal(keyLookups, 0);
  assert.deepEqual(g.attempts, []);
});
