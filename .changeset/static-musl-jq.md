---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

The `jq` bundled for Linux is now a static musl build of jq 1.8.2 instead of jq's official Linux release executable, which statically links glibc. Opengeni builds it reproducibly from the checksum-pinned jq source and zig toolchain (`scripts/build-static-jq.sh`); it behaves the same, runs on any Linux distribution, and is less than half the size. macOS and Windows keep jq's official builds, and the licence notices now list exactly what the Linux build contains.
