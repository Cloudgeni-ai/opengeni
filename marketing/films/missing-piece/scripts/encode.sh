#!/usr/bin/env bash
# Mux the rendered frames with the mastered score (out/audio/mix.wav, -16 LUFS / -1.6 dBTP).
#   bash scripts/encode.sh [output.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-out/missing-piece.mp4}"
FPS=60
FRAMES=$(ls out/frames/f_*.png | wc -l)
echo "frames: ${FRAMES}"

ffmpeg -hide_banner -loglevel error -y \
  -framerate "${FPS}" -i out/frames/f_%05d.png \
  -i out/audio/mix.wav \
  -map 0:v:0 -map 1:a:0 \
  -vf "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -tune animation -crf 11 -profile:v high -level 4.2 -g 120 -bf 3 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 256k -ar 48000 \
  -movflags +faststart -shortest \
  "${OUT}"

echo "wrote ${OUT}"
