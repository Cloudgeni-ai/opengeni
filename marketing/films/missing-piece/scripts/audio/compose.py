"""Original score and sound design for "The Missing Piece".

Everything is synthesised here from sine, FM and filtered-noise sources; there are no
samples, loops or third-party recordings. Cue times come from out/cues.json, which the
renderer exports from src/timeline.ts, so sound and picture share one timeline.

Musical idea (100 BPM, D major): while the bolted-on assistant fails, a three-note phrase
A-B-C# keeps stopping one note short of home. The missing D arrives exactly when the agent
docks inside the product, and the groove begins. Every agent action is a tick on the beat.

    python3 scripts/audio/compose.py            # → out/audio/score.wav (pre-master)
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np
from scipy import signal

SR = 48_000
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "out", "audio")
rng = np.random.default_rng(20260924)


# --------------------------------------------------------------------------- helpers

def note(name: str) -> float:
    """Scientific pitch name → Hz, e.g. 'C#5'."""
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    base = names[name[0]]
    rest = name[1:]
    if rest.startswith("#"):
        base += 1
        rest = rest[1:]
    elif rest.startswith("b"):
        base -= 1
        rest = rest[1:]
    midi = 12 * (int(rest) + 1) + base
    return 440.0 * 2 ** ((midi - 69) / 12)


def t_axis(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def env_adsr(n: int, a: float, d: float, s: float, r: float, hold: float | None = None) -> np.ndarray:
    """Linear-attack, exponential-decay envelope, n samples long."""
    t = np.arange(n) / SR
    a = max(a, 1e-4)
    e = np.where(t < a, t / a, 0.0)
    held = hold if hold is not None else (n / SR - r)
    dec = s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4))
    e = np.where((t >= a) & (t < held), dec, e)
    at_release = s + (1 - s) * np.exp(-(max(held - a, 0)) / max(d, 1e-4))
    rel = at_release * np.exp(-(t - held) / max(r / 4, 1e-4))
    e = np.where(t >= held, rel, e)
    return e


def exp_decay(n: int, tau: float, attack: float = 0.002) -> np.ndarray:
    t = np.arange(n) / SR
    return np.minimum(1, t / attack) * np.exp(-t / tau)


def lp(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, min(hz, SR / 2 * 0.95), "low", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def hp(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, hz, "high", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def bp(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, [lo, min(hi, SR / 2 * 0.95)], "band", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def pan(x: np.ndarray, p: float) -> np.ndarray:
    """Equal-power pan, p in [-1, 1] → (n, 2)."""
    a = (p + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)


class Track:
    def __init__(self, dur: float):
        self.buf = np.zeros((int(dur * SR) + SR, 2))

    def add(self, at: float, x: np.ndarray, gain: float = 1.0, p: float = 0.0) -> None:
        if x.ndim == 1:
            x = pan(x, p)
        i = int(round(at * SR))
        if i < 0:
            x = x[-i:]
            i = 0
        j = min(len(self.buf), i + len(x))
        if j > i:
            self.buf[i:j] += x[: j - i] * gain


# --------------------------------------------------------------------------- voices

def celesta(freq: float, dur: float = 1.6, bright: float = 1.0) -> np.ndarray:
    """Music-box / celesta: two FM partials with fast-decaying brightness."""
    t = t_axis(dur)
    idx = 2.2 * bright * np.exp(-t / 0.09)
    mod = np.sin(2 * np.pi * freq * 3.5 * t)
    car = np.sin(2 * np.pi * freq * t + idx * mod)
    over = 0.18 * np.sin(2 * np.pi * freq * 4.0 * t) * np.exp(-t / 0.12)
    body = (car + over) * exp_decay(len(t), 0.55, 0.0015)
    return lp(body, 9000)


def epiano(freq: float, dur: float, vel: float = 1.0) -> np.ndarray:
    """Warm FM electric piano (ratio 1) with a soft bell tine."""
    t = t_axis(dur)
    idx = (1.1 + 0.9 * vel) * np.exp(-t / 0.35)
    car = np.sin(2 * np.pi * freq * t + idx * np.sin(2 * np.pi * freq * t))
    tine = 0.12 * vel * np.sin(2 * np.pi * freq * 7.02 * t) * np.exp(-t / 0.05)
    trem = 1 + 0.03 * np.sin(2 * np.pi * 4.6 * t)
    e = env_adsr(len(t), 0.004, 0.9, 0.35, 0.35)
    return lp((car + tine) * e * trem, 6500)


def pad(freqs: list[float], dur: float, cutoff: float = 1800) -> np.ndarray:
    """Soft analogue-style pad: detuned band-limited saws, slow attack."""
    t = t_axis(dur)
    out = np.zeros(len(t))
    for f in freqs:
        for det in (-0.07, 0.0, 0.065):
            ff = f * 2 ** (det / 12)
            phase = rng.uniform(0, 2 * np.pi)
            h_max = max(1, int(min(12, 7000 / ff)))
            for h in range(1, h_max + 1):
                out += (1 / h) * np.sin(2 * np.pi * ff * h * t + phase * h)
    e = env_adsr(len(t), 0.45, 1.2, 0.8, 0.9)
    return lp(out * e / (len(freqs) * 6), cutoff, order=2)


def sub_bass(freq: float, dur: float) -> np.ndarray:
    t = t_axis(dur)
    x = np.sin(2 * np.pi * freq * t) + 0.34 * np.sin(2 * np.pi * freq * 2 * t) + 0.1 * np.sin(2 * np.pi * freq * 3 * t)
    e = env_adsr(len(t), 0.008, 0.25, 0.55, 0.12)
    return np.tanh(1.3 * x * e) / np.tanh(1.3)


def pluck_bass(freq: float, dur: float) -> np.ndarray:
    t = t_axis(dur)
    x = signal.sawtooth(2 * np.pi * freq * t)
    cutoff = 300 + 1600 * np.exp(-t / 0.06)
    # time-varying lowpass approximated by blending two static filters
    lo = lp(x, 300)
    hi = lp(x, 1900)
    mix = (cutoff - 300) / 1600
    y = lo * (1 - mix) + hi * mix
    return y * env_adsr(len(t), 0.004, 0.18, 0.3, 0.08) * 0.8


def kick(dur: float = 0.5) -> np.ndarray:
    t = t_axis(dur)
    f = 44 + 90 * np.exp(-t / 0.035)
    phase = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(phase) * np.exp(-t / 0.14)
    click = hp(rng.standard_normal(len(t)), 2500) * np.exp(-t / 0.003) * 0.25
    return np.tanh(1.6 * (body + click)) / np.tanh(1.6)


def rim(dur: float = 0.18) -> np.ndarray:
    t = t_axis(dur)
    tone = np.sin(2 * np.pi * 1650 * t) * np.exp(-t / 0.012) * 0.5
    noise = bp(rng.standard_normal(len(t)), 1800, 7000) * np.exp(-t / 0.025)
    return (tone + noise) * 0.7


def clap(dur: float = 0.35) -> np.ndarray:
    t = t_axis(dur)
    n = bp(rng.standard_normal(len(t)), 900, 5200)
    e = np.zeros(len(t))
    for k, off in enumerate((0.0, 0.009, 0.018)):
        e += np.where(t >= off, np.exp(-(t - off) / (0.006 if k < 2 else 0.11)), 0)
    return n * e * 0.55


def shaker(dur: float = 0.12, level: float = 1.0) -> np.ndarray:
    t = t_axis(dur)
    n = hp(rng.standard_normal(len(t)), 6000)
    e = np.minimum(1, t / 0.012) * np.exp(-t / 0.03)
    return n * e * 0.35 * level


# --------------------------------------------------------------------------- sound design

def key_tick() -> np.ndarray:
    """A soft laptop key: tiny damped knock plus a filtered click."""
    t = t_axis(0.05)
    f = rng.uniform(1700, 2600)
    knock = np.sin(2 * np.pi * rng.uniform(170, 240) * t) * np.exp(-t / 0.006) * 0.5
    click = bp(rng.standard_normal(len(t)), f, f * 2.6) * np.exp(-t / 0.0045)
    return (knock + click) * rng.uniform(0.7, 1.0)


def enter_key() -> np.ndarray:
    t = t_axis(0.09)
    knock = np.sin(2 * np.pi * 150 * t) * np.exp(-t / 0.012)
    click = bp(rng.standard_normal(len(t)), 1200, 4200) * np.exp(-t / 0.008)
    return knock * 0.7 + click * 0.8


def bubble_pop(freq: float = 880, dur: float = 0.16) -> np.ndarray:
    """Chat-app message sound: short sine with a quick upward glide."""
    t = t_axis(dur)
    f = freq * (1 + 0.35 * (1 - np.exp(-t / 0.02)))
    x = np.sin(2 * np.pi * np.cumsum(f) / SR)
    return x * exp_decay(len(t), 0.045, 0.003)


def soft_tick(freq: float = 3200, dur: float = 0.06) -> np.ndarray:
    t = t_axis(dur)
    x = np.sin(2 * np.pi * freq * t) * np.exp(-t / 0.008)
    n = hp(rng.standard_normal(len(t)), 5000) * np.exp(-t / 0.003) * 0.3
    return x * 0.5 + n


def whoosh(dur: float, lo: float = 300, hi: float = 3200, rise: bool = True) -> np.ndarray:
    """Filtered-noise air movement with a moving band centre."""
    t = t_axis(dur)
    n = rng.standard_normal(len(t))
    bands = 12
    out = np.zeros(len(t))
    seg = len(t) // bands
    for b in range(bands):
        centre = lo * (hi / lo) ** ((b + 0.5) / bands if rise else 1 - (b + 0.5) / bands)
        filt = bp(n, centre * 0.7, centre * 1.4)
        w = np.zeros(len(t))
        start = max(0, b * seg - seg // 2)
        end = min(len(t), (b + 1) * seg + seg // 2)
        w[start:end] = np.hanning(end - start)
        out += filt * w
    shape = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 1.5
    return out * shape * 0.35


def pop_away() -> np.ndarray:
    """Widget collapses: bright bubble pop with a falling tail."""
    t = t_axis(0.3)
    f = 1100 * np.exp(-t / 0.05) + 240
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * exp_decay(len(t), 0.06, 0.001)
    n = bp(rng.standard_normal(len(t)), 1500, 6000) * np.exp(-t / 0.01) * 0.4
    return x + n


def marker_draw(dur: float) -> np.ndarray:
    """Soft felt-tip stroke for the dashed outline being drawn."""
    t = t_axis(dur)
    n = bp(rng.standard_normal(len(t)), 2500, 7000)
    dashes = 0.55 + 0.45 * (np.sin(2 * np.pi * 11 * t) > 0)
    shape = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.8
    return n * dashes * shape * 0.12


def dock_thunk() -> np.ndarray:
    """The piece seating: a crisp latch click over a round, felt low thump."""
    t = t_axis(0.7)
    latch = hp(rng.standard_normal(len(t)), 3000) * np.exp(-t / 0.004) * 0.6
    knock = np.sin(2 * np.pi * 210 * t) * np.exp(-t / 0.03) * 0.55
    fthump = 58 + 40 * np.exp(-t / 0.03)
    thump = np.sin(2 * np.pi * np.cumsum(fthump) / SR) * np.exp(-t / 0.18) * 0.9
    return latch + knock + thump


def flap(dur: float = 0.14) -> np.ndarray:
    """Split-flap roll for the itinerary times."""
    t = t_axis(dur)
    out = np.zeros(len(t))
    for k in range(3):
        off = k * 0.035
        e = np.where(t >= off, np.exp(-(t - off) / 0.006), 0)
        out += bp(rng.standard_normal(len(t)), 1800, 6500) * e * (0.8 - 0.2 * k)
    return out * 0.5


def mouse_click() -> np.ndarray:
    t = t_axis(0.06)
    a = hp(rng.standard_normal(len(t)), 2200) * np.exp(-t / 0.0025)
    b = np.sin(2 * np.pi * 900 * t) * np.exp(-t / 0.006) * 0.4
    return (a + b) * 0.9


def chime(freqs: list[float], dur: float = 1.4) -> np.ndarray:
    out = np.zeros(int(dur * SR))
    for k, f in enumerate(freqs):
        x = celesta(f, dur, bright=0.7)
        d = int(0.045 * k * SR)
        out[d:] += x[: len(out) - d] * (1 - 0.15 * k)
    return out


def riser(dur: float) -> np.ndarray:
    t = t_axis(dur)
    n = rng.standard_normal(len(t))
    y = np.zeros(len(t))
    steps = 16
    seg = len(t) // steps
    for s in range(steps):
        c = 400 * (5000 / 400) ** (s / steps)
        blk = bp(n, c * 0.8, c * 1.25)
        w = np.zeros(len(t))
        a = max(0, s * seg - seg // 2)
        b = min(len(t), (s + 1) * seg + seg // 2)
        w[a:b] = np.hanning(b - a)
        y += blk * w
    return y * (t / dur) ** 2.2 * 0.22


# --------------------------------------------------------------------------- reverb

def make_ir(rt60: float = 1.7, pre: float = 0.018) -> np.ndarray:
    n = int((rt60 + pre) * SR)
    t = np.arange(n) / SR
    decay = np.exp(-6.91 * t / rt60)
    ir = np.zeros((n, 2))
    for ch in range(2):
        noise = rng.standard_normal(n) * decay
        dark = lp(noise, 5200)
        darker = lp(noise, 1800)
        blend = np.clip(t / rt60, 0, 1)
        ir[:, ch] = dark * (1 - blend) + darker * blend
    ir[: int(pre * SR)] = 0
    ir /= np.sqrt(np.sum(ir**2, axis=0, keepdims=True))
    return ir


def reverb(x: np.ndarray, ir: np.ndarray, wet: float) -> np.ndarray:
    y = np.zeros_like(x)
    for ch in range(2):
        y[:, ch] = signal.fftconvolve(x[:, ch], ir[:, ch])[: len(x)]
    return x + y * wet


# --------------------------------------------------------------------------- score

def compose(cues: dict) -> dict[str, np.ndarray]:
    dur = float(cues["duration"])
    bpm = float(cues["bpm"])
    beat = 60.0 / bpm
    bar = 4 * beat
    dock = float(cues["dock"])

    motif = Track(dur)
    keys = Track(dur)
    padt = Track(dur)
    bass = Track(dur)
    drums = Track(dur)
    sfx = Track(dur)

    # ---- Act 1-3: the phrase that never resolves -------------------------------
    phrase = ["A4", "B4", "C#5"]
    bars_before = int(round(dock / bar))  # bars before the dock downbeat
    for b in range(bars_before):
        start = b * bar
        stall = b == bars_before - 2  # the "truth" bar: the phrase stalls on B
        for k, name in enumerate(phrase):
            at = start + k * beat
            if stall and k == 2:
                continue
            level = 0.34 if b < bars_before - 2 else (0.3 if stall else 0.4)
            length = 2.6 if (stall and k == 1) else 1.4
            motif.add(at, celesta(note(name), length), level, p=-0.15 + 0.15 * k)
        # A barely-there drone under the supers and the turn, darker as tension builds.
    padt.add(cues["super1"] - 0.2, pad([note("D3"), note("A3")], 5.2, cutoff=700), 0.22)
    # anticipation: air rises into the silent beat before the dock
    sfx.add(dock - bar + 0.2, riser(bar - beat - 0.25), 0.5)

    # ---- The missing note ------------------------------------------------------
    motif.add(dock, celesta(note("D5"), 2.4), 0.5, p=0.1)
    motif.add(dock, celesta(note("D6"), 2.0, bright=0.6), 0.14, p=0.3)

    # ---- Act 4-5: groove inside the product -----------------------------------
    progression = [
        (dock + 0 * bar, 1.0, ["D3", "F#3", "A3", "D4"], "D2"),
        (dock + 1 * bar, 1.0, ["B2", "D3", "F#3", "B3"], "B1"),
        (dock + 2 * bar, 0.5, ["G2", "B2", "D3", "G3"], "G2"),
        (dock + 2.5 * bar, 0.5, ["A2", "C#3", "E3", "A3"], "A2"),
        (dock + 3 * bar, 1.0, ["D3", "F#3", "A3", "D4"], "D2"),  # "All set."
        (dock + 4 * bar, 1.0, ["D3", "F#3", "A3", "E4"], "D2"),  # code: lighter
        (dock + 5 * bar, 1.0, ["G2", "B2", "D3", "F#3"], "G2"),
    ]
    code_bar = dock + 4 * bar
    end_at = float(cues["end"])
    for at, length, chord, root in progression:
        span = length * bar
        lighter = at >= code_bar
        padt.add(at, pad([note(n) for n in chord[1:]], span + 0.6, cutoff=1500 if not lighter else 1100), 0.2 if not lighter else 0.15)
        # electric piano stabs: 1, and-of-2, 4 (a gentle push)
        for off in (0.0, 1.5, 3.0):
            if off * beat >= span - 0.05:
                continue
            vel = 0.9 if off == 0 else 0.6
            for k, n in enumerate(chord):
                keys.add(at + off * beat + 0.006 * k, epiano(note(n), 0.9 if off else 1.3, vel), 0.075 if not lighter else 0.055, p=-0.25 + 0.17 * k)
        # bass: root on 1, octave pickup on and-of-3
        bass.add(at, sub_bass(note(root), min(span, 1.1)), 0.42 if not lighter else 0.3)
        if span > 2 * beat:
            bass.add(at + 2.5 * beat, pluck_bass(note(root) * 2, 0.28), 0.18 if not lighter else 0.12)

    # found melody: the phrase, completed, over the first bars inside
    melody = [
        (dock + 4 * beat, "A4"), (dock + 5 * beat, "B4"), (dock + 6 * beat, "C#5"), (dock + 7 * beat, "D5"),
        (dock + 3 * bar + 0 * beat, "F#5"), (dock + 3 * bar + 1 * beat, "E5"), (dock + 3 * bar + 2 * beat, "D5"),
    ]
    for at, name in melody:
        motif.add(at, celesta(note(name), 1.3), 0.26, p=0.2)

    # drums: soft kick on 1 and 3, rim on 2 and 4, shaker 8ths — only while the agent works
    groove_end = code_bar + 2 * bar
    t = dock
    i = 0
    while t < groove_end - 0.01:
        inside_code = t >= code_bar
        beat_in_bar = i % 4
        if beat_in_bar in (0, 2):
            drums.add(t, kick(), 0.55 if not inside_code else 0.38)
        if beat_in_bar in (1, 3):
            drums.add(t, rim(), 0.2 if not inside_code else 0.14, p=0.1)
        drums.add(t, shaker(level=1.0), 0.16, p=0.35)
        drums.add(t + beat / 2, shaker(level=0.7), 0.13, p=0.35)
        t += beat
        i += 1
    # the question: the groove leans back into a held breath, the tap releases it
    q = float(cues["question"])
    tap = float(cues["tap"])
    drums.add(tap, clap(), 0.18, p=-0.1)

    # ---- Act 6: cadence onto the brand ----------------------------------------
    cadence = [
        (end_at, ["G2", "B2", "D3", "G3"], "G2", 0.6),
        (end_at + 0.6, ["A2", "C#3", "E3", "A3"], "A2", 0.6),
        (end_at + 1.2, ["D3", "F#3", "A3", "D4"], "D2", 2.2),
    ]
    for at, chord, root, length in cadence:
        padt.add(at, pad([note(n) for n in chord[1:]], length + 1.2, cutoff=1600), 0.2)
        for k, n in enumerate(chord):
            keys.add(at + 0.008 * k, epiano(note(n), length + 0.8, 0.8), 0.08, p=-0.25 + 0.17 * k)
        bass.add(at, sub_bass(note(root), length + 0.4), 0.36)
    final_phrase = [(end_at, "A4"), (end_at + 0.3, "B4"), (end_at + 0.6, "C#5"), (end_at + 1.2, "D5")]
    for at, name in final_phrase:
        motif.add(at, celesta(note(name), 2.2 if name == "D5" else 1.2), 0.36 if name == "D5" else 0.28, p=0.1)
    motif.add(end_at + 1.2, celesta(note("A5"), 2.4, bright=0.5), 0.12, p=0.35)

    # ---- sound design ----------------------------------------------------------
    for k in cues["keys"]:
        sfx.add(k, key_tick(), 0.1, p=0.12)
    sfx.add(cues["send"], enter_key(), 0.2)
    sfx.add(cues["send"] + 0.02, bubble_pop(740), 0.11, p=0.2)
    sfx.add(cues["replyWords"][0], bubble_pop(990), 0.1, p=0.25)
    for n, at in enumerate(cues["listItems"]):
        sfx.add(at, soft_tick(2600 + 90 * n, 0.05), 0.07, p=0.25)
    sfx.add(cues["signoff"], chime([note("E6"), note("A6")], 0.9), 0.05, p=0.3)

    sfx.add(cues["shrink"] - 0.05, whoosh(0.85, 250, 2200, rise=False), 0.22)
    sfx.add(cues["pop"], pop_away(), 0.22, p=0.3)
    sfx.add(cues["slotDraw"], lp(marker_draw(0.8), 5500), 0.34, p=0.2)
    sfx.add(dock, dock_thunk(), 0.55)
    sfx.add(cues["messageLand"], soft_tick(1800, 0.06), 0.12, p=0.2)

    step_notes = ["D6", "F#6", "A6", "D7"]
    for at, name in zip(cues["steps"], step_notes):
        sfx.add(at, soft_tick(4200, 0.04), 0.1, p=0.2)
        sfx.add(at, celesta(note(name), 0.9, bright=0.5), 0.07, p=0.25)
    for at in cues["steps"][1:]:
        sfx.add(at + 0.01, flap(), 0.35, p=-0.35)
    sfx.add(q, chime([note("B5"), note("E6")], 1.0), 0.07, p=0.25)
    sfx.add(tap, mouse_click(), 0.3, p=0.2)
    sfx.add(cues["allSet"], chime([note("D6"), note("F#6"), note("A6")], 1.8), 0.08, p=0.2)
    sfx.add(cues["pray"], bubble_pop(660, 0.12), 0.07, p=0.25)

    sfx.add(cues["scan"], whoosh(0.75, 500, 6000, rise=True), 0.3)
    for k in range(4):
        sfx.add(cues["code"] + 1.0 + 0.1 * k, soft_tick(3000 + 250 * k, 0.04), 0.06, p=-0.2 + 0.15 * k)
    sfx.add(cues["pageScroll"], whoosh(0.7, 200, 1800, rise=False), 0.2)

    stems = {"motif": motif.buf, "keys": keys.buf, "pad": padt.buf, "bass": bass.buf, "drums": drums.buf, "sfx": sfx.buf}
    n = int(dur * SR)
    for name in stems:
        stems[name] = stems[name][:n]
    return stems


def mix(stems: dict[str, np.ndarray]) -> np.ndarray:
    ir_room = make_ir(1.8)
    ir_small = make_ir(0.7, 0.008)
    music = reverb(stems["motif"], ir_room, 0.42) + reverb(stems["keys"], ir_room, 0.28) + reverb(stems["pad"], ir_room, 0.35)
    music = music + lp(stems["bass"], 900) + reverb(stems["drums"], ir_small, 0.18)
    sfx = reverb(stems["sfx"], ir_small, 0.22)
    music = hp(music, 38)
    total = music + sfx
    # gentle bus compression (RMS detector, 2:1 above threshold)
    level = np.sqrt(lp(np.mean(total**2, axis=1), 12, order=1) + 1e-12)
    thresh = 0.18
    gain = np.where(level > thresh, (thresh / level) ** 0.5, 1.0)
    total *= gain[:, None]
    # fade the very end to digital silence
    fade = int(0.35 * SR)
    total[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
    return total


def main() -> None:
    with open(os.path.join(ROOT, "out", "cues.json")) as f:
        cues = json.load(f)
    stems = compose(cues)
    os.makedirs(OUT, exist_ok=True)
    total = mix(stems)
    peak = np.max(np.abs(total))
    total = total / peak * 0.5  # headroom; loudness is set in the encode step
    import soundfile as sf

    sf.write(os.path.join(OUT, "score.wav"), total.astype(np.float32), SR, subtype="FLOAT")
    if "--stems" in sys.argv:
        for name, x in stems.items():
            p = np.max(np.abs(x)) or 1
            sf.write(os.path.join(OUT, f"stem_{name}.wav"), (x / p * 0.5).astype(np.float32), SR, subtype="FLOAT")
    print(f"score.wav  {len(total) / SR:.3f}s  pre-master peak {peak:.3f}")


if __name__ == "__main__":
    main()
