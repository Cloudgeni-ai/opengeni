#!/usr/bin/env bash
# Reproducible build: cues -> score -> picture (muted, BT.709) -> ffmpeg mux -> verify.
# Usage: scripts/build.sh [out/reveal.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"

OUT="${1:-out/reveal.mp4}"
mkdir -p out

if [ ! -d .pydeps/scipy ]; then
  python3 -m pip install --quiet --target .pydeps scipy
fi

bun scripts/export-cues.ts
PYTHONPATH=.pydeps python3 audio/score.py

# Picture is rendered muted and muxed separately: Remotion's own AAC mux left
# ~39 ms of un-trimmed encoder priming, audibly late against the picture.
bunx remotion render src/index.ts Reveal out/.picture.mp4 --muted --concurrency="${CONCURRENCY:-4}"

DURATION="$(bun -e 'import { T } from "./src/timeline.ts"; console.log(T.duration)')"
ffmpeg -hide_banner -loglevel error -y \
  -i out/.picture.mp4 -i public/audio/score.wav \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 256k -ar 48000 \
  -t "$DURATION" -movflags +faststart "$OUT"

bash scripts/verify.sh "$OUT"
