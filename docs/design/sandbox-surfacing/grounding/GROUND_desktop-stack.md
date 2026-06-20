# THE LINUX-DESKTOP-IN-CONTAINER STACK — implementation-grade

This is the Channel-B (pixel plane) ground-truth for the singleton-sandbox vision. It is the in-box stream-server + computer-use tooling that the agent draws to and viewers literally see. Everything below is verified against the canonical `e2b-dev/desktop` reference implementation, the local `@openai/agents-core` / `agents-extensions@0.11.6` SDK, and provider docs.

## 1. The components, decided

The pixel pipeline is a 4-stage chain, identical in shape across every desktop-capable provider:

```
[ agent xdotool/scrot ] ─┐
                         ▼
   Xvfb (virtual X display :0)  →  XFCE4 (DE drawn into the framebuffer)
                         │
                         ▼
   x11vnc  (RFB server, shares the EXISTING Xvfb display, port 5900)
                         │
                         ▼
   websockify + noVNC  (RFB-over-TCP → WebSocket, serves vnc.html on port 6080)
                         │
                         ▼  ONE exposed port (6080) → provider tunnel/preview URL
   browser viewers (N of them; x11vnc -shared fans out natively)
```

### Display: **Xvfb**, not Xorg-dummy (v1 and v2)
Xvfb is a headless X server that renders entirely to RAM with zero GPU/`/dev/fb0`/seat requirements — the right primitive for gVisor/Modal/E2B where there is no DRI device. Xorg + `dummy` driver is the only alternative that gives a real Xorg (needed for `RANDR` live-resize and GLX), but it needs a writable `xorg.conf`, root or `Xwrapper.config` relaxation, and a `videoram` line; it buys nothing for a CPU-rendered DE. **Stay on Xvfb.** Exact command from the e2b reference (`packages/js-sdk/src/sandbox.ts:531`):

```
Xvfb :0 -ac -screen 0 1024x768x24 -retro -dpi 96 -nolisten tcp -nolisten unix
```

- Geometry/depth: `WxHx24`, parameterized by `resolution` (default `[1024,768]`); 24-bit depth is mandatory for Chrome/VS Code (16-bit triggers rendering bugs).
- `-dpi 96` (parameterized) — keep at 96; XFCE fonts are tuned for it.
- `-ac` disables host-based access control (single-tenant box, fine). `-nolisten tcp -nolisten unix` forces local-only; x11vnc reaches it via `DISPLAY=:0` over the abstract socket.
- `-retro` paints the classic root weave so a blank-display bug is visually obvious vs. a black frame.
- Readiness gate: poll `xdpyinfo -display :0` for exit 0 before starting the DE (e2b does exactly this).
- **Resolution change** = kill Xvfb + restart at the new geometry, then restart the whole chain (Xvfb has no live RANDR resize). E2B's `stream.start({resolution})` does a full chain restart. This is the v1 model: resolution is a session/stream-open parameter, not a live control.

### DE/WM: **XFCE4** (v1). Openbox-only as the v2 lightweight tier.
XFCE4 is the e2b/blaxel/accetto/webtop consensus DE: it renders correctly under software-only X, has a real taskbar/file-manager/terminal (so a human viewer sees a *usable* desktop, which is the headline), and idles at ~150–250 MB. LXDE is lighter but unmaintained (LXQt is the successor and heavier). **Pick XFCE4.** Start it after Xvfb is verified (e2b `startXfce4()` at `sandbox.ts:552`), supervise the PID, restart on crash/logout:

```
DISPLAY=:0 startxfce4   # tracked PID; respawn if it dies
```

Mandatory: `dbus-x11` (XFCE needs a session bus — `dbus-launch`/`dbus-run-session`), and a `dbus-uuidgen > /var/lib/dbus/machine-id` in the image. Packages: `xfce4 xfce4-goodies dbus-x11`. **v2 lightweight tier** (for a "browser-only" sandbox, ~60 MB): drop XFCE for `openbox + tint2`, launch the target app fullscreen. Keep this behind the resolution machinery as a later template variant, not v1.

### Pixel server: **x11vnc (v1)** → **KasmVNC (v2)**
x11vnc is the right v1 pick *because of the settled architecture*: it shares the **existing** Xvfb display that the agent and DE already draw into (`x11vnc -display :0`), so the agent draws and viewers see literally those pixels — no projection, exactly the SHARED-LIVE model. It natively fans out to N viewers with `-shared`. Exact command (e2b `getVNCCommand()`, `sandbox.ts:725`):

```
x11vnc -bg -display :0 -forever -wait 50 -shared -rfbport 5900 -nopw 2>/tmp/x11vnc_stderr.log
```

- `-shared` = the load-bearing fan-out flag (multiple viewers, one display).
- `-forever` = don't exit when the last client disconnects (viewer-only liveness must survive zero viewers).
- `-wait 50` = 50 ms poll interval (20 fps ceiling); lower for snappier cursor, higher to cut CPU. This is the **single biggest latency knob** on the x11vnc path.
- Auth: `-nopw` for v1 (auth is enforced at the OpenGeni control plane / scoped tunnel, per the split-plane ruling — the box itself is single-tenant). When you do want box-level auth, e2b's path is `x11vnc -storepasswd <pw> ~/.vnc/passwd` then swap `-nopw`→`-usepw` (`sandbox.ts:719`).
- e2b's production flags add `-noxdamage -noxfixes -nowf -noscr -ping 1 -repeat -speeds lan` (from the template's x11vnc invocation) — `-noxdamage` is important under Xvfb (XDAMAGE is unreliable there, forces full-screen polling which is *more* correct albeit heavier), `-speeds lan` tunes the encoder for low-RTT.

**Why x11vnc over TigerVNC for v1:** TigerVNC's `Xvnc` is its *own* X server — adopting it means the agent and DE must draw into Xvnc's framebuffer instead of Xvfb, collapsing two components into one (faster Tight+JPEG encoding, lower redraw latency). That's a strictly better *combined* display+pixel-server, **but** it changes the display primitive and the readiness/snapshot semantics. Defer to v2 as a fused option.

**v2 pixel-server = KasmVNC.** It is a TigerVNC fork rebuilt as a web-native display server: a single `Xvnc` binary that *integrates the websocket server and an HTTP server* (`-websocketPort 6901 -httpd /usr/share/kasmvnc/www -PasswordFile ...`), eliminating the separate websockify+noVNC processes, ships its own HTML5 client, supports multi-user read/write, per-frame adaptive encoding, and lossless modes. It is the basis of `linuxserver/webtop` and Kasm Workspaces. Migration is "swap the Xvfb+x11vnc+websockify+noVNC quartet for one Xvnc" — a template change, transparent to the control plane (still one exposed port, still a URL). **v3 / GPU-or-video-heavy = Selkies-GStreamer (WebRTC)**: 30 fps@720p software / 60+ fps@1080p with NVIDIA, real H.264/VP8 over WebRTC, datachannel input — but it needs a STUN/TURN path and a far heavier image, so it is explicitly out of v1/v2 scope and only justified if you hit a video-fidelity wall.

### websockify + noVNC (v1 only; gone in the KasmVNC v2 path)
noVNC is the in-browser RFB client (canvas/WebGL); websockify is the WS↔TCP bridge that lets the browser speak RFB. e2b bundles them as one launcher (`VNCServer`, `sandbox.ts:620`):

```
cd /opt/noVNC/utils && ./novnc_proxy --vnc localhost:5900 --listen 6080 --web /opt/noVNC > /tmp/novnc.log 2>&1
```

- **Versions to pin** (from e2b template.py): noVNC = `e2b-dev/noVNC` fork, branch `e2b-desktop` (a vanilla `novnc/noVNC` tag like `v1.5.0` works if you don't need e2b's UI tweaks); websockify = **`v0.12.0`**, cloned to `/opt/noVNC/utils/websockify`; symlink `vnc.html`→`index.html`.
- One exposed port: **6080**. 5900 stays internal (localhost only).
- The viewer URL e2b mints: `https://<host>/vnc.html?...` — viewer connects to the WS path with the desktop password as a query param when box-auth is on (`sandbox.ts:663`, `url.searchParams.set('password', authKey)`).
- **WS upgrade + token auth at the edge:** websockify supports `--token-plugin TokenFile --token-source <dir>` to map an opaque token → backend `host:port`, re-read per connection (so tokens can be minted/revoked live). In the OpenGeni split-plane this is **not** where you enforce auth — the scoped tunnel URL (Modal/Blaxel, below) carries a short-TTL provider token; websockify just needs the reverse proxy to forward `Upgrade: websocket` + `Connection: upgrade` headers. Keep websockify on `-nopw`/no-token in v1 and let the provider tunnel + OpenGeni-minted scoped URL be the auth boundary.

### In-box browser: Chromium/Firefox flags for gVisor
The box is gVisor (Modal/E2B) or a generic container — no GPU, restricted `/dev/shm`, syscall-filtered. Chrome/Chromium launch flags (Firefox equivalents in parens):

- `--no-sandbox` — **required**; Chrome's setuid/namespace sandbox can't nest in gVisor. (Firefox: set `MOZ_DISABLE_CONTENT_SANDBOX=1` if needed; usually fine.)
- `--disable-dev-shm-usage` — **required**; containers default to a 64 MB `/dev/shm` and Chrome crashes ("tab aw snap") writing shared memory there. This flag routes to `/tmp`. (Alternative: run the container with `--shm-size=2g`; the flag is more portable.)
- Software GL: modern Chrome uses **ANGLE→SwiftShader** for headed-but-GPU-less, not legacy llvmpipe/osmesa. Use `--use-gl=angle --use-angle=swiftshader`. For WebGL specifically on recent Chrome you also need `--enable-unsafe-swiftshader` (SwiftShader was demoted from a silent WebGL fallback). `--disable-gpu` is acceptable for pure 2D/DOM workloads and avoids the GL stack entirely. (Firefox-esr under Xvfb falls back to software Mesa `llvmpipe` automatically — install `libgl1-mesa-dri`; e2b ships `firefox-esr` + `google-chrome-stable` and relies on this.)
- Stability: `--disable-gpu-compositing`, `--password-store=basic`, `--disable-features=Translate`, and a fixed `--window-size=<W>,<H>` matching the Xvfb geometry.

### Agent computer-use: input + capture
- **Input = xdotool** (X11, talks to Xvfb directly; e2b's choice throughout). The exact action→xdotool map (from `sandbox.ts`):
  - `click(left)` → `xdotool click 1`; right → `click 3`; middle → `click 2`; double → `xdotool click --repeat 2 1`
  - `move(x,y)` → `xdotool mousemove --sync x y` (`--sync` blocks until the pointer arrives — eliminates click-before-move races)
  - `mouseDown/Up` → `xdotool mousedown/mouseup <button>`
  - `scroll` → `xdotool click --repeat <amount> <4=up|5=down>`
  - `type(text)` → `xdotool type --delay <ms> -- <quoted>`
  - `keypress(keys)` → map model key names → X keysyms, join with `+`, `xdotool key <combo>` (e.g. `ctrl+c`)
  - drag = `mousedown` → series of `mousemove --sync` → `mouseup`
  - `getCursorPosition` → `xdotool getmouselocation`; `getScreenSize` → parse `xdotool getdisplaygeometry`/`xrandr`
  - **ydotool** is the v2 path *only if* you move to a Wayland compositor; on X11/Xvfb it's strictly inferior (needs a uinput daemon). Stay on xdotool.
- **Capture (screenshots for the model) = scrot**: `scrot --pointer /tmp/screenshot-<rand>.png` then read + delete (e2b `screenshot()`, `sandbox.ts:263`). `--pointer` includes the cursor so the model sees what a human sees. `import` (ImageMagick) or `ffmpeg -frames:v 1` are fallbacks; scrot is fastest for single frames.
- **The computer-use loop** fits the OpenAI Agents SDK `Computer` interface exactly (verified `@openai/agents-core@0.11.6/dist/computer.d.ts`):

```ts
export type Environment = 'mac' | 'windows' | 'ubuntu' | 'browser';
export type Button = 'left' | 'right' | 'wheel' | 'back' | 'forward';
interface ComputerBase {
  environment?: Environment;          // → 'ubuntu' for this stack
  dimensions?: [number, number];      // → the Xvfb [width, height]
  initRun?(rc?): Promisable<void>;
  screenshot(rc?): Promisable<string>;                       // → scrot, return base64 PNG
  click(x, y, button: Button, rc?): Promisable<void>;        // → mousemove --sync + click
  doubleClick(x, y, rc?): Promisable<void>;                  // → click --repeat 2 1
  scroll(x, y, scrollX, scrollY, rc?): Promisable<void>;     // → click --repeat 4/5
  type(text, rc?): Promisable<void>;                         // → xdotool type
  wait(rc?): Promisable<void>;                               // → sleep
  move(x, y, rc?): Promisable<void>;                         // → mousemove --sync
  keypress(keys: string[], rc?): Promisable<void>;           // → key <combo>
  drag(path: [number,number][], rc?): Promisable<void>;      // → mousedown/move/mouseup
}
export type Computer = Expand<ComputerBase & Record<Exclude<ActionNames, keyof ComputerBase>, never>>;
```

Construct with `computerTool({ computer })` and pass as a tool. The `Computer` impl issues commands through the same provider exec channel OpenGeni already owns (the externally-owned `{client}` from the ownership-inversion), so the agent's computer-use actions and the viewers' pixels are one and the same display — zero projection, per the settled data path. **Note:** the SDK enum is `'ubuntu'` (not `'linux'`); set `environment: 'ubuntu'`, `dimensions: [W,H]`.

### Recording: ffmpeg x11grab
Record the live Xvfb display to a file (for the dual-use verification-video use case in the workspace-surfacing vision):

```
ffmpeg -f x11grab -draw_mouse 1 -framerate 15 -video_size 1024x768 -i :0.0 \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart /tmp/session.mp4
```

- `-draw_mouse 1` includes the cursor; `-video_size` must match the Xvfb geometry exactly or x11grab errors.
- H.264 `yuv420p` + `+faststart` = browser-playable MP4. For smaller/streamable archival use VP9 (`-c:v libvpx-vp9 -b:v 0 -crf 32`) at the cost of CPU. 15 fps is the sweet spot for a screencast (matches x11vnc's `-wait 50` ceiling).
- This is a **second, independent** consumer of `:0` (x11grab just reads the framebuffer); it runs alongside x11vnc without interference — which is exactly the "separate dual-use desktop stream" the workspace-surfacing memory calls for.

## 2. The provider pixel path (how port 6080 reaches a viewer)

The settled "direct-to-provider via short-lived scoped tunnel URL" maps onto the SDK's `resolveExposedPort` per provider (verified in `agents-extensions@0.11.6/dist/sandbox/<provider>/sandbox.js`):

- **Modal (primary):** `tunnels(10_000)` → `tunnels[6080]` → `{host, port, tls:true}`. The control plane mints the URL `https://<host>:<port>/vnc.html`. Modal tunnels are the scoped, direct-to-box pixel path. (`modal/sandbox.js:271–301`) Modal's 24h box lifetime → the desktop chain must be re-launched after a snapshot-rollover (it's all userspace processes, so the lifecycle hook that re-runs `Xvfb→xfce→x11vnc→novnc` on resume is the recovery primitive).
- **Blaxel:** `previews.createIfNotExists({ port:6080, public })` → preview URL; if `public:false`, `createBlaxelPreviewTokenQuery(preview, ttlS=3600, port)` appends a **scoped, TTL'd token query string** — this is the literal "short-lived scoped tunnel URL." (`blaxel/sandbox.js:155–195`)
- **E2B:** `getHost(6080)` → host; URL is `https://<host>/vnc.html`. `exposedPorts:[6080]` must be configured. (`e2b/sandbox.ts` via `getHost`.)
- **Cloudflare/Vercel:** headless-only — `resolveExposedPort` is stubbed/unsupported; no desktop. These get Channel A only.

`resolveRemoteExposedPort` is the one method to wire per provider; OpenGeni's control plane calls `session.resolveExposedPort(6080)`, gets `{host,port,tls,query}`, and hands the assembled URL to the viewer. **The unsolved empirical risk (carry into load-test, not design): no provider publishes a per-port concurrent-WebSocket fan-out cap** — `x11vnc -shared` itself is unbounded, but the provider tunnel may throttle; must be measured.

## 3. The actual Dockerfile package list (v1, Modal/E2B-compatible)

Ubuntu 22.04 base, `yes | unminimize`, `DEBIAN_FRONTEND=noninteractive`. apt set (superset of e2b's verified template.py, trimmed to the load-bearing + browser + capture + record):

```
# X server + display
xserver-xorg x11-xserver-utils xvfb x11-utils x11-apps xauth
# desktop environment (+ session bus)
xfce4 xfce4-goodies dbus-x11
# pixel server
x11vnc
# computer-use input + capture + recording
xdotool scrot ffmpeg
# software GL for browsers under Xvfb
libgl1-mesa-dri
# net / tooling
net-tools netcat curl wget git sudo util-linux python3-pip software-properties-common apt-transport-https libgtk-3-bin
# in-box browsers (add-apt-repository for chrome/firefox-esr first)
firefox-esr google-chrome-stable
```

Plus, not from apt (git-clone, pinned):
```
git clone -b e2b-desktop https://github.com/e2b-dev/noVNC.git /opt/noVNC         # or novnc/noVNC v1.5.0
ln -s /opt/noVNC/vnc.html /opt/noVNC/index.html
git clone -b v0.12.0 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify
```

**v2 swap** (KasmVNC tier): drop `x11vnc` and the two git clones; add the KasmVNC `.deb` (`kasmvncserver`), launch one `Xvnc :0 -websocketPort 6080 -httpd /usr/share/kasmvnc/www ...` instead of the Xvfb+x11vnc+websockify trio. Everything above the pixel server (XFCE, xdotool, scrot, ffmpeg, browsers) is unchanged.

**Startup order (an entrypoint/supervisor — v1):**
1. `dbus-uuidgen --ensure` (image build) →
2. `Xvfb :0 -ac -screen 0 ${W}x${H}x24 -retro -dpi 96 -nolisten tcp -nolisten unix` (bg) →
3. gate on `xdpyinfo -display :0` →
4. `DISPLAY=:0 dbus-launch startxfce4` (supervised, respawn) →
5. `x11vnc -bg -display :0 -forever -wait 50 -shared -rfbport 5900 -nopw -noxdamage -speeds lan` →
6. `/opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6080 --web /opt/noVNC` →
7. (on demand) `ffmpeg -f x11grab -draw_mouse 1 -framerate 15 -video_size ${W}x${H} -i :0.0 ... /tmp/session.mp4`.

In the OpenGeni model this entrypoint is **not** the container CMD — it's a set of commands the in-worker SandboxOwner runs through the externally-owned `client` after box-create and after every resume/rollover, so the chain is idempotently re-established under the lease (matching "re-establish-singleton-from-envelope-under-CAS"; the desktop chain is part of the envelope replay).

## v1 pick → v2 path, in one line each
- **v1:** Xvfb `:0` (24-bit, 96 dpi) → XFCE4+dbus → x11vnc `-shared` `:5900` → websockify `v0.12.0`+noVNC `:6080` → Modal `tunnels()` / Blaxel scoped-preview URL; computer-use = xdotool + scrot via the SDK `Computer` interface (`environment:'ubuntu'`); recording = ffmpeg x11grab. **This is the e2b-dev/desktop stack, proven, lands as the v1 headline.**
- **v2:** fuse the pixel quartet into one **KasmVNC `Xvnc`** binary (built-in websocket + HTTP + multi-user + adaptive encoding), no other layer changes. Optional **TigerVNC** fusion of display+server if you don't take Kasm.
- **v3 (only on a video-fidelity wall):** **Selkies-GStreamer WebRTC** for 60 fps / H.264 / datachannel input.

## Key file references (load-bearing)
- Computer interface: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/computer.d.ts`
- Modal tunnel port-exposure: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/modal/sandbox.js:271-301`
- Blaxel scoped-preview port-exposure: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/blaxel/sandbox.js:155-195`
- E2B port-exposure (`getHost`) + client: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/e2b/sandbox.d.ts`
- Shared port resolution helpers: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/shared/ports.d.ts`
- OpenGeni provider wiring (where modal/docker/local are constructed): `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/runtime/src/index.ts:763` (`createSandboxClient`)
- OpenGeni run() ownership target (inject externally-owned client/sessionState): `packages/runtime/src/index.ts:1018,1044`
- SandboxBackend enum to extend (`docker|modal|local|none` → add `e2b|blaxel|daytona|runloop`): `packages/contracts/src/index.ts:13`

## Reference images
- **e2b-dev/desktop** (the canonical implementation cited throughout; exact commands verified from `packages/js-sdk/src/sandbox.ts` and `template/template.py`): https://github.com/e2b-dev/desktop
- **accetto/ubuntu-vnc-xfce-g3** (TigerVNC+noVNC XFCE reference): https://github.com/accetto/ubuntu-vnc-xfce-g3
- **linuxserver/webtop** (KasmVNC-based, the v2 model): on Docker Hub `linuxserver/webtop`
- **Kasm / KasmVNC** (v2 pixel server): https://github.com/kasmtech/KasmVNC
- **Selkies-GStreamer** (v3 WebRTC): https://github.com/selkies-project/selkies

Sources:
- [e2b desktop template (Ubuntu Desktop + VNC)](https://e2b.dev/docs/template/examples/desktop)
- [e2b-dev/desktop repo](https://github.com/e2b-dev/desktop) — `template/template.py`, `packages/js-sdk/src/sandbox.ts` (read via GitHub API)
- [e2b sandbox environment / startup commands (DeepWiki)](https://deepwiki.com/e2b-dev/desktop/5-sandbox-environment)
- [novnc/websockify + token plugin](https://github.com/novnc/websockify), [token-based target selection wiki](https://github.com/novnc/websockify/wiki/token-based-target-selection)
- [OpenAI Agents JS computerTool / Computer interface](https://openai.github.io/openai-agents-js/openai/agents/functions/computertool/)
- [KasmVNC docs (multi-user, integrated httpd/websocket)](https://www.kasmweb.com/kasmvnc/docs/master/man/Xvnc.html), [KasmVNC vs alternatives (Cendio)](https://www.cendio.com/blog/kasmvnc-alternatives/)
- [Selkies-GStreamer (WebRTC)](https://github.com/selkies-project/selkies)
- [Chromium SwiftShader software rendering](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md)
- [accetto/ubuntu-vnc-xfce-g3](https://github.com/accetto/ubuntu-vnc-xfce-g3)
- [VNC server comparison (TigerVNC/x11vnc latency)](https://forum.manjaro.org/t/x11vnc-has-slow-redraw-reaction-while-tigervnc-server-on-a-new-display-is-much-faster/7414)
