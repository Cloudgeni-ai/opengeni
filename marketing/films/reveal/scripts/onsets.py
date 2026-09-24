#!/usr/bin/env python3
"""Measure audio onsets against their picture cues in a WAV or MP4.

An onset is the first time the high-passed energy envelope crosses half of
its local peak inside a +/-60 ms window around the cue. Negative = early.
Usage: PYTHONPATH=.pydeps python3 scripts/onsets.py <file>
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess
import sys

import numpy as np
from scipy import signal

ROOT = pathlib.Path(__file__).resolve().parent.parent
C = json.loads((ROOT / "audio" / "cues.json").read_text())
SR = 48_000
PRESS = float(re.search(r"SEND_REPLICA_PRESS = ([\d.]+)", (ROOT / "src/scenes/CodePage.tsx").read_text()).group(1))

raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", sys.argv[1], "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
    capture_output=True,
    check=True,
).stdout
x = np.frombuffer(raw, dtype=np.float32).astype(np.float64)
hp = signal.sosfilt(signal.butter(2, 1200, "highpass", fs=SR, output="sos"), x)
hop = int(0.0005 * SR)
env = np.sqrt(np.convolve(hp**2, np.ones(4 * hop) / (4 * hop), mode="same"))[::hop]


def onset(t: float, win: float = 0.06) -> float:
    i0, i1 = int((t - win) / 0.0005), int((t + win) / 0.0005)
    seg = env[i0:i1]
    floor = np.percentile(seg, 10)
    half = floor + 0.5 * (seg.max() - floor)
    return (i0 + int(np.argmax(seg >= half))) * 0.0005 - t


hl = {h["key"]: h for h in C["highlights"]}
checks = [
    ("enter key", C["enter"]),
    ("landing 1", C["moves"][0]["land"]),
    ("landing 2", C["moves"][1]["land"]),
    ("send tap", C["sendTap"]),
    ("replica press", hl["approval"]["start"] + PRESS),
]
for name, t in checks:
    print(f"{name:14s} cue {t:7.3f}s  onset {onset(t) * 1000:+6.1f} ms")
