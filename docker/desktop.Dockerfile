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
FROM scratch AS lightpanda-assets

ADD --checksum=sha256:5713d49d06e8d4948d3358b6ce859ecca8e6f07dc312134d9f54999fb6e66c52 https://github.com/lightpanda-io/browser/releases/download/0.3.5/lightpanda-x86_64-linux /lightpanda-x86_64-linux
ADD --checksum=sha256:8d7b3a1d7b9024beef94e7fc7ce854030ee4d6def5f802b8e0e8824731c3d93a https://github.com/lightpanda-io/browser/releases/download/0.3.5/lightpanda-aarch64-linux /lightpanda-aarch64-linux
ADD --checksum=sha256:a5005b353a1738dd3d239234841cfcc808a7ec9faaebfcede3528f9fab3ae058 https://github.com/lightpanda-io/browser/archive/refs/tags/0.3.5.tar.gz /lightpanda-0.3.5-source.tar.gz
ADD --checksum=sha256:8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef https://raw.githubusercontent.com/lightpanda-io/browser/0.3.5/LICENSE /lightpanda-LICENSE

FROM scratch AS chrome-assets

ADD --checksum=sha256:bfb6e6d345055eb481a50db423256fa2732ce010f785a56c327e213a638efdef https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_151.0.7922.108-1_amd64.deb /google-chrome-stable.deb

FROM rust:1.82-bookworm AS computer-native-build

WORKDIR /src/agent
COPY agent .
RUN set -eux; \
    cargo build --locked --release -p opengeni-computer-native; \
    mkdir -p /out; \
    install -m 0755 target/release/opengeni-computer-native /out/opengeni-computer-native

FROM oven/bun:1.3.14 AS bun-runtime

FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS anydoc-runtime-builder

ARG TARGETARCH
WORKDIR /src
COPY docker/anydoc/package.json docker/anydoc/bun.lock ./
RUN set -eux; \
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

FROM debian:13-slim

ARG TERRAFORM_VERSION=1.13.3
ARG GLAB_VERSION=1.109.0
ARG CHECKOV_VERSION=3.2.526
ARG NOVNC_REF=v1.5.0
ARG WEBSOCKIFY_REF=v0.12.0
ARG TTYD_VERSION=1.7.7
ARG NODE_MAJOR=20
ARG TARGETARCH
ARG OPENGENI_CHROMIUM_VERSION=151.0.7922.108-1~deb13u1
ARG OPENGENI_DEBIAN_SECURITY_SNAPSHOT=20260809T010020Z

# noninteractive + a fixed TZ on EVERY apt layer (mandatory — see header).
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# ---- Layer 1: headless tool layer (parity with docker/sandbox.Dockerfile) ----
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    printf '%s\n' \
      "deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://snapshot.debian.org/archive/debian-security/${OPENGENI_DEBIAN_SECURITY_SNAPSHOT} trixie-security main" \
      > /etc/apt/sources.list.d/opengeni-chromium-snapshot.list; \
    base_packages=" \
        bash ca-certificates coreutils curl gpg git jq openssh-client \
        fuse3 procps rclone ripgrep unzip wget python3 python3-pip python3-venv \
        apt-transport-https net-tools netcat-openbsd sudo util-linux xxd file \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends $base_packages && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

# Node.js LTS from NodeSource. Pin the 20.x LTS line instead of inheriting the
# distribution's moving Node release, mirroring the gh keyring+repo layer.
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
        at-spi2-core libgtk-3-bin python3-gi gir1.2-gtk-3.0 \
        tini \
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
# The canonical image ships Google Chrome on amd64 and Debian Chromium on arm64.
# Both are real CDP-capable engines; there is no Ubuntu chromium snap-transition
# stub and no Firefox-only architecture that silently breaks browser automation.
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
# /opt/google/chrome/google-chrome (Chrome deb) and /usr/lib/chromium/chromium
# (Debian Chromium) are real engine binaries and are NOT aliased.
ARG OPENGENI_BROWSER_BIN_AMD64=/opt/google/chrome/google-chrome
ARG OPENGENI_BROWSER_BIN_ARM64=/usr/lib/chromium/chromium

# (i) the wrapper + the default-browser config files (one COPY, used right below).
COPY docker/desktop/opengeni-browser.sh            /usr/local/bin/opengeni-browser
COPY docker/desktop/opengeni-browser.helper.desktop /usr/share/xfce4/helpers/opengeni-browser.desktop
COPY docker/desktop/opengeni-browser.app.desktop    /usr/share/applications/opengeni-browser.desktop
COPY --from=chrome-assets /google-chrome-stable.deb /tmp/google-chrome-stable.deb

RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    if [ "${arch}" = "amd64" ]; then \
        for attempt in 1 2 3; do \
            rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
            apt-get update && apt-get install -y --no-install-recommends \
                /tmp/google-chrome-stable.deb && break; \
            if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
        done; \
        BROWSER_BIN="${OPENGENI_BROWSER_BIN_AMD64}"; \
    else \
        for attempt in 1 2 3; do \
            rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
            apt-get update && apt-get install -y --no-install-recommends \
                "chromium=${OPENGENI_CHROMIUM_VERSION}" \
                "chromium-common=${OPENGENI_CHROMIUM_VERSION}" && break; \
            if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
        done; \
        BROWSER_BIN="${OPENGENI_BROWSER_BIN_ARM64}"; \
    fi; \
    rm -f /tmp/google-chrome-stable.deb; \
    rm -rf /var/lib/apt/lists/*; \
    # Persist the resolved per-architecture engine. Docker ENV cannot retain a shell
    # variable chosen inside this RUN layer, so both launchers read this immutable file.
    install -d -m 0755 /etc/opengeni; \
    printf '%s\n' "${BROWSER_BIN}" > /etc/opengeni/browser-engine; \
    chmod 0644 /etc/opengeni/browser-engine; \
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
    # (vi) prove the wrapper reads the persisted path and launches the real engine.
    /usr/local/bin/opengeni-browser --version; \
    # (vii) prove the NAME aliases resolve to the wrapper AND launch (loop-free): invoke
    #     via the alias names (PATH resolution) with the real engine baked in. If any name
    #     had recursed into the wrapper the process would spin/EMFILE instead of printing
    #     a version; a clean --version here is the no-loop proof.
    for alias_name in google-chrome google-chrome-stable chromium chromium-browser; do \
        "${alias_name}" --version; \
    done

# ---- Layer 6: terraform / checkov / az / gh (parity with docker/sandbox.Dockerfile) ----
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) tfa="amd64" ;; arm64|aarch64) tfa="arm64" ;; *) echo "unsupported architecture=${arch}" >&2; exit 1 ;; esac; \
    curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tfa}.zip"; \
    unzip /tmp/terraform.zip -d /usr/local/bin; rm /tmp/terraform.zip; terraform version
RUN set -eux; \
    python3 -m venv /opt/checkov; \
    /opt/checkov/bin/pip install --no-cache-dir "checkov==${CHECKOV_VERSION}"; \
    ln -s /opt/checkov/bin/checkov /usr/local/bin/checkov; \
    checkov --version
RUN set -eux; curl --retry 5 --retry-all-errors --retry-delay 2 -fsSL https://aka.ms/InstallAzureCLIDeb | bash; az version
ENV AZURE_EXTENSION_DIR=/opt/az/extensions
RUN set -eux; \
    install -d -m 0755 "$AZURE_EXTENSION_DIR"; \
    az extension add --name azure-devops; \
    az repos --help >/dev/null
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

# ---- Layer 6b: ttyd static binary (REAL PTY-over-websocket; Channel-B terminal) ----
# Pinned static build from the upstream release. The PTY
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
COPY docker/desktop/opengeni-browserd-up.sh    /usr/local/bin/opengeni-browserd-up
COPY docker/desktop/opengeni-browserd-down.sh  /usr/local/bin/opengeni-browserd-down
COPY docker/desktop/opengeni-record.sh        /usr/local/bin/opengeni-record
COPY docker/opengeni-git-askpass              /usr/local/bin/opengeni-git-askpass
COPY packages/ogtool/package.json             /opt/opengeni/ogtool/package.json
COPY --from=browserd-build /src/packages/ogtool/dist/bin/ogtool.cjs /opt/opengeni/ogtool/bin/ogtool.cjs
COPY --from=browserd-build /out/opengeni-browserd /usr/local/bin/opengeni-browserd
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=browserd-build /out/agent-browser /usr/local/lib/opengeni/agent-browser
COPY --from=browserd-build /out/lightpanda /usr/local/lib/opengeni/lightpanda
COPY --from=browserd-build /out/lightpanda-LICENSE /usr/local/share/licenses/lightpanda/LICENSE
COPY --from=browserd-build /out/lightpanda-0.3.5-source.tar.gz /usr/local/share/source/lightpanda-0.3.5.tar.gz
COPY --from=browserd-build /out/opengeni-computer-native /usr/local/lib/opengeni/opengeni-computer-native
COPY --from=browserd-build /out/SHA256SUMS /usr/local/share/opengeni/browserd-SHA256SUMS
COPY docker/browserd-THIRD-PARTY-NOTICES /usr/local/share/opengeni/browserd-THIRD-PARTY-NOTICES
COPY --from=browserd-build /out/codemode-runtime /opt/opengeni/codemode-runtime
COPY --from=anydoc-runtime-builder /out /opt/opengeni/anydoc
COPY docker/anydoc/LICENSE /usr/local/share/licenses/anydoc/LICENSE
COPY docker/anydoc/THIRD-PARTY-NOTICES /usr/local/share/opengeni/anydoc-THIRD-PARTY-NOTICES
RUN set -eux; \
    chmod 0755 /usr/local/bin/opengeni-desktop-up /usr/local/bin/opengeni-desktop-down \
               /usr/local/bin/opengeni-terminal-up /usr/local/bin/opengeni-terminal-down \
               /usr/local/bin/opengeni-browserd-up /usr/local/bin/opengeni-browserd-down \
               /usr/local/bin/opengeni-record /usr/local/bin/opengeni-git-askpass \
               /usr/local/bin/opengeni-browserd /usr/local/lib/opengeni/agent-browser \
               /usr/local/lib/opengeni/lightpanda \
               /usr/local/lib/opengeni/opengeni-computer-native; \
    chmod 0755 /opt/opengeni/ogtool/bin/ogtool.cjs; \
    ln -s /opt/opengeni/ogtool/bin/ogtool.cjs /usr/local/bin/ogtool; \
    chmod 0755 /opt/opengeni/anydoc/node_modules/@firecrawl/anydoc/cli.js; \
    ln -s /opt/opengeni/anydoc/node_modules/@firecrawl/anydoc/cli.js /usr/local/bin/anydoc; \
    node --check /opt/opengeni/ogtool/bin/ogtool.cjs; \
    test -n "$(ogtool --version)"; \
    test "$(anydoc --version)" = 0.1.8; \
    printf 'name,value\nalpha,42\n' >/tmp/anydoc-smoke.csv; \
    anydoc /tmp/anydoc-smoke.csv | grep -q alpha; \
    printf '{\\rtf1\\ansi AnyDoc smoke}' >/tmp/anydoc-smoke.rtf; \
    anydoc /tmp/anydoc-smoke.rtf | grep -q 'AnyDoc smoke'; \
    NODE_PATH=/opt/opengeni/codemode-runtime/node_modules bun -e 'const module = await import("@opengeni/codemode"); if (typeof module.CodemodeClient !== "function" || typeof module.openGeni !== "object") process.exit(1)'; \
    bash -n /usr/local/bin/opengeni-desktop-up; \
    bash -n /usr/local/bin/opengeni-desktop-down; \
    bash -n /usr/local/bin/opengeni-terminal-up; \
    bash -n /usr/local/bin/opengeni-terminal-down; \
    bash -n /usr/local/bin/opengeni-browserd-up; \
    bash -n /usr/local/bin/opengeni-browserd-down; \
    sha256sum -c /usr/local/share/opengeni/browserd-SHA256SUMS; \
    bash -n /usr/local/bin/opengeni-record

ENV HOME=/workspace
ENV DISPLAY=:0
ENV OPENGENI_DESKTOP_STREAM_PORT=6080
ENV OPENGENI_TERMINAL_STREAM_PORT=7681
ENV OPENGENI_BROWSERD_PORT=7682
ENV OPENGENI_BROWSERD_AGENT_BROWSER_BINARY=/usr/local/lib/opengeni/agent-browser
ENV OPENGENI_BROWSERD_LIGHTPANDA_BINARY=/usr/local/lib/opengeni/lightpanda
ENV OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY=/usr/local/lib/opengeni/opengeni-computer-native
ENV OPENGENI_BROWSERD_COMPUTER_ENVIRONMENT_MODE=isolated_linux
ENV NODE_PATH=/opt/opengeni/codemode-runtime/node_modules
EXPOSE 6080
EXPOSE 7681
EXPOSE 7682
WORKDIR /workspace

# The managed box hosts many independently ending GUI process trees. PID 1 must
# reap their D-Bus/AT-SPI descendants after exact controller teardown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
