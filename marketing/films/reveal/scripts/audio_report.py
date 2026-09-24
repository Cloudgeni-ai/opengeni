#!/usr/bin/env python3
"""Objective audio QA for the Reveal score or a delivered file's audio.

Measurements only; they cannot say whether the score sounds good.
Usage: PYTHONPATH=.pydeps python3 scripts/audio_report.py <file.wav|file.mp4>
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import numpy as np
from scipy import signal

ROOT = pathlib.Path(__file__).resolve().parent.parent
CUES = json.loads((ROOT / "audio" / "cues.json").read_text())
SR = 48_000


def decode(path: str) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", str(SR), "-f", "f32le", "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.astype(np.float64)


def k_weight(x: np.ndarray) -> np.ndarray:
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    return signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)


def momentary(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    k = k_weight(x)
    block, hop = int(0.4 * SR), int(0.1 * SR)
    starts = np.arange(0, k.shape[1] - block, hop)
    z = np.array([np.mean(k[:, i : i + block] ** 2, axis=1).sum() for i in starts])
    return (starts + block) / SR, -0.691 + 10 * np.log10(z + 1e-12)


def main() -> None:
    x = decode(sys.argv[1])
    t, m = momentary(x)
    c = CUES
    h0 = c["highlights"][0]["start"]
    sections = [
        ("typing", 0.4, c["enter"]),
        ("agent works", c["enter"], c["closeStart"]),
        ("app closed", c["closeEnd"], c["openStart"]),
        ("reopen + send", c["openStart"], c["wideHerStart"]),
        ("her super", c["wideHerStart"], c["slideStart"]),
        ("code reveal", c["slideStart"], h0),
        ("highlights", h0, c["finalStart"]),
        ("final frame", c["finalStart"], c["duration"] - 0.7),
    ]
    print("momentary loudness (LUFS, 400 ms), median / max per section")
    for name, a, b in sections:
        sel = (t >= a) & (t < b) & (m > -70)
        print(f"  {name:14s} {np.median(m[sel]):6.1f} / {m[sel].max():6.1f}")
    left, right = x
    corr = np.corrcoef(left, right)[0, 1]
    mono = 10 * np.log10(np.mean(((left + right) / 2) ** 2) / np.mean((left**2 + right**2) / 2))
    print(f"L/R correlation {corr:.2f}; mono fold-down {mono:+.1f} dB")
    f, p = signal.welch((left + right) / 2, SR, nperseg=8192)
    total = p[(f >= 20) & (f < 20_000)].sum()
    print("spectral balance, dB relative to total")
    for lo, hi, name in ((20, 120, "sub/bass"), (120, 500, "low-mid"), (500, 2000, "mid"), (2000, 6000, "presence"), (6000, 20_000, "air")):
        print(f"  {name:9s} {10 * np.log10(p[(f >= lo) & (f < hi)].sum() / total):6.1f}")
    peak = 20 * np.log10(np.max(np.abs(signal.resample_poly(x, 4, 1, axis=-1))) + 1e-12)
    print(f"true peak (4x) {peak:.2f} dBTP; clipped samples {int(np.sum(np.abs(x) >= 0.999))}")


if __name__ == "__main__":
    main()
