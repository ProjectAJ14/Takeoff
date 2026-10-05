"""Local face tracking for face-aware crop, zoom and captions (PRD F06, F08).

OpenCV's bundled Haar frontal-face cascade on frames FFmpeg samples at a fixed rate:
fully offline, no model download. Coordinates are displayed-orientation source pixels
(FFmpeg applies the display rotation). The track is smoothed so the centre never jitters:
callers frame on it directly, and keep a stable wide shot where confidence is 0.
"""

import json
import shutil
import subprocess
from statistics import median

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"
DETECT_WIDTH = 480  # detection runs on a downscaled frame; boxes are scaled back to source pixels
MEDIAN_WINDOW = 5  # samples (1 s at 5 fps)
HOLD_GAP_S = 1.0  # a single face missing for at most this long keeps the last box
HYSTERESIS = 0.05  # box moves only when centre shifts > 5% of the frame or size > 10%


def probe_video(path: str) -> tuple[int, int, int]:
    """(displayed width, displayed height, rotation 0|90|180|270) of the first video stream."""
    from .worker import WorkerError

    p = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=width,height:stream_side_data=rotation", "-of", "json", f"file:{path}"],
                       capture_output=True, text=True, timeout=60)
    streams = json.loads(p.stdout or "{}").get("streams") if p.returncode == 0 else None
    if not streams:
        raise WorkerError("bad_input", "media has no readable video stream", "Pass a video file with --video.")
    s = streams[0]
    rot = next((int(d["rotation"]) for d in s.get("side_data_list", []) if "rotation" in d), 0)
    rotation = (-rot) % 360  # side data is counter-clockwise; report clockwise like the asset manifest
    w, h = int(s["width"]), int(s["height"])
    return (h, w, rotation) if rotation in (90, 270) else (w, h, rotation)


def detect(path: str, width: int, height: int, sample_fps: float) -> list[dict]:
    """Samples [{us, faces:[{x,y,w,h,score}]}] at `sample_fps`, boxes in displayed source pixels."""
    import cv2
    import numpy as np

    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    dw = min(DETECT_WIDTH, width) // 2 * 2
    dh = max(2, round(height * dw / width) // 2 * 2)
    k = width / dw
    # FFmpeg autorotates, so frames arrive in displayed orientation. Argument array; path is a `file:` input.
    proc = subprocess.Popen([FFMPEG, "-nostdin", "-v", "error", "-i", f"file:{path}", "-an", "-sn",
                             "-vf", f"fps={sample_fps},scale={dw}:{dh}", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    samples, i, size = [], 0, dw * dh
    try:
        while len(buf := proc.stdout.read(size)) == size:
            frame = np.frombuffer(buf, np.uint8).reshape(dh, dw)
            boxes, _, weights = cascade.detectMultiScale3(frame, scaleFactor=1.1, minNeighbors=5,
                                                          minSize=(max(24, dw // 20),) * 2, outputRejectLevels=True)
            faces = [{"x": round(x * k), "y": round(y * k), "w": round(w * k), "h": round(h * k), "score": round(float(s), 4)}
                     for (x, y, w, h), s in zip(boxes, np.ravel(weights))]
            samples.append({"us": round(i * 1_000_000 / sample_fps), "faces": faces})
            i += 1
    finally:
        proc.stdout.close()
        code = proc.wait()
    if code != 0:
        from .worker import WorkerError
        raise WorkerError("bad_input", "video could not be decoded", "Re-import the media or convert it with ffmpeg.")
    return samples


def build_track(samples: list[dict], width: int, height: int, sample_fps: float) -> tuple[list[dict], str]:
    """Smoothed, piecewise-constant face track and an overall status. Pure function.

    Per sample: one face -> its box; >1 face -> multiple; none -> missing, but a gap up to
    HOLD_GAP_S after a face holds the last box. Face boxes are median-filtered over
    MEDIAN_WINDOW samples, then held until the centre moves > HYSTERESIS of the frame or the
    size changes > 2*HYSTERESIS, so the box never jitters. Equal consecutive states merge
    into one [startUs, endUs) entry; multiple/lost entries are the full frame at confidence 0.
    """
    period = 1_000_000 / sample_fps
    hold = int(HOLD_GAP_S * sample_fps)
    states: list[tuple[str, tuple | None, bool]] = []  # (kind, box, detected)
    last, gap = None, 0
    for s in samples:
        n = len(s["faces"])
        if n == 1:
            f = s["faces"][0]
            # Clamp into the frame: detection-scale rounding can overshoot by a pixel, and the renderer refuses
            # (fails the render on) any box outside its frame.
            x, y = min(max(0, f["x"]), width - 1), min(max(0, f["y"]), height - 1)
            last, gap = (x, y, max(1, min(f["w"], width - x)), max(1, min(f["h"], height - y))), 0
            states.append(("face", last, True))
        elif n > 1:
            last = None
            states.append(("multiple", None, False))
        else:
            gap += 1
            if last is not None and gap <= hold:
                states.append(("face", last, False))
            else:
                last = None
                states.append(("lost", None, False))

    half = MEDIAN_WINDOW // 2
    held, entries = None, []
    for i, (kind, box, detected) in enumerate(states):
        if kind == "face":
            # Median over neighbouring face samples only: a multi/lost boundary never pulls the box.
            win = [states[j][1] for j in range(max(0, i - half), min(len(states), i + half + 1)) if states[j][0] == "face"]
            box = tuple(round(median(v[c] for v in win)) for c in range(4))
            if held is None or moved(held, box, width, height):
                held = box
        else:
            held, box = None, (0, 0, width, height)
        cur = held if kind == "face" else box
        e = entries[-1] if entries else None
        if e and e["kind"] == kind and e["box"] == cur:
            e["end"], e["hits"] = i + 1, e["hits"] + detected
        else:
            entries.append({"kind": kind, "box": cur, "start": i, "end": i + 1, "hits": int(detected)})

    track = [{
        "startUs": round(e["start"] * period), "endUs": round(e["end"] * period),
        "x": e["box"][0], "y": e["box"][1], "w": e["box"][2], "h": e["box"][3],
        "confidence": round(e["hits"] / (e["end"] - e["start"]), 4) if e["kind"] == "face" else 0,
    } for e in entries]
    kinds = {e["kind"] for e in entries}
    status = ("none" if not any(s["faces"] for s in samples) else "multiple_faces" if "multiple" in kinds
              else "lost" if "lost" in kinds else "tracked")
    return track, status


def moved(a: tuple, b: tuple, width: int, height: int) -> bool:
    ca, cb = (a[0] + a[2] / 2, a[1] + a[3] / 2), (b[0] + b[2] / 2, b[1] + b[3] / 2)
    return (abs(ca[0] - cb[0]) > HYSTERESIS * width or abs(ca[1] - cb[1]) > HYSTERESIS * height
            or abs(a[2] - b[2]) > 2 * HYSTERESIS * a[2] or abs(a[3] - b[3]) > 2 * HYSTERESIS * a[3])


def faces(video: str, sample_fps: float, source_hash: str | None = None) -> dict:
    import os

    from .worker import SHA256_RE, WorkerError

    if not (0 < sample_fps <= 30):
        raise WorkerError("bad_input", "--sample-fps must be in (0, 30]", "Use --sample-fps 5.")
    if source_hash is not None and not SHA256_RE.match(source_hash):
        raise WorkerError("bad_input", "--source-hash must be 64 lowercase hex characters", "Pass the asset's sha256.")
    if not os.path.isfile(video):
        raise WorkerError("bad_input", "video file not found", "Pass an existing video with --video.")
    width, height, rotation = probe_video(video)
    samples = detect(video, width, height, sample_fps)
    track, status = build_track(samples, width, height, sample_fps)
    out = {"schemaVersion": "1.0", "width": width, "height": height, "rotation": rotation, "sampleFps": sample_fps,
           "detector": "opencv_haar_frontalface_default", "samples": samples, "track": track, "status": status}
    if source_hash:
        out["sourceHash"] = source_hash
    return out
