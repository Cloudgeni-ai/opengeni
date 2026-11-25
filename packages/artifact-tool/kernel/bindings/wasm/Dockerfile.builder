ARG BUN_IMAGE=oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18
FROM ${BUN_IMAGE} AS bun

FROM rust:1.97.0-bookworm@sha256:8fa55b2f3ddf97471ab6a767bfa3f37e6bad0986ba823e75fea57e2a2a5c3073

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN rustup target add --toolchain 1.97.0 wasm32-unknown-unknown \
    && rustup run 1.97.0 cargo install --locked wasm-bindgen-cli --version 0.2.127
