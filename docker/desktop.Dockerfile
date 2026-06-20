# docker/desktop.Dockerfile
# OpenGeni canonical DESKTOP sandbox image (Channel B pixel plane + Channel A headless).
#
# Productionized from spikes/desktop-stack (PASSED locally: noVNC vnc.html 200,
# websockify WS upgrade 101 + RFB banner, OCR'd SECRET123 off the live framebuffer)
# and the gVisor harness spikes/provider-credentialed/desktop-on-gvisor (V2 PASSED
# live on Modal: XTEST mouse/key/click read-back under runsc, scrot capture).
#
# The stack (Xvfb -> XFCE -> x11vnc -viewonly -> websockify:6080 -> noVNC) is launched
# via ensureDisplayStack over `exec` (NOT a container CMD) so it re-establishes
# idempotently after a snapshot rollover / box re-election. The entrypoint stays
# `sleep infinity`: OpenGeni / the provider owns the keep-alive root, the stack is a
# set of idempotent exec commands.
#
# MANDATORY (the 07-credentialed finding): DEBIAN_FRONTEND=noninteractive + TZ=Etc/UTC
# on EVERY apt layer — the full xfce4 tree pulls tzdata, whose interactive debconf
# blocks the builder forever otherwise.
#
# The CI push of this image to GHCR is P-Deploy, NOT this PR.
FROM ubuntu:22.04

ARG TERRAFORM_VERSION=1.13.3
ARG CHECKOV_VERSION=3.2.526
ARG NOVNC_REF=v1.5.0
ARG WEBSOCKIFY_REF=v0.12.0
ARG TARGETARCH

# noninteractive + a fixed TZ on EVERY apt layer (mandatory — see header).
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# ---- Layer 1: headless tool layer (parity with docker/sandbox.Dockerfile) ----
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    base_packages=" \
        bash ca-certificates coreutils curl gpg git jq openssh-client \
        fuse3 rclone ripgrep unzip wget python3 python3-pip software-properties-common \
        apt-transport-https net-tools netcat-openbsd sudo util-linux xxd file \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends $base_packages && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

# ---- Layer 2: DESKTOP STACK (X server + DE + pixel server + computer-use + record) ----
# NO xfce4-goodies (pulls screensaver/power-manager/notifyd that fight a headless box);
# NO xserver-xorg (Xvfb is the only X server; xorg pulls seat/udev cruft).
# tesseract-ocr is the OCR read-back tool the local stack-up assertion uses.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    desktop_packages=" \
        xvfb x11-utils x11-xserver-utils x11-apps xauth \
        xfce4 xfce4-terminal dbus-x11 \
        x11vnc \
        xdotool scrot ffmpeg \
        libgl1-mesa-dri \
        xterm tesseract-ocr \
        fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends $desktop_packages && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

# ---- Layer 3: noVNC + websockify (pinned, git-cloned) ----
RUN set -eux; \
    git clone --depth 1 -b ${NOVNC_REF} https://github.com/novnc/noVNC.git /opt/noVNC; \
    git clone --depth 1 -b ${WEBSOCKIFY_REF} https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify; \
    ln -sf /opt/noVNC/vnc.html /opt/noVNC/index.html

# ---- Layer 4: dbus machine-id (XFCE session bus needs it; must exist at build time) ----
RUN set -eux; dbus-uuidgen --ensure=/var/lib/dbus/machine-id; \
    ln -sf /var/lib/dbus/machine-id /etc/machine-id

# ---- Layer 5: a REAL in-box browser (google-chrome-stable) ----
# The spike PROVED `chromium-browser` on Jammy is a SNAP-TRANSITION STUB (a shell
# script that demands the chromium snap; with no snapd in the container it does NOT
# install a runnable browser). The canonical image ships the real Google Chrome deb
# (the "apt-key dance" is unavoidable and correct). Launch flags (--no-sandbox etc.)
# are applied at launch (computer-use / hook), never baked here.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
    chmod a+r /etc/apt/keyrings/google-chrome.gpg; \
    if [ "${arch}" = "amd64" ]; then \
        echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
            > /etc/apt/sources.list.d/google-chrome.list; \
        for attempt in 1 2 3; do \
            rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
            apt-get update && apt-get install -y --no-install-recommends google-chrome-stable && break; \
            if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
        done; \
        ln -sf /usr/bin/google-chrome-stable /usr/local/bin/opengeni-browser; \
    else \
        for attempt in 1 2 3; do \
            rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
            apt-get update && apt-get install -y --no-install-recommends firefox-esr && break; \
            if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
        done; \
        ln -sf /usr/bin/firefox-esr /usr/local/bin/opengeni-browser; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/local/bin/opengeni-browser --version

# ---- Layer 6: terraform / checkov / az / gh (parity with docker/sandbox.Dockerfile) ----
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) tfa="amd64" ;; arm64|aarch64) tfa="arm64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tfa}.zip"; \
    unzip /tmp/terraform.zip -d /usr/local/bin; rm /tmp/terraform.zip; terraform version
RUN set -eux; pip3 install --no-cache-dir "checkov==${CHECKOV_VERSION}"; checkov --version
RUN set -eux; curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash; az version
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    install -d -m 0755 /etc/apt/keyrings; \
    wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null; \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends gh && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    gh --version

# ---- Layer 7: the launch scripts (idempotent; invoked by ensureDisplayStack via exec) ----
COPY docker/desktop/opengeni-desktop-up.sh   /usr/local/bin/opengeni-desktop-up
COPY docker/desktop/opengeni-desktop-down.sh /usr/local/bin/opengeni-desktop-down
COPY docker/desktop/opengeni-record.sh       /usr/local/bin/opengeni-record
COPY docker/opengeni-git-askpass             /usr/local/bin/opengeni-git-askpass
RUN set -eux; \
    chmod 0755 /usr/local/bin/opengeni-desktop-up /usr/local/bin/opengeni-desktop-down \
               /usr/local/bin/opengeni-record /usr/local/bin/opengeni-git-askpass; \
    bash -n /usr/local/bin/opengeni-desktop-up; \
    bash -n /usr/local/bin/opengeni-desktop-down; \
    bash -n /usr/local/bin/opengeni-record

ENV HOME=/workspace
ENV DISPLAY=:0
ENV OPENGENI_DESKTOP_STREAM_PORT=6080
EXPOSE 6080
WORKDIR /workspace

# No CMD/ENTRYPOINT override of substance: the provider runs its own keep-alive
# root (Modal pins this to `sleep infinity`); the desktop stack is launched via
# exec by ensureDisplayStack, NOT as the container CMD.
CMD ["sleep", "infinity"]
