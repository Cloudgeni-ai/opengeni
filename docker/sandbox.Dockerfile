FROM python:3.12-slim

ARG TERRAFORM_VERSION=1.13.3
ARG CHECKOV_VERSION=3.2.526
ARG TARGETARCH

COPY docker/infra-agent-git-askpass /usr/local/bin/infra-agent-git-askpass
COPY docker/infra-agent-azure-login /usr/local/bin/infra-agent-azure-login

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        coreutils \
        curl \
        gpg \
        git \
        jq \
        openssh-client \
        unzip \
        wget \
    && rm -rf /var/lib/apt/lists/*

RUN chmod 0755 /usr/local/bin/infra-agent-git-askpass /usr/local/bin/infra-agent-azure-login

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
    apt-get update; \
    apt-get install -y --no-install-recommends gh; \
    rm -rf /var/lib/apt/lists/*; \
    gh --version

WORKDIR /workspace
