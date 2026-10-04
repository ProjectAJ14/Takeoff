// Hand-written types mirroring src/schemas/*.schema.json. The schema is authoritative;
// change both together.
// Clocks: *Us = integer source microseconds, *Frame(s) = integer output frames,
// *Sample(s) = integer samples at 48 kHz. Intervals are half-open [start, end).

export type SchemaVersion = '1.0';
export type Id = string;
/** Project-relative portable path; never absolute, never contains `..`. */
export type RelPath = string;
/** Lowercase hex SHA-256. */
export type Sha256 = string;
/** UTC ISO-8601, e.g. 2026-10-05T12:00:00Z. */
export type Timestamp = string;
export type HexColor = string;

export interface Rational {
  num: number;
  den: number;
}

export type Severity = 'critical' | 'warning' | 'info';
export type ConfidenceTier = 'high' | 'medium' | 'low';
export type AssetKind = 'video' | 'audio' | 'image';
export type NetworkPolicy = 'local_only' | 'approved_providers';
export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'not_run';
export type JobStage =
  | 'Prepare'
  | 'Transcribe'
  | 'Clean speech'
  | 'Plan visuals/audio'
  | 'Build graphics'
  | 'Render preview'
  | 'Check quality'
  | 'Export';
export type JobState = 'queued' | 'running' | 'waiting_for_user' | 'succeeded' | 'failed' | 'canceled';
export type FeatureId =
  | 'F01' | 'F02' | 'F03' | 'F04' | 'F05' | 'F06' | 'F07' | 'F08' | 'F09'
  | 'F10' | 'F11' | 'F12' | 'F13' | 'F14' | 'F15' | 'F16' | 'F17';
export type ProviderDataType =
  | 'transcript' | 'frames' | 'audio' | 'video' | 'asset_query' | 'asset_download' | 'prompt' | 'brand_page';

export interface FrameSpan {
  startFrame: number;
  endFrame: number;
}
export interface ErrorInfo {
  code: string;
  message: string;
  remedy: string;
}
export interface Warning {
  code: string;
  message: string;
  refs: Id[];
}

// ---------- EditPlan (PRD 9.3) ----------

export type FillerStrength = 'conservative' | 'normal' | 'aggressive';
export interface HookSetting {
  autoSelect: boolean;
  text: string | null;
}
export interface Settings {
  badTakes: boolean;
  fillers: boolean;
  silence: boolean;
  captions: boolean;
  userBroll: boolean;
  aiBroll: boolean;
  zoom: boolean;
  music: boolean;
  sfx: boolean;
  studioVoice: boolean;
  autoColor: boolean;
  textHook: boolean;
  motionGraphics: boolean;
  networkPolicy: NetworkPolicy;
  fillerStrength?: FillerStrength;
  /** null = automatic length. */
  targetSeconds?: number | null;
  hook?: HookSetting;
}
export type BooleanSettingKey = {
  [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
}[keyof Settings];

export interface OutputSpec {
  width: number;
  height: number;
  fps: Rational;
  audioSampleRate: 48000;
  colorSpace: 'bt709';
  targetFrames: number | null;
  lengthPolicy: 'hard_max' | 'soft_target' | 'none';
}
export interface PlanAssetRef {
  id: Id;
  kind: AssetKind;
  manifestRef: RelPath;
}
export interface Decision {
  id: Id;
  assetId: Id;
  action: 'remove' | 'keep' | 'review';
  sourceStartUs: number;
  sourceEndUs: number;
  wordIds?: Id[];
  reason: string;
  evidenceIds: Id[];
  confidenceTier: ConfidenceTier;
  detector?: string;
  locked?: boolean;
}
export type CropPolicy = 'face_safe_vertical' | 'center' | 'manual';
export interface Segment {
  id: Id;
  assetId: Id;
  sourceStartUs: number;
  sourceEndUs: number;
  wordIds: Id[];
  speed: Rational;
  cropPolicy: CropPolicy;
  locked: boolean;
}
export type CaptionTemplate = 'restrained' | 'energetic' | 'static';
export type CaptionPosition = 'safe_face_aware' | 'safe_bottom' | 'safe_top';
export interface Caption {
  id: Id;
  segmentId: Id;
  wordIds: Id[];
  text: string;
  template: CaptionTemplate;
  emphasisWordIds: Id[];
  positionPolicy: CaptionPosition;
  locked: boolean;
}
export interface Anchor {
  wordId: Id;
  edge: 'start' | 'end';
  /** Signed delta in output frames, bounded ±900. */
  offsetFrames: number;
}
export type VisualFallback = 'omit' | 'presenter_only' | 'static_card';
interface VisualBase {
  id: Id;
  segmentId: Id;
  anchor: Anchor;
  durationFrames: number;
  evidenceIds: Id[];
  fallback: VisualFallback;
  locked: boolean;
}
export interface KineticTextParams {
  lines: string[];
}
export interface RequestFlowParams {
  containerLabel: string;
  internalNode: string;
  externalNode: string;
  edgeLabel: string;
}
export interface ComparisonListParams {
  title: string;
  items: string[];
}
export type MotionTemplateVisual = VisualBase & { kind: 'motion_template' } & (
    | { template: 'kinetic_text_v1'; params: KineticTextParams }
    | { template: 'request_flow_v1'; params: RequestFlowParams }
    | { template: 'comparison_list_v1'; params: ComparisonListParams }
  );
export type MotionTemplateId = MotionTemplateVisual['template'];
export interface BrollVisual extends VisualBase {
  kind: 'broll';
  assetId: Id;
  sourceStartUs: number;
  sourceEndUs: number;
  layout: 'full' | 'inset' | 'split';
}
export interface HookTextVisual extends VisualBase {
  kind: 'hook_text';
  text: string;
}
export type Visual = MotionTemplateVisual | BrollVisual | HookTextVisual;

export interface CropRect {
  /** Fractions of the source frame, 0..1. */
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PunchTransform {
  id: Id;
  segmentId: Id;
  anchor: Anchor;
  kind: 'punch';
  /** 1.0–1.25. */
  scale: number;
  centerPolicy: 'tracked_face' | 'center';
  transitionFrames: number;
  durationFrames?: number;
  locked: boolean;
}
export interface CropTransform {
  id: Id;
  segmentId: Id;
  kind: 'crop';
  rect: CropRect;
  locked: boolean;
}
export type Transform = PunchTransform | CropTransform;

export type SfxCategory = 'ui_click' | 'hit' | 'whoosh';
export interface MusicCue {
  assetId: Id;
  startFrame: number;
  durationFrames: number;
  gainDb: number;
  duckUnderDialogue: boolean;
  fadeInFrames: number;
  fadeOutFrames: number;
  locked?: boolean;
}
export interface SfxCue {
  id: Id;
  assetId: Id;
  anchor: Anchor;
  category: SfxCategory;
  gainDb: number;
  visualId?: Id;
  locked: boolean;
}
export interface AudioPlan {
  dialogue: { profile: 'studio_conservative' | 'studio_strong' | 'bypass'; seamFadeMs: number };
  music: MusicCue | null;
  sfx: SfxCue[];
  mixTarget: { integratedLufs: number; truePeakDbtp: number };
}
export type ReviewMarkerKind =
  | 'uncertain_retake'
  | 'meaning_risk'
  | 'alignment_uncertain'
  | 'duration_conflict'
  | 'low_confidence_crop'
  | 'visual_unavailable'
  | 'orphaned_anchor'
  | 'unsupported_claim';
export interface ReviewMarker {
  id: Id;
  kind: ReviewMarkerKind;
  severity: Severity;
  message: string;
  refs: Id[];
}
export interface PlanProvenance {
  director: string;
  seed: number;
  promptVersion: string | null;
}
export interface EditPlan {
  schemaVersion: SchemaVersion;
  projectId: Id;
  revision: number;
  output: OutputSpec;
  settings: Settings;
  assets: PlanAssetRef[];
  transcriptRef: RelPath | null;
  brandProfileRef: RelPath | null;
  styleProfileRef: RelPath | null;
  decisions: Decision[];
  segments: Segment[];
  captions: Caption[];
  visuals: Visual[];
  transforms: Transform[];
  audio: AudioPlan;
  reviewMarkers: ReviewMarker[];
  provenance: PlanProvenance;
}

// ---------- Patch ----------

interface Span {
  sourceStartUs: number;
  sourceEndUs: number;
}
export type SetSettingOp =
  | { op: 'set_setting'; key: BooleanSettingKey; value: boolean }
  | { op: 'set_setting'; key: 'networkPolicy'; value: NetworkPolicy }
  | { op: 'set_setting'; key: 'fillerStrength'; value: FillerStrength }
  | { op: 'set_setting'; key: 'targetSeconds'; value: number | null }
  | { op: 'set_setting'; key: 'hook'; value: HookSetting };
export type PatchOp =
  | ({ op: 'restore_span'; assetId: Id } & Span)
  | ({ op: 'remove_span'; assetId: Id; reason: string } & Span)
  | ({ op: 'replace_take'; segmentId: Id; assetId: Id; wordIds: Id[] } & Span)
  | {
      op: 'set_caption';
      captionId: Id;
      text?: string;
      wordIds?: Id[];
      emphasisWordIds?: Id[];
      template?: CaptionTemplate;
      positionPolicy?: CaptionPosition;
    }
  | { op: 'set_crop'; segmentId: Id; rect: CropRect }
  | { op: 'replace_asset'; targetId: Id; assetId: Id }
  | { op: 'set_gain'; targetId: Id; gainDb: number }
  | { op: 'lock_object'; objectId: Id }
  | { op: 'unlock_object'; objectId: Id }
  | SetSettingOp
  | { op: 'reorder_segment'; segmentId: Id; toIndex: number }
  | { op: 'split_segment'; segmentId: Id; atSourceUs: number; newSegmentId: Id }
  | ({ op: 'trim_segment'; segmentId: Id } & Span)
  | { op: 'remove_visual'; visualId: Id }
  | { op: 'set_hook'; text: string | null; evidenceIds: Id[] };
export type PatchOpName = PatchOp['op'];
export interface PlanPatch {
  schemaVersion: SchemaVersion;
  baseRevision: number;
  ops: PatchOp[];
}

// ---------- Transcript ----------

export type WordAlignment = 'aligned' | 'estimated' | 'failed';
export interface TranscriptWord {
  id: Id;
  /** Raw ASR text; never overwritten. */
  text: string;
  correctedText: string | null;
  sourceStartUs: number;
  sourceEndUs: number;
  /** Raw engine-specific score, not a calibrated probability. */
  score: number | null;
  alignment: WordAlignment;
  speaker: string | null;
}
export interface TranscriptSentence {
  id: Id;
  startWordId: Id;
  endWordId: Id;
  rawText: string;
  correctedText: string | null;
}
export interface Transcript {
  schemaVersion: SchemaVersion;
  assetId: Id;
  sourceHash: Sha256;
  backend: 'faster_whisper' | 'whisper' | 'whisperx' | 'whisper_cpp' | 'manual';
  model: string;
  version: string;
  configHash: Sha256;
  language: string;
  words: TranscriptWord[];
  sentences: TranscriptSentence[];
  provenance: { createdAt: Timestamp; glossaryHash: Sha256 | null; vad: string | null; alignment: string | null };
}

// ---------- AssetManifest ----------

export interface VideoStreamProbe {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  fpsNum: number | null;
  fpsDen: number | null;
  vfr: boolean;
  codec: string;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  pixFmt: string | null;
}
export interface AudioStreamProbe {
  sampleRate: number;
  channels: number;
  codec: string;
}
export interface AssetManifest {
  schemaVersion: SchemaVersion;
  id: Id;
  kind: AssetKind;
  contentHash: Sha256;
  relativePath: RelPath;
  probe: { durationUs: number | null; video: VideoStreamProbe | null; audio: AudioStreamProbe | null };
  derived: { proxy: Sha256 | null; analysisWav: Sha256 | null };
  rights: {
    origin: 'user' | 'bundled' | 'stock' | 'generated';
    license: string | null;
    attribution: string | null;
    sourceUrl: string | null;
  };
  provenance: { importedAt: Timestamp; importer: string };
  permissionScope: NetworkPolicy;
}

// ---------- CompiledTimeline ----------

export interface CompiledSegment {
  segmentId: Id;
  assetId: Id;
  sourceStartUs: number;
  sourceEndUs: number;
  outputStartFrame: number;
  outputEndFrame: number;
  outputStartSample: number;
  outputEndSample: number;
}
export interface CompiledCaption extends FrameSpan {
  captionId: Id;
  words: Array<FrameSpan & { wordId: Id }>;
}
export interface CompiledVisual extends FrameSpan {
  visualId: Id;
  kind: Visual['kind'];
}
export interface CompiledTransform extends FrameSpan {
  transformId: Id;
  kind: Transform['kind'];
}
export interface CompiledAudioEvent {
  id: Id;
  kind: 'dialogue' | 'music' | 'sfx';
  assetId: Id;
  startSample: number;
  endSample: number;
  gainDb: number;
}
export interface CompiledTimeline {
  schemaVersion: SchemaVersion;
  planHash: Sha256;
  compilerVersion: string;
  fps: Rational;
  width: number;
  height: number;
  totalFrames: number;
  sampleRate: 48000;
  totalSamples: number;
  segments: CompiledSegment[];
  captions: CompiledCaption[];
  visuals: CompiledVisual[];
  transforms: CompiledTransform[];
  audioEvents: CompiledAudioEvent[];
  warnings: Warning[];
}

// ---------- Brand and style ----------

export type HookTone = 'plain' | 'direct' | 'playful';
export type MotionIntensity = 'restrained' | 'normal' | 'energetic';
export interface BrandProfile {
  schemaVersion: SchemaVersion;
  id: Id;
  version: number;
  name: string;
  palette: Array<{ role: 'primary' | 'secondary' | 'accent' | 'background' | 'text' | 'highlight'; color: HexColor }>;
  fonts: Array<{ role: 'heading' | 'body' | 'caption'; family: string; assetId: Id | null; license: string }>;
  logos: Array<{ assetId: Id; role: 'primary' | 'mark' | 'wordmark' }>;
  captionStyle: { template: CaptionTemplate; highlightColor: HexColor; positionPolicy: CaptionPosition };
  hookTone: HookTone;
  glossary: string[];
  prohibitedClaims: string[];
  motionIntensity: MotionIntensity;
  safeLayouts: Array<'full' | 'inset' | 'split'>;
  music: { moods: string[]; bannedCategories: string[] };
  sfx: { bannedCategories: SfxCategory[] };
  ctaTemplates: string[];
  aspectPresets: Array<{ width: number; height: number }>;
  provenance: { source: 'manual' | 'website'; sourceUrl: string | null; createdAt: Timestamp };
}
export type StyleTrait =
  | 'pace' | 'shotDuration' | 'typography' | 'textDensity' | 'palette' | 'framing' | 'motion' | 'transitions' | 'audio';
export interface StyleProfile {
  schemaVersion: SchemaVersion;
  id: Id;
  version: number;
  pace: { wordsPerMinuteMin: number; wordsPerMinuteMax: number };
  shotDurationUs: { p25: number; p50: number; p75: number };
  typography: { category: 'sans' | 'serif' | 'mono' | 'display'; scale: 'small' | 'medium' | 'large' };
  textDensity: 'low' | 'medium' | 'high';
  palette: { relationship: 'monochrome' | 'analogous' | 'complementary' | 'neutral'; colors: HexColor[] };
  framing: 'tight' | 'medium' | 'wide';
  motion: { easing: 'linear' | 'ease' | 'spring' | 'snappy'; intensity: MotionIntensity };
  transitionsPerMinute: number;
  audio: { energy: 'low' | 'medium' | 'high'; beatAligned: boolean };
  confidence: number;
  disabledTraits: StyleTrait[];
  provenance: { sources: Array<{ kind: 'local_media' | 'url'; ref: string; analyzed: string }>; createdAt: Timestamp };
}

// ---------- Jobs, QA, receipts, exports ----------

export type RenderProfile = 'draft' | 'final';
export interface Job {
  schemaVersion: SchemaVersion;
  id: Id;
  projectId: Id;
  stage: JobStage;
  profile: RenderProfile;
  state: JobState;
  /** null when the stage cannot be measured. */
  progress: number | null;
  baseRevision: number;
  idempotencyKey: string;
  attempts: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  error: ErrorInfo | null;
  artifacts: Array<{ kind: string; ref: RelPath; hash: Sha256 }>;
}
export interface QACheck {
  name: string;
  status: CheckStatus;
  detail: string | null;
}
export interface QAIssue {
  id: Id;
  severity: Severity;
  check: string;
  objectRef: Id | null;
  frame: number | null;
  span: FrameSpan | null;
  evidence: string;
  suggestedPatch?: PlanPatch;
}
export interface QAReport {
  schemaVersion: SchemaVersion;
  id: Id;
  planHash: Sha256;
  artifactHash: Sha256 | null;
  createdAt: Timestamp;
  issues: QAIssue[];
  checks: QACheck[];
}
export interface ProviderReceipt {
  schemaVersion: SchemaVersion;
  id: Id;
  projectId: Id;
  jobId: Id | null;
  provider: Id;
  dataType: ProviderDataType;
  purpose: string;
  sentAt: Timestamp;
  bytes: number;
  estimatedCostUsd: number | null;
  retentionPolicyUrl: string | null;
}
export interface ExportManifest {
  schemaVersion: SchemaVersion;
  id: Id;
  projectId: Id;
  revision: number;
  planHash: Sha256;
  createdAt: Timestamp;
  preset: {
    id: Id;
    version: number;
    width: number;
    height: number;
    fps: Rational;
    container: 'mp4';
    videoCodec: 'h264';
    audioCodec: 'aac';
    colorSpace: 'bt709';
    burnCaptions: boolean;
  };
  durationFrames: number;
  outputs: Array<{
    kind: 'video' | 'srt' | 'vtt' | 'caption_json' | 'project_bundle' | 'stem';
    relativePath: RelPath;
    sha256: Sha256;
    bytes: number;
  }>;
  checks: QACheck[];
  unresolvedWarnings: Warning[];
}
export interface Capabilities {
  schemaVersion: SchemaVersion;
  appVersion: string;
  networkPolicy: NetworkPolicy;
  models: Array<{ id: Id; kind: 'asr' | 'vad' | 'alignment' | 'director'; backend: string; installed: boolean; device: Id | null }>;
  devices: Array<{ id: Id; kind: 'cpu' | 'cuda' | 'metal'; name: string }>;
  codecs: { decode: string[]; encode: string[] };
  providers: Array<{ id: Id; enabled: boolean; dataTypes: ProviderDataType[] }>;
  features: Array<{ id: FeatureId; status: 'available' | 'experimental' | 'unavailable'; reason: string | null }>;
}

// ---------- API DTOs (PRD 8) ----------

export interface CreateProjectRequest {
  schemaVersion: SchemaVersion;
  name: string;
  settings?: Settings;
}
export interface CreateProjectResponse {
  schemaVersion: SchemaVersion;
  projectId: Id;
  revision: number;
}
export interface ImportAssetsRequest {
  schemaVersion: SchemaVersion;
  items: Array<{ source: 'path'; path: string } | { source: 'upload'; uploadId: Id }>;
}
export interface ImportAssetsResponse {
  schemaVersion: SchemaVersion;
  items: Array<{ assetId: Id; jobId: Id }>;
}
export interface CreateJobRequest {
  schemaVersion: SchemaVersion;
  stage: JobStage;
  profile: RenderProfile;
  baseRevision: number;
  idempotencyKey: string;
}

// ---------- Director I/O ----------

export interface DirectorCandidate {
  id: Id;
  kind: 'filler' | 'silence' | 'retake' | 'false_start';
  assetId: Id;
  sourceStartUs: number;
  sourceEndUs: number;
  wordIds: Id[];
  evidence: string;
  confidenceTier: ConfidenceTier;
}
export interface DirectorRequest {
  schemaVersion: SchemaVersion;
  projectId: Id;
  revision: number;
  output: OutputSpec;
  settings: Settings;
  words: Array<{ id: Id; assetId: Id; text: string; sourceStartUs: number; sourceEndUs: number; alignment: WordAlignment }>;
  candidates: DirectorCandidate[];
  brand: {
    name: string;
    hookTone: HookTone;
    motionIntensity: MotionIntensity;
    glossary: string[];
    prohibitedClaims: string[];
  } | null;
}
export interface DirectorResponse {
  schemaVersion: SchemaVersion;
  decisions: Decision[];
  segments: Segment[];
  captions: Caption[];
  visuals: Visual[];
  transforms: Transform[];
  reviewMarkers: ReviewMarker[];
  provenance: PlanProvenance;
  /** At most three truthful options (F13). */
  hookOptions: Array<{ text: string; evidenceIds: Id[] }>;
}
