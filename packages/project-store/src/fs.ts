import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolve a project-relative path under `root`, rejecting absolute paths, `..`
 * segments, backslashes and symlinks (anywhere in the existing prefix) that
 * escape the root. The target itself need not exist yet.
 */
export function resolveUnderRoot(root: string, rel: string): string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\') || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error('path must be a non-empty project-relative path');
  }
  if (rel.split('/').includes('..')) throw new Error('path must not contain ".." segments');
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, rel);
  // Walk up to the deepest existing entry (lstat: a dangling symlink counts as existing);
  // its realpath exposes any symlink escape, and a dangling link fails realpath.
  let probe = target;
  while (!lstatSync(probe, { throwIfNoEntry: false })) probe = dirname(probe);
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    throw new Error('path escapes the project root');
  }
  const back = relative(realRoot, realProbe);
  if (back === '..' || back.startsWith('..' + sep) || isAbsolute(back)) throw new Error('path escapes the project root');
  return resolve(realProbe, relative(probe, target));
}

/** Write via `<path>.<random>.partial` + fsync + rename, then fsync the directory. Readers never see a torn file. */
export function atomicWrite(path: string, data: string | Uint8Array): void {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.partial`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const dfd = openSync(dirname(path), 'r');
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}
