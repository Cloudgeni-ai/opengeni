# Module: Desktop image & stack (the what + how)  (desktop-image)

## Specification

# MODULE SPEC — Desktop Image & Stack (the "what" + "how")

**Channel B pixel-plane image, the in-box display stack, and per-provider image composition for the OpenGeni sandbox-surfacing vision.**

Scope boundary: this module owns (1) the canonical OpenGeni *desktop image* (Dockerfile, package list, geometry/DPI), (2) the *display stack launch* procedure (`ensureDisplayStack`) that brings up `Xvfb → WM → x11vnc → websockify/noVNC` over the externally-owned `client`, (3) the *per-provider image composition* (one canonical OCI image → per-provider template build), and (4) the *recording* sidecar (ffmpeg x11grab). It does **not** own the lease, the resume/launch lifecycle, the tunnel-URL minting handshake, or the React viewer — those are sibling modules. The seams to them are named precisely in §9.

> **SUPERSEDED transport note (stateless-workers ruling — see `00-master-spine.md` §B.2 and `modules/02-owner.md`).** This module was written against the old in-worker `SandboxOwner` actor; under the stateless-workers ruling there is **no persistent `SandboxOwner`** — any pool worker resumes the box **by id** per turn (or per viewer-attach), runs the idempotent `ensureDisplayStack`/`setGeometry`/recording exec commands over the **non-owned** handle, and **drops the handle** at turn end. The **desktop-image / display-stack / recording capability content is unchanged and not weakened** — only the launcher's identity changes. Read every "`SandboxOwner.ensureDisplayStack`" / "the `SandboxOwner` holds `{client, session}`" / "`apps/worker/src/sandbox-owner.ts`" below as **"any pool worker, via the per-turn resume-by-id handle (file: `apps/worker/src/sandbox-resume.ts`)"**; retained verbatim for provenance.

---

## 0. Decisions locked for v1 (the "what")

| Axis | v1 decision | v2 path |
|---|---|---|
| X server | **Xvfb :0**, 24-bit, 96 DPI, RAM framebuffer (no DRI/GPU) | KasmVNC `Xvnc` (fused) or TigerVNC |
| Desktop env | **XFCE4** + `dbus-x11` | openbox+tint2 lightweight tier |
| Pixel server | **x11vnc** `-shared` on `:5900` | KasmVNC (built-in ws+httpd) |
| WS bridge | **websockify v0.12.0 + noVNC** → one port `6080` | gone (fused into Xvnc) |
| Input | **xdotool** | ydotool (only if Wayland) |
| Capture | **scrot --pointer** | — |
| Recording | **ffmpeg x11grab** sidecar | — |
| Transport | **VNC-over-WebSocket**, one exposed port `6080` | WebRTC (Selkies) |
| Auth at box edge | **none** (`-nopw`); auth is the OpenGeni scoped tunnel URL | websockify `--token-plugin` if box-level needed |
| Who launches | **`SandboxOwner.ensureDisplayStack`** via `client.exec` (NOT container CMD) | baked supervisord init (provider-template only) |
| Stream port | **`OPENGENI_DESKTOP_STREAM_PORT=6080`** (constant `DESKTOP_STREAM_PORT`) | — |
| Geometry | session-open parameter `{width,height,dpi}`; resolution change = full chain restart | live RANDR via Xorg-dummy/Kasm |

**Why launch-via-exec, not CMD:** the canonical envelope-replay primitive ("re-establish-singleton-from-envelope-under-CAS") must idempotently re-establish the desktop chain after Modal's 24h snapshot-rollover (new `sandboxId`, same image) and after any owner re-election. If the chain were the container CMD, OpenGeni could not (a) re-run it on resume against a box whose root process is `sleep infinity` (Modal pins this — `modal/sandbox.js`), (b) parameterize geometry per session, or (c) tear it down/restart on resolution change. The stack is therefore a **set of idempotent exec commands the `SandboxOwner` drives**, mirroring the existing `SandboxLifecycleHook` mechanism (`packages/runtime/src/index.ts:1735-1740`, `beforeAgentStart` phase, `run(session, context)` signature).

---

## 1. THE DOCKERFILE — `docker/desktop-sandbox.Dockerfile`

New file. Layered on the *same conventions* as the existing `docker/sandbox.Dockerfile` (3-attempt apt retry loop, `HOME=/workspace`, `WORKDIR /workspace`, askpass copy) so it is a strict superset: the desktop image is the headless image **plus** the pixel stack, so a desktop box can also serve Channel A (terminal/files/git) with zero divergence.

```dockerfile
# docker/desktop-sandbox.Dockerfile
# OpenGeni canonical DESKTOP sandbox image (Channel B pixel plane + Channel A headless).
# Superset of docker/sandbox.Dockerfile: same tool layer + Xvfb/XFCE/x11vnc/websockify/noVNC.
# Launched via SandboxOwner.ensureDisplayStack (exec), NOT as container CMD.
FROM ubuntu:22.04

ARG TERRAFORM_VERSION=1.13.3
ARG CHECKOV_VERSION=3.2.526
ARG NOVNC_REF=v1.5.0
ARG WEBSOCKIFY_REF=v0.12.0
ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# ---- Layer 1: headless tool layer (parity with docker/sandbox.Dockerfile) ----
RUN set -eux; \
    base_packages=" \
        bash ca-certificates coreutils curl gpg git jq openssh-client \
        fuse3 rclone ripgrep unzip wget python3 python3-pip software-properties-common \
        apt-transport-https net-tools netcat-openbsd sudo util-linux \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends $base_packages && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*

# ---- Layer 2: DESKTOP STACK (X server + DE + pixel server + computer-use + record) ----
RUN set -eux; \
    desktop_packages=" \
        xvfb x11-utils x11-xserver-utils x11-apps xauth \
        xfce4 xfce4-terminal dbus-x11 \
        x11vnc \
        xdotool scrot ffmpeg \
        libgl1-mesa-dri \
        fonts-dejavu fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    "; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; \
        apt-get update && apt-get install -y --no-install-recommends $desktop_packages && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*
# Note: NO xfce4-goodies (pulls screensaver/power-manager/notifyd that fight a headless box);
#       NO xserver-xorg (Xvfb is the only X server; xorg pulls seat/udev cruft).

# ---- Layer 3: noVNC + websockify (pinned, git-cloned) ----
RUN set -eux; \
    git clone --depth 1 -b ${NOVNC_REF} https://github.com/novnc/noVNC.git /opt/noVNC; \
    git clone --depth 1 -b ${WEBSOCKIFY_REF} https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify; \
    ln -sf /opt/noVNC/vnc.html /opt/noVNC/index.html

# ---- Layer 4: dbus machine-id (XFCE session bus needs it; must exist at build time) ----
RUN set -eux; dbus-uuidgen --ensure=/var/lib/dbus/machine-id; \
    ln -sf /var/lib/dbus/machine-id /etc/machine-id

# ---- Layer 5: in-box browser (Chromium via apt; flags applied at launch, not here) ----
RUN set -eux; \
    for attempt in 1 2 3; do \
        rm -rf /var/lib/apt/lists/*; \
        apt-get update && apt-get install -y --no-install-recommends chromium-browser && break; \
        if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); \
    done; \
    rm -rf /var/lib/apt/lists/*
# (firefox-esr optional: add to the apt line above if a 2nd browser is wanted.)

# ---- Layer 6: terraform / checkov / az / gh (verbatim from docker/sandbox.Dockerfile) ----
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in amd64) tfa="amd64" ;; arm64|aarch64) tfa="arm64" ;; *) exit 1 ;; esac; \
    curl -fsSLo /tmp/terraform.zip "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_${tfa}.zip"; \
    unzip /tmp/terraform.zip -d /usr/local/bin; rm /tmp/terraform.zip; terraform version
RUN set -eux; pip3 install --no-cache-dir "checkov==${CHECKOV_VERSION}"; checkov --version
RUN set -eux; curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash; az version
# (gh install block: copy verbatim from docker/sandbox.Dockerfile lines installing gh)

# ---- Layer 7: the launch scripts (idempotent; invoked by ensureDisplayStack via exec) ----
COPY docker/desktop/opengeni-desktop-up.sh   /usr/local/bin/opengeni-desktop-up
COPY docker/desktop/opengeni-desktop-down.sh /usr/local/bin/opengeni-desktop-down
COPY docker/desktop/opengeni-record.sh       /usr/local/bin/opengeni-record
COPY docker/opengeni-git-askpass             /usr/local/bin/opengeni-git-askpass
RUN chmod 0755 /usr/local/bin/opengeni-desktop-up /usr/local/bin/opengeni-desktop-down \
               /usr/local/bin/opengeni-record /usr/local/bin/opengeni-git-askpass

ENV HOME=/workspace
ENV DISPLAY=:0
ENV OPENGENI_DESKTOP_STREAM_PORT=6080
WORKDIR /workspace
# No CMD/ENTRYPOINT override: providers run their own keep-alive root (Modal: sleep infinity).
```

**Package-list rationale (load-bearing exclusions):**
- `netcat-openbsd` not `netcat` — Ubuntu 22.04 `netcat` is a virtual package (ambiguous provider → apt fails non-interactively).
- `chromium-browser` not `google-chrome-stable` — avoids the Google apt-key dance; flags (`--no-sandbox` etc.) are applied at *launch* (§4), never baked.
- Fonts are mandatory: a bare Xvfb has no fonts → Chromium/XFCE render tofu boxes. `fonts-noto-color-emoji` so terminal/web emoji render in recordings.
- `dbus-uuidgen --ensure` at build time — without it XFCE's first `dbus-launch` generates a per-container id and logs a warning; baking it makes the session bus deterministic.

---

## 2. THE LAUNCH SCRIPTS — `docker/desktop/*.sh`

These are the idempotent chain. `ensureDisplayStack` calls `opengeni-desktop-up` exactly once per (box, geometry); it is safe to call N times (PID guards + readiness gates make re-invocation a no-op when already up).

### `docker/desktop/opengeni-desktop-up.sh`
```bash
#!/usr/bin/env bash
# Idempotent desktop-stack launcher. Re-runnable after snapshot-rollover / owner re-election.
# Env: DESKTOP_W DESKTOP_H DESKTOP_DPI STREAM_PORT (defaults below). DISPLAY fixed to :0.
set -euo pipefail
W="${DESKTOP_W:-1280}"; H="${DESKTOP_H:-800}"; DPI="${DESKTOP_DPI:-96}"
PORT="${STREAM_PORT:-${OPENGENI_DESKTOP_STREAM_PORT:-6080}}"
export DISPLAY=:0
RUN=/tmp/opengeni-desktop; mkdir -p "$RUN"

alive() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
start() { # name, cmd...
  local name="$1"; shift
  alive "$name" && return 0
  setsid "$@" >"$RUN/$name.log" 2>&1 &
  echo $! >"$RUN/$name.pid"
}

# 1. Xvfb :0  (RAM framebuffer; 24-bit mandatory for Chromium; no live RANDR -> geometry fixed here)
start xvfb Xvfb :0 -ac -screen 0 "${W}x${H}x24" -dpi "$DPI" -retro -nolisten tcp -nolisten unix
# readiness gate: block until the display answers
for i in $(seq 1 50); do xdpyinfo -display :0 >/dev/null 2>&1 && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "Xvfb failed to come up" >&2; exit 11; }; done

# 2. dbus + XFCE4  (supervised by caller; respawn handled by re-invoking up)
if ! alive xfce; then
  start xfce dbus-launch --exit-with-session startxfce4
fi

# 3. x11vnc  (shares the EXISTING :0; -shared = native N-viewer fan-out; -forever = survive 0 viewers)
start x11vnc x11vnc -display :0 -forever -shared -wait 50 -rfbport 5900 -nopw \
  -noxdamage -noxfixes -repeat -ping 1 -speeds lan -o "$RUN/x11vnc.full.log"
for i in $(seq 1 50); do nc -z localhost 5900 && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "x11vnc failed on :5900" >&2; exit 12; }; done

# 4. websockify + noVNC  -> ONE exposed port (6080); 5900 stays localhost-only
start novnc /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen "$PORT" --web /opt/noVNC
for i in $(seq 1 50); do nc -z localhost "$PORT" && break; sleep 0.1; \
  [ "$i" = "50" ] && { echo "websockify failed on $PORT" >&2; exit 13; }; done

echo "OPENGENI_DESKTOP_UP port=$PORT geometry=${W}x${H} dpi=${DPI}"
```

### `docker/desktop/opengeni-desktop-down.sh`
```bash
#!/usr/bin/env bash
set -uo pipefail
RUN=/tmp/opengeni-desktop
for name in record novnc x11vnc xfce xvfb; do
  [ -f "$RUN/$name.pid" ] || continue
  kill "$(cat "$RUN/$name.pid")" 2>/dev/null || true
  rm -f "$RUN/$name.pid"
done
echo "OPENGENI_DESKTOP_DOWN"
```

### `docker/desktop/opengeni-record.sh`
```bash
#!/usr/bin/env bash
# Second, independent reader of :0 (x11grab). Runs alongside x11vnc with no interference.
set -euo pipefail
W="${DESKTOP_W:-1280}"; H="${DESKTOP_H:-800}"; FPS="${RECORD_FPS:-15}"
OUT="${RECORD_OUT:-/tmp/opengeni-desktop/recording-$(date +%s).mp4}"
RUN=/tmp/opengeni-desktop; mkdir -p "$RUN"
export DISPLAY=:0
setsid ffmpeg -y -f x11grab -draw_mouse 1 -framerate "$FPS" -video_size "${W}x${H}" -i :0.0 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart "$OUT" \
  >"$RUN/record.log" 2>&1 &
echo $! >"$RUN/record.pid"
echo "OPENGENI_RECORD_STARTED out=$OUT pid=$(cat "$RUN/record.pid")"
```

**Resolution-change semantics (v1):** Xvfb has no live RANDR. `setGeometry({w,h,dpi})` = `opengeni-desktop-down` → `opengeni-desktop-up` with new `DESKTOP_W/H/DPI` env. The whole chain restarts (~1-2s blink); viewers see a reconnect. This is `SandboxOwner.setDesktopGeometry()` and emits `desktop.geometry.changed` on Channel A so the React viewer re-fits the canvas.

---

## 3. THE LAUNCH SEAM — `SandboxOwner.ensureDisplayStack` (TypeScript contract)

This is the *how-it-gets-started*. The `SandboxOwner` (sibling module, `apps/worker/src/sandbox-owner.ts`) holds the externally-owned `{client, session}`. This module contributes the desktop methods it gains. They drive the scripts above through the session's `execCommand` (verified shape `ExecCommandArgs`/`SandboxExecResult`, `@openai/agents-core@0.11.6/dist/sandbox/session.d.ts:39-57,113`).

```ts
// packages/runtime/src/desktop/stack.ts  (NEW — pure functions, no owner-lifecycle coupling)
import type { SandboxSessionLike } from "@openai/agents-core/sandbox/session";
import { urlForExposedPort } from "@openai/agents-core/sandbox/session";

export const DESKTOP_STREAM_PORT = 6080 as const;

export type DesktopGeometry = {
  width: number;   // default 1280
  height: number;  // default 800
  dpi: number;     // default 96
};
export const DEFAULT_DESKTOP_GEOMETRY: DesktopGeometry = { width: 1280, height: 800, dpi: 96 };

export type DesktopStackState =
  | { phase: "absent" }                                   // never launched on this box
  | { phase: "launching"; geometry: DesktopGeometry }     // up.sh in flight
  | { phase: "up"; geometry: DesktopGeometry; port: number }
  | { phase: "failed"; geometry: DesktopGeometry; exitCode: number; stderr: string };

export type EnsureDisplayStackResult = {
  state: DesktopStackState;
  /** raw exec result for diagnostics; never surfaced to viewers */
  exec: { exitCode: number; stdout: string; stderr: string };
};

/**
 * Idempotently bring up Xvfb→XFCE→x11vnc→websockify on STREAM_PORT.
 * Safe to call N times (scripts are PID-guarded). Throws DesktopStackError only on
 * non-recoverable launch failure (exit codes 11/12/13 from up.sh = stage that died).
 */
export async function ensureDisplayStack(
  session: SandboxSessionLike,
  geometry: DesktopGeometry = DEFAULT_DESKTOP_GEOMETRY,
): Promise<EnsureDisplayStackResult> {
  assertHasExec(session); // throws DesktopUnsupportedError if !session.execCommand
  const env =
    `DESKTOP_W=${geometry.width} DESKTOP_H=${geometry.height} ` +
    `DESKTOP_DPI=${geometry.dpi} STREAM_PORT=${DESKTOP_STREAM_PORT}`;
  const res = await execOrThrow(session, `${env} opengeni-desktop-up`, /* timeoutMs */ 30_000);
  if (res.exitCode === 0) {
    return { state: { phase: "up", geometry, port: DESKTOP_STREAM_PORT }, exec: res };
  }
  throw new DesktopStackError(res.exitCode ?? -1, res.stderr);
}

export async function tearDownDisplayStack(session: SandboxSessionLike): Promise<void> {
  await execOrThrow(session, "opengeni-desktop-down", 10_000);
}

export async function startRecording(
  session: SandboxSessionLike,
  geometry: DesktopGeometry,
  out: string,
): Promise<{ pid: number; out: string }> {
  const env = `DESKTOP_W=${geometry.width} DESKTOP_H=${geometry.height} RECORD_OUT=${shellQuote(out)}`;
  const res = await execOrThrow(session, `${env} opengeni-record`, 10_000);
  return parseRecordResult(res.stdout); // "OPENGENI_RECORD_STARTED out=… pid=…"
}

/**
 * Mint the direct-to-provider viewer URL for the desktop port.
 * Control-plane only; pixels never traverse this code.
 */
export async function resolveDesktopStreamUrl(
  session: SandboxSessionLike,
): Promise<{ wsUrl: string; httpUrl: string; endpoint: ExposedPortEndpoint }> {
  if (typeof session.resolveExposedPort !== "function") {
    throw new DesktopUnsupportedError("provider session has no resolveExposedPort (headless-only)");
  }
  const endpoint = await session.resolveExposedPort(DESKTOP_STREAM_PORT);
  return {
    wsUrl: urlForExposedPort(endpoint, "ws"),     // wss://<host>:<port>/websockify
    httpUrl: urlForExposedPort(endpoint, "http"), // https://<host>:<port>/vnc.html
    endpoint,
  };
}
```

**Diagnostics → Channel A mapping** (emitted by the owner, not here): `up.sh` echoes `OPENGENI_DESKTOP_UP port=… geometry=… dpi=…` on success; exit `11/12/13` = Xvfb/x11vnc/websockify stage failure respectively. The owner maps these to a `desktop.stack` event (`{ phase, geometry, port, error? }`) so the failure is a *handshake value, never silent* (§9 capability contract `DesktopStream.transport: null` on failure).

---

## 4. IN-BOX BROWSER LAUNCH FLAGS (gVisor-safe)

The agent (or a `beforeAgentStart` hook) launches Chromium with these flags. Baked nowhere; applied at exec time so they can be tuned per workload.

```ts
// packages/runtime/src/desktop/browser.ts
export const CHROMIUM_GVISOR_FLAGS = [
  "--no-sandbox",                       // setuid/namespace sandbox can't nest in gVisor — REQUIRED
  "--disable-dev-shm-usage",            // 64MB /dev/shm default → crash; route to /tmp — REQUIRED
  "--disable-gpu",                      // no DRI device; pure 2D/DOM path (avoids GL stack entirely)
  "--use-gl=angle", "--use-angle=swiftshader", // only if WebGL needed; else --disable-gpu alone
  "--enable-unsafe-swiftshader",        // recent Chrome demoted SwiftShader from silent WebGL fallback
  "--password-store=basic",
  "--disable-features=Translate,site-per-process",
  "--window-position=0,0",
] as const;

export function chromiumLaunchCommand(geometry: DesktopGeometry, url?: string): string {
  const size = `--window-size=${geometry.width},${geometry.height}`;
  return `DISPLAY=:0 chromium-browser ${CHROMIUM_GVISOR_FLAGS.join(" ")} ${size} ${url ? shellQuote(url) : "about:blank"} &`;
}
```

---

## 5. AGENT COMPUTER-USE (xdotool/scrot) — `Computer` interface impl

The agent's computer-use actions and the viewers' pixels are *the same display* (zero projection). Implements `@openai/agents-core@0.11.6/dist/computer.d.ts` over the same `session.execCommand` channel the owner already holds.

```ts
// packages/runtime/src/desktop/computer.ts
import type { Computer, Button } from "@openai/agents-core";

export function createSandboxComputer(
  session: SandboxSessionLike,
  geometry: DesktopGeometry,
): Computer {
  const x = (cmd: string) => execOrThrow(session, `DISPLAY=:0 ${cmd}`, 10_000);
  const btn = (b: Button) => ({ left: 1, wheel: 2, right: 3, back: 8, forward: 9 }[b] ?? 1);
  return {
    environment: "ubuntu",                       // SDK enum is 'ubuntu', NOT 'linux'
    dimensions: [geometry.width, geometry.height],
    async screenshot() {
      const p = `/tmp/shot-${crypto.randomUUID()}.png`;
      await x(`scrot --pointer ${p}`);           // --pointer = include cursor (what a human sees)
      const b64 = await readFileBase64(session, p);
      await x(`rm -f ${p}`);
      return b64;
    },
    async click(px, py, button) { await x(`xdotool mousemove --sync ${px} ${py} click ${btn(button)}`); },
    async doubleClick(px, py)    { await x(`xdotool mousemove --sync ${px} ${py} click --repeat 2 1`); },
    async move(px, py)           { await x(`xdotool mousemove --sync ${px} ${py}`); },
    async scroll(px, py, _sx, sy){ await x(`xdotool mousemove --sync ${px} ${py} click --repeat ${Math.abs(sy)||1} ${sy<0?4:5}`); },
    async type(text)             { await x(`xdotool type --delay 12 -- ${shellQuote(text)}`); },
    async keypress(keys)         { await x(`xdotool key ${keys.map(toXKeysym).join("+")}`); },
    async drag(path) {
      const [sx, sy] = path[0];
      await x(`xdotool mousemove --sync ${sx} ${sy} mousedown 1`);
      for (const [px, py] of path.slice(1)) await x(`xdotool mousemove --sync ${px} ${py}`);
      await x(`xdotool mouseup 1`);
    },
    async wait() { await new Promise((r) => setTimeout(r, 1000)); },
  };
}
```

`--sync` on every `mousemove` blocks until the pointer arrives, eliminating click-before-move races. `environment: "ubuntu"` is mandatory (the SDK enum is `'mac'|'windows'|'ubuntu'|'browser'`; `'linux'` is rejected).

---

## 6. PER-PROVIDER IMAGE COMPOSITION (the "how it composes")

**One canonical OCI image, built once, pushed to GHCR; then each provider's image model consumes it.** Two structurally different consumption models:

### Model A — registry-at-runtime (Modal)
Modal runs an **arbitrary registry OCI image at sandbox-create time** — no prebuild/template step. `ModalImageSelector.fromTag(imageTag)` (verified `modal/sandbox.d.ts:62,83`) selects the GHCR image; the SDK pins the box root process to `sleep infinity` and OpenGeni owns the desktop launch via exec. This is the *primary* path.

- Wire-up: `OPENGENI_MODAL_IMAGE_REF=ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:<ver>` → `createSandboxClient` already does `options.image = ModalImageSelector.fromTag(settings.modalImageRef)` (`packages/runtime/src/index.ts:777-779`). **Zero code change** for Modal beyond pointing the ref at the desktop image and adding `6080` to `exposedPorts`.
- 24h rollover: snapshot captures the *filesystem* but the desktop processes die. On resume (new `sandboxId`), `ensureDisplayStack` re-runs idempotently. This is why the stack is exec-driven.

### Model B — prebuilt template (e2b, blaxel, runloop, daytona)
These providers require a **template/blueprint/snapshot built ahead of time** from a Dockerfile, then referenced by name:

| Provider | Template artifact | SDK option | Build step |
|---|---|---|---|
| **e2b** | `e2b template build` → template id | `template: "<id>"` | `e2b.Dockerfile` FROM canonical image; `e2b template build -c "<noop>"` |
| **blaxel** | image push + `name` | `image: "<ghcr ref>"` | references GHCR directly (like Modal); ships official `blaxel/xfce-vnc` as fallback |
| **runloop** | blueprint build | `blueprintName`/`blueprintId` | `POST /blueprints` FROM image |
| **daytona** | snapshot | `image` / `sandboxSnapshotName` | references GHCR or builds a snapshot |

**Resolution:** the canonical image is the single source of truth. Provider templates are *thin wrappers* — a one-line `FROM ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:<ver>` with no added layers (e2b/runloop need the FROM-wrapper because they don't accept a bare registry ref the way Modal/blaxel do). e2b/blaxel *also* ship official XFCE+VNC+noVNC images, so they have a degraded-fallback path if the canonical template build fails, but the canonical image is preferred for parity (same tool layer, same launch scripts, same geometry semantics).

### Build & publish (CI) — extend `.github/workflows/release.yml`
The existing `images` job (`.github/workflows/release.yml:105-189`) builds api/worker/web via `docker/build-push-action@v6` from `docker/opengeni.Dockerfile`. Add a 4th build step:

```yaml
      - name: Build and push desktop sandbox image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/desktop-sandbox.Dockerfile
          push: true
          platforms: linux/amd64,linux/arm64
          tags: |
            ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:${{ steps.meta.outputs.version }}
            ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:sha-${{ steps.meta.outputs.sha }}
            ghcr.io/cloudgeni-ai/opengeni-desktop-sandbox:latest
```

Plus a per-provider template-build job (matrix over `{e2b, runloop}`) gated on a `build-provider-templates` input, each `FROM`-wrapping the just-pushed canonical tag. Dev-loop parity: extend `scripts/dev-stack.sh:102` and `packages/testing/src/compose.ts:119` (`buildSandboxImage`) to optionally build `desktop-sandbox.Dockerfile` as `opengeni-desktop-sandbox:local`.

---

## 7. THE PROVIDER PIXEL PATH (port 6080 → viewer)

The settled "direct-to-provider scoped tunnel URL" maps onto `session.resolveExposedPort(6080)` per provider (all verified in the SDK dist tree). This module only *calls* it (`resolveDesktopStreamUrl`, §3); the URL-minting/auth handshake is the sibling control-plane module.

| Provider | `resolveExposedPort(6080)` returns | URL form | Scoping |
|---|---|---|---|
| **Modal** | `tunnels(10_000)[6080]` → `{host,port,tls:true}` (verified `modal/sandbox.js:261-303`) | `https://<host>:<port>/vnc.html` | L4 TLS-TCP passthrough; carries WS |
| **E2B** | `getHost(6080)` | `https://<host>/vnc.html` | configured port required |
| **Blaxel** | `previews.createIfNotExists({port:6080, public})`; if `!public` → `bl_preview_token` TTL query (verified `blaxel/sandbox.js:155-195`) | tokened preview URL | scoped + TTL'd (the literal "short-lived scoped URL") |
| **Daytona** | `getSignedPreviewUrl(6080, ttl)` | signed preview URL | TTL-expiring, re-mintable |
| **Runloop** | `enableTunnel` + `getTunnelUrl(6080)` | tunnel URL | bearer token |
| **Cloudflare** | **throws `SandboxUnsupportedFeatureError`** (verified `cloudflare/sandbox.js:264`) | — | **headless-only, no desktop** |
| **Vercel** | `sandbox.domain(6080)` exists BUT no custom image / no Xvfb possible | — | **headless-only in practice** |

`urlForExposedPort(endpoint, "ws")` (verified core `session.d.ts:100`) assembles `wss://<host>:<port>/websockify` for the noVNC WebSocket; `"http"` gives `https://…/vnc.html` for the iframe fallback.

**Carry-forward empirical risk (NOT design):** no provider publishes a per-port concurrent-WebSocket fan-out cap. `x11vnc -shared` is itself unbounded, but the provider tunnel may throttle. Must be load-tested with many concurrent noVNC viewers before betting the headline.

---

## 8. STATE MACHINE — desktop stack lifecycle (per box)

```
                    ┌────────────────────────── setGeometry(w,h) ──────────────┐
                    ▼                                                           │
  ┌────────┐ ensureDisplayStack  ┌───────────┐  up.sh exit 0   ┌──────┐  down.sh │
  │ absent ├────────────────────►│ launching ├────────────────►│  up  ├──────────┘
  └────────┘                     └─────┬─────┘                 └──┬───┘
       ▲                               │ up.sh exit 11/12/13      │ box snapshot-rollover (Modal 24h)
       │ tearDownDisplayStack          ▼                          │ OR owner re-election (new session)
       │                          ┌────────┐                      ▼
       └──────────────────────────┤ failed │              ┌──────────────┐ ensureDisplayStack (idempotent)
            (cold/box death)       └────┬───┘              │ stale (proc  ├──────────────► launching
                                        │ retry            │ died, box ok)│   (re-run up.sh on resumed box)
                                        └──────────────────► launching     └──────────────┘
```

**Transitions & invariants:**
- `absent → launching`: first `ensureDisplayStack`. Owner sets `DesktopStackState.phase = "launching"`.
- `launching → up`: `up.sh` exit 0; owner records `{port:6080, geometry}` and resolves the stream URL.
- `launching → failed`: `up.sh` exit 11 (Xvfb)/12 (x11vnc)/13 (websockify). Owner emits `desktop.stack {phase:"failed", error}` on Channel A; capability handshake returns `DesktopStream.transport: null`. **Never silent.**
- `up → up` (`setGeometry`): full chain restart (down→up); ~1-2s blink; `desktop.geometry.changed` event.
- `up → stale`: Modal 24h rollover OR owner re-election → box filesystem intact, processes gone. The **envelope-replay primitive** re-runs `ensureDisplayStack` (idempotent) → `launching → up`. The desktop chain is *part of envelope replay*, not a separate recovery path.
- `failed → launching`: bounded retry (≤3, mirrors `WORKER_DEATH_MAX_REDISPATCHES`); if Xvfb itself can't bind `:0` the box is corrupt → escalate to box-death recovery (sibling lease module).
- `* → absent`: `tearDownDisplayStack` on cold/drain; box death drops the whole box.

**Idempotency guarantee:** `up.sh`'s PID-guards + readiness gates make `ensureDisplayStack` safe to call on every viewer-attach and every resume. A second caller racing a first either sees the PIDs alive (no-op) or both serialize on the same scripts (last finishes, both observe `up`).

---

## 9. SEAMS TO SIBLING MODULES (the contract this module exports)

| Seam | This module provides | Consumed by |
|---|---|---|
| **Ownership inversion** | desktop methods operate on the externally-owned `session` | `SandboxOwner` (`apps/worker/src/sandbox-owner.ts`); injected via `RunAgentStreamOptions`/`runOptions.sandbox` (`packages/runtime/src/index.ts:968,1044`) |
| **Capability handshake** | `DesktopStream: { transport: "vnc-ws" \| null; url?; token? }` value | control-plane `GET /sessions/:id/stream-capabilities`; `SessionCapabilities` interface (sibling) |
| **Channel A events** | `desktop.stack`, `desktop.geometry.changed`, `desktop.recording.started`, `stream.url.rotated` payloads | contracts `SessionEventType` enum + React timeline (sibling) |
| **Tunnel URL** | `resolveDesktopStreamUrl(session)` → `{wsUrl, httpUrl, endpoint}` | scoped-token mint + viewer URL assembly (sibling) |
| **Lifecycle hook option** | optional registration of `ensureDisplayStack` as a `beforeAgentStart` `SandboxLifecycleHook` (`packages/runtime/src/index.ts:1735`) for the always-on-desktop tier | `builtInSandboxLifecycleHooks` registry (`:1742`) |
| **Recording artifact** | `/tmp/opengeni-desktop/recording-*.mp4`, downloadable via existing `withSandboxFileDownloads` (`:1012`) | workspace file-surfacing module |

The capability degradation is a **handshake value, never silent**: a session whose `session.resolveExposedPort` throws (`cloudflare`, headless `vercel`) or whose `up.sh` fails returns `DesktopStream.transport: null`; the React client falls back to Channel-A-only (terminal+files+git+diff).

---

## 10. FILE-BY-FILE CHANGE LIST

| File | Status | Change |
|---|---|---|
| `docker/desktop-sandbox.Dockerfile` | **NEW** | the canonical image (§1) |
| `docker/desktop/opengeni-desktop-up.sh` | **NEW** | idempotent chain launcher (§2) |
| `docker/desktop/opengeni-desktop-down.sh` | **NEW** | teardown (§2) |
| `docker/desktop/opengeni-record.sh` | **NEW** | ffmpeg x11grab sidecar (§2) |
| `docker/provider-templates/e2b.Dockerfile` | **NEW** | `FROM ghcr.io/…/opengeni-desktop-sandbox` wrapper |
| `docker/provider-templates/runloop.Dockerfile` | **NEW** | blueprint FROM-wrapper |
| `packages/runtime/src/desktop/stack.ts` | **NEW** | `ensureDisplayStack`/`tearDownDisplayStack`/`startRecording`/`resolveDesktopStreamUrl`, `DesktopGeometry`, `DesktopStackState`, `DESKTOP_STREAM_PORT` (§3) |
| `packages/runtime/src/desktop/computer.ts` | **NEW** | `createSandboxComputer` (`Computer` impl, `environment:"ubuntu"`) (§5) |
| `packages/runtime/src/desktop/browser.ts` | **NEW** | `CHROMIUM_GVISOR_FLAGS`, `chromiumLaunchCommand` (§4) |
| `packages/runtime/src/index.ts` | edit | add `6080` to Modal `exposedPorts` in `createSandboxClient` (`:773`); optionally register `ensureDisplayStack` in `builtInSandboxLifecycleHooks` (`:1742`); export desktop module |
| `packages/config/src/index.ts` | edit | add `desktopStreamPort` (default 6080), `desktopGeometry` (default `1280x800x96`), `desktopEnabled` settings (after `:244`) + `OPENGENI_DESKTOP_*` env maps (after `:481`) |
| `.github/workflows/release.yml` | edit | add desktop-image build step + provider-template matrix job (after `:189`) |
| `scripts/dev-stack.sh` | edit | optional `docker build -f docker/desktop-sandbox.Dockerfile -t opengeni-desktop-sandbox:local .` (after `:102`) |
| `packages/testing/src/compose.ts` | edit | `buildDesktopSandboxImage()` mirroring `buildSandboxImage` (`:119`) |

**Modal needs no factory branch change** — pointing `OPENGENI_MODAL_IMAGE_REF` at the desktop tag + adding `6080` to `exposedPorts` is the entire wire-up, because `createSandboxClient` already does `ModalImageSelector.fromTag(settings.modalImageRef)` (`packages/runtime/src/index.ts:777`).

---

## 11. FAILURE / EDGE-CASE MATRIX

| # | Case | Detection | Handling |
|---|---|---|---|
| F1 | Xvfb can't bind `:0` | `up.sh` exit 11 (xdpyinfo gate) | bounded retry; persistent → box corrupt, escalate box-death recovery |
| F2 | XFCE crashes mid-session | PID dead, but x11vnc still serves blank `:0` | re-invoke `ensureDisplayStack` (respawns xfce only; PID-guard no-ops others) |
| F3 | x11vnc dies | `up.sh` exit 12 / `nc :5900` fails | restart x11vnc; viewers reconnect (noVNC auto-retries) |
| F4 | websockify dies | exit 13 / `nc :6080` fails | restart; tunnel URL unchanged (same port) |
| F5 | Modal 24h rollover | new `sandboxId` on resume | envelope-replay re-runs `ensureDisplayStack`; ~2s desktop blink; viewers reconnect |
| F6 | `resolveExposedPort` throws (cloudflare/vercel) | `DesktopUnsupportedError` | capability handshake `DesktopStream.transport:null`; Channel-A-only fallback |
| F7 | Geometry mismatch (Chromium ≠ Xvfb) | visual; `--window-size` enforces | always pass geometry to both Xvfb and Chromium `--window-size` |
| F8 | `/dev/shm` 64MB → Chromium crash | tab "aw snap" | `--disable-dev-shm-usage` flag (baked into launch, §4) |
| F9 | No fonts → tofu boxes | render | fonts in image layer (§1); non-negotiable |
| F10 | Recording fills disk | `setArchiveLimits` / ffmpeg `out` size | cap recording duration; download+delete via file-surfacing |
| F11 | N viewers exceed provider fan-out cap | **unknown** | LOAD-TEST gate before headline ship (carry-forward risk) |
| F12 | Concurrent geometry-change races | last-writer | `setGeometry` serialized through owner's single control handle (singleton lease) |
| F13 | Raw VNC write from a viewer bypasses agent approval | security | v1: **read-only desktop** — websockify/noVNC view-only mode; no write path to `:0` from viewers |
| F14 | Pixel plane shows live cloud creds (un-redacted) | inherent | shared-live is **opt-in/acknowledged**, never silent default (consent gate in handshake) |

---

## KEY FILE REFERENCES (load-bearing, absolute)

- Existing headless image to mirror: `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/docker/sandbox.Dockerfile`
- Provider factory (Modal image-ref + exposedPorts): `packages/runtime/src/index.ts:763` (`createSandboxClient`), Modal branch `:770-789` (`ModalImageSelector.fromTag` at `:777`)
- Ownership-inversion seam: `packages/runtime/src/index.ts:968` (`RunAgentStreamOptions`), attach at `:1044` (`runOptions.sandbox = {client, sessionState}`)
- Lifecycle-hook mechanism (model for `ensureDisplayStack` registration): `packages/runtime/src/index.ts:1735-1740` (`SandboxLifecycleHook` type), builtin registry `:1742`, runner `:1761`
- Config schema to extend: `packages/config/src/index.ts:235` (`sandboxBackend`), `:236-244` (docker/modal fields), env maps `:472-481`
- CI image-build pattern to extend: `.github/workflows/release.yml:105-189` (the `images` job, `docker/build-push-action@v6`)
- Dev-loop build: `scripts/dev-stack.sh:102`, `packages/testing/src/compose.ts:119` (`buildSandboxImage`)
- SDK `Computer` interface (`environment:'ubuntu'`): `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/computer.d.ts`
- SDK `ExecCommandArgs`/`SandboxExecResult`/`resolveExposedPort`/`urlForExposedPort`: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/session.d.ts:39-57,100,113,124`
- Modal `resolveExposedPort`/`tunnels` (verified real): `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/modal/sandbox.js:261-303`; `ModalImageSelector.fromTag`: `.../modal/sandbox.d.ts:62,83`
- Blaxel scoped-preview token URL: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/blaxel/sandbox.js:155-195`
- Cloudflare desktop-disqualifier (`resolveExposedPort` throws): `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/cloudflare/sandbox.js:264`

Reference images: `e2b-dev/desktop` (canonical command source), `accetto/ubuntu-vnc-xfce-g3` (TigerVNC ref), `linuxserver/webtop` (KasmVNC v2 model), `kasmtech/KasmVNC`, `selkies-project/selkies` (v3 WebRTC).

---

## Adversarial Review

# Adversarial Review — "Desktop Image & Stack" spec

Findings are ordered by severity. Each cites the spec location and the grounded fact, with a fix. Line refs are to the verified codebase/SDK at HEAD.

## BLOCKER correctness bugs (won't compile / won't run)

**C1 — Invalid SDK import path; `stack.ts`/`computer.ts` won't resolve.**
§3 imports `import type { SandboxSessionLike } from "@openai/agents-core/sandbox/session"` and `import { urlForExposedPort } from "@openai/agents-core/sandbox/session"`. The `@openai/agents-core@0.11.6` `package.json` `exports` map exposes only `./sandbox`, `./sandbox/local`, `./sandbox/internal` — **there is no `./sandbox/session` subpath**, so this import fails to resolve at build time. `urlForExposedPort`, `SandboxSessionLike`, and `ExposedPortEndpoint` are re-exported from `./sandbox` (via `dist/sandbox/index.d.ts:10` `export * from './session'`).
**Fix:** import from `@openai/agents/sandbox` (the umbrella the runtime actually uses at `packages/runtime/src/index.ts:52-58`) or `@openai/agents-core/sandbox`. Also `ExposedPortEndpoint` is used in the `resolveDesktopStreamUrl` return type but never imported — add it to the import.

**C2 — `execCommand` returns `Promise<string>`, not a result object; every `res.exitCode/res.stdout/res.stderr` access is wrong.**
§3 `ensureDisplayStack` does `const res = await execOrThrow(session, ...); if (res.exitCode === 0)` and §5 `computer.ts` builds everything on `session.execCommand`. Per `session.d.ts:39-57`, `execCommand?(args): Promise<string>` returns a bare string; only `exec?(args): Promise<SandboxExecResult>` returns `{output, stdout, stderr, exitCode, ...}`. The canonical codebase pattern (`packages/runtime/src/index.ts:1243-1256`, `:1905-1921`) is **prefer `session.exec`, fall back to `execCommand`**, then `assertSandboxCommandSucceeded(result, ...)`. The spec inverts this — it picks the string-returning method and then reads object fields off the string.
**Fix:** use `session.exec` for the structured result (and its `exitCode`); fall back to `execCommand` only where you don't need the exit code. Reuse the existing `assertSandboxCommandSucceeded` helper rather than hand-rolling exit-code checks. The whole `EnsureDisplayStackResult.exec: {exitCode, stdout, stderr}` shape depends on `exec`, not `execCommand`.

**C3 — `urlForExposedPort` cannot produce the `/websockify` or `/vnc.html` paths the spec claims.**
§3/§7 assert `urlForExposedPort(endpoint, "ws")` → `wss://<host>:<port>/websockify` and `"http"` → `https://…/vnc.html`. The real impl (`session.js` `urlForExposedPort`) builds **only** `<scheme>://<host>[:<port>]/` plus an optional `?<query>` — it has **no path component** and no way to append `/websockify` or `/vnc.html`. Moreover the Modal endpoint is constructed with `query: ''` (`modal/sandbox.js:300`), so even the query is empty. The noVNC WS path `websockify` is a *client-side* default (`noVNC app/ui.js:183 initSetting('path','websockify')`), appended by the browser, not by this helper.
**Fix:** the caller must append the path itself: `urlForExposedPort(endpoint,"http") + "vnc.html"` and pass `?path=websockify` (or the resolveDesktopStreamUrl helper must construct `{base, wsPath:"websockify", httpPath:"vnc.html"}`). Do not claim the SDK helper returns pathed URLs.

**C4 — `Button` is not exported from `@openai/agents-core`.**
§5 `import type { Computer, Button } from "@openai/agents-core"`. `dist/index.d.ts` re-exports `Computer` (`:4 export { Computer } from './computer'`) but **not** `Button` (grep confirms zero `Button` in the root barrel). `Button`/`Environment` live in `./computer`.
**Fix:** `import type { Computer } from "@openai/agents-core"; import type { Button } from "@openai/agents-core/dist/computer"` — or, since deep-importing dist is fragile, define the `Button` union locally (`'left'|'right'|'wheel'|'back'|'forward'`).

**C5 — Modal `resolveExposedPort(6080)` throws unless 6080 is in `configuredExposedPorts`, and the spec never wires it correctly.**
`modal/sandbox.js:262` calls `assertConfiguredExposedPort(...)` against `this.state.configuredExposedPorts`; an unconfigured port throws `SandboxProviderError`. But in `createSandboxClient` the Modal branch sources `exposedPorts` from **`parseExposedPorts(settings.dockerExposedPorts)`** (`packages/runtime/src/index.ts:773`) — there is no `modalExposedPorts` field. §6/§10 say "add 6080 to Modal `exposedPorts`" and "zero code change for Modal" but never reconcile that the only knob is the cross-named `OPENGENI_DOCKER_EXPOSED_PORTS`. So "zero code change" is false, and as written `resolveDesktopStreamUrl` will throw on every Modal box unless an operator sets `OPENGENI_DOCKER_EXPOSED_PORTS=6080`.
**Fix:** add a real `desktopStreamPort`/`modalExposedPorts` config field and merge it into the Modal (and Docker) `exposedPorts` array in `createSandboxClient`; do not rely on the docker-named field. Update §10's "Modal needs no factory branch change" — it does need the exposedPorts merge.

## HIGH-severity correctness / behavior bugs

**C6 — `chromium-browser` apt package is broken in an Ubuntu 22.04 container.**
§1 Layer 5 installs `chromium-browser` "to avoid the Google apt-key dance." On Ubuntu 22.04, `chromium-browser` is a **transitional package that pulls the Chromium *snap* via snapd** — there is no snapd/systemd in the sandbox container, so it installs a non-functional stub (or fails). The grounded e2b reference (GROUND:desktop-stack §3) explicitly ships `google-chrome-stable` + `firefox-esr` for exactly this reason. The spec's stated rationale is backwards.
**Fix:** install `google-chrome-stable` from the Google deb repo (the "apt-key dance" is unavoidable and correct), or `firefox-esr` (real .deb on jammy), or switch the base to a Debian image where `chromium` is a real package. Drop the `chromium-browser` claim.

**C7 — PID guards track the wrong process for `novnc_proxy` and `dbus-launch` (double-fork).**
§2 `start()` does `setsid "$@" & echo $! > pid`. Two of the four managed processes fork a child and the captured `$!` is the short-lived parent:
- `start novnc /opt/noVNC/utils/novnc_proxy ...` — `novnc_proxy` is a wrapper shell that launches `websockify ... &` as a child (`novnc_proxy` lines 211+), then continues. `$!` is the wrapper PID; the actual listener is the websockify grandchild. When the wrapper exits, `alive novnc` reports dead while port 6080 is still served (or vice-versa), defeating idempotency.
- `start xfce dbus-launch --exit-with-session startxfce4` — `dbus-launch` forks the bus daemon and execs the session; the PID semantics don't match a single supervised process, so the `alive xfce`/F2 "respawn xfce only" logic is unreliable.
**Fix:** for noVNC, run websockify directly (`websockify --web /opt/noVNC <port> localhost:5900`) so `$!` is the listener; or grep the port instead of the PID. For XFCE, use `dbus-run-session -- startxfce4` under `setsid` and track via a readiness probe (`xprop -root` / wmctrl) rather than the `dbus-launch` PID. The readiness gates already exist for Xvfb/x11vnc/websockify — add one for the WM.

**C8 — F13 "read-only desktop" directly contradicts the launched x11vnc command.**
§0 (Input: xdotool) and §2 launch `x11vnc -display :0 -forever -shared ... -repeat` with **no `-viewonly`** — i.e. a fully *writable* VNC server where any connected viewer can move the mouse and type. F13/§K(h) in the settled context mandate **read-only desktop in v1** ("disable raw-pty write… a writer bypasses approvalQueue/interrupt", "websockify/noVNC view-only mode; no write path to :0 from viewers"). The spec's own failure matrix contradicts its own launch script. This is also a settled-constraint violation, not just an internal inconsistency.
**Fix:** add `-viewonly` to the x11vnc invocation for the viewer-facing path (and/or serve noVNC with `?view_only=true`). If the agent's computer-use must still write, that goes through `session.exec`-driven xdotool (§5), which it already does — so `-viewonly` on x11vnc is the correct posture and costs nothing. Reconcile §0/§2 with F13.

**C9 — `setGeometry` is named inconsistently and the event contract is undefined.**
§2 prose and §8 call it `SandboxOwner.setDesktopGeometry()`; §3 type doc and §10 call it `setGeometry`; §8 state machine labels the transition `setGeometry(w,h)`. Three names for one operation, none implemented in this module (it's "the owner's" but the method body isn't given, and it must serialize down→up). The emitted `desktop.geometry.changed` payload is referenced in §2/§8/§9 but never schematized. Per GROUND:capability-pattern, a new event type must be added to `SessionEventType` (contracts `:1270`), mirrored in `sdk/types.ts` `SESSION_EVENT_TYPES`, and folded into `react/timeline.ts` — none of that is specified.
**Fix:** pick one name, give the method body (serialized down→up under the owner's single control handle), and define the Zod payloads for `desktop.stack`, `desktop.geometry.changed`, `desktop.recording.started`, `stream.url.rotated` plus their sdk/react mirrors. §9 lists these as "provided" but provides no schema.

## MEDIUM — gaps / hand-waving / unspecified behavior

**C10 — Undefined helpers; the TS sketches don't compile as given.**
`stack.ts` references `assertHasExec`, `execOrThrow`, `shellQuote`, `parseRecordResult`, `DesktopStackError`, `DesktopUnsupportedError` with no definitions. `computer.ts` references `execOrThrow`, `shellQuote`, `readFileBase64`, `toXKeysym`, and `crypto.randomUUID` (needs `node:crypto` import or `globalThis.crypto`). `browser.ts` references `shellQuote`. None are defined or imported.
**Fix:** specify these helpers (especially `readFileBase64` — does it use `session.readFile` returning `string|Uint8Array` per `session.d.ts:124`, then base64-encode? `viewImage` returning `ToolOutputImage` is the more natural primitive for `screenshot()`). `toXKeysym` (model-key-name → X keysym map) is non-trivial and load-bearing for `keypress`; it must be enumerated, not named.

**C11 — `ensureDisplayStack` can never reach `phase:"launching"` or `phase:"failed"` from within this module — the state type is partly dead.**
§3 `DesktopStackState` has `launching`/`failed`/`absent` variants, but `ensureDisplayStack` only ever returns `{phase:"up"}` or throws `DesktopStackError`. The `launching`/`failed`/`absent` phases are set "by the owner" (§3 diagnostics note, §8), but the owner is a sibling module. So this module exports a 4-state union it never produces three states of, and the §8 state machine's `launching`/`failed` nodes have no producer here. Either the owner owns the state (then don't export a half-used type here) or this module owns it (then `ensureDisplayStack` must set `launching` before exec and `failed` on throw).
**Fix:** decide ownership of `DesktopStackState`. If the owner owns it, this module should return a narrower result and let the owner map; if this module owns it, `ensureDisplayStack` must transition through `launching`.

**C12 — `ensureDisplayStack` registration as a `SandboxLifecycleHook` is signature-incompatible.**
§9 seam "Lifecycle hook option" claims optional registration of `ensureDisplayStack` as a `beforeAgentStart` `SandboxLifecycleHook`. The hook contract (`packages/runtime/src/index.ts:1739`) is `run: (session, context) => Promise<void>` — **void return, no geometry param, context not geometry**. `ensureDisplayStack(session, geometry): Promise<EnsureDisplayStackResult>` has the wrong arity and return type.
**Fix:** register an adapter closure `{ phase:"beforeAgentStart", run: (session) => ensureDisplayStack(session, geometryFromConfig).then(()=>{}) }`, not `ensureDisplayStack` directly. Say so.

**C13 — "Strict superset of docker/sandbox.Dockerfile" / "verbatim" claims are false.**
§1 repeatedly claims parity ("same conventions… strict superset", "verbatim from docker/sandbox.Dockerfile", "copy verbatim… gh"). The existing `docker/sandbox.Dockerfile` is **`FROM python:3.12-slim`** (Debian bookworm), uses a **two-phase `--download-only` then install** apt pattern, and a Debian-keyring gh block. The spec's image is `FROM ubuntu:22.04` with a single-phase retry loop and `pip3` (vs the existing `pip`). It is a *reimplementation on a different base OS*, not a superset. The "superset → a desktop box also serves Channel A with zero divergence" argument is therefore unsupported: different base, different python, different apt suite → tool-version drift between headless and desktop images.
**Fix:** either base the desktop image `FROM` the existing headless image's base (or `FROM opengeni-sandbox:<ver>` itself, layering desktop on top — which *would* make it a true superset and is cleaner), or drop the "verbatim/superset" language and own the divergence. The "copy verbatim from docker/sandbox.Dockerfile lines installing gh" is an unspecified TODO, not a spec.

**C14 — CI: desktop image + provider-template ordering and tag-resolution under-specified.**
§6 places the desktop build in the `images` job (gated `needs: release`, `if: published == 'true'`) and adds a separate provider-template matrix that does `FROM ghcr.io/.../opengeni-desktop-sandbox:<ver>`. Two problems: (a) the provider-template job must run *after* the desktop image is pushed and must reference the **same** `steps.meta.outputs.version`, but it's a separate job that re-resolves `meta` — the version-resolution `run` block (`release.yml:122-141`, depends on `needs.release.outputs.publishedPackages`) must be duplicated or shared via job outputs; not specified. (b) The existing image builds are `platforms: linux/amd64` only; the spec's desktop step is `linux/amd64,linux/arm64`. Building arm64 desktop adds significant CI time and the GHCR multi-arch path isn't validated against the existing single-arch convention. (c) The matrix is "gated on a `build-provider-templates` input" but the workflow is triggered by changesets release (no `workflow_dispatch` inputs shown at `:105`) — where does that input come from?
**Fix:** make the provider-template job `needs:` the desktop-image job and consume its `version` via job outputs; justify or drop arm64; specify the `workflow_dispatch` input plumbing for `build-provider-templates`.

**C15 — Recording lifecycle gaps: no stop, unbounded duration, disk-fill only hand-waved.**
§2 `opengeni-record.sh` starts ffmpeg and writes a PID, and `opengeni-desktop-down.sh` kills `record` first — but there's no `stopRecording`/graceful SIGINT (killing ffmpeg with SIGTERM can truncate the MP4 / skip `+faststart` finalization → corrupt file). §3 `startRecording` exists but no `stopRecording` is exported. F10 says "cap recording duration / ffmpeg `out` size" but no mechanism is specified (ffmpeg `-t <sec>` or `-fs <bytes>` not in the command). The recording artifact path is `/tmp/opengeni-desktop/recording-*.mp4` (§9) but `/tmp` on Modal is ephemeral and lost on the 24h rollover the spec itself emphasizes — recordings vanish across resume.
**Fix:** add `stopRecording` (SIGINT then wait so the moov atom finalizes), add `-t`/`-fs` caps to the ffmpeg command, and define when recordings are flushed to durable object storage (the `withSandboxFileDownloads` seam is mentioned but the *upload* direction is what's needed, and isn't specified).

**C16 — `startRecording` env-var name mismatch makes geometry ineffective for ffmpeg.**
§3 `startRecording` sets `DESKTOP_W=… DESKTOP_H=… RECORD_OUT=…`. §2 `opengeni-record.sh` reads `DESKTOP_W/DESKTOP_H` ✅ and `RECORD_OUT` ✅ and `RECORD_FPS` (never passed → defaults 15, fine). OK there. But the `-video_size ${W}x${H}` must exactly match the **current** Xvfb geometry or x11grab errors (F7); after a `setGeometry` the recording started with stale geometry will fail. Nothing guarantees `startRecording` is called with the live geometry post-resize.
**Fix:** have `startRecording` read geometry from the live stack state (or query `xdotool getdisplaygeometry`) rather than trusting a passed-in value that may be stale after a geometry change.

## LOW — risk notes / minor

**C17 — `-nolisten unix` on Xvfb is a gVisor risk.** §2 Xvfb uses `-nolisten tcp -nolisten unix`. On Linux, x11vnc reaches `:0` via the abstract `@/tmp/.X11-unix/X0` socket, which `-nolisten unix` does *not* disable (that's `-nolisten local`), so it works on a normal kernel — and it matches the e2b reference, so this is not a hard bug. But under gVisor (Modal/E2B), abstract-socket support has historically been incomplete; if x11vnc can't reach `:0` you'll see exit 12. **Fix:** keep, but flag as a load-test item; have a fallback that drops `-nolisten unix` if x11vnc's connect fails.

**C18 — `--use-gl=angle --use-angle=swiftshader` together with `--disable-gpu` is contradictory.** §4 `CHROMIUM_GVISOR_FLAGS` lists both `--disable-gpu` and `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader` unconditionally. `--disable-gpu` disables the GPU process entirely, making the ANGLE/SwiftShader flags inert (and they're only needed *if WebGL is wanted*, per the inline comment which contradicts the flat array). **Fix:** make the SwiftShader flags a separate opt-in set, not unconditionally concatenated with `--disable-gpu`.

**C19 — `scroll` wheel-button mapping ignores horizontal scroll and magnitude direction nuance.** §5 `scroll(px,py,_sx,sy)` maps to xdotool buttons 4/5 with `--repeat ${Math.abs(sy)||1}`, discarding `scrollX` (`_sx`) entirely and treating `sy` as a click-count. Horizontal scroll (buttons 6/7) is dropped silently. Minor, but the `Computer.scroll` contract passes both axes. **Fix:** handle `scrollX` via buttons 6/7, or document the v1 limitation explicitly.

**C20 — `keypress` keysym join assumes chord, but `keys: string[]` can be a sequence.** §5 `keypress(keys)` does `xdotool key ${keys.map(toXKeysym).join("+")}` — always a simultaneous chord. The SDK passes `keys: string[]`; some models emit sequential keys (e.g. typing a word via keypresses) where `+` is wrong. **Fix:** clarify chord vs sequence semantics; the OpenAI computer-use convention is a single chord per `keypress`, so this is *probably* fine — but state it.

**C21 — `30_000`ms `ensureDisplayStack` timeout vs the readiness gates' worst case.** §3 passes `timeoutMs: 30_000` to the exec. `up.sh` has four readiness loops of `50 × 0.1s = 5s` each = up to ~20s plus XFCE/dbus startup, plus first-boot font cache — on a cold gVisor box this can exceed 30s, producing a spurious `DesktopStackError`. **Fix:** raise to ~60s or make it config-driven; align with `SANDBOX_LIFECYCLE_COMMAND_TIMEOUT_MS` already used by the runtime hooks.

**C22 — F5/§8 "envelope-replay re-runs ensureDisplayStack" relies on `/tmp` PID files surviving, which they don't across rollover.** The idempotency guarantee (§2, §8) is built on `/tmp/opengeni-desktop/*.pid`. On a Modal 24h snapshot-rollover the *filesystem* is captured but `/tmp` contents + the processes are gone; on resume the PID files may be stale-present (pointing at dead PIDs from the pre-snapshot box) → `alive` does `kill -0 <stale-pid>` which on a fresh box could match an unrelated process or fail. The "safe to call N times" claim holds for the same box, but across rollover the stale PID files are a hazard. **Fix:** `opengeni-desktop-up.sh` should validate that a live PID actually owns the expected process (e.g. `readlink /proc/$pid/exe` or check `/proc/$pid/comm`), not just `kill -0`.

---

## Summary of must-fix before this is buildable
C1 (import path), C2 (`exec` vs `execCommand` result), C3 (`urlForExposedPort` has no path), C4 (`Button` not exported), C5 (Modal exposedPorts not actually wired / "zero change" false), C6 (`chromium-browser` broken on jammy) are hard blockers — the TypeScript won't compile, the URLs won't be correct, and the image won't have a working browser. C7 (PID guards), C8 (read-only contradiction with a settled constraint), C9 (geometry naming + missing event schemas) are the next tier. The architectural seams (ownership inversion, exec-driven launch, split-plane, capability-as-handshake-value) are sound and correctly grounded — the failures are at the interface/implementation level, not the architecture.
