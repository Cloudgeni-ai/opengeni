# syntax=docker/dockerfile:1.7
# Adds opengeni-agent, built from the same commit, to a sandbox image that
# does not carry it yet (ADR 21 puts it at /usr/local/bin/opengeni-agent in
# Opengeni's sandbox and desktop images). Build context: agent/.
ARG BASE
FROM rust:1.99.1-bookworm AS agent
RUN apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends musl-tools protobuf-compiler >/dev/null \
  && rustup target add x86_64-unknown-linux-musl
ENV CC_x86_64_unknown_linux_musl=musl-gcc
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release --target x86_64-unknown-linux-musl -p opengeni-agent \
  && install -m 755 target/x86_64-unknown-linux-musl/release/opengeni-agent /opengeni-agent

FROM ${BASE}
COPY --from=agent /opengeni-agent /usr/local/bin/opengeni-agent
