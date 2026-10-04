// F17 brand library (app level, under appDataDir) and brand files (fonts, logos) addressed by SHA-256.
// Versions are immutable: saving a profile always writes a new version; nothing rewrites an old one.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { validate, type BrandProfile } from '@takeoff/contracts';
import { atomicWrite } from '@takeoff/project-store';
import { EngineError } from './errors.ts';

export type BrandFileKind = 'font' | 'logo';
const MAX_BRAND_FILE = 10 * 1024 * 1024;
const EXT: Record<BrandFileKind, string[]> = { font: ['.woff2', '.woff', '.ttf', '.otf'], logo: ['.png', '.jpg', '.jpeg'] };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Brand file ids are `bf_<sha256>`; the id is the content address, so a file can never change under it. */
export const BRAND_FILE = /^bf_([0-9a-f]{64})$/;
/** Plan reference to one stored brand version. */
export const BRAND_REF = /^brands\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})@([1-9][0-9]{0,8})$/;
export const brandRef = (b: { id: string; version: number }) => `brands/${b.id}@${b.version}`;

const invalid = (m: string) => new EngineError('invalid_brand', m, 'Fix the brand profile and save again.');

/** Magic bytes, so a renamed file of another type is refused. */
function sniff(body: Buffer, kind: BrandFileKind): boolean {
  const head = body.subarray(0, 4).toString('latin1');
  if (kind === 'logo') return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) || (body[0] === 0xff && body[1] === 0xd8);
  return head === 'wOF2' || head === 'wOFF' || head === 'OTTO' || head === 'true' || body.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]));
}

/** Copies an approved font or logo file into `<dir>/files/<sha256><ext>`; returns its brand file id. */
export function importBrandFile(dir: string, realPath: string, kind: BrandFileKind): { assetId: string; sha256: string } {
  const ext = extname(realPath).toLowerCase();
  if (!EXT[kind].includes(ext)) throw invalid(`a ${kind} must be ${EXT[kind].join(', ')}`);
  const st = statSync(realPath, { throwIfNoEntry: false });
  if (!st?.isFile() || st.size > MAX_BRAND_FILE) throw invalid(`the ${kind} file is missing or larger than 10 MB`);
  const body = readFileSync(realPath);
  if (!sniff(body, kind)) throw invalid(`the file is not a ${kind === 'font' ? 'font' : 'PNG or JPEG image'}`);
  const sha256 = createHash('sha256').update(body).digest('hex');
  mkdirSync(join(dir, 'files'), { recursive: true });
  const dest = join(dir, 'files', `${sha256}${ext === '.jpeg' ? '.jpg' : ext}`);
  if (!existsSync(dest)) atomicWrite(dest, body);
  return { assetId: `bf_${sha256}`, sha256 };
}

/** Absolute path of a brand file under `<dir>/files`, verified against its id's hash; null when missing or altered. */
export function brandFilePath(dir: string, id: string): string | null {
  const m = BRAND_FILE.exec(id);
  if (!m) return null;
  const files = join(dir, 'files');
  const name = existsSync(files) ? readdirSync(files).find((f) => f.startsWith(m[1]!) && /^[0-9a-f]{64}\.[a-z0-9]+$/.test(f)) : undefined;
  if (!name) return null;
  const p = join(files, name);
  return createHash('sha256').update(readFileSync(p)).digest('hex') === m[1] ? p : null;
}

/** Every brand file id a profile references. */
export const brandFileIds = (b: BrandProfile) => [...b.fonts.map((f) => f.assetId), ...b.logos.map((l) => l.assetId)].filter((x): x is string => !!x);

/** Copies a profile's files from one brand directory to another (library → project). Missing files are an error. */
export function copyBrandFiles(b: BrandProfile, fromDir: string, toDir: string): void {
  for (const id of brandFileIds(b)) {
    if (brandFilePath(toDir, id)) continue;
    const src = brandFilePath(fromDir, id);
    if (!src) throw new EngineError('brand_file_missing', 'a font or logo of this brand is missing', 'Pick the file again in the brand editor.');
    mkdirSync(join(toDir, 'files'), { recursive: true });
    copyFileSync(src, join(toDir, 'files', src.slice(src.lastIndexOf('/') + 1)));
  }
}

export function checkBrand(profile: unknown): BrandProfile {
  const v = validate('brand-profile', profile);
  if (!v.ok) throw new EngineError('invalid_brand', `the brand profile does not match the schema (${v.errors.slice(0, 3).map((e) => e.path || '/').join(', ')})`, 'Fix the highlighted fields and save again.');
  for (const id of brandFileIds(v.value)) if (!BRAND_FILE.test(id)) throw invalid('font and logo ids must come from a picked file');
  return v.value;
}

// ---------- app-level library: <appDataDir>/brands/<id>/v<n>.json ----------

export const libraryDir = (appDataDir: string) => join(appDataDir, 'brands');

function versions(appDataDir: string, id: string): number[] {
  const d = join(libraryDir(appDataDir), id);
  return existsSync(d) ? readdirSync(d).map((f) => /^v(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : [];
}

/** Saves `profile` as the next version of its id (the caller's version is ignored); its files must be in the library. */
export function saveLibraryBrand(appDataDir: string, profile: unknown): BrandProfile {
  const p = profile as BrandProfile;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID.test(p.id) || p.id.startsWith('bf_') || p.id === 'files') throw invalid('the brand id is invalid');
  const b = checkBrand({ ...p, version: (versions(appDataDir, p.id).at(-1) ?? 0) + 1 });
  for (const id of brandFileIds(b)) if (!brandFilePath(libraryDir(appDataDir), id)) throw new EngineError('brand_file_missing', 'a font or logo of this brand is missing', 'Pick the file again.');
  const file = join(libraryDir(appDataDir), b.id, `v${b.version}.json`);
  mkdirSync(join(libraryDir(appDataDir), b.id), { recursive: true });
  if (existsSync(file)) throw new EngineError('brand_version_exists', 'that brand version already exists', 'Save again.');
  atomicWrite(file, JSON.stringify(b, null, 2));
  return b;
}

export function getLibraryBrand(appDataDir: string, id: string, version?: number): BrandProfile | undefined {
  if (!ID.test(id)) return undefined;
  const v = version ?? versions(appDataDir, id).at(-1);
  if (!v) return undefined;
  try {
    return checkBrand(JSON.parse(readFileSync(join(libraryDir(appDataDir), id, `v${v}.json`), 'utf8')));
  } catch {
    return undefined;
  }
}

/** Latest version of each library brand. */
export function listLibraryBrands(appDataDir: string): BrandProfile[] {
  const d = libraryDir(appDataDir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((x) => x !== 'files' && ID.test(x)).flatMap((id) => getLibraryBrand(appDataDir, id) ?? []);
}
