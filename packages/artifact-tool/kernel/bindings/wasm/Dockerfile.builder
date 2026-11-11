ARG BUN_IMAGE=oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d
FROM ${BUN_IMAGE} AS bun

FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN rustup target add --toolchain 1.97.0 wasm32-unknown-unknown \
    && rustup run 1.97.0 cargo install --locked wasm-bindgen-cli --version 0.2.127
