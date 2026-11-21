#!/usr/bin/env bash
# Build the same package-contained interaction runtime on either native Windows runner.
set -euo pipefail

arch=${1:?expected x64 or arm64}
case "$arch" in
  x64) target=x86_64-pc-windows-msvc ;;
  arm64) target=aarch64-pc-windows-msvc ;;
  *) echo "unsupported Windows architecture: $arch" >&2; exit 2 ;;
esac
export OPENGENI_RUNTIME_BUILD_ID=${GITHUB_SHA:?expected the source revision}

workspace_windows="$(pwd -W)"
(
  cd agent
  rustup target add "$target"
  cargo build --release --target "$target" -p opengeni-computer-native
)
native="opengeni-computer-native-$target.exe"
browserd="opengeni-browserd-$target.exe"
asset="opengeni-agent-$target.exe"
cua="packages/browserd/dist/cua/$arch"
cp "agent/target/$target/release/opengeni-computer-native.exe" "$native"

bun packages/browserd/scripts/stage-cua-runtime.ts "$arch"
bun build --compile --target="bun-windows-$arch" packages/browserd/src/main.ts \
  --define "process.env.OPENGENI_RUNTIME_BUILD_ID=\"$OPENGENI_RUNTIME_BUILD_ID\"" \
  --outfile "$browserd"
bun docker/distrust-embedded-roots.ts docker/distrusted-roots.pem "$browserd"
bun docker/distrust-embedded-roots.ts --check docker/distrusted-roots.pem "$browserd"
(
  cd agent
  OPENGENI_EMBEDDED_BROWSERD="$workspace_windows\\$browserd" \
  OPENGENI_EMBEDDED_COMPUTER_NATIVE="$workspace_windows\\$native" \
  OPENGENI_EMBEDDED_CUA_RUNTIME="$workspace_windows/$cua/embedded.rs" \
    cargo build --release --target "$target" -p opengeni-agent
)
cp "agent/target/$target/release/opengeni-agent.exe" "$asset"

# CI runners have the Visual C++ runtime; ordinary PCs may not.
bun scripts/check-windows-binary-imports.ts "$asset" "$native" "$cua/cua-driver.exe" "$browserd"
