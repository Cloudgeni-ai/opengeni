FROM python:3.12-slim

ARG TERRAFORM_VERSION=1.13.3
ARG CHECKOV_VERSION=3.2.526
ARG TTYD_VERSION=1.7.7
ARG NODE_MAJOR=20
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
        openssh-client \
        procps \
        fuse3 \
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

# Node.js LTS from NodeSource. The distro `nodejs` package is far too old for
# ogtool (Debian bookworm ships 18, Ubuntu jammy ships 12); pin the 20.x LTS
# line via the NodeSource apt repo, mirroring the gh keyring+repo layer below.
RUN set -eux; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    chmod go+r /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update \
        && apt-get install -y --download-only --no-install-recommends nodejs \
        && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
    done; \
    apt-get install -y --no-install-recommends nodejs; \
    rm -rf /var/lib/apt/lists/*; \
    node --version

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) terraform_arch="amd64" ;; arm64|aarch64) terraform_arch="arm64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${terraform_arch}.zip"; \
    unzip /tmp/terraform.zip -d /usr/local/bin; \
    rm /tmp/terraform.zip; \
    terraform version

RUN set -eux; \
    pip install --no-cache-dir "checkov==${CHECKOV_VERSION}"; \
    checkov --version

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

ENV HOME=/workspace
ENV OPENGENI_TERMINAL_STREAM_PORT=7681

COPY docker/opengeni-git-askpass /usr/local/bin/opengeni-git-askpass
COPY docker/ogtool                 /usr/local/bin/ogtool
COPY docker/desktop/opengeni-terminal-up.sh   /usr/local/bin/opengeni-terminal-up
COPY docker/desktop/opengeni-terminal-down.sh /usr/local/bin/opengeni-terminal-down
RUN set -eux; \
    chmod 0755 /usr/local/bin/opengeni-git-askpass \
               /usr/local/bin/ogtool \
               /usr/local/bin/opengeni-terminal-up /usr/local/bin/opengeni-terminal-down; \
    cp /usr/local/bin/ogtool /tmp/ogtool-check.js; \
    node --check /tmp/ogtool-check.js; \
    rm /tmp/ogtool-check.js; \
    bash -n /usr/local/bin/opengeni-terminal-up; \
    bash -n /usr/local/bin/opengeni-terminal-down

EXPOSE 7681

WORKDIR /workspace
