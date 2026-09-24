#!/usr/bin/env bash
# Master the score to -16 LUFS / -1.5 dBTP and mux it with the rendered frames.
#   bash scripts/encode.sh [output.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="${1:-out/missing-piece.mp4}"
FPS=60
TARGET_I=-16
TARGET_TP=-1.5

# Pass 1: measure. Pass 2: apply a linear gain (no dynamic processing) to hit the target.
MEASURE=$(ffmpeg -hide_banner -nostats -i out/audio/score.wav \
  -af "loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { echo "$MEASURE" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
ffmpeg -hide_banner -loglevel error -y -i out/audio/score.wav \
  -af "loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true:print_format=summary" \
  -ar 48000 -c:a pcm_s24le out/audio/mix.wav

FRAMES=$(ls out/frames/f_*.png | wc -l)
echo "frames: ${FRAMES}"

ffmpeg -hide_banner -loglevel error -y \
  -framerate "${FPS}" -i out/frames/f_%05d.png \
  -i out/audio/mix.wav \
  -map 0:v:0 -map 1:a:0 \
  -vf "scale=in_range=full:out_range=tv:out_color_matrix=bt709:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p" \
  -c:v libx264 -preset slow -crf 15 -profile:v high -level 4.2 -g 120 -bf 3 \
  -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv \
  -c:a aac -b:a 256k -ar 48000 \
  -movflags +faststart -shortest \
  "${OUT}"

echo "wrote ${OUT}"
