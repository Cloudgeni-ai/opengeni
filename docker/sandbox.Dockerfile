ARG BUN_VERSION=1.4.0
FROM python:3.12-slim AS checkov-runtime

ARG CHECKOV_VERSION=3.2.526

RUN set -eux; \
    python -m venv /opt/checkov; \
    /opt/checkov/bin/pip install --no-cache-dir "checkov==${CHECKOV_VERSION}"

FROM scratch AS lightpanda-assets

ADD --checksum=sha256:5713d49d06e8d4948d3358b6ce859ecca8e6f07dc312134d9f54999fb6e66c52 https://github.com/lightpanda-io/browser/releases/download/0.3.5/lightpanda-x86_64-linux /lightpanda-x86_64-linux
ADD --checksum=sha256:8d7b3a1d7b9024beef94e7fc7ce854030ee4d6def5f802b8e0e8824731c3d93a https://github.com/lightpanda-io/browser/releases/download/0.3.5/lightpanda-aarch64-linux /lightpanda-aarch64-linux
ADD --checksum=sha256:a5005b353a1738dd3d239234841cfcc808a7ec9faaebfcede3528f9fab3ae058 https://github.com/lightpanda-io/browser/archive/refs/tags/0.3.5.tar.gz /lightpanda-0.3.5-source.tar.gz
ADD --checksum=sha256:8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef https://raw.githubusercontent.com/lightpanda-io/browser/0.3.5/LICENSE /lightpanda-LICENSE

FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.9.0@sha256:c64defb9ed5a91eacb37f96ccc3d4cd72521c4bd18d5442905b95e2226b0e707 AS xx
FROM --platform=$BUILDPLATFORM rust:1.82-bookworm AS computer-native-build

COPY --from=xx / /

# Keep the large Rust release build on the native GitHub runner. `xx-cargo`
# selects the requested OCI target and configures clang/lld for its glibc ABI;
# `xx-verify` fails closed if the copied helper is not actually target-native.
RUN apt-get update \
    && apt-get install -y --no-install-recommends clang lld \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src/agent
ARG TARGETPLATFORM
RUN xx-apt-get install -y --no-install-recommends xx-c-essentials
COPY agent .
# Cache mounts keep the crates.io registry and the per-target build directory
# between builds so an edit under agent/ recompiles only the changed crates.
# Cargo locks its own package cache, so the registry/git mounts are shared and
# parallel target platforms do not serialize; the build directory is per target.
# The verified binary is installed to /out inside the same step, so the image
# layer never depends on the mounts; --locked still pins every dependency.
RUN --mount=type=cache,id=opengeni-sandbox-cargo-registry,target=/usr/local/cargo/registry,sharing=shared \
    --mount=type=cache,id=opengeni-sandbox-cargo-git,target=/usr/local/cargo/git,sharing=shared \
    --mount=type=cache,id=opengeni-sandbox-cargo-target-${TARGETPLATFORM},target=/src/agent/target,sharing=locked \
    set -eux; \
    rust_target="$(xx-cargo --print-target-triple)"; \
    xx-cargo build --locked --release --target-dir /src/agent/target -p opengeni-computer-native; \
    mkdir -p /out; \
    install -m 0755 "target/${rust_target}/release/opengeni-computer-native" /out/opengeni-computer-native; \
    xx-verify /out/opengeni-computer-native

FROM oven/bun:${BUN_VERSION} AS bun-runtime

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS anydoc-runtime-builder

ARG TARGETARCH
WORKDIR /src
COPY docker/anydoc/package.json docker/anydoc/bun.lock ./
RUN --mount=type=cache,id=opengeni-sandbox-bun-anydoc,target=/root/.bun/install/cache,sharing=locked \
    set -eux; \
    case "$TARGETARCH" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported AnyDoc OCI architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    bun install --frozen-lockfile --production --os=linux --cpu="$node_arch"; \
    runtime=/out/node_modules/@firecrawl; \
    install -d -m 0755 "$runtime"; \
    cp -a node_modules/@firecrawl/anydoc "$runtime/anydoc"; \
    cp -a "node_modules/@firecrawl/anydoc-linux-${node_arch}-gnu" \
      "$runtime/anydoc-linux-${node_arch}-gnu"; \
    test "$(bun -e 'const value=await Bun.file("node_modules/@firecrawl/anydoc/package.json").json();process.stdout.write(value.version)')" = 0.1.8

FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS browserd-source-build

WORKDIR /src
# Stage only the lock-resolving manifests first so the frozen install layer is
# reused across source edits; every workspace manifest below is checked against
# the repository workspace list by scripts/release-image-workflow-contract.test.ts.
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/browser-extension/package.json apps/browser-extension/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY examples/northstar-support/package.json examples/northstar-support/package.json
COPY packages/agent-proto/package.json packages/agent-proto/package.json
COPY packages/artifact-kernel-wasm-document/package.json packages/artifact-kernel-wasm-document/package.json
COPY packages/artifact-kernel-wasm-presentation/package.json packages/artifact-kernel-wasm-presentation/package.json
COPY packages/artifact-kernel-wasm-spreadsheet/package.json packages/artifact-kernel-wasm-spreadsheet/package.json
COPY packages/artifact-tool/package.json packages/artifact-tool/package.json
COPY packages/browserd/package.json packages/browserd/package.json
COPY packages/capabilities/package.json packages/capabilities/package.json
COPY packages/codemode/package.json packages/codemode/package.json
COPY packages/codex/package.json packages/codex/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/deployment/package.json packages/deployment/package.json
COPY packages/documents/package.json packages/documents/package.json
COPY packages/events/package.json packages/events/package.json
COPY packages/github/package.json packages/github/package.json
COPY packages/interaction/package.json packages/interaction/package.json
COPY packages/network/package.json packages/network/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/ogtool/package.json packages/ogtool/package.json
COPY packages/react/package.json packages/react/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/svelte/package.json packages/svelte/package.json
COPY packages/testing/package.json packages/testing/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/xai-subscription/package.json packages/xai-subscription/package.json
COPY patches patches
# The cache mount only holds Bun's download cache; the exact lock-resolved
# node_modules tree still lands in the layer and is byte-identical without it.
# Each stage owns its own cache id so concurrently building stages never share
# one writer.
RUN --mount=type=cache,id=opengeni-sandbox-bun-source,target=/root/.bun/install/cache,sharing=locked \
    bun install --frozen-lockfile
COPY . .

# Install the exact lock-resolved Codemode package closure for ordinary Bun
# programs. The CLI and imported module therefore share source, catalog rules,
# and transport behavior without resolving mutable registry versions at runtime.
RUN set -eux; \
    runtime=/out/codemode-runtime; \
    install -d -m 0755 "$runtime/node_modules/@opengeni/codemode" \
                        "$runtime/node_modules/@opengeni/contracts" \
                        "$runtime/node_modules/@noble"; \
    install -m 0644 packages/codemode/package.json "$runtime/node_modules/@opengeni/codemode/package.json"; \
    cp -a packages/codemode/src "$runtime/node_modules/@opengeni/codemode/src"; \
    install -m 0644 packages/contracts/package.json "$runtime/node_modules/@opengeni/contracts/package.json"; \
    cp -a packages/contracts/src "$runtime/node_modules/@opengeni/contracts/src"; \
    cp -aL packages/codemode/node_modules/ajv "$runtime/node_modules/ajv"; \
    ajv_modules="$(dirname "$(readlink -f packages/codemode/node_modules/ajv)")"; \
    for dependency in fast-deep-equal fast-uri json-schema-traverse require-from-string; do \
      cp -aL "$ajv_modules/$dependency" "$runtime/node_modules/$dependency"; \
    done; \
    cp -aL packages/contracts/node_modules/zod "$runtime/node_modules/zod"; \
    cp -aL packages/contracts/node_modules/@noble/hashes "$runtime/node_modules/@noble/hashes"; \
    test -f "$runtime/node_modules/@opengeni/codemode/src/index.ts"

RUN cd packages/ogtool && bun run build

FROM oven/bun:${BUN_VERSION} AS browserd-build

WORKDIR /src
COPY --from=browserd-source-build /src /src
COPY --from=browserd-source-build /out/codemode-runtime /out/codemode-runtime
COPY --from=lightpanda-assets / /lightpanda-assets/

ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) native=agent-browser-linux-x64; expected=b7bc3dfcf0a7326c1f5a60423163259ba2349eebfa5bd2e70e111af743da4a49; lightpanda_native=lightpanda-x86_64-linux; lightpanda_expected=5713d49d06e8d4948d3358b6ce859ecca8e6f07dc312134d9f54999fb6e66c52 ;; \
      arm64) native=agent-browser-linux-arm64; expected=6ccaba1eb26a0e6f5c23c59d2c63e6e0237fde82713cfdb543ba506490cac9c1; lightpanda_native=lightpanda-aarch64-linux; lightpanda_expected=8d7b3a1d7b9024beef94e7fc7ce854030ee4d6def5f802b8e0e8824731c3d93a ;; \
      *) echo "unsupported browser controller architecture=${arch}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out; \
    bun build --compile \
      packages/browserd/src/main.ts \
      --outfile /out/opengeni-browserd; \
    chmod 0755 /out/opengeni-browserd; \
    install -m 0755 "packages/browserd/node_modules/agent-browser/bin/${native}" /out/agent-browser; \
    test "$(sha256sum /out/agent-browser | awk '{print $1}')" = "$expected"; \
    install -m 0755 "/lightpanda-assets/${lightpanda_native}" /out/lightpanda; \
    test "$(sha256sum /out/lightpanda | awk '{print $1}')" = "$lightpanda_expected"; \
    install -m 0644 /lightpanda-assets/lightpanda-0.3.5-source.tar.gz /out/lightpanda-0.3.5-source.tar.gz; \
    test "$(sha256sum /out/lightpanda-0.3.5-source.tar.gz | awk '{print $1}')" = a5005b353a1738dd3d239234841cfcc808a7ec9faaebfcede3528f9fab3ae058; \
    install -m 0644 /lightpanda-assets/lightpanda-LICENSE /out/lightpanda-LICENSE; \
    test "$(sha256sum /out/lightpanda-LICENSE | awk '{print $1}')" = 8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef; \
    { \
      printf '%s  %s\n' "$(sha256sum /out/opengeni-browserd | awk '{print $1}')" /usr/local/bin/opengeni-browserd; \
      printf '%s  %s\n' "$expected" /usr/local/lib/opengeni/agent-browser; \
      printf '%s  %s\n' "$lightpanda_expected" /usr/local/lib/opengeni/lightpanda; \
      printf '%s  %s\n' a5005b353a1738dd3d239234841cfcc808a7ec9faaebfcede3528f9fab3ae058 /usr/local/share/source/lightpanda-0.3.5.tar.gz; \
      printf '%s  %s\n' 8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef /usr/local/share/licenses/lightpanda/LICENSE; \
    } > /out/SHA256SUMS

COPY --from=computer-native-build /out/opengeni-computer-native /out/opengeni-computer-native
RUN printf '%s  %s\n' \
      "$(sha256sum /out/opengeni-computer-native | awk '{print $1}')" \
      /usr/local/lib/opengeni/opengeni-computer-native \
      >> /out/SHA256SUMS

FROM node:22.22.0-bookworm-slim AS node-runtime

FROM oven/bun:${BUN_VERSION} AS artifact-runtime-builder

ARG TARGETARCH
ARG OPENGENI_ARTIFACT_RUNTIME_BUNDLE=.release/artifact-runtime
ARG OPENGENI_SOURCE_SHA

RUN set -eux; \
    for attempt in 1 2 3; do \
      rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
      apt-get update \
      && apt-get install -y --no-install-recommends fonts-liberation \
      && break; \
      if [ "$attempt" = "3" ]; then exit 1; fi; \
      sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    test -f /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf; \
    test -f /usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf; \
    test -f /usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf; \
    test -f /usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf

ENV OPENGENI_ARTIFACT_RASTER_FONT_FILES="[\"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf\",\"/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf\",\"/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf\",\"/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf\"]"
ENV OPENGENI_ARTIFACT_RASTER_DEFAULT_FONT_FAMILY="Liberation Sans"

WORKDIR /src
COPY . .
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
RUN --mount=type=cache,id=opengeni-sandbox-bun-artifact-runtime-${TARGETARCH},target=/root/.bun/install/cache,sharing=locked \
    set -eux; \
    case "$TARGETARCH" in \
      amd64) expected_target=linux-x64-gnu ;; \
      arm64) expected_target=linux-arm64-gnu ;; \
      *) echo "unsupported artifact runtime OCI architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && input="/src/$OPENGENI_ARTIFACT_RUNTIME_BUNDLE/$TARGETARCH/installation.json" \
    && if [ -f "$input" ]; then \
      test "$(node --version)" = "v22.22.0"; \
      bun install --frozen-lockfile; \
      bun scripts/verify-artifact-runtime-container-inputs.ts \
        --root "/src/$OPENGENI_ARTIFACT_RUNTIME_BUNDLE" \
        --source-sha "$OPENGENI_SOURCE_SHA" \
        --architecture "$TARGETARCH"; \
      actual_target="$(bun -e 'const value=await Bun.file(process.argv[1]).json();process.stdout.write(typeof value.target==="string"?value.target:"")' "$input")"; \
      test "$actual_target" = "$expected_target"; \
      bun scripts/prepare-artifact-sandbox-runtime.ts \
        --repository-root /src \
        --installation-root "$(dirname "$input")" \
        --output /opt/opengeni/artifact-runtime; \
    else \
      mkdir -p /opt/opengeni/artifact-runtime; \
      touch /opt/opengeni/artifact-runtime/.unavailable; \
    fi

FROM python:3.12-slim

ARG TERRAFORM_VERSION=1.13.3
ARG GLAB_VERSION=1.109.0
ARG AZURE_DEVOPS_EXTENSION_VERSION=1.0.6
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
ARG OPENGENI_CHROMIUM_VERSION=151.0.7922.108-1~deb13u1
ARG OPENGENI_DEBIAN_SECURITY_SNAPSHOT=20260809T010020Z

RUN set -eux; \
    printf '%s\n' \
      "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian-security/${OPENGENI_DEBIAN_SECURITY_SNAPSHOT} trixie-security main" \
      > /etc/apt/sources.list.d/opengeni-chromium-snapshot.list; \
    packages=" \
        bash \
        ca-certificates \
        coreutils \
        curl \
        gpg \
        git \
        jq \
        libatomic1 \
        libstdc++6 \
        openssh-client \
        procps \
        fuse3 \
        fonts-liberation \
        rclone \
        ripgrep \
        unzip \
        util-linux \
        wget \
        xvfb \
        x11vnc \
        xauth \
        x11-utils \
        x11-xserver-utils \
        xterm \
        xkb-data \
        x11-xkb-utils \
        dbus-x11 \
        at-spi2-core \
        xfwm4 \
        fonts-liberation \
        fonts-noto-color-emoji \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update \
        && apt-get install -y --download-only --no-install-recommends \
            $packages \
            "chromium=${OPENGENI_CHROMIUM_VERSION}" \
            "chromium-common=${OPENGENI_CHROMIUM_VERSION}" \
        && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
    done; \
    apt-get install -y --no-install-recommends \
        $packages \
        "chromium=${OPENGENI_CHROMIUM_VERSION}" \
        "chromium-common=${OPENGENI_CHROMIUM_VERSION}"; \
    rm -rf /var/lib/apt/lists/*; \
    install -d -m 0755 /etc/opengeni; \
    printf '%s\n' /usr/lib/chromium/chromium > /etc/opengeni/browser-engine; \
    test -x /usr/lib/chromium/chromium; \
    dbus-uuidgen --ensure=/var/lib/dbus/machine-id; \
    ln -sf /var/lib/dbus/machine-id /etc/machine-id

# ogtool requires a supported Node runtime. Ordinary typed Codemode programs
# use the exact Bun binary from the already-pinned build image.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
RUN test "$(node --version)" = "v22.22.0"

# Pinned native document-to-Markdown parser. The lock contains the registry
# integrity for the JS wrapper and every target binding; the builder copies
# only this Debian image's exact GNU binding into the final image.
COPY --from=anydoc-runtime-builder /out /opt/opengeni/anydoc
COPY docker/anydoc/LICENSE /usr/local/share/licenses/anydoc/LICENSE
COPY docker/anydoc/THIRD-PARTY-NOTICES /usr/local/share/opengeni/anydoc-THIRD-PARTY-NOTICES
RUN set -eux; \
    chmod 0755 /opt/opengeni/anydoc/node_modules/@firecrawl/anydoc/cli.js; \
    ln -s /opt/opengeni/anydoc/node_modules/@firecrawl/anydoc/cli.js /usr/local/bin/anydoc; \
    test "$(anydoc --version)" = 0.1.8; \
    printf 'name,value\nalpha,42\n' >/tmp/anydoc-smoke.csv; \
    anydoc /tmp/anydoc-smoke.csv >/tmp/anydoc-smoke.md; \
    grep -q alpha /tmp/anydoc-smoke.md; \
    printf '{\\rtf1\\ansi AnyDoc smoke}' >/tmp/anydoc-smoke.rtf; \
    anydoc /tmp/anydoc-smoke.rtf | grep -q 'AnyDoc smoke'

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) terraform_arch="amd64" ;; arm64|aarch64) terraform_arch="arm64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${terraform_arch}.zip"; \
    unzip /tmp/terraform.zip -d /usr/local/bin; \
    rm /tmp/terraform.zip; \
    terraform version

RUN set -eux; \
    curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://aka.ms/InstallAzureCLIDeb | bash; \
    az version

ENV AZURE_EXTENSION_DIR=/opt/az/extensions
RUN set -eux; \
    install -d -m 0755 "$AZURE_EXTENSION_DIR"; \
    az extension add --name azure-devops --version "$AZURE_DEVOPS_EXTENSION_VERSION"; \
    az repos --help >/dev/null

RUN set -eux; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update \
        && apt-get install -y --download-only --no-install-recommends gh \
        && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
    done; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    gh --version

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64) glab_arch="amd64"; expected="67b4a8557727a058f44e0839babdcf214ea6f6f829062cf0bae02f7b25814e5d" ;; \
      arm64|aarch64) glab_arch="arm64"; expected="288155229b7a0824aaca5fbdc36000d0c41fe5d8b4a4c3cbe9908e75f4e4ec2e" ;; \
      *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; \
    esac; \
    archive="/tmp/glab_${GLAB_VERSION}_linux_${glab_arch}.tar.gz"; \
    curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL \
      "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${glab_arch}.tar.gz" \
      -o "$archive"; \
    echo "$expected  $archive" | sha256sum -c -; \
    tar -xzf "$archive" -C /tmp bin/glab; \
    install -m 0755 /tmp/bin/glab /usr/local/bin/glab; \
    rm -rf "$archive" /tmp/bin; \
    glab --version

# ttyd static binary (REAL PTY-over-websocket; Channel-B terminal on headless boxes).
# Pinned static build from the upstream release; the PTY port (7681) is exposed over
# the SAME Modal raw-TLS tunnel mechanism the desktop image uses. Mirrors the
# desktop.Dockerfile ttyd layer.
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) tarch="x86_64" ;; arm64|aarch64) tarch="aarch64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${tarch}" -o /usr/local/bin/ttyd; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

# Checkov's large target-native Python closure is independent of the serial
# final-image toolchain. Build it in parallel, then retain the existing final
# executable path and version probe on the identical Python base image.
COPY --from=checkov-runtime /opt/checkov /opt/checkov
RUN set -eux; \
    ln -s /opt/checkov/bin/checkov /usr/local/bin/checkov; \
    checkov --version

# Exact native document/spreadsheet/presentation runtime. Keep this exact-source
# copy after the source-invariant toolchain so remote BuildKit caches can reuse
# Terraform, Checkov, Azure CLI, GitHub CLI, and ttyd across source revisions.
# The builder still pins every byte and runs real DOCX/XLSX/PPTX plus PNG/WebP
# smoke probes before this copy, and the final image still doctors that runtime.
COPY --from=artifact-runtime-builder /opt/opengeni/artifact-runtime /opt/opengeni/artifact-runtime
RUN set -eux; \
    if [ -f /opt/opengeni/artifact-runtime/installation.json ]; then \
      ln -s /opt/opengeni/artifact-runtime/opengeni-artifact-runtime.mjs /usr/local/bin/opengeni-artifact-runtime; \
      OPENGENI_ARTIFACT_RUNTIME_MANIFEST=/opt/opengeni/artifact-runtime/installation.json \
        OPENGENI_ARTIFACT_TOOL_ENTRY=/opt/opengeni/artifact-runtime/skill-facade-entry.mjs \
        opengeni-artifact-runtime doctor --json; \
    else \
      test -f /opt/opengeni/artifact-runtime/.unavailable; \
    fi

ENV HOME=/workspace
ENV OPENGENI_TERMINAL_STREAM_PORT=7681
ENV OPENGENI_ARTIFACT_RASTER_FONT_FILES="[\"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf\",\"/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf\",\"/usr/share/fonts/truetype/liberation/LiberationSans-Italic.ttf\",\"/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf\"]"
ENV OPENGENI_ARTIFACT_RASTER_DEFAULT_FONT_FAMILY="Liberation Sans"
ENV OPENGENI_BROWSERD_PORT=7682
ENV OPENGENI_BROWSERD_AGENT_BROWSER_BINARY=/usr/local/lib/opengeni/agent-browser
ENV OPENGENI_BROWSERD_LIGHTPANDA_BINARY=/usr/local/lib/opengeni/lightpanda
ENV OPENGENI_BROWSERD_BROWSER_EXECUTABLE=/usr/lib/chromium/chromium
ENV OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY=/usr/local/lib/opengeni/opengeni-computer-native
ENV OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE=isolated_linux
ENV NODE_PATH=/opt/opengeni/codemode-runtime/node_modules

COPY --from=browserd-build /out/opengeni-browserd /usr/local/bin/opengeni-browserd
COPY --from=browserd-build /out/agent-browser /usr/local/lib/opengeni/agent-browser
COPY --from=browserd-build /out/lightpanda /usr/local/lib/opengeni/lightpanda
COPY --from=browserd-build /out/opengeni-computer-native /usr/local/lib/opengeni/opengeni-computer-native
COPY --from=browserd-build /out/lightpanda-LICENSE /usr/local/share/licenses/lightpanda/LICENSE
COPY --from=browserd-build /out/lightpanda-0.3.5-source.tar.gz /usr/local/share/source/lightpanda-0.3.5.tar.gz
COPY --from=browserd-build /out/SHA256SUMS /usr/local/share/opengeni/browserd-SHA256SUMS
COPY docker/browserd-THIRD-PARTY-NOTICES /usr/local/share/opengeni/browserd-THIRD-PARTY-NOTICES
COPY --from=browserd-build /out/codemode-runtime /opt/opengeni/codemode-runtime
COPY docker/opengeni-git-askpass /usr/local/bin/opengeni-git-askpass
COPY packages/ogtool/package.json  /opt/opengeni/ogtool/package.json
COPY --from=browserd-build /src/packages/ogtool/dist/bin/ogtool.cjs /opt/opengeni/ogtool/bin/ogtool.cjs
COPY docker/desktop/opengeni-terminal-up.sh   /usr/local/bin/opengeni-terminal-up
COPY docker/desktop/opengeni-terminal-down.sh /usr/local/bin/opengeni-terminal-down
COPY docker/desktop/opengeni-browserd-up.sh     /usr/local/bin/opengeni-browserd-up
COPY docker/desktop/opengeni-browserd-down.sh   /usr/local/bin/opengeni-browserd-down
RUN set -eux; \
    chmod 0755 /usr/local/bin/opengeni-git-askpass \
               /usr/local/bin/opengeni-terminal-up /usr/local/bin/opengeni-terminal-down \
               /usr/local/bin/opengeni-browserd-up /usr/local/bin/opengeni-browserd-down \
               /usr/local/bin/opengeni-browserd /usr/local/lib/opengeni/agent-browser \
               /usr/local/lib/opengeni/lightpanda \
               /usr/local/lib/opengeni/opengeni-computer-native; \
    chmod 0755 /opt/opengeni/ogtool/bin/ogtool.cjs; \
    ln -s /opt/opengeni/ogtool/bin/ogtool.cjs /usr/local/bin/ogtool; \
    node --check /opt/opengeni/ogtool/bin/ogtool.cjs; \
    test -n "$(ogtool --version)"; \
    bun -e 'const module = await import("@opengeni/codemode"); if (typeof module.CodemodeClient !== "function" || typeof module.openGeni !== "object") process.exit(1)'; \
    bash -n /usr/local/bin/opengeni-terminal-up; \
    bash -n /usr/local/bin/opengeni-terminal-down; \
    bash -n /usr/local/bin/opengeni-browserd-up; \
    bash -n /usr/local/bin/opengeni-browserd-down; \
    chromium --version; \
    sha256sum -c /usr/local/share/opengeni/browserd-SHA256SUMS

EXPOSE 7681
EXPOSE 7682

WORKDIR /workspace
