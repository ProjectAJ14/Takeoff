# Benchmarks

Measured timings of the local route against the PRD §12 laptop targets. Every
number here came from a run of `scripts/benchmark.ts`; nothing is estimated.

## How to run

```sh
node scripts/benchmark.ts            # about 10–20 min on an Apple Silicon laptop
TAKEOFF_BENCH_KEEP=1 node scripts/benchmark.ts   # keep the temporary folder
```

It builds a synthetic 5-minute 1080p30 H.264/AAC take (macOS `say` speech over
`testsrc2`), runs the engine with the real worker and renderer offline
(`HF_HUB_OFFLINE=1`), and prints a Markdown table with the machine, model and
versions. A step over 20 minutes is abandoned and reported. It needs macOS
`say`, FFmpeg, uv with the cached `base` model and the Playwright Chromium. CI
does not run it, because timings depend on the machine and its thermal state.

## Latest result

The second of two runs on the same machine; the first passed every row too.

- **Machine:** Mac16,8, Apple M4 Pro, 12 cores, 24 GB RAM. The PRD laptop
  class is 16 GB; this machine has more.
- **ASR:** faster-whisper `base`, CPU, int8.
- **Versions:** engine 0.1.0, Node 26.7.0, FFmpeg 9.0.1, Python 3.12.13,
  faster-whisper 1.2.1, ctranslate2 4.8.2.

| Scenario | PRD target (laptop) | Measured | Result |
|---|---|---|---|
| First playable proxy, 5-min 1080p (whole import, not progressive) | ≤ 30 s | 11.9 s | Pass |
| Transcribe 5 min (`base`, CPU) | ≤ 5 min | 14.6 s | Pass |
| Speech-only 60 s draft from a cached transcript | ≤ 60 s | 7.5 s | Pass |
| 720p30 60 s template-polish draft | ≤ 3 min | 20.4 s | Pass, but 0 motion scenes |
| 1080p30 60 s final, ≤ 3 motion scenes | ≤ 5 min | 31.0 s | Pass, but 0 motion scenes |
| Caption change re-render | Never re-transcribe | 13.5 s | Pass (0 transcribe calls) |
| Full 5-min raw → 60 s short (new project) | ≤ 12 min | 1 min 7 s | Pass |

## Read these numbers with care

- **The two motion-scene rows are not a real measurement of motion graphics.**
  The synthetic script triggered no motion template, so those renders had none.
  A corpus whose speech fires `request_flow_v1` or `comparison_list_v1` is needed
  to measure them.
- **The "720p30" draft is 540×960.** Edit Video renders with the renderer's
  `draft` profile ([rendering.md](rendering.md#output-profiles)).
- **Synthetic speech is easy.** `say` speech is clean and evenly paced; real
  recordings will transcribe and edit differently.
- **One machine.** No Windows, Linux or CUDA workstation has been measured.
- **Not measured:** UI response and cached-project open time, interactive
  preview frame rate, cancel acknowledgement time, resident RAM, and cold-start
  or model download time.
