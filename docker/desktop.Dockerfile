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
ARG TTYD_VERSION=1.7.7
ARG NODE_MAJOR=20
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
        fuse3 procps rclone ripgrep unzip wget python3 python3-pip software-properties-common \
        apt-transport-https net-tools netcat-openbsd sudo util-linux xxd file \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends $base_packages && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

# Node.js LTS from NodeSource. Ubuntu 22.04's apt `nodejs` is Node 12 — too old
# to run ogtool; pin the 20.x LTS line via the NodeSource apt repo, mirroring the
# gh keyring+repo layer.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    mkdir -p -m 755 /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    chmod go+r /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends nodejs && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    node --version

# ---- Layer 2: DESKTOP STACK (X server + DE + pixel server + computer-use + record) ----
# NO xfce4-goodies (pulls screensaver/power-manager/notifyd that fight a headless box);
# NO xserver-xorg (Xvfb is the only X server; xorg pulls seat/udev cruft).
# tesseract-ocr is the OCR read-back tool the local stack-up assertion uses.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    desktop_packages=" \
        xvfb x11-utils x11-xserver-utils x11-apps xauth \
        xkb-data x11-xkb-utils \
        xfce4 xfce4-terminal dbus-x11 \
        at-spi2-core \
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

# ---- Layer 5: a REAL in-box browser (google-chrome-stable) + container-safe wiring ----
# The spike PROVED `chromium-browser` on Jammy is a SNAP-TRANSITION STUB (a shell
# script that demands the chromium snap; with no snapd in the container it does NOT
# install a runnable browser). The canonical image ships the real Google Chrome deb
# (the "apt-key dance" is unavoidable and correct).
#
# CONTAINER-SAFE LAUNCH (the bug this layer fixes): the box runs as ROOT, and Chrome
# refuses to start as root without --no-sandbox — so the stock XFCE/exo "Web Browser"
# (debian-sensible-browser -> x-www-browser -> google-chrome-stable, NO flags) hard-
# fails with exit 1, which exo surfaces as "Failed to execute default Web Browser.
# Input/output error." We fix BOTH the human menu path and the agent path with ONE
# wrapper that supplies the container-safe flags, and we wire it as the system default
# browser so every exo/x-www-browser/mimeapps resolution lands on it.
# The REAL engine binary the wrapper execs — ABSOLUTE path into the package payload,
# NEVER a /usr/bin name, because below we alias the /usr/bin browser NAMES
# (google-chrome, google-chrome-stable, chromium, chromium-browser) to the wrapper
# itself. Pointing OPENGENI_BROWSER_BIN at /usr/bin/google-chrome-stable would make the
# wrapper exec a symlink that resolves straight back to the wrapper => infinite loop.
# /opt/google/chrome/google-chrome (chrome deb) and /usr/lib/firefox-esr/firefox-esr
# (firefox-esr deb) are the real launcher binaries and are NOT aliased.
ARG OPENGENI_BROWSER_BIN_AMD64=/opt/google/chrome/google-chrome
ARG OPENGENI_BROWSER_BIN_ARM64=/usr/lib/firefox-esr/firefox-esr

# (i) the wrapper + the default-browser config files (one COPY, used right below).
COPY docker/desktop/opengeni-browser.sh            /usr/local/bin/opengeni-browser
COPY docker/desktop/opengeni-browser.helper.desktop /usr/share/xfce4/helpers/opengeni-browser.desktop
COPY docker/desktop/opengeni-browser.app.desktop    /usr/share/applications/opengeni-browser.desktop

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
        BROWSER_BIN="${OPENGENI_BROWSER_BIN_AMD64}"; \
    else \
        for attempt in 1 2 3; do \
            rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
            apt-get update && apt-get install -y --no-install-recommends firefox-esr && break; \
            if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
        done; \
        BROWSER_BIN="${OPENGENI_BROWSER_BIN_ARM64}"; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    # the wrapper reads OPENGENI_BROWSER_BIN; bake the per-arch real binary into the
    # process env (ENV below) AND record it so the wrapper resolves it deterministically.
    echo "OPENGENI_BROWSER_BIN baked as ${BROWSER_BIN}"; \
    chmod 0755 /usr/local/bin/opengeni-browser; \
    bash -n /usr/local/bin/opengeni-browser; \
    # (ii) make the wrapper the XFCE default WebBrowser so exo-open --launch WebBrowser
    #      (the panel/menu "Web Browser") resolves to it instead of debian-sensible-browser.
    #      Write helpers.rc both system-wide (/etc/xdg) and into the /workspace skel so a
    #      HOME=/workspace session picks it up. The up-script also re-asserts the HOME copy.
    install -d -m 0755 /etc/xdg/xfce4; \
    printf '[Default]\nWebBrowser=opengeni-browser\n' > /etc/xdg/xfce4/helpers.rc; \
    install -d -m 0755 /workspace/.config/xfce4; \
    printf '[Default]\nWebBrowser=opengeni-browser\n' > /workspace/.config/xfce4/helpers.rc; \
    # (iii) repoint the debian x-www-browser / sensible-browser alternatives at the
    #       wrapper too, so even the fallback chain is container-safe.
    update-alternatives --install /usr/bin/x-www-browser  x-www-browser  /usr/local/bin/opengeni-browser 250; \
    update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/local/bin/opengeni-browser 250 || true; \
    update-alternatives --set x-www-browser /usr/local/bin/opengeni-browser; \
    # (iv) register the freedesktop default handler for http(s)/html so any "open URL"
    #      (mimeapps) path also lands on the wrapper.
    install -d -m 0755 /etc/xdg; \
    printf '[Default Applications]\nx-scheme-handler/http=opengeni-browser.desktop\nx-scheme-handler/https=opengeni-browser.desktop\ntext/html=opengeni-browser.desktop\nx-scheme-handler/about=opengeni-browser.desktop\nx-scheme-handler/unknown=opengeni-browser.desktop\n' \
        > /etc/xdg/mimeapps.list; \
    update-desktop-database /usr/share/applications 2>/dev/null || true; \
    # (v) NAME ALIASES — make every common browser command name resolve to the wrapper.
    #     The agent's computer-use shell runs `google-chrome --new-window <url>` /
    #     `chromium` / `chromium-browser`; none of those are container-safe on their own
    #     (chromium isn't installed; bare google-chrome crashes as root w/o --no-sandbox).
    #     We symlink each NAME into /usr/local/bin -> the wrapper. /usr/local/bin precedes
    #     /usr/bin on the default PATH, so these shadow the chrome deb's own
    #     /usr/bin/google-chrome{,-stable} symlinks WITHOUT removing them (the deb's
    #     /usr/bin links stay intact -> /opt/google/chrome/google-chrome, keeping the
    #     wrapper's exec target healthy). NO LOOP: the wrapper execs the REAL binary by
    #     absolute path (/opt/google/chrome/google-chrome via OPENGENI_BROWSER_BIN), never
    #     one of these names — so a name never resolves back into the wrapper recursively.
    for alias_name in google-chrome google-chrome-stable chromium chromium-browser; do \
        ln -sf /usr/local/bin/opengeni-browser "/usr/local/bin/${alias_name}"; \
    done; \
    # x-www-browser stays owned by update-alternatives (set in step iii above); leave it.
    # (vi) prove the wrapper actually launches the real engine (--version, NO_AT_BRIDGE
    #     keeps it quiet). Uses the baked env via the ENV directive below at runtime;
    #     here we pass it inline so the build-time check exercises the same path.
    OPENGENI_BROWSER_BIN="${BROWSER_BIN}" /usr/local/bin/opengeni-browser --version; \
    # (vii) prove the NAME aliases resolve to the wrapper AND launch (loop-free): invoke
    #     via the alias names (PATH resolution) with the real engine baked in. If any name
    #     had recursed into the wrapper the process would spin/EMFILE instead of printing
    #     a version; a clean --version here is the no-loop proof.
    for alias_name in google-chrome google-chrome-stable chromium chromium-browser; do \
        OPENGENI_BROWSER_BIN="${BROWSER_BIN}" "${alias_name}" --version; \
    done

# the per-arch real engine the wrapper execs (amd64 chrome by default; the ARM build
# arg path overrides at build time). Lives in process env so the wrapper picks it up
# from BOTH the human exo launch and the agent computer-use launch. ABSOLUTE real-binary
# path — NOT /usr/bin/google-chrome-stable, which is now a wrapper alias (loop guard).
ENV OPENGENI_BROWSER_BIN=/opt/google/chrome/google-chrome

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

# ---- Layer 6b: ttyd static binary (REAL PTY-over-websocket; Channel-B terminal) ----
# Pinned static build from the upstream release (no apt package on Jammy). The PTY
# port (7681) is exposed over the SAME Modal raw-TLS tunnel as the desktop noVNC.
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) tarch="x86_64" ;; arm64|aarch64) tarch="aarch64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${tarch}" -o /usr/local/bin/ttyd; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

# ---- Layer 7: the launch scripts (idempotent; invoked by ensureDisplayStack via exec) ----
COPY docker/desktop/opengeni-desktop-up.sh    /usr/local/bin/opengeni-desktop-up
COPY docker/desktop/opengeni-desktop-down.sh  /usr/local/bin/opengeni-desktop-down
COPY docker/desktop/opengeni-terminal-up.sh   /usr/local/bin/opengeni-terminal-up
COPY docker/desktop/opengeni-terminal-down.sh /usr/local/bin/opengeni-terminal-down
COPY docker/desktop/opengeni-record.sh        /usr/local/bin/opengeni-record
COPY docker/opengeni-git-askpass              /usr/local/bin/opengeni-git-askpass
COPY docker/ogtool                            /usr/local/bin/ogtool
RUN set -eux; \
    chmod 0755 /usr/local/bin/opengeni-desktop-up /usr/local/bin/opengeni-desktop-down \
               /usr/local/bin/opengeni-terminal-up /usr/local/bin/opengeni-terminal-down \
               /usr/local/bin/opengeni-record /usr/local/bin/opengeni-git-askpass \
               /usr/local/bin/ogtool; \
    cp /usr/local/bin/ogtool /tmp/ogtool-check.js; \
    node --check /tmp/ogtool-check.js; \
    rm /tmp/ogtool-check.js; \
    bash -n /usr/local/bin/opengeni-desktop-up; \
    bash -n /usr/local/bin/opengeni-desktop-down; \
    bash -n /usr/local/bin/opengeni-terminal-up; \
    bash -n /usr/local/bin/opengeni-terminal-down; \
    bash -n /usr/local/bin/opengeni-record

ENV HOME=/workspace
ENV DISPLAY=:0
ENV OPENGENI_DESKTOP_STREAM_PORT=6080
ENV OPENGENI_TERMINAL_STREAM_PORT=7681
EXPOSE 6080
EXPOSE 7681
WORKDIR /workspace

# No CMD/ENTRYPOINT override of substance: the provider runs its own keep-alive
# root (Modal pins this to `sleep infinity`); the desktop stack is launched via
# exec by ensureDisplayStack, NOT as the container CMD.
CMD ["sleep", "infinity"]
