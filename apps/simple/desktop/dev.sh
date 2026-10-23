#!/usr/bin/env bash
# Runs the Mac app from source on this computer: bundles desktop/out, builds the
# web app and a companion server for this platform into desktop/build, then
# starts Electron. Extra arguments go to Electron (e.g. --hidden).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
simple="$(dirname "$here")"
root="$(cd "$simple/../.." && pwd)"
mkdir -p "$here/build"
bun "$here/bundle.ts"
(cd "$simple" && bunx vite build --outDir "$here/build/dist" --emptyOutDir)
(cd "$simple" && bun build --compile server/index.ts --outfile "$here/build/simple-server")
electron="$(find "$root/node_modules/.bun" -maxdepth 4 -type d -path '*electron@44.7.2/node_modules/electron' | head -n 1)"
case "$(uname -s)" in
  Darwin) binary="$electron/dist/Electron.app/Contents/MacOS/Electron" ;;
  *) binary="$electron/dist/electron" ;;
esac
exec "$binary" "$here" "$@"
