import { stat } from 'node:fs/promises';
import type { AssetKind, AssetManifest } from '@takeoff/contracts';
import { FFPROBE, MediaError, ffInput, run } from './run.ts';
import { capabilities } from './capabilities.ts';

/** `AssetManifest.probe` plus the fields ingest and color need. Rotation is clockwise degrees, as the legacy `rotate` tag. */
export type ProbeResult = AssetManifest['probe'] & {
  kind: AssetKind;
  /** Container start_time; proxies and WAVs are 0-based relative to it. */
  startUs: number;
  /** PQ (smpte2084) or HLG (arib-std-b67) transfer. P0 output is SDR; callers must not silently treat these as SDR. */
  hdr: boolean;
};

interface FfStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
  color_primaries?: string;
  pix_fmt?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}
export interface FfprobeJson {
  streams?: FfStream[];
  format?: { format_name?: string; duration?: string; start_time?: string };
}

const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);
const MAX_DIM = 16384;

const rational = (s: string | undefined): [number, number] | null => {
  const m = /^(\d+)\/(\d+)$/.exec(s ?? '');
  if (!m) return null;
  const n = Number(m[1]), d = Number(m[2]);
  return n > 0 && d > 0 ? [n, d] : null;
};
const secToUs = (s: string | undefined): number | null => {
  const v = Number(s);
  return s !== undefined && Number.isFinite(v) && v >= 0 ? Math.round(v * 1e6) : null;
};
const unknownStr = (s: string | undefined): string | null => (s && s !== 'unknown' ? s.slice(0, 64) : null);

function rotationOf(s: FfStream): 0 | 90 | 180 | 270 {
  const dm = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  // Display-matrix rotation is counter-clockwise; the `rotate` tag is clockwise.
  const cw = dm !== undefined ? -dm : Number(s.tags?.rotate ?? 0);
  const r = ((Math.round((Number.isFinite(cw) ? cw : 0) / 90) * 90) % 360 + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

const unsupported = (s: FfStream) =>
  new MediaError(
    'unsupported_codec',
    `stream ${s.index} (${s.codec_type}) uses codec "${s.codec_name ?? 'unknown'}", which this FFmpeg cannot decode`,
    'Re-export the file as H.264 or HEVC video with AAC audio in MP4/MOV, or install an FFmpeg build that includes this decoder.',
  );

/** Pure mapping from ffprobe JSON to the manifest probe; `decoders` is the set of codec names FFmpeg can decode. */
export function parseProbe(j: FfprobeJson, decoders: Set<string>): ProbeResult {
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new MediaError('no_streams', 'the file has no video or audio stream', 'Choose a video or audio recording; subtitle, data and cover-art-only files cannot be edited.');
  for (const s of [v, a]) if (s && (!s.codec_name || !decoders.has(s.codec_name))) throw unsupported(s);

  let video: ProbeResult['video'] = null;
  if (v) {
    const width = v.width ?? 0, height = v.height ?? 0;
    if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM)
      throw new MediaError('unsupported_dimensions', `stream ${v.index} is ${width}x${height}; the limit is ${MAX_DIM} per side`, 'Re-export the video at a standard resolution such as 1080x1920.');
    const r = rational(v.r_frame_rate), avg = rational(v.avg_frame_rate);
    const fps = avg ?? r;
    // ponytail: r vs avg frame-rate heuristic; a per-packet pts scan is the upgrade if phones slip past it.
    const vfr = !!(r && avg && Math.abs((r[0] * avg[1]) / (r[1] * avg[0]) - 1) > 0.01);
    video = {
      width,
      height,
      rotation: rotationOf(v),
      fpsNum: fps ? fps[0] : null,
      fpsDen: fps ? fps[1] : null,
      vfr,
      codec: v.codec_name!.slice(0, 64),
      colorTransfer: unknownStr(v.color_transfer),
      colorPrimaries: unknownStr(v.color_primaries),
      pixFmt: unknownStr(v.pix_fmt),
    };
  }
  const audio: ProbeResult['audio'] = a
    ? { sampleRate: Number(a.sample_rate) || 0, channels: a.channels ?? 0, codec: a.codec_name!.slice(0, 64) }
    : null;
  if (audio && (audio.sampleRate < 1 || audio.channels < 1)) throw unsupported(a!);

  const fmt = j.format?.format_name ?? '';
  const kind: AssetKind = video ? (/image2|_pipe$/.test(fmt) ? 'image' : 'video') : 'audio';
  return {
    kind,
    durationUs: secToUs(j.format?.duration) ?? secToUs(v?.duration) ?? secToUs(a?.duration),
    startUs: secToUs(j.format?.start_time) ?? 0,
    video,
    audio,
    hdr: !!video?.colorTransfer && HDR_TRANSFERS.has(video.colorTransfer),
  };
}

export async function probe(path: string, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    if (!(await stat(path)).isFile()) throw new Error();
  } catch {
    throw new MediaError('not_found', 'the source file is missing or is not a regular file', 'Relink the file from its new location.');
  }
  const [r, caps] = await Promise.all([
    run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', ffInput(path)], signal),
    capabilities(),
  ]);
  if (r.code !== 0) throw new MediaError('corrupt', 'the file could not be read as media (damaged, truncated or not a media file)', 'Re-copy the file from the camera or phone; if it was still recording or uploading, wait for it to finish.');
  let j: FfprobeJson;
  try {
    j = JSON.parse(r.stdout.toString('utf8')) as FfprobeJson;
  } catch {
    throw new MediaError('corrupt', 'ffprobe returned unreadable output', 'Re-copy the file and try again.');
  }
  return parseProbe(j, new Set(caps.decoders));
}
