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

FROM rust:1.82-bookworm AS computer-native-build

WORKDIR /src/agent
COPY agent .
RUN set -eux; \
    cargo build --locked --release -p opengeni-computer-native; \
    mkdir -p /out; \
    install -m 0755 target/release/opengeni-computer-native /out/opengeni-computer-native

FROM oven/bun:1.3.14 AS bun-runtime

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS browserd-source-build

WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile

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

FROM oven/bun:1.3.14 AS browserd-build

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

FROM oven/bun:1.3.14 AS artifact-runtime-builder

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
RUN set -eux; \
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
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
ARG OPENGENI_CHROMIUM_VERSION=151.0.7922.108-1~deb13u1

RUN set -eux; \
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
            $packages "chromium=${OPENGENI_CHROMIUM_VERSION}" \
        && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
    done; \
    apt-get install -y --no-install-recommends \
        $packages "chromium=${OPENGENI_CHROMIUM_VERSION}"; \
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

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) terraform_arch="amd64" ;; arm64|aarch64) terraform_arch="arm64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${terraform_arch}.zip"; \
    unzip /tmp/terraform.zip -d /usr/local/bin; \
    rm /tmp/terraform.zip; \
    terraform version

RUN set -eux; \
    curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash; \
    az version

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
