# opengeni-relay — the stateless stream-relay edge image.
#
# Multi-stage: build a fully-static x86_64 musl binary, then ship it in a distroless
# (effectively scratch) runtime so the image is tiny, has no shell/package surface,
# and runs as a non-root user. The GHCR build wiring (release.yml) is M11; this
# Dockerfile just produces a buildable, production-shaped image.
#
#   docker build -f agent/crates/opengeni-relay/Dockerfile -t opengeni-relay agent
#
# (build context = the `agent/` Cargo workspace; the relay shares the
# opengeni-agent-stream codec, so the whole workspace must be in context.)

# ---- build stage ----------------------------------------------------------------
FROM rust:1.82-alpine AS build

# musl-dev + the build essentials for a fully-static link. protoc is NOT needed:
# the proto crate compiles the .proto via the pure-Rust `protox` (build.rs).
RUN apk add --no-cache musl-dev

WORKDIR /build
# The build context is the agent/ workspace root.
COPY . .

# Build the relay binary as a static musl target. The workspace profile already
# strips + LTOs the release build.
RUN rustup target add x86_64-unknown-linux-musl \
 && cargo build --release --target x86_64-unknown-linux-musl -p opengeni-relay \
 && cp target/x86_64-unknown-linux-musl/release/opengeni-relay /opengeni-relay

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
