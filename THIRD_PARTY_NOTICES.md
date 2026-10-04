# Third-party notices and license inventory

This lists what this repository installs or uses, as recorded on 2026-10-05
from the installed packages. PRD §15 requires every dependency, model, font and
binary to be recorded before it ships.

The repository commits no third-party binaries, model weights or fonts. Nothing
is redistributed yet, because there is no app build or installer. Rendered
videos do embed third-party font glyphs and Takeoff's own generated audio; see
[Content embedded in renders](#content-embedded-in-renders). The
"Redistributed?" column says what would ship in a packaged app. A row marked
**verify** has a license that comes from upstream documentation rather than
from a file inspected here. Confirm those rows before release.

## npm: runtime dependencies (root `package.json` `dependencies`)

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| ajv | 8.20.0 | MIT | JSON Schema validation in `@takeoff/contracts` | Yes, in an app bundle | `node_modules/ajv/package.json`, `LICENSE` |
| fast-deep-equal | 3.1.3 | MIT | ajv dependency | Yes, with ajv | `node_modules/fast-deep-equal/package.json`, `LICENSE` |
| fast-uri | 3.1.8 | BSD-3-Clause | ajv dependency | Yes, with ajv | `node_modules/fast-uri/package.json`, `LICENSE` |
| json-schema-traverse | 1.0.0 | MIT | ajv dependency | Yes, with ajv | `node_modules/json-schema-traverse/package.json`, `LICENSE` |
| require-from-string | 2.0.2 | MIT | ajv dependency | Yes, with ajv | `node_modules/require-from-string/package.json`, `license` |
| react | 19.3.0 | MIT | UI (app not built yet) | Yes, when the app ships | `node_modules/react/package.json`, `LICENSE` |
| react-dom | 19.3.0 | MIT | UI (app not built yet) | Yes, when the app ships | `node_modules/react-dom/package.json`, `LICENSE` |
| scheduler | 0.28.0 | MIT | react-dom dependency | Yes, with react-dom | `node_modules/scheduler/package.json` |
| lucide-react | 1.52.0 | ISC | UI icons (app not built yet) | Yes, when the app ships | `node_modules/lucide-react/package.json`, `LICENSE` |
| @fontsource/inter | 5.3.0 | OFL-1.1 (font) | App chrome font, bundled locally with no CDN. Also the default caption and graphics face in rendered videos (Inter 600/800 woff2, served to the sandboxed overlay page by `@takeoff/renderer-browser`) | Yes, with OFL text | `package.json` `license`; `LICENSE` says "SIL Open Font License, Version 1.1" |
| @fontsource/archivo | 5.3.0 | OFL-1.1 (font) | App chrome font | Yes, with OFL text | Same as above |
| @fontsource/jetbrains-mono | 5.3.0 | OFL-1.1 (font) | App chrome monospace font | Yes, with OFL text | Same as above |

## npm: development dependencies (root `package.json` `devDependencies`)

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| typescript | 7.0.2 | Apache-2.0 | Type checking (`tsc --noEmit`) | No | `node_modules/typescript/package.json`, `LICENSE`, `NOTICE.txt` |
| @types/node | 26.6.4 | MIT | Types | No | `package.json`, `LICENSE` |
| undici-types | 8.9.0 | MIT | @types/node dependency | No | `package.json` |
| @types/react | 19.3.0 | MIT | Types | No | `package.json`, `LICENSE` |
| @types/react-dom | 19.3.0 | MIT | Types | No | `package.json`, `LICENSE` |
| csstype | 3.2.3 | MIT | @types/react dependency | No | `package.json` |
| vite | 8.3.2 | MIT | UI bundler (app not built yet) | No (build tool) | `node_modules/vite/package.json`, `LICENSE.md` |
| lightningcss (+ `lightningcss-darwin-arm64`) | 1.33.0 | MPL-2.0 | vite CSS transform | No (build tool). If it is ever shipped, MPL-2.0 file-level source terms apply | `node_modules/lightningcss/package.json` |
| source-map-js | 1.2.2 | BSD-3-Clause | vite dependency | No | `package.json` |
| @vitejs/plugin-react | 6.1.1 | MIT | vite React plugin | No | `package.json`, `LICENSE` |
| electron | 44.5.1 | MIT (npm wrapper and `dist/LICENSE`) | Desktop shell (app in progress). Its install script is allowed in root `package.json` `allowScripts` | Yes, when the app ships. The binary in `node_modules/electron/dist/` bundles Chromium, FFmpeg and other components listed in `dist/LICENSES.chromium.html`; **verify** those when packaging | `node_modules/electron/package.json`, `LICENSE`, `dist/LICENSE`, `dist/LICENSES.chromium.html` |
| @electron-internal/extract-zip | 1.0.5 | BSD-2-Clause | electron installer | No | `package.json` |
| esbuild (+ `@esbuild/darwin-arm64`) | 0.28.2 | MIT | Bundles the overlay scene runtime (`packages/renderer-browser/src/runtime.ts` plus the renderer-api scene kit) into an IIFE at render time with `buildSync`; a runtime dependency of `@takeoff/renderer-browser`. Built with `legalComments: 'none'`; the bundle contains only Takeoff code | Yes, if the renderer ships as is (it bundles at runtime) | `package.json`, `LICENSE.md`; `@esbuild/darwin-arm64/package.json` |
| playwright, playwright-core | 1.63.0 | Apache-2.0 | Drives the headless Chromium that renders overlays (`@takeoff/renderer-browser`); the engine's capability check calls `chromium.executablePath()` | Not yet decided. If shipped, include `NOTICE` and `ThirdPartyNotices.txt` | `package.json`, `LICENSE`, `NOTICE`, `ThirdPartyNotices.txt` |

Transitive npm packages in `node_modules`, summarised from each package's
`package.json`:

- 33 MIT
- 6 Apache-2.0
- 5 ISC
- 2 BSD-3-Clause (fast-uri, source-map-js)
- 1 BSD-2-Clause (@electron-internal/extract-zip)
- 2 MPL-2.0 (lightningcss and its darwin-arm64 binary)
- 3 OFL-1.1 (the fonts)

None is unlicensed. Re-run the summary when `package-lock.json` changes.

## Browser binaries (Playwright)

Downloaded by `npx playwright install chromium` into the user cache
(`~/Library/Caches/ms-playwright/`), not into the repo. None is redistributed.

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| Chrome Headless Shell (Chromium), Playwright revision 1243 | 153.0.8010.12 | BSD-3-Clause (Chromium), plus bundled third-party notices | Launched headless by the overlay renderer for every render | No | `node_modules/playwright-core/browsers.json`; `chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/LICENSE.headless_shell` |
| Chrome for Testing (Chromium), Playwright revision 1243 | 153.0.8010.12 | BSD-3-Clause (Chromium), plus bundled third-party notices (**verify**: notices not inspected here) | Not launched; the engine's capability check looks for this binary | No | `npx playwright install --dry-run chromium`; `chromium-1243/chrome-mac-arm64/` |
| Playwright FFmpeg, revision 1011 | 1011 | **verify** (an FFmpeg build; license not inspected here) | Installed by `npx playwright install chromium`; Takeoff does not use it (it spawns the system FFmpeg) | No | `npx playwright install --dry-run chromium-headless-shell`; `~/Library/Caches/ms-playwright/ffmpeg-1011` |

## System FFmpeg

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| FFmpeg / ffprobe (Homebrew, `/opt/homebrew/bin`) | 9.0.1 | **GPL** for this build: configured with `--enable-gpl --enable-version3 --enable-libx264 --enable-libx265`, so it is GPL-3.0-or-later as a whole | Spawned as an external process with argument arrays by `@takeoff/media`. Not linked | No. The repo doesn't ship FFmpeg, and users install their own. Shipping a build is a separate license decision (PRD §15) | `ffmpeg -version` configuration line |

## Python (`workers/transcribe`, from `uv.lock` and `.venv` dist-info `METADATA`)

Runtime: Python 3.12.13 (PSF-2.0), managed by uv 0.12.3. Neither is
redistributed.

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| faster-whisper | 1.2.1 | MIT | ASR and word timestamps | No (installed by `uv sync`) | `faster_whisper-1.2.1.dist-info/METADATA` |
| Silero VAD v6 (ONNX, bundled in faster-whisper) | `silero_vad_v6.onnx` | MIT (**verify**: `faster_whisper/vad.py` credits snakers4/silero-vad) | Speech intervals | No | `faster_whisper/assets/silero_vad_v6.onnx` |
| ctranslate2 | 4.8.2 | MIT | Inference engine | No | `METADATA` `License: MIT` |
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 | Audio arrays | No | `METADATA` `License-Expression` |
| onnxruntime | 1.30.0 | MIT | Runs the VAD | No | `METADATA` |
| av (PyAV) | 19.0.1 | BSD-3-Clause; bundled FFmpeg libraries report "LGPL version 3 or later", but the wheel also ships `libx264` and `libx265` dylibs (GPL) — **verify** | faster-whisper dependency. The worker doesn't use it: audio is read with stdlib `wave` | No | `av-19.0.1.dist-info/licenses/LICENSE.txt`; `av/.dylibs/` |
| huggingface-hub | 1.33.0 | Apache-2.0 | Locates cached models offline; downloads only for `download-model --allow-network` | No | `METADATA` |
| hf-xet | 1.6.0 | Apache-2.0 | huggingface-hub dependency | No | `METADATA` |
| tokenizers | 0.23.2 | Apache-2.0 (classifier) | Whisper tokenizer | No | `METADATA` classifier |
| flatbuffers | 25.12.19 | Apache-2.0 | onnxruntime dependency | No | `METADATA` |
| protobuf | 7.36.2 | BSD-3-Clause | onnxruntime dependency | No | `METADATA` |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause | Dependency | No | `METADATA` |
| pyyaml | 6.0.3 | MIT | Dependency | No | `METADATA` |
| tqdm | 4.70.1 | MPL-2.0 AND MIT | Progress bars inside dependencies | No | `METADATA` |
| certifi | 2026.7.22 | MPL-2.0 | CA bundle for huggingface-hub | No | `METADATA` |
| filelock | 4.0.10 | MIT | Dependency | No | `METADATA` |
| fsspec | 2026.9.0 | BSD-3-Clause | Dependency | No | `METADATA` |
| httpx | 0.28.1 | BSD-3-Clause | huggingface-hub HTTP | No | `METADATA` |
| httpcore | 1.0.9 | BSD-3-Clause | httpx dependency | No | `METADATA` |
| h11 | 0.16.0 | MIT | httpcore dependency | No | `METADATA` |
| anyio | 4.15.1 | MIT | httpx dependency | No | `METADATA` |
| idna | 3.20 | BSD-3-Clause | httpx dependency | No | `METADATA` |
| click | 8.5.0 | BSD-3-Clause | Dependency | No | `METADATA` |
| typing-extensions | 4.16.0 | PSF-2.0 | Dependency | No | `METADATA` |
| colorama | 0.4.6 | BSD-3-Clause (**verify**: not installed here, Windows-only marker) | tqdm/click on Windows | No | `uv.lock` (`sys_platform == 'win32'`) |

## Models

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| Systran faster-whisper weights (`tiny`, `base`, `small`, `large-v3` cached locally) | Hugging Face snapshot | MIT (**verify**: per the Systran model cards and OpenAI Whisper weights; no license file in the cached snapshot) | ASR. Loaded with `local_files_only=True`. Default `--model base`; tests use `tiny` | No. Weights live in the user's Hugging Face cache and are fetched only by `download-model --allow-network` | `~/.cache/huggingface/hub/models--Systran--faster-whisper-*` (contents: `config.json`, `model.bin`, `tokenizer.json`, `vocabulary.*`) |

## Content embedded in renders

| Component | Version | License | How used | Redistributed? | Evidence |
|---|---|---|---|---|---|
| Takeoff generated music and SFX library (`bed_calm`, `bed_pulse`, `bed_bright`, `sfx_ui_click`, `sfx_hit`, `sfx_whoosh`) | `library.json` version 1 | Takeoff original, generated (`LIBRARY_LICENSE`). Synthesised by `generateLibraryAudio` from fixed FFmpeg `lavfi` recipes (`sine`, seeded `anoisesrc`); no third-party recording is sampled | Music beds and sound effects mixed into exports when F09/F10 are on | Generated on the user's machine by the starter pack into `<app data>/library`; not committed. Exports that use it contain it | `packages/renderer-browser/src/library.ts` |
| Inter (via @fontsource/inter) | 5.3.0 | OFL-1.1 | Default caption, hook and motion-graphics face; glyphs are rasterised into rendered frames | Rendered pixels only; OFL-1.1 places no restriction on output documents | `node_modules/@fontsource/inter/LICENSE` |
| Inter 400/700, Archivo 700, JetBrains Mono 400 (@fontsource) | 5.3.0 | OFL-1.1 | Passed to the renderer as pinned fonts (`bundledFonts`); used only when a brand profile names one of these families | Same as above | `packages/engine/src/engine.ts` `bundledFonts` |

## Not yet used

Remotion and GSAP are not installed. Per PRD §7.1 and §15 they stay optional
until their licenses are cleared.
