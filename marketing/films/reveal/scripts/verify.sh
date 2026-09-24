#!/usr/bin/env bash
# Technical floor checks for a delivered file. Passing these says nothing about
# whether the film is any good; they only catch broken deliverables.
set -euo pipefail
FILE="${1:?usage: scripts/verify.sh <file.mp4>}"

echo "== streams"
ffprobe -v error -show_entries stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,color_space,color_primaries,color_transfer,sample_rate,channels,duration -of compact "$FILE"

echo "== full decode (errors would print below)"
ffmpeg -hide_banner -v error -i "$FILE" -f null - && echo "decode ok"

echo "== loudness (EBU R128)"
ffmpeg -hide_banner -nostats -i "$FILE" -vn -af ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I:|LRA:|Peak:)"

DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$FILE")"
awk -v d="$DUR" 'BEGIN { if (d <= 30.0) printf "duration %.3fs <= 30s ok\n", d; else { printf "duration %.3fs exceeds 30s\n", d; exit 1 } }'
ls -lh "$FILE" | awk '{ print "size " $5 }'
