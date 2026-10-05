// Data handed to the sandboxed overlay page. Types only: shared by the Node side and the page runtime.
// Every string here is untrusted text; the page writes it through textContent only.
import type { CaptionPosition, CaptionTemplate, ComparisonListParams, KineticTextParams, Rational, RequestFlowParams } from '@takeoff/contracts';
import type { Rect } from '@takeoff/renderer-api';

export interface OverlayBrand {
  text: string;
  highlight: string;
  accent: string;
  background: string;
  /** Internal @font-face family names (never user strings). */
  captionFont: string;
  headingFont: string;
}

export interface CaptionSpec {
  id: string;
  startFrame: number;
  endFrame: number;
  template: CaptionTemplate;
  position: CaptionPosition;
  /** Words with caption-relative frame spans; null when caption text and word ids no longer line up (no per-word highlight). */
  words: Array<{ text: string; startFrame: number; endFrame: number; emphasis: boolean }> | null;
  text: string;
}

export type SceneSpec = { id: string; startFrame: number; endFrame: number } & (
  | { kind: 'hook_text'; params: { text: string } }
  | { kind: 'kinetic_text_v1'; params: KineticTextParams }
  | { kind: 'request_flow_v1'; params: RequestFlowParams }
  | { kind: 'comparison_list_v1'; params: ComparisonListParams }
);

export interface OverlaySpec {
  width: number;
  height: number;
  fps: Rational;
  seed: number;
  brand: OverlayBrand;
  /** Font loads the page must complete before the first seek, as CSS font shorthands. */
  fontLoads: string[];
  captions: CaptionSpec[];
  scenes: SceneSpec[];
}

export interface PageViolation {
  code: 'caption_overflow' | 'font_missing' | 'scene_text_overflow';
  ref: string;
  detail: string;
}

export interface SeekResult {
  /** Serialized DOM of the active layers: equal keys mean equal pixels. Empty when nothing is visible. */
  key: string;
  bounds: Array<{ id: string; kind: 'caption' | 'scene'; rect: Rect }>;
}
