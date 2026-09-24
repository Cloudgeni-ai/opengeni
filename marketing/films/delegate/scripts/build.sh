#!/usr/bin/env bash
# Reproducible picture edit with the original, unmodified score retained in source.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-out/the-last-click.mp4}"
mkdir -p out
# The original 28.8-second AAC score is included in public/audio. To revisit its
# synthesis, use the separately documented audio/compose.py and original cues.
bunx remotion render src/index.ts TheLastClick "$OUT" --log=error
bash scripts/qa.sh "$OUT"
