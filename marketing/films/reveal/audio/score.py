#!/usr/bin/env python3
"""Original score and sound design for the Reveal film.

Every sound is synthesized here (no samples, no third-party music) and placed
from the shared timeline in audio/cues.json, so picture and sound cannot drift.

Musical idea: I-vi-IV-I-ii-V-I in D major. Each appointment the agent lands
plays the next note of a motif; while the app is closed the remaining notes
continue, muffled, as if heard through a wall; in the reveal each highlighted
line of code replays the sound of the moment it caused.

Output: public/audio/score.wav (48 kHz, 24-bit stereo, loudness-normalized).
Run:   PYTHONPATH=.pydeps python3 audio/score.py
"""

from __future__ import annotations

import json
import pathlib
import sys
import wave

import numpy as np
from scipy import signal

SR = 48_000
ROOT = pathlib.Path(__file__).resolve().parent.parent
CUES = json.loads((ROOT / "audio" / "cues.json").read_text())
DUR = float(CUES["duration"])
N = int((DUR + 0.6) * SR)
TARGET_LUFS = -16.0
CEILING_DBTP = -1.5

rng = np.random.default_rng(24092026)


def note(name: str) -> float:
    names = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    pitch, octave = name[:-1], int(name[-1])
    midi = 12 * (octave + 1) + names[pitch]
    return 440.0 * 2 ** ((midi - 69) / 12)


def stereo() -> np.ndarray:
    return np.zeros((2, N))


def taxis(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def place(dst: np.ndarray, sig: np.ndarray, t0: float, gain: float = 1.0, pan: float = 0.0) -> None:
    if sig.ndim == 1:
        left = np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
        right = np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)
        sig = np.vstack([sig * left, sig * right])
    i0 = int(round(t0 * SR))
    if i0 < 0:
        sig = sig[:, -i0:]
        i0 = 0
    if i0 >= N:
        return
    n = min(sig.shape[1], N - i0)
    dst[:, i0 : i0 + n] += sig[:, :n] * gain


def sos_filter(x: np.ndarray, kind: str, freq, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, freq, kind, fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=-1)


def lowpass(x, fc, order=2):
    return sos_filter(x, "lowpass", fc, order)


def highpass(x, fc, order=2):
    return sos_filter(x, "highpass", fc, order)


def bandpass(x, lo, hi, order=2):
    return sos_filter(x, "bandpass", [lo, hi], order)


def raised_attack(sig: np.ndarray, seconds: float) -> np.ndarray:
    n = min(len(sig), max(1, int(seconds * SR)))
    sig[:n] *= 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, n))
    return sig


def tail_fade(sig: np.ndarray, seconds: float = 0.05) -> np.ndarray:
    n = min(len(sig), int(seconds * SR))
    sig[-n:] *= np.linspace(1, 0, n)
    return sig


def normalize(sig: np.ndarray, peak: float = 1.0) -> np.ndarray:
    m = np.max(np.abs(sig))
    return sig if m == 0 else sig * (peak / m)


# ---------------------------------------------------------------- instruments


def felt_piano(f0: float, dur: float = 4.5, vel: float = 1.0, bright: float = 1.0) -> np.ndarray:
    """Soft felt piano: inharmonic partials, hammer-position comb, two-stage decay,
    detuned unison strings and a muted hammer thump."""
    t = taxis(dur)
    out = np.zeros_like(t)
    inharm = 0.00032
    t60 = 3.4 * (261.63 / f0) ** 0.5
    for n in range(1, 18):
        fn = n * f0 * np.sqrt(1 + inharm * n * n)
        if fn > 12_000:
            break
        strike = abs(np.sin(np.pi * n * 0.118))
        amp = strike / n**1.1 * np.exp(-fn / (1900 * bright * (0.55 + 0.45 * vel)))
        tau = t60 / 6.9 / (1 + 0.45 * (n - 1))
        env = 0.7 * np.exp(-t / (tau * 0.3)) + 0.3 * np.exp(-t / tau)
        p1, p2 = rng.uniform(0, 2 * np.pi, 2)
        out += amp * env * (np.sin(2 * np.pi * fn * t + p1) + 0.85 * np.sin(2 * np.pi * fn * 1.00055 * t + p2))
    out = raised_attack(out, 0.009)
    k = int(0.03 * SR)
    thump = lowpass(rng.standard_normal(k), 900) * np.exp(-np.arange(k) / SR / 0.005)
    out[:k] += thump * 0.035 * np.max(np.abs(out))
    return tail_fade(normalize(out, vel), 0.08)


def glass(f: float, dur: float = 0.5, vel: float = 1.0) -> np.ndarray:
    t = taxis(dur)
    s = (
        np.sin(2 * np.pi * f * t) * np.exp(-t / 0.11)
        + 0.3 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t / 0.04)
        + 0.1 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t / 0.016)
    )
    return tail_fade(normalize(raised_attack(s, 0.003), vel), 0.05)


def key_click(kind: str, seed: int) -> np.ndarray:
    r = np.random.default_rng(seed)
    t = taxis(0.09)
    noise = r.standard_normal(len(t))
    center = 3200 * r.uniform(0.85, 1.15)
    click = bandpass(noise, center * 0.5, min(center * 1.9, 15_000)) * np.exp(-t / 0.0055)
    body_f = {"space": 150, "enter": 170}.get(kind, 205) * r.uniform(0.94, 1.06)
    body = np.sin(2 * np.pi * body_f * t * (1 - 0.3 * t / t[-1])) * np.exp(-t / (0.024 if kind != "normal" else 0.016))
    tick = np.sin(2 * np.pi * 4300 * r.uniform(0.95, 1.05) * t) * np.exp(-t / 0.0028)
    s = 0.85 * click + (0.7 if kind != "normal" else 0.5) * body + 0.12 * tick
    s = raised_attack(s, 0.0008)
    return tail_fade(normalize(s, r.uniform(0.78, 1.0) * (1.25 if kind == "enter" else 1.0)), 0.02)


def whoosh(dur: float, f_start: float, f_end: float, seed: int, damping: float = 1.1) -> np.ndarray:
    """Noise through a swept state-variable band-pass, with a smooth swell."""
    r = np.random.default_rng(seed)
    n = int(dur * SR)
    noise = r.standard_normal(n)
    out = np.empty(n)
    low = band = 0.0
    for i in range(n):
        fc = f_start * (f_end / f_start) ** (i / n)
        f = 2 * np.sin(np.pi * fc / SR)
        high = noise[i] - low - damping * band
        band += f * high
        low += f * band
        out[i] = band
    env = np.sin(np.pi * np.linspace(0, 1, n)) ** 1.6
    return normalize(out * env, 1.0)


def sub(f: float, dur: float, attack: float, vel: float = 1.0) -> np.ndarray:
    t = taxis(dur)
    s = np.sin(2 * np.pi * f * t) + 0.12 * np.sin(2 * np.pi * 2 * f * t)
    env = np.minimum(1, t / attack) * np.exp(-np.maximum(0, t - attack) / (dur * 0.35))
    return tail_fade(normalize(s * env, vel), 0.1)


def pad(freqs: list[float], dur: float, attack: float, release: float, cutoff: float, seed: int) -> np.ndarray:
    r = np.random.default_rng(seed)
    t = taxis(dur)
    out = np.zeros((2, len(t)))
    for f in freqs:
        for cents, pan in ((-7, -0.55), (0, 0.0), (7, 0.55)):
            ff = f * 2 ** (cents / 1200)
            ph = r.uniform(0, 2 * np.pi)
            saw = np.zeros(len(t))
            for k in range(1, 20):
                if k * ff > 7000:
                    break
                saw += np.sin(2 * np.pi * k * ff * t + k * ph) / k
            out[0] += saw * np.cos((pan + 1) * np.pi / 4)
            out[1] += saw * np.sin((pan + 1) * np.pi / 4)
    out = lowpass(out, cutoff, 2)
    env = np.ones(len(t))
    a = int(attack * SR)
    rel = int(release * SR)
    env[:a] = 0.5 - 0.5 * np.cos(np.linspace(0, np.pi, a))
    env[-rel:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, rel))
    breathe = 1 + 0.04 * np.sin(2 * np.pi * 0.23 * t + r.uniform(0, 6))
    return normalize(out * env * breathe, 1.0)


def make_ir(t60: float, seed: int, bright: float = 1.0, predelay: float = 0.014) -> np.ndarray:
    r = np.random.default_rng(seed)
    n = int(t60 * 1.15 * SR)
    t = np.arange(n) / SR
    ir = np.zeros((2, n))
    for ch in range(2):
        noise = r.standard_normal(n)
        lo = lowpass(noise, 700)
        mid = bandpass(noise, 700, 3800)
        hi = highpass(noise, 3800)
        ir[ch] = (
            lo * np.exp(-t * 6.9 / t60)
            + mid * np.exp(-t * 6.9 / (t60 * 0.72))
            + 0.55 * hi * np.exp(-t * 6.9 / (t60 * 0.35 * bright))
        )
    ir *= np.minimum(1, t / 0.006)
    pd = int(predelay * SR)
    ir = np.pad(ir, ((0, 0), (pd, 0)))[:, :n]
    return ir / np.sqrt(np.sum(ir**2, axis=1, keepdims=True))


def reverb(dry: np.ndarray, ir: np.ndarray) -> np.ndarray:
    wet = np.vstack([signal.fftconvolve(dry[c], ir[c])[:N] for c in range(2)])
    return wet


# ---------------------------------------------------------------- score

C = CUES
keys = stereo()
fx = stereo()
music = stereo()
pads = stereo()
subs = stereo()
wall = stereo()  # sounds heard "through the wall" while the app is closed

# Typing: one click per character, following the picture exactly.
for i, (t0, ch) in enumerate(zip(C["typeTimes"], C["request"])):
    kind = "space" if ch == " " else "normal"
    place(keys, key_click(kind, 100 + i), t0 - 0.004, 0.26, pan=-0.12 + 0.24 * (i / len(C["request"])))
place(keys, key_click("enter", 999), C["enter"] - 0.004, 0.36, pan=0.05)

# The agent takes the task: a soft low bloom and a D add9 bed.
place(subs, sub(note("D2"), 3.6, 0.9), C["enter"], 0.30)
place(pads, pad([note("D3"), note("A3"), note("E4"), note("F#4")], C["closeStart"] + 0.5 - C["enter"], 1.4, 0.8, 1100, 1), C["enter"] + 0.05, 0.12)

# It reads the day: six glints as the outlines trace today's appointments.
for i in range(6):
    place(fx, glass(note("D7") * (1 + 0.0 * i), 0.3, 1.0), C["scanStart"] + i * C["scanStagger"], 0.035, pan=-0.6)

# Two appointments lift and land in view: lift swish, landing note.
motif_live = [note("F#5"), note("A5")]
for i, mv in enumerate(C["moves"]):
    place(fx, whoosh(0.5, 700, 2600, 30 + i), mv["start"] - 0.04, 0.075, pan=-0.3 + 0.5 * i)
    place(music, felt_piano(motif_live[i], 3.6, 0.9), mv["land"] - 0.012, 0.34, pan=0.25 + 0.15 * i)
    place(fx, key_click("normal", 700 + i), mv["land"] - 0.006, 0.06, pan=0.3)

# "You can close the app": a small, polite pop.
place(fx, glass(note("A6"), 0.25, 1.0), C["toast"] + 0.05, 0.04, pan=0.0)

# Close: a downward swish and a soft thump; the world goes muffled.
place(fx, whoosh(C["closeEnd"] - C["closeStart"] + 0.1, 2600, 280, 50), C["closeStart"] - 0.02, 0.11)
place(subs, sub(58.0, 0.7, 0.03), C["closeEnd"] - 0.12, 0.22)
place(pads, pad([note("B2"), note("F#3"), note("A3"), note("D4")], C["openEnd"] + 0.6 - C["closeStart"], 0.6, 0.7, 520, 2), C["closeStart"] + 0.1, 0.11)

# Behind the wall, the work continues: the next four notes of the motif.
for i, (t0, n) in enumerate(zip(C["hiddenMoves"], ["B5", "A5", "F#5", "E5"])):
    place(wall, felt_piano(note(n), 3.0, 0.85), t0, 0.30, pan=0.1 * (i - 1.5))

# Reopen: an upward swish, a G major 9 bloom, and a warm dyad.
place(fx, whoosh(C["openEnd"] - C["openStart"] + 0.1, 280, 2600, 60), C["openStart"] - 0.03, 0.10)
place(pads, pad([note("G2"), note("D3"), note("A3"), note("B3"), note("F#4")], C["sendTap"] + 0.6 - C["openStart"], 0.5, 0.7, 1300, 3), C["openStart"] + 0.15, 0.13)
place(music, felt_piano(note("D5"), 3.2, 0.6), C["openEnd"], 0.18, pan=-0.2)
place(music, felt_piano(note("A5"), 3.2, 0.55), C["openEnd"] + 0.03, 0.15, pan=0.2)
place(subs, sub(note("G1"), 2.2, 0.35), C["openStart"] + 0.1, 0.18)

# The approval card rises; she taps Send; six messages leave.
place(fx, whoosh(0.4, 900, 1900, 70), C["cardIn"] - 0.02, 0.05)
place(fx, key_click("enter", 1200), C["sendTap"] - 0.005, 0.24)
sparkle = ["D6", "E6", "F#6", "A6", "B6", "D7"]
for i, (t0, n) in enumerate(zip(C["sentTicks"], sparkle)):
    place(fx, glass(note(n), 0.45, 1.0), t0, 0.07, pan=-0.45 + 0.18 * i)

# Resolution: D/F#.
resolve_at = C["sentTicks"][-1]
place(pads, pad([note("F#2"), note("D3"), note("A3"), note("E4")], C["slideStart"] + 0.7 - resolve_at, 0.35, 1.0, 1400, 4), resolve_at - 0.1, 0.15)
place(music, felt_piano(note("D4"), 4.5, 0.75), resolve_at + 0.02, 0.22, pan=-0.15)
place(subs, sub(note("F#1"), 2.6, 0.2), resolve_at, 0.2)

# "One sentence for her." — a warm D major voicing.
for j, n in enumerate(["D4", "F#4", "A4"]):
    place(music, felt_piano(note(n), 4.5, 0.62 - j * 0.04), C["superHer"] + j * 0.018, 0.2, pan=-0.3 + 0.3 * j)

# Her app slides away and uncovers the code beneath it: E minor 9.
place(fx, whoosh(C["slideEnd"] - C["slideStart"] + 0.2, 240, 1100, 80, 1.3), C["slideStart"] - 0.05, 0.12)
place(subs, sub(note("E2"), 2.4, 0.8), C["slideStart"] + 0.2, 0.24)
place(pads, pad([note("E2"), note("B2"), note("F#3"), note("G3"), note("D4")], C["highlights"][0]["start"] + 0.5 - C["slideStart"] + 0.2, 1.0, 0.9, 1000, 5), C["slideStart"] + 0.2, 0.14)

# "One handler for you." — the answering E minor voicing.
for j, n in enumerate(["E4", "G4", "B4"]):
    place(music, felt_piano(note(n), 4.5, 0.6 - j * 0.04), C["superYou"] + j * 0.018, 0.19, pan=0.0 + 0.3 * j)

# Code highlights over A7sus4, each replaying the moment it caused.
hl = {h["key"]: h for h in C["highlights"]}
push_at = hl["tools"]["start"] - 0.9
place(pads, pad([note("A2"), note("E3"), note("G3"), note("D4")], C["finalStart"] + 0.5 - push_at, 0.7, 0.8, 1100, 6), push_at + 0.1, 0.14)
place(fx, whoosh(0.9, 380, 1500, 90), push_at - 0.02, 0.06)
place(fx, whoosh(0.5, 700, 2600, 31), hl["tools"]["start"] - 0.04, 0.05)
place(music, felt_piano(note("F#5"), 3.0, 0.8), hl["tools"]["start"], 0.28, pan=0.2)
place(music, felt_piano(note("A5"), 3.0, 0.8), hl["tools"]["start"] + 0.16, 0.28, pan=0.3)
SEND_REPLICA_PRESS = 0.6  # matches CodePage.tsx
place(fx, key_click("enter", 1300), hl["approval"]["start"] + SEND_REPLICA_PRESS - 0.005, 0.18)
for i, n in enumerate(["A5", "B5", "D6"]):
    place(fx, glass(note(n), 0.45, 1.0), hl["approval"]["start"] + SEND_REPLICA_PRESS + 0.09 + i * 0.08, 0.065, pan=-0.2 + 0.2 * i)

# The whole idea in one frame, with the sign-off: home to D.
place(fx, whoosh(1.2, 1400, 300, 100, 1.3), C["finalStart"] - 0.05, 0.07)
place(pads, pad([note("D2"), note("A2"), note("F#3"), note("E4"), note("A4")], C["duration"] + 0.2 - C["finalStart"], 0.8, 2.2, 1250, 7), C["finalStart"] + 0.1, 0.16)
place(subs, sub(note("D2"), 3.5, 0.5), C["finalStart"] + 0.15, 0.26)
for j, n in enumerate(["D3", "A3", "F#4", "D5"]):
    place(music, felt_piano(note(n), 5.0, 0.7 - j * 0.05), C["finalEnd"] - 0.35 + j * 0.022, 0.2, pan=-0.35 + 0.23 * j)

# Sign-off: the wordmark arrives on a last octave D, then silence.
place(music, felt_piano(note("D4"), 5.0, 0.7), C["brandIn"] + 0.05, 0.22, pan=-0.1)
place(music, felt_piano(note("D5"), 5.0, 0.55), C["brandIn"] + 0.07, 0.16, pan=0.1)

# ---------------------------------------------------------------- mix

t = np.arange(N) / SR
closed = np.clip((t - C["closeStart"]) / (C["closeEnd"] - C["closeStart"]), 0, 1) * (
    1 - np.clip((t - C["openStart"]) / (C["openEnd"] - C["openStart"]), 0, 1)
)
closed = 0.5 - 0.5 * np.cos(np.pi * closed)

room = make_ir(1.1, 7, 1.0)
hall = make_ir(2.8, 8, 0.8)

# Bus balance: the motif leads; pads sit underneath; sub is felt, not heard.
keys = keys * 0.46  # foley, not lead: a hushed opening; the score blooms on Enter
fx = lowpass(fx, 7500, 2) * 0.85
music = music * 1.6
pads = highpass(pads, 110, 2) * 0.66
subs = lowpass(subs, 160, 2) * 0.3
wall = wall * 0.68

world = keys + fx + pads * 0.9
world = world * (1 - closed) + lowpass(world, 520, 2) * closed * 0.8
music_bus = music * (1 - 0.6 * closed)
wall_bus = lowpass(wall, 640, 2) * 0.9

mix = (
    world
    + 0.22 * reverb(keys + fx, room)
    + music_bus
    + 0.34 * reverb(music_bus + pads * 0.7, hall)
    + wall_bus
    + 0.55 * reverb(wall_bus, hall)
    + subs
)
mix = highpass(mix, 28, 2)


def biquad(kind: str, f0: float, gain_db: float, q: float = 0.707):
    """RBJ cookbook shelf/peak biquad, returned as (b, a)."""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / SR
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    if kind == "low":
        b = [A * ((A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * alpha), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * alpha)]
        a = [(A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * alpha, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * alpha]
    elif kind == "high":
        b = [A * ((A + 1) + (A - 1) * cw + 2 * np.sqrt(A) * alpha), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - 2 * np.sqrt(A) * alpha)]
        a = [(A + 1) - (A - 1) * cw + 2 * np.sqrt(A) * alpha, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - 2 * np.sqrt(A) * alpha]
    else:
        b = [1 + alpha * A, -2 * cw, 1 - alpha * A]
        a = [1 + alpha / A, -2 * cw, 1 - alpha / A]
    return np.array(b) / a[0], np.array(a) / a[0]


# Master EQ for small-speaker translation (phones cannot reproduce the sub
# region, and presence carries the motif): gentle shelves, one soft peak.
for kind, f0, g, q in (("low", 110, -2.0, 0.707), ("high", 3500, 3.0, 0.707), ("peak", 2500, 1.5, 0.9)):
    b_, a_ = biquad(kind, f0, g, q)
    mix = signal.lfilter(b_, a_, mix, axis=-1)
end = int((DUR - 0.08) * SR)
mix[:, end:] *= 0
fade_n = int(0.6 * SR)
mix[:, end - fade_n : end] *= np.linspace(1, 0, fade_n) ** 1.5


def integrated_lufs(x: np.ndarray) -> float:
    b1, a1 = [1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585]
    b2, a2 = [1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621]
    k = signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=-1), axis=-1)
    block, hop = int(0.4 * SR), int(0.1 * SR)
    z = np.array([np.mean(k[:, i : i + block] ** 2, axis=1).sum() for i in range(0, k.shape[1] - block, hop)])
    lk = -0.691 + 10 * np.log10(z + 1e-12)
    z = z[lk > -70]
    rel = -0.691 + 10 * np.log10(np.mean(z)) - 10
    z = z[(-0.691 + 10 * np.log10(z + 1e-12)) > rel]
    return -0.691 + 10 * np.log10(np.mean(z))


def true_peak_limit(x: np.ndarray, ceiling_db: float) -> np.ndarray:
    ceiling = 10 ** (ceiling_db / 20)
    up = signal.resample_poly(x, 4, 1, axis=-1)
    peak = np.max(np.abs(up), axis=0).reshape(-1, 4).max(axis=1)[: x.shape[1]]
    peak = np.pad(peak, (0, x.shape[1] - len(peak)), constant_values=0)
    gain = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    look = int(0.004 * SR)
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    # Centred minimum then a shorter moving average: the smoothed gain can never
    # exceed the instantaneous requirement, so no overshoot reaches the output.
    g = uniform_filter1d(minimum_filter1d(gain, 2 * look + 1), look)
    return x * g


loud = integrated_lufs(mix)
mix *= 10 ** ((TARGET_LUFS - loud) / 20)
mix = true_peak_limit(mix, CEILING_DBTP - 0.3)
final_lufs = integrated_lufs(mix)
peak_db = 20 * np.log10(np.max(np.abs(signal.resample_poly(mix, 4, 1, axis=-1))) + 1e-12)

out_dir = ROOT / "public" / "audio"
out_dir.mkdir(parents=True, exist_ok=True)
pcm = np.clip(mix.T, -1, 1)
ints = (pcm * (2**23 - 1)).astype(np.int32)
raw = np.zeros((ints.shape[0], 2, 3), dtype=np.uint8)
for b in range(3):
    raw[:, :, b] = (ints >> (8 * b)) & 0xFF
with wave.open(str(out_dir / "score.wav"), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(3)
    w.setframerate(SR)
    w.writeframes(raw.tobytes())

print(f"score.wav: {N / SR:.2f}s, integrated {final_lufs:.2f} LUFS, true peak ~{peak_db:.2f} dBTP", file=sys.stderr)

if "--stems" in sys.argv:
    def db(x):
        return 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12)
    def pk(x):
        return 20 * np.log10(np.max(np.abs(x)) + 1e-12)
    for name, stem in [("keys", keys), ("fx", fx), ("music", music), ("pads", pads), ("subs", subs), ("wall", wall)]:
        active = stem[:, np.max(np.abs(stem), axis=0) > 1e-4]
        print(f"{name:6s} rms(active) {db(active):6.1f} dBFS  peak {pk(stem):6.1f} dBFS", file=sys.stderr)
