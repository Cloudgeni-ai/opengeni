"""Analytic audio checks (no listening involved): unexpected transients/pops,
DC offset, edge silence, and whether any click-like transient follows the
approval click. Usage: python3 scripts/audio_artifacts.py public/audio/mix.wav"""
import json
import sys

import numpy as np
import soundfile as sf
from scipy import signal as sig

path = sys.argv[1] if len(sys.argv) > 1 else "public/audio/mix.wav"
x, sr = sf.read(path, always_2d=True)
cues = json.load(open("audio/cues.json"))
T = cues["T"]
mono = x.mean(axis=1)

print(f"duration {len(mono) / sr:.3f}s  DC L {x[:, 0].mean():+.2e} R {x[:, 1].mean():+.2e}")
print(f"first 10 ms peak {np.max(np.abs(x[: sr // 100])):.4f}   last 10 ms peak {np.max(np.abs(x[-sr // 100 :])):.4f}")

# Transient detector: energy jump in the 3-12 kHz band, 2 ms frames.
hp = sig.sosfilt(sig.butter(4, [3000, 12000], btype="bandpass", fs=sr, output="sos"), mono)
frame = int(0.002 * sr)
e = np.sqrt(np.mean(hp[: len(hp) // frame * frame].reshape(-1, frame) ** 2, axis=1)) + 1e-9
ratio = e[1:] / np.maximum(e[:-1], np.median(e) * 0.5)
db = 20 * np.log10(e[1:])
onsets = np.where((ratio > 4.0) & (db > -58))[0]
times = []
for i in onsets:
    t = (i + 1) * frame / sr
    if not times or t - times[-1] > 0.03:
        times.append(t)

intended = list(cues["clicks"]) + [k["t"] for k in cues["keys"]] + [T["enter"]]
intended += [b * cues["beat"] for b in range(int(round(T["enter"] / cues["beat"])))]
intended += list(cues["chips"]) + list(cues["sends"]) + list(cues["landings"])


def explained(t):
    return min(abs(t - s) for s in intended) < 0.035


unexpected = [t for t in times if not explained(t)]
print(f"sharp high-band onsets: {len(times)}; explained by cues: {len(times) - len(unexpected)}")
print("unexpected onsets (s):", ", ".join(f"{t:.3f}" for t in unexpected) or "none")

# Is the approval the last click-like transient? Look for broadband sharp
# transients (> -36 dB in the band, very fast rise) after it.
late = [t for t in times if t > T["approve"] + 0.05]
sharp_late = []
for t in late:
    i = int(t * sr / frame)
    if db[max(0, i - 1)] > -36 and ratio[max(0, i - 1)] > 8:
        sharp_late.append(t)
print("click-like transients after the approval:", ", ".join(f"{t:.3f}" for t in sharp_late) or "none")
