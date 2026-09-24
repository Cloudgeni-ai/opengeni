#!/usr/bin/env bash
# Technical floor checks for an exported film. These prove the file is well-formed;
# they say nothing about whether the film is any good.
#   bash scripts/qa.sh [film.mp4]
set -euo pipefail
cd "$(dirname "$0")/.."
FILM="${1:-out/missing-piece.mp4}"
mkdir -p out/qa

echo "== streams"
ffprobe -v error -show_entries stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,color_space,sample_rate,channels,bit_rate \
  -show_entries format=duration,size,bit_rate -of default=nw=1 "${FILM}"

echo "== duration limit (<= 30.000 s)"
python3 - "${FILM}" <<'EOF'
import json, subprocess, sys
d = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", sys.argv[1]]))
dur = float(d["format"]["duration"])
print(f"duration {dur:.3f}s -> {'OK' if dur <= 30.0 else 'TOO LONG'}")
EOF

echo "== full decode (errors are printed; none expected)"
ffmpeg -hide_banner -v error -i "${FILM}" -f null - && echo "decode OK"

echo "== loudness (EBU R128) and true peak"
ffmpeg -hide_banner -nostats -i "${FILM}" -map 0:a -af ebur128=peak=true -f null - 2>&1 | sed -n '/Summary/,$p'

echo "== clipped samples in decoded audio"
ffmpeg -hide_banner -v error -i "${FILM}" -map 0:a -f f32le -ac 2 -ar 48000 - | python3 -c "
import sys, numpy as np
x = np.frombuffer(sys.stdin.buffer.read(), dtype=np.float32)
print(f'samples {x.size}, peak {np.max(np.abs(x)):.4f}, >=0.999: {int(np.sum(np.abs(x) >= 0.999))}')
"

echo "== contact sheet (1 frame / second)"
ffmpeg -hide_banner -loglevel error -y -i "${FILM}" -vf "fps=1,scale=480:-1,tile=6x5:padding=6:color=0x1e1e1c" -frames:v 1 out/qa/contact-sheet.png
echo "out/qa/contact-sheet.png"
