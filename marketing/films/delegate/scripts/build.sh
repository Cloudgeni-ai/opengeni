#!/usr/bin/env bash
# Reproducible build: cues -> score/sound -> picture -> QA.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-out/the-last-click.mp4}"
mkdir -p out
bun scripts/export-cues.ts
python3 audio/compose.py
bunx remotion render src/index.ts TheLastClick "$OUT" --log=error
bash scripts/qa.sh "$OUT"
