"""Face tracking: pure smoothing/hysteresis logic on synthetic detections, plus the CLI on lavfi media."""

import json
import os
import shutil
import socket
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from takeoff_transcribe import faces
from tests.test_worker import run_cli

W, H, FPS = 1920, 1080, 5


def samples(boxes):
    """boxes: per sample a list of (x, y, w, h)."""
    return [{"us": round(i * 1_000_000 / FPS), "faces": [{"x": x, "y": y, "w": w, "h": h, "score": 1.0} for x, y, w, h in b]}
            for i, b in enumerate(boxes)]


class TrackTest(unittest.TestCase):
    def test_jitter_is_held_and_spikes_are_median_filtered(self):
        jitter = [[(900 + d, 300 - d, 200, 200)] for d in (0, 6, -5, 4, -6, 3, 0, 5, -4, 2)]
        jitter[5] = [(1500, 300, 200, 200)]  # one-sample detector spike
        track, status = faces.build_track(samples(jitter), W, H, FPS)
        self.assertEqual(status, "tracked")
        self.assertEqual(len(track), 1, track)  # one stable box: no frame-to-frame jitter
        t = track[0]
        self.assertEqual((t["startUs"], t["endUs"], t["confidence"]), (0, 2_000_000, 1))
        self.assertLess(abs(t["x"] - 900), 10)

    def test_real_move_beyond_hysteresis_starts_a_new_entry(self):
        boxes = [[(400, 300, 200, 200)]] * 10 + [[(1300, 300, 200, 200)]] * 10
        track, status = faces.build_track(samples(boxes), W, H, FPS)
        self.assertEqual(status, "tracked")
        self.assertEqual([t["x"] for t in track], [400, 1300])
        self.assertEqual(track[0]["endUs"], track[1]["startUs"])  # half-open, contiguous

    def test_multiple_faces_are_confidence_zero_full_frame(self):
        one, two = [(400, 300, 200, 200)], [(400, 300, 200, 200), (1300, 300, 200, 200)]
        track, status = faces.build_track(samples([one] * 6 + [two] * 6 + [one] * 6), W, H, FPS)
        self.assertEqual(status, "multiple_faces")
        mid = [t for t in track if t["confidence"] == 0]
        self.assertEqual(len(mid), 1)
        self.assertEqual((mid[0]["x"], mid[0]["y"], mid[0]["w"], mid[0]["h"]), (0, 0, W, H))
        self.assertEqual((mid[0]["startUs"], mid[0]["endUs"]), (1_200_000, 2_400_000))

    def test_short_gap_holds_long_gap_is_lost(self):
        f = [(400, 300, 200, 200)]
        track, status = faces.build_track(samples([f] * 5 + [[]] * 3 + [f] * 5), W, H, FPS)
        self.assertEqual(status, "tracked")
        self.assertEqual(len(track), 1)
        self.assertLess(track[0]["confidence"], 1)  # held samples are not detections
        track, status = faces.build_track(samples([f] * 5 + [[]] * 10), W, H, FPS)
        self.assertEqual(status, "lost")
        self.assertEqual(track[-1]["confidence"], 0)

    def test_boxes_overshooting_the_frame_are_clamped_inside_it(self):
        # Detection runs downscaled; scaling back can overshoot by a pixel (e.g. 1004 px tall -> 482 rows * 2.083).
        track, _ = faces.build_track(samples([[(1800, 900, 121, 181)]] * 3 + [[(-2, -1, 50, 50)]] * 3), W, H, FPS)
        for e in track:
            self.assertTrue(e["x"] >= 0 and e["y"] >= 0 and e["x"] + e["w"] <= W and e["y"] + e["h"] <= H, e)

    def test_no_faces_is_none(self):
        track, status = faces.build_track(samples([[]] * 4), W, H, FPS)
        self.assertEqual(status, "none")
        self.assertTrue(all(t["confidence"] == 0 for t in track))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class FacesCliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="takeoff-faces-")
        cls.video = os.path.join(cls.tmp, "src.mp4")
        cls.rotated = os.path.join(cls.tmp, "rot.mp4")
        ff = ["ffmpeg", "-loglevel", "error", "-y"]
        subprocess.run([*ff, "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-c:v", "libx264",
                        "-preset", "ultrafast", "-pix_fmt", "yuv420p", cls.video], check=True)
        subprocess.run([*ff, "-display_rotation:v:0", "-90", "-i", cls.video, "-c", "copy", cls.rotated], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_testsrc_has_no_face_and_output_is_well_formed(self):
        out = os.path.join(self.tmp, "faces.json")
        code, events = run_cli("faces", "--video", self.video, "--sample-fps", "5", "--out", out)
        self.assertEqual(code, 0, events)
        self.assertEqual(events[-1]["status"], "none")
        t = json.loads(Path(out).read_text())
        self.assertEqual((t["schemaVersion"], t["width"], t["height"], t["rotation"], t["status"]), ("1.0", 640, 360, 0, "none"))
        self.assertEqual(len(t["samples"]), 10)
        self.assertEqual([s["us"] for s in t["samples"]], [i * 200_000 for i in range(10)])
        for e in t["track"]:
            self.assertIsInstance(e["startUs"], int)
            self.assertLess(e["startUs"], e["endUs"])
        self.assertFalse(os.path.exists(out + ".partial"))

    def test_rotation_reports_displayed_dims(self):
        self.assertEqual(faces.probe_video(self.rotated), (360, 640, 90))

    def test_bad_inputs_are_typed(self):
        code, events = run_cli("faces", "--video", self.video, "--sample-fps", "0", "--out", os.path.join(self.tmp, "x.json"))
        self.assertEqual((code, events[-1]["code"]), (2, "bad_input"))
        missing = os.path.join(self.tmp, "nope.mp4")
        code, events = run_cli("faces", "--video", missing, "--out", os.path.join(self.tmp, "x.json"))
        self.assertEqual((code, events[-1]["code"]), (2, "bad_input"))
        self.assertNotIn(missing, json.dumps(events))

    def test_faces_makes_no_network_connection(self):
        attempts = []

        def deny(*args, **kwargs):
            attempts.append(args)
            raise OSError("network denied by test")

        with mock.patch.object(socket.socket, "connect", deny), \
             mock.patch.object(socket.socket, "connect_ex", deny), \
             mock.patch.object(socket, "getaddrinfo", deny):
            result = faces.faces(self.video, 5)
        self.assertEqual(attempts, [])
        self.assertEqual(result["status"], "none")
