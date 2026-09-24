"""Visual audio QA: spectrogram + short-term loudness with story cues overlaid.

Usage: python3 scripts/audio_report.py [mix.wav] [out.png]
"""
import json
import sys

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from PIL import Image, ImageDraw, ImageFont
from scipy import signal as sig

path = sys.argv[1] if len(sys.argv) > 1 else "public/audio/mix.wav"
out = sys.argv[2] if len(sys.argv) > 2 else "out/audio_report.png"
x, sr = sf.read(path, always_2d=True)
mono = x.mean(axis=1)
cues = json.load(open("audio/cues.json"))
T = cues["T"]
dur = len(mono) / sr

W, H = 1900, 900
img = Image.new("RGB", (W, H), (18, 18, 20))
d = ImageDraw.Draw(img)
font = ImageFont.truetype("public/fonts/JetBrainsMono.ttf", 15)

# Spectrogram (log frequency 40 Hz – 16 kHz)
f, t, S = sig.spectrogram(mono, fs=sr, nperseg=2048, noverlap=1536)
S = 10 * np.log10(S + 1e-12)
fmin, fmax = 40, 16000
rows = 360
ys = np.geomspace(fmin, fmax, rows)
spec = np.zeros((rows, len(t)))
for i, fy in enumerate(ys):
    spec[rows - 1 - i] = S[np.argmin(np.abs(f - fy))]
spec = np.clip((spec + 110) / 80, 0, 1)
cols = np.interp(np.linspace(0, len(t) - 1, W - 80), np.arange(len(t)), np.arange(len(t))).astype(int)
spec = spec[:, cols]
rgb = np.stack([spec ** 0.8 * 255, spec ** 1.6 * 200, spec ** 3 * 120], axis=2).astype(np.uint8)
img.paste(Image.fromarray(rgb).resize((W - 80, 380)), (60, 30))
for hz_ in [100, 1000, 10000]:
    y = 30 + 380 - int(380 * np.log(hz_ / fmin) / np.log(fmax / fmin))
    d.text((4, y - 8), f"{hz_ if hz_ < 1000 else str(hz_ // 1000) + 'k'}", fill=(160, 160, 160), font=font)

# Momentary loudness (400 ms) and peaks
meter = pyln.Meter(sr, block_size=0.4)
hop = int(0.05 * sr)
lk, pk = [], []
for i in range(0, len(mono) - int(0.4 * sr), hop):
    seg = x[i : i + int(0.4 * sr)]
    lk.append(meter.integrated_loudness(seg) if np.any(seg) else -70)
    pk.append(20 * np.log10(np.max(np.abs(x[i : i + hop])) + 1e-9))
lk = np.maximum(np.array(lk), -60)
pk = np.maximum(np.array(pk), -60)
top, h = 450, 380
d.rectangle([60, top, W - 20, top + h], outline=(60, 60, 60))
for level in [-10, -20, -30, -40, -50]:
    y = top + int(h * (-level) / 60)
    d.line([60, y, W - 20, y], fill=(40, 40, 44))
    d.text((8, y - 8), f"{level}", fill=(150, 150, 150), font=font)
xs = 60 + (np.arange(len(lk)) * hop / sr + 0.2) / dur * (W - 80)
d.line(list(zip(xs, top + h * (-lk) / 60)), fill=(120, 200, 255), width=2)
xs2 = 60 + (np.arange(len(pk)) * hop / sr) / dur * (W - 80)
d.line(list(zip(xs2, top + h * (-pk) / 60)), fill=(255, 150, 90), width=1)

marks = {
    "click": cues["clicks"],
    "enter": [T["enter"]],
    "land": cues["landings"],
    "approval": [T["approvalIn"]],
    "LAST CLICK": [T["approve"]],
    "morning": [T["wipe"]],
    "callouts": [T["ann1"], T["ann2"], T["ann3"]],
    "line": [T["line1"], T["line2"]],
    "mark": [T["mark"]],
}
for label, times in marks.items():
    for tm in times:
        xx = 60 + tm / dur * (W - 80)
        d.line([xx, 24, xx, top + h], fill=(90, 90, 90) if label == "land" else (200, 200, 90), width=1)
    d.text((60 + times[0] / dur * (W - 80) + 3, top + h + 8 + (18 if label in ("land", "callouts", "line") else 0)), label, fill=(220, 220, 150), font=font)
for s in range(0, int(dur) + 1, 2):
    xx = 60 + s / dur * (W - 80)
    d.text((xx - 6, H - 22), f"{s}", fill=(150, 150, 150), font=font)
d.text((60, 6), f"{path}  {dur:.3f}s  integrated {pyln.Meter(sr).integrated_loudness(x):.2f} LUFS   blue=momentary LUFS  orange=peak dBFS", fill=(230, 230, 230), font=font)
img.save(out)
print(out)
