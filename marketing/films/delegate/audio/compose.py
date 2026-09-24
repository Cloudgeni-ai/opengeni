"""Original score + sound design for "The Last Click".

Everything is generated here from audio/cues.json (exported from the picture
timeline), so sound is frame-locked to picture by construction.

Instruments: acoustic piano, celesta and marimba are rendered with fluidsynth
from the MuseScore General SoundFont (MIT); the pad, sub bass and all sound
effects are synthesized below. No samples of existing recordings are used.

Run: python3 audio/compose.py  ->  public/audio/mix.wav (48 kHz, 24-bit)
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import mido
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy import signal as sig

ROOT = Path(__file__).resolve().parent.parent
SR = 48000
SF2 = os.environ.get("OPENGENI_FILM_SF2", "/usr/share/sounds/sf2/MuseScore_General_Full.sf2")
STEMS = ROOT / "audio" / "stems"
STEMS.mkdir(parents=True, exist_ok=True)
cues = json.loads((ROOT / "audio" / "cues.json").read_text())
T = cues["T"]
BEAT = cues["beat"]
DUR = cues["duration"]
N = int(round(DUR * SR))
TAIL = int(1.0 * SR)
rng = np.random.default_rng(20260924)

NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi(name: str) -> int:
    pitch, octave = name[:-1], int(name[-1])
    n = NAMES[pitch[0]] + (1 if "#" in pitch else -1 if "b" in pitch else 0)
    return 12 * (octave + 1) + n


def hz(name: str) -> float:
    return 440.0 * 2 ** ((midi(name) - 69) / 12)


def buf(seconds: float | None = None) -> np.ndarray:
    return np.zeros((N + TAIL if seconds is None else int(seconds * SR), 2))


def place(dst: np.ndarray, src: np.ndarray, t: float, gain: float = 1.0, pan: float = 0.0) -> None:
    """Add mono/stereo `src` into `dst` at time t (s). pan -1..1 (constant power)."""
    if src.ndim == 1:
        a = (pan + 1) * np.pi / 4
        src = np.stack([src * np.cos(a), src * np.sin(a)], axis=1)
    i = int(round(t * SR))
    if i >= len(dst):
        return
    j = min(len(dst), i + len(src))
    if i < 0:
        src = src[-i:]
        i = 0
    dst[i:j] += src[: j - i] * gain


def sos(kind: str, f, order: int = 2):
    return sig.butter(order, f, btype=kind, fs=SR, output="sos")


def filt(x: np.ndarray, kind: str, f, order: int = 2) -> np.ndarray:
    return sig.sosfilt(sos(kind, f, order), x, axis=0)


def env_ar(n: int, attack: float, release: float) -> np.ndarray:
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    return a * np.exp(-t / release)


def db(x: float) -> float:
    return 10 ** (x / 20)


# ---------------------------------------------------------------------------
# Score (seconds). Key: D major, 75 BPM. Harmony follows the story:
#   night (Bm7, Gmaj7) → delegation (Em9, Asus4) → work (D, A/C#) →
#   the question (Bm7, Asus4 → A) → THE LAST CLICK (D add9) →
#   brand morning (G add9, Em7, A, Bm7, A) → cadence G–A–D on the end line.
# ---------------------------------------------------------------------------
Note = tuple  # (time, name, dur, velocity)

piano: list[Note] = []
celesta: list[Note] = []
marimba: list[Note] = []


def roll(lst, t, names, dur, vel, spread=0.028, dv=0):
    for k, n in enumerate(names):
        lst.append((t + k * spread, n, dur - k * spread, max(1, vel - dv * k)))


def B(k: int, beat: float = 0.0) -> float:
    """Time of bar k (0 = the ask, 1 = Enter, 3 = the question, 4 = THE LAST
    CLICK, 5 = "hour", 7 = the end line), plus beats. Mirrors src/timeline.ts."""
    return cues["downbeat0"] + cues["bar"] * k + BEAT * beat


# Night (pickup): a low dyad under the first frame; then a sparse, patient motif.
roll(piano, 0.02, ["B1", "F#2"], 2.8, 44, spread=0.0)
piano += [(B(0), "F#4", 1.0, 40), (B(0, 1), "A4", 0.9, 36), (B(0, 2), "B4", 1.1, 42), (B(0, 3), "A4", 1.0, 34)]
roll(piano, B(0), ["G2", "D3"], 3.0, 30, spread=0.0)
# Enter: the exhale.
roll(piano, B(1), ["E3", "B3", "D4", "F#4", "G4"], 1.9, 46, spread=0.035, dv=2)
roll(piano, B(1, 2), ["A2", "D4", "E4"], 1.6, 34, spread=0.03)
# The work.
roll(piano, B(2), ["D2", "A2"], 1.7, 38, spread=0.0)
roll(piano, B(2, 2), ["C#3", "A3"], 1.6, 34, spread=0.0)
# The question.
roll(piano, B(3), ["B2", "F#3", "A3", "D4"], 1.8, 40, spread=0.04)
roll(piano, B(3, 2), ["A2", "E3", "D4"], 1.7, 34, spread=0.03)
piano += [(B(3, 3), "E5", 0.8, 28), (B(3, 3.5), "E5", 0.4, 30)]
# THE LAST CLICK — resolution.
roll(piano, B(4), ["D2", "A2", "D3", "F#3", "A3", "E4", "F#4", "A4"], 3.0, 64, spread=0.022, dv=2)
roll(piano, B(4, 2), ["G3", "B3", "D4"], 1.4, 30, spread=0.03)
# Morning: the paper rises on the downbeat; the backstage walk-through.
roll(piano, T["wipe"], ["G3", "D4", "A4", "B4", "D5"], 2.0, 50, spread=0.03, dv=2)
roll(piano, B(5, 2), ["E3", "B3", "D4", "G4"], 0.8, 36, spread=0.025)
roll(piano, B(5, 3), ["A2", "E3", "C#4", "E4"], 0.8, 38, spread=0.025)
roll(piano, B(6), ["B2", "F#3", "A3", "D4"], 0.8, 38, spread=0.025)
roll(piano, B(6, 1), ["G2", "D3", "B3", "D4"], 0.8, 40, spread=0.025)
roll(piano, B(6, 2), ["C#3", "E3", "A3", "E4"], 0.8, 40, spread=0.025)
roll(piano, B(6, 3), ["B2", "F#3", "A3", "D4"], 0.8, 36, spread=0.025)
roll(piano, B(7), ["G2", "D3", "B3", "D4", "G4"], 0.85, 48, spread=0.025, dv=1)
roll(piano, B(7, 1), ["A2", "E3", "C#4", "E4", "A4"], 0.85, 50, spread=0.025, dv=1)
roll(piano, B(7, 2), ["D2", "A2", "F#3", "A3", "D4", "F#4", "A4", "D5"], 2.4, 56, spread=0.024, dv=2)

# Checking history: glassy steps up the D pentatonic, one per client.
for t, n in zip(cues["chips"], ["D5", "E5", "F#5", "A5", "B5", "D6", "E6"]):
    celesta.append((t, n, 0.9, 42))
# Seven messages sent: a cascade settling downwards.
for t, n in zip(cues["sends"], ["A6", "F#6", "E6", "D6", "B5", "A5", "F#5"]):
    celesta.append((t, n, 0.9, 40))
celesta += [(T["wipe"] + 0.12, "D6", 1.4, 30), (T["wipe"] + 0.3, "A6", 1.4, 26)]

# Each booking landing is a step up: the work becomes a melody.
for t, n in zip(cues["landings"], ["A4", "B4", "D5", "E5", "F#5", "A5", "B5"]):
    marimba.append((t, n, 0.6, 62))
# The three annotations: "yours", rising.
for t, n in [(T["ann1"], "A4"), (T["ann2"], "B4"), (T["ann3"], "D5")]:
    marimba.append((t, n, 0.6, 54))
marimba.append((T["mark"] + 0.024 * 8, "A5", 1.2, 40))

PAD_CHORDS = [
    (0.0, B(0), ["B2", "F#3", "A3", "D4"]),
    (B(0), B(1), ["G2", "D3", "F#3", "B3"]),
    (B(1), B(1, 2), ["E2", "B2", "G3", "D4", "F#4"]),
    (B(1, 2), B(1, 3), ["A2", "E3", "A3", "D4"]),
    (B(1, 3), B(2), ["A2", "E3", "A3", "C#4"]),
    (B(2), B(2, 2), ["D3", "A3", "D4", "F#4"]),
    (B(2, 2), B(3), ["C#3", "E3", "A3", "E4"]),
    (B(3), B(3, 2), ["B2", "F#3", "A3", "D4"]),
    (B(3, 2), B(3, 3.5), ["A2", "E3", "A3", "D4"]),
    (B(3, 3.5), B(4), ["A2", "E3", "A3", "C#4"]),
    (B(4), B(5), ["D3", "A3", "E4", "F#4"]),
    (B(5), B(5, 2), ["G3", "D4", "A4", "B4"]),
    (B(5, 2), B(5, 3), ["E3", "G3", "B3", "D4"]),
    (B(5, 3), B(6), ["A2", "E3", "A3", "C#4"]),
    (B(6), B(6, 1), ["B2", "F#3", "A3", "D4"]),
    (B(6, 1), B(6, 2), ["G2", "D3", "G3", "B3"]),
    (B(6, 2), B(6, 3), ["C#3", "E3", "A3", "E4"]),
    (B(6, 3), B(7), ["B2", "F#3", "A3", "D4"]),
    (B(7), B(7, 1), ["G2", "D3", "G3", "B3"]),
    (B(7, 1), B(7, 2), ["A2", "E3", "A3", "C#4"]),
    (B(7, 2), DUR + 0.6, ["D3", "A3", "D4", "F#4"]),
]
BASS = [
    (B(1), B(1, 2), "E2"), (B(1, 2), B(2), "A1"), (B(2), B(2, 2), "D2"), (B(2, 2), B(3), "C#2"),
    (B(3), B(3, 2), "B1"), (B(3, 2), B(4), "A1"), (B(4), B(5) - 0.2, "D2"),
    (B(5), B(5, 2), "G1"), (B(5, 2), B(5, 3), "E2"), (B(5, 3), B(6), "A1"), (B(6), B(6, 1), "B1"),
    (B(6, 1), B(6, 2), "G1"), (B(6, 2), B(6, 3), "C#2"), (B(6, 3), B(7), "B1"),
    (B(7), B(7, 1), "G1"), (B(7, 1), B(7, 2), "A1"), (B(7, 2), DUR + 0.4, "D2"),
]


# ---------------------------------------------------------------------------
# fluidsynth rendering
# ---------------------------------------------------------------------------
def render_sf(notes: list[Note], program: int, name: str, gain: float = 0.7) -> np.ndarray:
    mid = mido.MidiFile(ticks_per_beat=480)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=500000))  # 960 ticks per second
    tr.append(mido.Message("program_change", program=program, channel=0, time=0))
    tr.append(mido.Message("control_change", control=91, value=0, channel=0, time=0))
    tr.append(mido.Message("control_change", control=93, value=0, channel=0, time=0))
    ev = []
    for t, n, d, v in notes:
        ev.append((t, 1, midi(n), int(v)))
        ev.append((t + max(0.05, d), 0, midi(n), 0))
    ev.sort(key=lambda e: (e[0], e[1]))
    last = 0
    for t, on, m, v in ev:
        tick = int(round(t * 960))
        tr.append(mido.Message("note_on" if on else "note_off", note=m, velocity=v, channel=0, time=tick - last))
        last = tick
    tr.append(mido.MetaMessage("end_of_track", time=int(2.5 * 960)))
    mid_path, wav_path = STEMS / f"{name}.mid", STEMS / f"{name}.wav"
    mid.save(mid_path)
    subprocess.run(
        ["fluidsynth", "-ni", "-q", "-R", "0", "-C", "0", "-g", str(gain), "-r", str(SR), "-F", str(wav_path), SF2, str(mid_path)],
        check=True,
        capture_output=True,
    )
    data, sr = sf.read(wav_path, always_2d=True)
    assert sr == SR, sr
    out = buf()
    n = min(len(out), len(data))
    out[:n] = data[:n]
    return out


# ---------------------------------------------------------------------------
# Synth voices
# ---------------------------------------------------------------------------
def saw_voice(f: float, n: int, detune_cents: float, phase: float) -> np.ndarray:
    """Soft, rounded saw (1/k^1.6 roll-off): warm rather than buzzy."""
    t = np.arange(n) / SR
    ff = f * 2 ** (detune_cents / 1200)
    out = np.zeros(n)
    k = 1
    while ff * k < 5000 and k <= 12:
        out += np.sin(2 * np.pi * ff * k * t + phase * k) / k**1.6
        k += 1
    return out


def make_pad() -> np.ndarray:
    out = buf()
    for start, end, names in PAD_CHORDS:
        n = int((end - start + 1.6) * SR)
        for name in names:
            f = hz(name)
            left = saw_voice(f, n, -6, rng.uniform(0, 6.28)) + saw_voice(f, n, 4, rng.uniform(0, 6.28))
            right = saw_voice(f, n, 6, rng.uniform(0, 6.28)) + saw_voice(f, n, -3, rng.uniform(0, 6.28))
            v = np.stack([left, right], axis=1) / len(names)
            t = np.arange(n) / SR
            dur = end - start
            e = np.clip(t / 0.55, 0, 1) ** 1.5
            rel = np.clip((t - dur) / 1.2, 0, 1)
            e = e * (1 - rel) ** 2
            place(out, v * e[:, None], start)
    out = filt(out, "lowpass", 1150, 4)
    out = filt(out, "highpass", 120, 2)
    return out


def make_bass() -> np.ndarray:
    out = buf()
    for start, end, name in BASS:
        f = hz(name)
        n = int((end - start + 0.5) * SR)
        t = np.arange(n) / SR
        dur = end - start
        e = np.clip(t / 0.06, 0, 1) * np.clip(1 - (t - dur + 0.25) / 0.5, 0, 1)
        v = (np.sin(2 * np.pi * f * t) + 0.18 * np.sin(4 * np.pi * f * t) + 0.05 * np.sin(6 * np.pi * f * t)) * e
        place(out, v, start)
    return filt(out, "lowpass", 400, 2)


def make_ir(rt60: float, length: float, predelay: float, damp: float, seed: int) -> np.ndarray:
    n = int(length * SR)
    t = np.arange(n) / SR
    r = np.random.default_rng(seed)
    ir = np.zeros((n, 2))
    w = np.clip(t / rt60, 0, 1)
    for ch in range(2):
        x = r.standard_normal(n) * np.exp(-6.908 * t / rt60)
        a = sig.sosfilt(sos("lowpass", damp), x)
        b = sig.sosfilt(sos("lowpass", damp / 3.5), x)
        ir[:, ch] = a * (1 - w) + b * w
    pd = int(predelay * SR)
    ir = np.vstack([np.zeros((pd, 2)), ir])[:n]
    return ir / np.sqrt(np.sum(ir**2, axis=0, keepdims=True))


def reverb(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    y = np.stack([sig.fftconvolve(x[:, c], ir[:, c])[: len(x)] for c in range(2)], axis=1)
    return y


# ---------------------------------------------------------------------------
# Sound design
# ---------------------------------------------------------------------------
def mouse_click(seed: int, weight: float = 1.0) -> np.ndarray:
    r = np.random.default_rng(seed)
    n = int(0.16 * SR)
    t = np.arange(n) / SR
    press = sig.sosfilt(sos("bandpass", [1800, 7500]), r.standard_normal(n) * np.exp(-t / 0.0015))
    ping = np.sin(2 * np.pi * 3150 * t) * np.exp(-t / 0.0045) * 0.55
    body = np.sin(2 * np.pi * 980 * t) * np.exp(-t / 0.006) * 0.35
    thump = np.sin(2 * np.pi * 165 * t) * np.exp(-t / 0.012) * 0.45 * weight
    s = press + ping + body + thump
    k = int(0.068 * SR)
    tr = t[: n - k]
    rel = sig.sosfilt(sos("bandpass", [2600, 8500]), r.standard_normal(n - k) * np.exp(-tr / 0.0011)) * 0.3
    rel += np.sin(2 * np.pi * 3700 * tr) * np.exp(-tr / 0.003) * 0.14
    s[k:] += rel
    return s / np.max(np.abs(s))


def key_tap(seed: int, deep: float = 0.0) -> np.ndarray:
    r = np.random.default_rng(seed)
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    f1 = r.uniform(1500, 2300) * (1 - 0.35 * deep)
    tick = sig.sosfilt(sos("bandpass", [f1 * 0.6, f1 * 2.2]), r.standard_normal(n) * np.exp(-t / 0.0022))
    thock = np.sin(2 * np.pi * r.uniform(230, 290) * (1 - 0.3 * deep) * t) * np.exp(-t / 0.01) * (0.5 + 0.5 * deep)
    s = tick + thock
    return s / np.max(np.abs(s))


def clock_tick(high: bool) -> np.ndarray:
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    f = 2350 if high else 1750
    s = sig.sosfilt(sos("bandpass", [f * 0.8, f * 1.25]), rng.standard_normal(n) * np.exp(-t / 0.004))
    s += np.sin(2 * np.pi * f * 1.41 * t) * np.exp(-t / 0.006) * 0.3
    return s / np.max(np.abs(s))


def flop() -> np.ndarray:
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * (60 + 55 * np.exp(-t / 0.05)) * t) * np.exp(-t / 0.07)
    air = sig.sosfilt(sos("lowpass", 700), rng.standard_normal(n)) * np.exp(-t / 0.05) * 0.6
    s = body + air
    return s / np.max(np.abs(s))


def swell(length: float, f0: float, f1: float, peak_at: float = 0.85, seed: int = 3) -> np.ndarray:
    """Airy noise rise with a moving band (used for flights, flap and wipe)."""
    r = np.random.default_rng(seed)
    n = int(length * SR)
    t = np.arange(n) / SR
    x = r.standard_normal(n)
    out = np.zeros(n)
    blocks = 64
    edges = np.linspace(0, n, blocks + 1).astype(int)
    zi = None
    for b in range(blocks):
        a, e = edges[b], edges[b + 1]
        fc = f0 * (f1 / f0) ** (b / (blocks - 1))
        s = sos("bandpass", [fc * 0.6, min(fc * 1.7, SR / 2 - 100)])
        if zi is None:
            zi = sig.sosfilt_zi(s) * 0
        y, zi = sig.sosfilt(s, x[a:e], zi=zi)
        out[a:e] = y
    k = t / length
    envl = np.where(k < peak_at, (k / peak_at) ** 2, np.exp(-(k - peak_at) * length / 0.08))
    out *= envl
    return out / (np.max(np.abs(out)) + 1e-9)


def sub_thump() -> np.ndarray:
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    s = np.sin(2 * np.pi * (48 + 30 * np.exp(-t / 0.04)) * t) * np.exp(-t / 0.16)
    return s / np.max(np.abs(s))


def time_varying_lowpass(x: np.ndarray, cutoff_at) -> np.ndarray:
    out = np.zeros_like(x)
    block = 512
    zi = np.zeros((1, 2, 2))
    for a in range(0, len(x), block):
        e = min(len(x), a + block)
        fc = cutoff_at((a + e) / 2 / SR)
        s = sos("lowpass", min(fc, SR / 2 - 200), 2)
        for c in range(2):
            y, zc = sig.sosfilt(s, x[a:e, c], zi=zi[:, c, :])
            out[a:e, c] = y
            zi[:, c, :] = zc
    return out


def norm_active(x: np.ndarray, target_db: float = -20.0) -> np.ndarray:
    """Scale so the RMS of the audible (non-silent) 50 ms frames hits target."""
    mono = x.mean(axis=1) if x.ndim == 2 else x
    frame = int(0.05 * SR)
    usable = len(mono) // frame * frame
    r = np.sqrt(np.mean(mono[:usable].reshape(-1, frame) ** 2, axis=1))
    loud = r[r > np.max(r) * db(-40)]
    rms = np.sqrt(np.mean(loud**2)) if len(loud) else 1.0
    return x * db(target_db) / max(rms, 1e-9)


def automation(points: list[tuple[float, float]]) -> np.ndarray:
    """Piecewise-linear gain curve from (time s, dB) points."""
    tt = np.arange(N + TAIL) / SR
    ts, ds = zip(*points)
    return 10 ** (np.interp(tt, ts, ds) / 20)


PAD_LEVELS = [
    (0.0, -26), (0.8, -12), (B(1) - 0.1, -12), (B(1) + 0.6, -2), (B(3), -3), (B(3) + 0.6, -9), (B(3, 2), -8),
    (B(4) - 0.05, -2), (B(4) + 0.05, 2), (B(4, 2), -3), (B(4, 3), -9), (T["wipe"] - 0.1, -12), (T["wipe"] + 0.5, -1),
    (B(7), -2), (B(7, 2), 1), (DUR, 0),
]
BASS_LEVELS = [
    (0.0, -40), (B(1) - 0.05, -40), (B(1) + 0.2, -3), (B(3), -3), (B(3) + 0.5, -8), (B(4) - 0.1, -2),
    (B(4) + 0.05, 2), (B(4, 3) - 0.4, -4), (B(5), -2), (DUR, -2),
]
MUSIC_LEVELS = [
    (0.0, -3.5), (B(0), -4.5), (B(1) - 0.1, -3), (B(1) + 0.8, 0), (B(3) - 0.2, 0), (B(3) + 0.5, -4), (B(3, 2), -4.5),
    (B(4) - 0.1, -1.5), (B(4) + 0.02, 1.0), (B(4, 1.8), 0), (T["dim"], -1), (T["dim"] + 0.9, -5), (T["wipe"] - 0.1, -5.5),
    (T["wipe"] + 0.5, 0), (B(7), 0), (B(7, 2), 1), (DUR, 0),
]


def limiter(x: np.ndarray, ceiling_db: float = -1.2, look: float = 0.004, release: float = 0.08) -> np.ndarray:
    ceiling = db(ceiling_db)
    up = sig.resample_poly(x, 4, 1, axis=0)
    peak = np.max(np.abs(up), axis=1)
    peak = peak.reshape(-1, 4).max(axis=1)[: len(x)]
    need = np.minimum(1.0, ceiling / np.maximum(peak, 1e-9))
    w = int(look * SR)
    from scipy.ndimage import minimum_filter1d

    g = minimum_filter1d(need, size=2 * w + 1)
    a_rel = np.exp(-1 / (release * SR))
    sm = np.empty_like(g)
    cur = 1.0
    for i, v in enumerate(g):
        cur = v if v < cur else a_rel * cur + (1 - a_rel) * v
        sm[i] = cur
    return x * sm[:, None]


def main() -> None:
    print("rendering instruments with fluidsynth …")
    pno = render_sf(piano, 0, "piano", gain=0.9)
    cel = render_sf(celesta, 8, "celesta", gain=0.8)
    mar = render_sf(marimba, 12, "marimba", gain=0.8)
    # Reverse-piano swell into THE LAST CLICK: render the chord, flip it.
    swell_chord = [(0.0, n, 2.4, 52) for n in ["A2", "E3", "A3", "C#4", "E4"]]
    rev = render_sf(swell_chord, 0, "swell", gain=0.9)[: int(2.2 * SR)][::-1]
    rev = filt(rev, "lowpass", 5000)
    print("synthesizing pad, bass, sound design …")
    pad = make_pad()
    bass = make_bass()

    pno = filt(pno, "lowpass", 7000)
    cel = filt(cel, "lowpass", 9500)
    # Gain staging: every stem to the same active RMS, then deliberate levels.
    pno, cel, mar, pad, bass = (norm_active(s) for s in (pno, cel, mar, pad, bass))
    rev = norm_active(rev)
    pad *= automation(PAD_LEVELS)[:, None]
    bass *= automation(BASS_LEVELS)[:, None]
    music = pno * db(0) + mar * db(-1.5) + cel * db(-5.0) + pad * db(-14.0) + bass * db(-12.0)
    place(music, rev, T["approve"] - len(rev) / SR + 0.02, gain=db(-7.0))
    # The film's dynamic arc: intimate night, lift on delegation, held breath
    # on the question, bloom on the last click, dark, then morning.
    music *= automation(MUSIC_LEVELS)[:, None]

    # Lights out at 17.9 s: the music darkens; morning at the wipe restores it.
    def cutoff(t):
        if t < T["dim"]:
            return 19000.0
        if t < T["dim"] + 0.8:
            return 19000.0 * (2400 / 19000) ** ((t - T["dim"]) / 0.8)
        if t < T["wipe"]:
            return 2400.0
        if t < T["wipe"] + 0.5:
            return 2400.0 * (19000 / 2400) ** ((t - T["wipe"]) / 0.5)
        return 19000.0

    music = time_varying_lowpass(music, cutoff)
    hall = make_ir(rt60=2.6, length=3.2, predelay=0.022, damp=7000, seed=11)
    music = music * 0.82 + reverb(music, hall) * 0.36

    sfx = buf()
    pans = {T["benClick"]: -0.35, T["cancelClick"]: 0.12, T["askClick"]: -0.4, T["approve"]: -0.3}
    for i, t in enumerate(cues["clicks"]):
        last = abs(t - T["approve"]) < 1e-6
        place(sfx, mouse_click(100 + i, weight=1.6 if last else 1.0), t - 0.004, gain=db(-8.0 if last else -10.0), pan=pans.get(t, 0))
    place(sfx, sub_thump(), T["approve"], gain=db(-14.0))
    for i, k in enumerate(cues["keys"]):
        ch = k["ch"]
        deep = 1.0 if ch == " " else 0.0
        place(sfx, key_tap(300 + i, deep), k["t"] - 0.003, gain=db(-25.0 + rng.uniform(-2, 1.5)), pan=-0.3 + rng.uniform(-0.08, 0.08))
    place(sfx, key_tap(999, 0.8), T["enter"] - 0.004, gain=db(-18.0), pan=-0.25)
    # The clock: the night's pressure. It stops the moment she delegates.
    ticks = [b * BEAT for b in range(int(round(T["enter"] / BEAT)))]
    for j, t in enumerate(ticks):
        if any(abs(t - c) < 0.05 for c in cues["clicks"]):
            continue
        fade = 1.0 if t < T["enter"] - 1.7 else 0.7
        place(sfx, clock_tick(j % 2 == 0), t, gain=db(-30.0) * fade, pan=0.45)
    place(sfx, flop(), T["lieStart"] + 0.62, gain=db(-21.0), pan=0.2)
    place(sfx, flop(), T["lieAgain"] + 0.33, gain=db(-24.0), pan=0.1)
    for i, t in enumerate(cues["liftoffs"]):
        place(sfx, swell(0.42, 500, 2600, peak_at=0.55, seed=40 + i), t, gain=db(-33.0), pan=-0.4 + 0.12 * i)
    # Night into morning: an airy rise that crests as the paper edge passes.
    place(sfx, swell(0.8, 300, 3200, peak_at=0.92, seed=7), T["wipe"] - 0.72, gain=db(-30.0))
    place(sfx, swell(0.62, 250, 5200, peak_at=0.82, seed=9), T["wipe"] - 0.05, gain=db(-25.0))

    room_ir = make_ir(rt60=0.45, length=0.7, predelay=0.006, damp=9000, seed=5)
    sfx = sfx + reverb(sfx, room_ir) * 0.12

    # Night room tone until morning.
    room = filt(rng.standard_normal((N + TAIL, 2)) * 0.5, "lowpass", 1800)
    room = filt(room, "highpass", 60)
    tt = np.arange(N + TAIL) / SR
    room_env = np.clip(tt / 0.4, 0, 1) * np.clip((T["wipe"] + 0.3 - tt) / 0.5, 0, 1)
    sfx += room * db(-54.0) * room_env[:, None]

    mix = music + sfx
    mix = filt(mix, "highpass", 28, 2)
    mix = mix[:N]
    # Fade in over the scene fade, and out on the final frame.
    fi = np.clip(np.arange(N) / (0.05 * SR), 0, 1)
    fo = np.clip((N - np.arange(N)) / (0.9 * SR), 0, 1) ** 1.5
    mix *= (fi * fo)[:, None]

    meter = pyln.Meter(SR)
    target = -15.0
    for _ in range(3):
        lufs = meter.integrated_loudness(mix)
        mix = mix * db(target - lufs)
        mix = limiter(mix, ceiling_db=-1.3)
    lufs = meter.integrated_loudness(mix)
    up = sig.resample_poly(mix, 4, 1, axis=0)
    tp = 20 * np.log10(np.max(np.abs(up)) + 1e-12)
    out = ROOT / "public" / "audio" / "mix.wav"
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(out, mix.astype(np.float32), SR, subtype="PCM_24")
    sf.write(STEMS / "music.wav", music[:N].astype(np.float32), SR, subtype="PCM_24")
    sf.write(STEMS / "sfx.wav", sfx[:N].astype(np.float32), SR, subtype="PCM_24")
    print(f"{out}  duration {len(mix) / SR:.3f}s  integrated {lufs:.2f} LUFS  true-peak {tp:.2f} dBTP")


if __name__ == "__main__":
    main()
