# syntax=docker/dockerfile:1.7
# The control service and front door (compute-control) as a container image.
# It also carries the host agent's binary for the store's daily sweep
# (`compute-host sweep`, run as a job beside the service), never to run
# VMs. Build context: the compute/ directory.
#
#   docker build -f docker/control.Dockerfile -t compute-control .
#
# The binary is linked statically against musl and runs on a distroless
# base as an unprivileged user; it needs no system libraries and no CA
# bundle of the image (its TLS roots are built in, its hosts' authority
# and certificates are mounted). The toolchain is pinned here, not taken
# from rust-toolchain.toml's channel, so a rebuild of a commit uses the same
# compiler. Paths are remapped, so the binary does not depend on where it
# was built.
ARG RUST_VERSION=1.99.1

FROM rust:${RUST_VERSION}-bookworm AS build
ARG RUST_VERSION
RUN apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends musl-tools >/dev/null \
  && rm -rf /var/lib/apt/lists/* \
  && rustup target add x86_64-unknown-linux-musl
# Rust links musl targets against its own bundled musl; musl-gcc only
# compiles the C the crates carry (ring, jemalloc, zstd). Linking with
# musl-gcc would mix the distribution's musl into Rust's and crash.
ENV RUSTUP_TOOLCHAIN=${RUST_VERSION} \
    CC_x86_64_unknown_linux_musl=musl-gcc \
    RUSTFLAGS="--remap-path-prefix=/usr/local/cargo=/cargo --remap-path-prefix=/src=/compute"
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --locked --release --target x86_64-unknown-linux-musl -p compute-control -p compute-host \
  && install -D -m 0755 -t /out target/x86_64-unknown-linux-musl/release/compute-control \
    target/x86_64-unknown-linux-musl/release/compute-host \
  && /out/compute-control --help >/dev/null && /out/compute-host sweep --help >/dev/null

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/compute-control /out/compute-host /usr/local/bin/
USER nonroot:nonroot
# 8080: the API (Opengeni's backend, and E2B clients behind a proxy);
# 8443: hosts, with mutual TLS.
EXPOSE 8080 8443
ENTRYPOINT ["/usr/local/bin/compute-control"]
CMD ["serve"]
