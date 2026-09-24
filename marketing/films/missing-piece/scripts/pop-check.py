"""Find single-frame visual pops: frames whose change dwarfs the frames around them.

A deliberate animation spreads its change over many frames; an accidental layout jump or a
hard appearance concentrates it in one. This flags frames whose mean absolute change is
both large and several times the local median.

    bun scripts/render-frames.ts --scale 0.5 --out out/allframes --workers 4
    python3 scripts/pop-check.py out/allframes
"""
import glob
import os
import sys

import numpy as np
from PIL import Image

FPS = 60


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "out/allframes"
    files = sorted(glob.glob(os.path.join(src, "f_*.png")) + glob.glob(os.path.join(src, "f_*.jpg")))
    prev = None
    diffs: list[tuple[int, float]] = []
    for path in files:
        frame = int(os.path.basename(path)[2:7])
        img = np.asarray(Image.open(path).convert("L"), dtype=np.float32)
        if prev is not None:
            diffs.append((frame, float(np.mean(np.abs(img - prev[1])))))
        prev = (frame, img)
    values = np.array([d for _, d in diffs])
    flagged = []
    for i, (frame, d) in enumerate(diffs):
        lo, hi = max(0, i - 6), min(len(values), i + 7)
        neighbours = np.concatenate([values[lo:i], values[i + 1 : hi]])
        local = float(np.median(neighbours)) if len(neighbours) else 0.0
        if d > 1.0 and d > 3.0 * max(local, 0.15):
            flagged.append((frame, d, local))
    print(f"frames analysed: {len(files)}; mean change {values.mean():.3f}; max {values.max():.3f}")
    if not flagged:
        print("no single-frame pops found")
    for frame, d, local in flagged:
        print(f"  pop? frame {frame} ({frame / FPS:6.3f}s): change {d:.2f} vs local median {local:.2f}")


if __name__ == "__main__":
    main()
