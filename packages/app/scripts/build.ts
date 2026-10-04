// Builds the desktop app into dist/: main (ESM) and preload (CJS, required by sandboxed preloads) with
// esbuild, the React renderer with Vite. @takeoff/* stay external: Electron's Node runs their TS sources
// through type stripping, so the engine's import.meta.url-relative files (prompts, worker dir) still resolve.
import { build } from 'esbuild';
import { build as vite } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('..', import.meta.url));
const dist = `${app}dist`;

await build({ entryPoints: [`${app}src/main/main.ts`], outfile: `${dist}/main.js`, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'warning' });
await build({ entryPoints: [`${app}src/preload/preload.ts`], outfile: `${dist}/preload.cjs`, bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'warning' });
await vite({
  configFile: false,
  root: `${app}src/renderer`,
  base: './',
  logLevel: 'warn',
  plugins: [react()],
  // Fonts and icons ship as files under font-src/img-src 'self'; nothing is inlined as data: or fetched.
  build: { outDir: `${dist}/renderer`, emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
});
