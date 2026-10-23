#!/usr/bin/env bash
# Builds "Opengeni Simple.app" (Apple silicon) into desktop/release. Runs on Linux or macOS;
# the app is unsigned, so finish on the Mac with: codesign --force --deep -s - "Opengeni Simple.app"
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
simple="$(dirname "$here")"
rm -rf "$here/build" "$here/release"
mkdir -p "$here/build"
# The main-process module and the window's preload (desktop/out), and the login agent.
bun "$here/bundle.ts"
(cd "$simple" && bunx vite build --outDir "$here/build/dist" --emptyOutDir)
(cd "$simple" && bun build --compile --target=bun-darwin-arm64 server/index.ts --outfile "$here/build/simple-server")
cp "$simple/../web/public/icon-512.png" "$here/build/icon.png"
(cd "$here" && bunx electron-builder@26.15.3 --mac --arm64 --publish never)
