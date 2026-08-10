FROM python:3.12-slim AS checkov-runtime

ARG CHECKOV_VERSION=3.2.526

RUN set -eux; \
    python -m venv /opt/checkov; \
    /opt/checkov/bin/pip install --no-cache-dir "checkov==${CHECKOV_VERSION}"

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
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update \
        && apt-get install -y --download-only --no-install-recommends $packages \
        && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
    done; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/*

# ogtool is dependency-free but requires a supported Node runtime. Copy the
# exact official LTS binary instead of trusting a mutable third-party apt key.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
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

COPY docker/opengeni-git-askpass /usr/local/bin/opengeni-git-askpass
COPY packages/ogtool/package.json  /opt/opengeni/ogtool/package.json
COPY packages/ogtool/bin/ogtool.cjs /opt/opengeni/ogtool/bin/ogtool.cjs
COPY docker/desktop/opengeni-terminal-up.sh   /usr/local/bin/opengeni-terminal-up
COPY docker/desktop/opengeni-terminal-down.sh /usr/local/bin/opengeni-terminal-down
RUN set -eux; \
    chmod 0755 /usr/local/bin/opengeni-git-askpass \
               /usr/local/bin/opengeni-terminal-up /usr/local/bin/opengeni-terminal-down; \
    chmod 0755 /opt/opengeni/ogtool/bin/ogtool.cjs; \
    ln -s /opt/opengeni/ogtool/bin/ogtool.cjs /usr/local/bin/ogtool; \
    node --check /opt/opengeni/ogtool/bin/ogtool.cjs; \
    test -n "$(ogtool --version)"; \
    bash -n /usr/local/bin/opengeni-terminal-up; \
    bash -n /usr/local/bin/opengeni-terminal-down

EXPOSE 7681

WORKDIR /workspace
