#!/usr/bin/env bash
# Technical floor only: decode, format, duration, loudness, peaks.
# None of this is evidence of advertising quality; see NOTES.md for review.
set -euo pipefail
cd "$(dirname "$0")/.."
F="${1:-out/the-last-click.mp4}"
echo "== format"
ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_name,profile,width,height,r_frame_rate,pix_fmt,sample_rate,channels -of compact "$F"
echo "== full decode (errors would print below)"
ffmpeg -v error -i "$F" -f null - && echo "decode ok"
echo "== duration <= 30 s"
python3 - "$F" <<'EOF'
import json, subprocess, sys
d = float(json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", sys.argv[1]]))["format"]["duration"])
print(f"duration {d:.3f}s", "OK" if d <= 30.0 else "TOO LONG")
sys.exit(0 if d <= 30.0 else 1)
EOF
echo "== loudness (EBU R128, decoded from the MP4)"
ffmpeg -v info -nostats -i "$F" -filter_complex "ebur128=peak=true" -f null - 2>&1 | grep -A 12 "Summary:" | sed 's/^/  /'
echo "== clipping check (sample peak of decoded audio)"
ffmpeg -v error -i "$F" -af "volumedetect" -f null - 2>&1 | grep -E "max_volume|mean_volume" || ffmpeg -i "$F" -af volumedetect -f null - 2>&1 | grep -E "max_volume|mean_volume"
