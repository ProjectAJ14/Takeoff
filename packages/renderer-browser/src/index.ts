export { BrowserRenderer, RenderError, renderStill, RENDERER_ID, RENDERER_VERSION, type BrowserRenderArtifact, type BrowserRenderInput, type OverlayReport } from './render.ts';
export { openOverlay, buildOverlay, renderSize, sceneRuntime, sceneRuntimeHash, DEFAULT_PALETTE, type OverlaySession, type OverlayFrame, type OverlayViolation } from './overlay.ts';
export { zoomAt, cropFractions, type BrowserResolvedAsset } from './compose.ts';
export { generateLibraryAudio, LIBRARY_LICENSE, type LibraryItem, type LibraryManifest } from './library.ts';
export type * from './spec.ts';
