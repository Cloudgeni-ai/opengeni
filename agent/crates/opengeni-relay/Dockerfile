# opengeni-relay — the stateless stream-relay edge image.
#
# Multi-stage: build a fully-static native musl binary, then ship it in a distroless
# (effectively scratch) runtime so the image is tiny, has no shell/package surface,
# and runs as a non-root user. The GHCR build wiring (release.yml) is M11; this
# Dockerfile just produces a buildable, production-shaped image.
#
#   docker build -f agent/crates/opengeni-relay/Dockerfile -t opengeni-relay agent
#
# (build context = the `agent/` Cargo workspace; the relay shares the
# opengeni-agent-stream codec, so the whole workspace must be in context.)

# syntax=docker/dockerfile:1

# ---- build stage ----------------------------------------------------------------
# BuildKit normally runs each build stage as the target architecture. That makes
# an arm64 Rust release build crawl through QEMU on an amd64 CI runner. `xx`
# configures clang/lld + Cargo for the requested target while this stage remains
# native to the builder, so both OCI variants compile at native speed.
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.9.0@sha256:c64defb9ed5a91eacb37f96ccc3d4cd72521c4bd18d5442905b95e2226b0e707 AS xx
FROM --platform=$BUILDPLATFORM rust:1.82-alpine AS build

COPY --from=xx / /

# clang/lld are native cross-compilers. protoc is NOT needed: the proto crate
# compiles the .proto via the pure-Rust `protox` (build.rs).
RUN apk add --no-cache clang lld

WORKDIR /build
# The build context is the agent/ workspace root.
COPY . .

# Build the relay binary for the requested OCI architecture as a static musl
# target without emulation. The workspace profile already strips + LTOs the
# release build; `xx-verify` fails if the output architecture drifts.
ARG TARGETPLATFORM
RUN set -eux; \
    rust_target="$(xx-cargo --print-target-triple)"; \
    rustup target add "${rust_target}"; \
    xx-cargo build --release --target-dir /build/target -p opengeni-relay; \
    xx-verify "/build/target/${rust_target}/release/opengeni-relay"; \
    cp "target/${rust_target}/release/opengeni-relay" /opengeni-relay

# ---- runtime stage --------------------------------------------------------------
# Distroless static: no shell, no package manager, a nonroot user — minimal attack
# surface. The static musl binary needs nothing from the base image.
FROM gcr.io/distroless/static-debian12:nonroot AS runtime

COPY --from=build /opengeni-relay /usr/local/bin/opengeni-relay

# The wss listener port (matches OPENGENI_RELAY_BIND's default 0.0.0.0:8443).
EXPOSE 8443

# Config is injected by env (the deploy IaC sets the secrets + knobs):
#   OPENGENI_RELAY_BIND, OPENGENI_STREAM_TOKEN_SECRET, OPENGENI_RELAY_TOKEN_SECRET,
#   OPENGENI_RELAY_RING_FRAMES, OPENGENI_RELAY_SPLICE_BUFFER,
#   OPENGENI_RELAY_RATE_BURST_BYTES, OPENGENI_RELAY_RATE_BYTES_PER_SEC,
#   OPENGENI_RELAY_PAIR_TIMEOUT_SECS.
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/opengeni-relay"]
