# Module: Channel B — desktop data plane  (channel-b)

## Specification

# Channel B — Desktop Data Plane: Implementation-Grade Spec

The pixel transport. This module owns everything from "the agent draws to an X display" to "N browsers render those literal pixels," and the control-plane handshake that authorizes and addresses that transport. It rides on top of the settled lease architecture, Channel A (the SSE event spine), and the in-box desktop stack (Xvfb→x11vnc→websockify→noVNC).

> **SUPERSEDED transport note (API-direct control-plane ruling — see `00-master-spine.md` §B.1/§B.2/§B.3/§B.6 and `modules/02-owner.md`).** This module predates **two** rulings and was written against the old in-worker `SandboxOwner` actor + per-session `sandbox-owner::<sessionId>` task-queue model, then briefly re-cast onto a Temporal-worker activity hop. **Both transports are gone.** There is **no `SandboxOwner` actor**, **no per-session/per-group task queue**, **no `signalWithStart`/`openStreamRequest` workflow hop**, and **no worker RPC / NATS request-reply for the handshake**. The **desktop/pixel capability content of this module is unchanged and not weakened** — only the transport/placement is restated to the **AUTHORITATIVE CORRECTED MODEL: the control plane is API-direct.** The `GET /stream-capabilities` handshake, the viewer-holder acquisition, the cold→warming lease CAS, `ensureDisplayStack`, `resolveExposedPort(6080)`, the stream-token mint, and every rotation are served **client → API → box** by the **API process itself**: the API imports the thin shared sandbox module (`@opengeni/runtime/sandbox`: `createSandboxClient` + the envelope (de)serializers), `resume()`s the box **by id** from the group lease's stored envelope **in-process**, runs `session.exec`/`resolveExposedPort`, mints/registers the edge token, returns inline JSON, and drops the handle when the request completes. The cold→warming lease CAS is a **Postgres transaction the API owns**; the API already makes outbound HTTPS (Stripe/OpenAI/GitHub), egress to `api.modal.com` is confirmed, and `ModalSandboxClient.resume()` is per-call with no pool/singleton, so this needs **no Temporal, no worker, and no NATS round-trip in the synchronous control path.** **Temporal is used for exactly two things:** the long-running agent **turn** (the existing `sessionWorkflow`), and **one global reaper Schedule** (the crosscut module's periodic sweep — TTL-reap stale viewer holders, reset warming-death, terminate at `refcount=0`). The **pixel plane is unchanged**: viewers connect **directly** to `data_plane_url` (client → Modal-tunnel direct); there is no owner process to reach. Read every "activity scheduled on `sandbox-owner::<sessionId>`", "lives on the `SandboxOwner`", "`signalWithStart(openStreamRequest)`", "`proxyOwnerActivities`", "owner method", and "owner keep-alive timer" below as **"served API-direct: the API resumes the box by id in-process and operates the live `session` handle, rotation driven by the global reaper Schedule"**; they are retained verbatim for provenance only.

Scope boundary: Channel A (terminal-as-events, files, git) is **out of scope** here — it rides `appendAndPublishEvents` (`packages/events/src/index.ts:30`) and `sseSessionStream` (`apps/api/src/http/sse.ts:5`) unchanged. Channel B carries only raw framebuffer pixels and uses Channel A solely for one out-of-band signal: `stream.url.rotated`. The lease machinery, the `sandbox_leases` DDL, and the ownership-inversion refactor are owned by their own modules; this spec consumes their interfaces and specifies only the desktop-specific additions (`exposeStreamPort`, `ensureDisplayStack`, token minting/rotation, the websockify edge, the handshake route, the React noVNC client).

---

## 0. The mental model in one diagram

```
CONTROL PLANE (API-DIRECT: client→API→box)       DATA PLANE (direct-to-provider, Channel B)
──────────────────────────────────              ──────────────────────────────────────────
 client  ── GET /stream-capabilities ─►  API  (the API process serves this IN-PROCESS)
   │                                      │ requireAccessGrant("sessions:read")
   │                                      │ acquire viewer-holder + cold→warming CAS  (Postgres txn the API owns)
   │                                      ▼
   │                          sandbox.resume(box-id, envelope)   (in-process, per-call, no pool)
   │                                  ├─ ensureDisplayStack()  (idempotent, via session.exec)
   │                                  ├─ session.resolveExposedPort(6080) ─► provider tunnel
   │                                  ├─ mint streamToken (HMAC, TTL)
   │                                  ├─ register token at websockify edge (in-box token file)
   │                                  └─ drop the handle on return
   │                                      │
   ◄── 200 {capabilities,dataPlaneUrl,streamToken,expiresAt} ─┘     (NO Temporal, NO worker, NO NATS req/reply)
   │
   └─ open WS:  wss://<provider-host>/websockify?token=<streamToken> ───────────────► websockify (in box)
                                                                                          │ validate token (edge)
                                                                                          ▼
                                                                          x11vnc :5900 ◄─ Xvfb :0 ◄─ agent xdotool
                 (rotation) ◄── SSE  stream.url.rotated {dataPlaneUrl,streamToken,expiresAt} ── global reaper Schedule (event-driven on rollover)
```

Two planes, one display. The agent's `computerTool` actions and the viewers' pixels are the same `:0` framebuffer — zero projection (settled).

---

## 1. Contracts — the capability interface (`packages/contracts/src/index.ts`)

The handshake response and the advertised capability are net-new Zod schemas. Place them near `ClientConfig` (`:1425`) and `SandboxBackend` (`:13`).

### 1.1 New Zod schemas

```ts
// packages/contracts/src/index.ts — after SandboxBackend (~:15)

export const StreamTransport = z.enum(["vnc-ws", "webrtc", "sse-events", "pty-ws"]);
export type StreamTransport = z.infer<typeof StreamTransport>;

// The per-capability descriptor. transport=null means "not available on this
// backend/session" — degradation is ALWAYS a handshake value, never silent.
export const FileSystemCapability = z.object({
  available: z.boolean(),
  readOnly: z.boolean(),
});
export const TerminalCapability = z.object({
  transport: z.union([z.literal("sse-events"), z.literal("pty-ws"), z.null()]),
  // Channel-A terminal rides /events/stream; no url/token. pty-ws reserved.
});
export const GitCapability = z.object({ available: z.boolean() });

export const DesktopStreamCapability = z.object({
  transport: z.union([z.literal("vnc-ws"), z.literal("webrtc"), z.null()]),
  // interactivity: read-only is v1 default; "interactive" gates raw input fan-in.
  interactivity: z.enum(["read-only", "interactive"]).default("read-only"),
  // shared-live MUST be acknowledged: the pixel plane is un-redacted (can show
  // live cloud creds). When sharedLive=false the URL is single-viewer-scoped.
  sharedLive: z.boolean().default(false),
  resolution: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
});

export const RecordingCapability = z.object({
  available: z.boolean(),
  mode: z.enum(["x11grab-mp4", "off"]).default("off"),
});

export const SessionCapabilities = z.object({
  fileSystem: FileSystemCapability,
  terminal: TerminalCapability,
  git: GitCapability,
  desktopStream: DesktopStreamCapability,
  recording: RecordingCapability,
});
export type SessionCapabilities = z.infer<typeof SessionCapabilities>;

// The handshake response body for GET /sessions/:id/stream-capabilities.
// dataPlaneUrl + streamToken are present IFF desktopStream.transport !== null.
export const StreamCapabilitiesResponse = z.object({
  capabilities: SessionCapabilities,
  // The direct-to-provider WS URL the viewer connects to. NOT secret on its own
  // (token is the auth boundary), but short-TTL + scoped where the provider
  // supports it (Blaxel token-query, Daytona signed-preview, Modal raw tunnel).
  dataPlaneUrl: z.string().url().nullable(),
  // OpenGeni-minted scoped token; validated at the websockify edge on WS upgrade.
  streamToken: z.string().nullable(),
  // Absolute expiry of {dataPlaneUrl,streamToken}; client must re-handshake or
  // consume a stream.url.rotated event before this instant.
  expiresAt: z.string().datetime().nullable(),
  // Echoed so the client can reconcile against a later rotation event.
  leaseEpoch: z.number().int().nonnegative(),
});
export type StreamCapabilitiesResponse = z.infer<typeof StreamCapabilitiesResponse>;
```

### 1.2 New SessionEventType members (Channel-A rotation signal + lifecycle)

Append to `SessionEventType` (`:1270`):

```ts
  // ...existing through "goal.continuation",
  "stream.url.rotated",      // re-minted {dataPlaneUrl,streamToken,expiresAt} (event-driven on box rollover)
  "stream.opened",           // a viewer attached (audit + refcount visibility)
  "stream.closed",           // a viewer detached / was reaped
  "stream.revoked",          // grant revoked → all viewers MUST disconnect now
```

Their payloads (new Zod objects near the existing payload schemas; mirror the `SessionEvent.payload` discriminated-by-`type` convention already used):

```ts
export const StreamUrlRotatedPayload = z.object({
  dataPlaneUrl: z.string().url(),
  streamToken: z.string(),
  expiresAt: z.string().datetime(),
  leaseEpoch: z.number().int().nonnegative(),
});
export const StreamOpenedPayload = z.object({
  viewerHolderId: z.string(),          // sandbox_lease_holders.holder_id
  sharedLive: z.boolean(),
  viewerCount: z.number().int().nonnegative(),
});
export const StreamClosedPayload = z.object({
  viewerHolderId: z.string(),
  reason: z.enum(["client-disconnect", "reaped", "revoked", "box-rollover"]),
  viewerCount: z.number().int().nonnegative(),
});
export const StreamRevokedPayload = z.object({
  reason: z.enum(["grant-revoked", "session-failed", "admin"]),
});
```

> **Why `stream.url.rotated` is on Channel A, not Channel B:** the pixel socket carries opaque RFB and cannot carry a control message the React client can act on without a parallel protocol. The rotation must reach the client durably and sequenced (it may arrive while the client's WS is momentarily down) — that is exactly the SSE contract (`sseSessionStream` gap-fill, `apps/api/src/http/sse.ts:20`). The client subscribes to `/events/stream`, and on `stream.url.rotated` it swaps the noVNC connection URL without a full re-handshake.

### 1.3 ClientConfig advertisement (static, deployment-level)

The per-session capability is dynamic (handshake), but the *deployment* advertises whether desktop is wireable at all so a client can hide the button when the backend is `cloudflare`/`vercel`/`none`. Extend `ClientConfig` (`:1425`):

```ts
  desktopStream: z.object({
    // True when the configured sandboxBackend's SDK client implements a real
    // resolveExposedPort (modal/daytona/runloop/e2b/blaxel) AND a desktop image
    // is configured. False for cloudflare/vercel/local/docker/none.
    supported: z.boolean(),
    defaultResolution: z.tuple([z.number().int(), z.number().int()]).default([1280, 800]),
  }).default({ supported: false, defaultResolution: [1280, 800] }),
```

### 1.4 SDK + React parity (mechanical)

Per GROUND:capability-pattern, every contract change mirrors into `packages/sdk/src/types.ts` (the `contract-parity.test.ts` gate) and surfaces in `packages/react`:
- `packages/sdk/src/types.ts:100` — append the 4 new strings to `SESSION_EVENT_TYPES`; add `SessionCapabilities`/`StreamCapabilitiesResponse`/payload types.
- `packages/sdk/src/index.ts:21` — re-export the new types.
- `packages/react/src/timeline.ts:163` — add `switch` cases for `stream.opened`/`stream.closed`/`stream.revoked` (new `NoticeItem`-like timeline rows; `stream.url.rotated` is consumed by the hook, NOT rendered as a timeline row).

---

## 2. The capability resolver — provider × backend → SessionCapabilities

This is the single function that decides what a session can do. It is pure (no I/O) given the backend id and the deployed image flag, and is the source of truth for both the static `ClientConfig.desktopStream.supported` and the dynamic handshake.

**New file: `packages/runtime/src/stream/capabilities.ts`**

```ts
import type { SandboxBackend, SessionCapabilities } from "@opengeni/contracts";

// The decisive fact (GROUND:sdk-clients): only cloudflare's resolveExposedPort
// is a hard throw; everything else resolves a real endpoint. Desktop also needs
// a custom-root image (R1) — cloudflare locks /workspace, vercel has no custom
// image. So desktop-capable = {modal,daytona,runloop,e2b,blaxel}.
const DESKTOP_CAPABLE: ReadonlySet<SandboxBackend> = new Set([
  "modal", "daytona", "runloop", "e2b", "blaxel",
] as SandboxBackend[]);

// PTY truth table (GROUND:sdk-clients §supportsPty): modal/cloudflare hardcode
// true; vercel/runloop hardcode false; e2b/daytona/blaxel are runtime-conditional.
// Terminal-as-events (Channel A) needs only session.exec, which ALL have — so
// terminal transport is "sse-events" everywhere a sandbox exists.
const TERMINAL_NONE: ReadonlySet<SandboxBackend> = new Set(["none"] as SandboxBackend[]);

export type CapabilityInputs = {
  backend: SandboxBackend;
  desktopImageConfigured: boolean;   // settings.desktopImageRef present for backend
  reachable: boolean;                // false for deployed `local` (loopback-only box)
  sharedLiveAcknowledged: boolean;   // session/grant opted into shared-live
  resolution: [number, number];
};

export function resolveSessionCapabilities(i: CapabilityInputs): SessionCapabilities {
  const sandboxExists = i.backend !== "none" && i.reachable;
  const desktopOk =
    sandboxExists && DESKTOP_CAPABLE.has(i.backend) && i.desktopImageConfigured;

  return {
    fileSystem: { available: sandboxExists, readOnly: !sandboxExists },
    terminal: { transport: sandboxExists && !TERMINAL_NONE.has(i.backend) ? "sse-events" : null },
    git: { available: sandboxExists },
    desktopStream: {
      transport: desktopOk ? "vnc-ws" : null,    // webrtc reserved for v3
      interactivity: "read-only",                // v1: ALWAYS read-only (§7.2)
      sharedLive: i.sharedLiveAcknowledged,
      ...(desktopOk ? { resolution: i.resolution } : {}),
    },
    recording: {
      available: desktopOk,
      mode: desktopOk ? "x11grab-mp4" : "off",
    },
  };
}

// Static flag for ClientConfig — does NOT need a live session.
export function deploymentDesktopSupported(
  backend: SandboxBackend, desktopImageConfigured: boolean,
): boolean {
  return DESKTOP_CAPABLE.has(backend) && desktopImageConfigured;
}
```

The `reachable:false` case is the settled "deployed `local`" degradation (a loopback-only sandbox a remote browser cannot reach): capabilities come back with `desktopStream.transport:null` and the client falls back to Channel-A-only. `local`/`docker` are *not* in `DESKTOP_CAPABLE` (no provider tunnel), so they also degrade cleanly.

---

## 3. The in-box stream stack — `ensureDisplayStack` (idempotent)

The desktop chain is **not** the container CMD. It is a set of commands run through the live `session.exec` against the resumed-by-id box after box-create and after every resume/rollover, so it is idempotently re-established under the lease (per "re-establish-singleton-from-envelope-under-CAS"). Per the **CORRECTED MODEL** this runs **in whatever process currently holds the live handle**: the **API process** in the API-direct `/stream-capabilities` handshake (the common case — a viewer attaching), or the worker's agent-turn activity if a turn happens to be the first to resume the box. There is **no `SandboxOwner` actor** and **no Temporal hop** for this; `ensureDisplayStack` is an idempotent function the holder calls directly. This is where the GROUND:desktop-stack startup order becomes code.

**New file: `packages/runtime/src/sandbox/display-stack.ts`** (re-exported under `@opengeni/runtime/sandbox` so the **API-direct** handshake handler imports it without the agent-loop graph; the worker's agent-turn can also call it):

```ts
import type { SandboxSessionLike } from "@openai/agents-core/sandbox";

export const STREAM_PORT = 6080;          // the ONE exposed port (websockify/noVNC)
const VNC_PORT = 5900;                    // x11vnc, localhost-only
const DISPLAY = ":0";

export type DisplayStackConfig = {
  width: number;
  height: number;
  dpi: number;                            // 96
  recording: boolean;
};

// A single guarded exec: idempotent because every step is "start if not already
// running". Re-running after a Modal 24h snapshot-rollover re-launches the chain
// against the fresh box. The script writes a sentinel so a second concurrent
// exposeStreamPort (turn + viewer racing) does not double-spawn the chain.
export async function ensureDisplayStack(
  session: SandboxSessionLike,
  cfg: DisplayStackConfig,
): Promise<{ ready: boolean }> {
  const script = buildDisplayStackScript(cfg);
  const res = await session.exec!({
    cmd: script,
    shell: "/bin/bash",
    login: false,
    yieldTimeMs: 30_000,                  // gate on xdpyinfo readiness inside
    maxOutputTokens: 4_000,
  });
  return { ready: res.exitCode === 0 };
}

function buildDisplayStackScript(cfg: DisplayStackConfig): string {
  const geom = `${cfg.width}x${cfg.height}x24`;
  // Sentinel lock prevents double-spawn under the turn+viewer race; flock makes
  // the whole block a critical section inside the box.
  return `
set -euo pipefail
exec 9>/tmp/.opengeni-display.lock
flock -w 25 9
# 1. dbus machine-id (image build normally does this; ensure at runtime)
[ -f /var/lib/dbus/machine-id ] || dbus-uuidgen --ensure
# 2. Xvfb :0 — start if not up
if ! xdpyinfo -display ${DISPLAY} >/dev/null 2>&1; then
  nohup Xvfb ${DISPLAY} -ac -screen 0 ${geom} -retro -dpi ${cfg.dpi} \\
    -nolisten tcp -nolisten unix >/tmp/xvfb.log 2>&1 &
  for i in $(seq 1 50); do xdpyinfo -display ${DISPLAY} >/dev/null 2>&1 && break; sleep 0.1; done
fi
xdpyinfo -display ${DISPLAY} >/dev/null 2>&1 || { echo "xvfb-failed"; exit 1; }
# 3. XFCE4 (+ session bus) — start if no xfdesktop
if ! pgrep -x xfdesktop >/dev/null 2>&1; then
  DISPLAY=${DISPLAY} nohup dbus-launch startxfce4 >/tmp/xfce.log 2>&1 &
  sleep 1
fi
# 4. x11vnc -shared on :5900 (localhost only) — start if no listener
if ! pgrep -x x11vnc >/dev/null 2>&1; then
  nohup x11vnc -display ${DISPLAY} -forever -wait 50 -shared -rfbport ${VNC_PORT} \\
    -localhost -nopw -noxdamage -speeds lan -ping 1 -repeat \\
    >/tmp/x11vnc.log 2>&1 &
fi
# 5. websockify+noVNC on :6080 (the exposed port). Token plugin dir is the
#    edge auth boundary (§5). --token-source re-read per connection.
if ! pgrep -f 'novnc_proxy' >/dev/null 2>&1; then
  mkdir -p /tmp/novnc-tokens
  cd /opt/noVNC/utils
  nohup ./novnc_proxy --vnc localhost:${VNC_PORT} --listen ${STREAM_PORT} \\
    --web /opt/noVNC --token-plugin TokenFile --token-source /tmp/novnc-tokens \\
    >/tmp/novnc.log 2>&1 &
fi
${cfg.recording ? `
# 6. recording (independent reader of :0) — start if no ffmpeg
if ! pgrep -x ffmpeg >/dev/null 2>&1; then
  nohup ffmpeg -y -f x11grab -draw_mouse 1 -framerate 15 -video_size ${cfg.width}x${cfg.height} \\
    -i ${DISPLAY}.0 -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +faststart \\
    /tmp/session-$(date +%s).mp4 >/tmp/ffmpeg.log 2>&1 &
fi` : ""}
echo "display-stack-ready"
`.trim();
}
```

**Important divergence from GROUND:desktop-stack's plain x11vnc command:** the spec runs websockify with `--token-plugin TokenFile --token-source /tmp/novnc-tokens`, and x11vnc with `-localhost`. This is the edge auth (§5): websockify maps an opaque token → `localhost:5900` and is re-read per connection, so a token written by `exposeStreamPort` authorizes a connect and deleting the token file revokes it live. x11vnc itself stays `-nopw` and `-localhost` (only reachable via the websockify hop). The provider tunnel exposes **only** 6080.

**Resolution change** = a separate `restartDisplayStack` exec that `pkill`s Xvfb/x11vnc/xfce/novnc and re-runs `ensureDisplayStack` with the new geometry (Xvfb has no live RANDR resize). This is wired to a future `stream.resize` control event; not v1-required.

### 3.1 Two new Dockerfile artifacts (the desktop image)

The repo's only image is `docker/sandbox.Dockerfile` (headless). The desktop image is net-new.

**New file: `docker/desktop.Dockerfile`** (extends the headless base with the GROUND:desktop-stack package list):

```dockerfile
# syntax=docker/dockerfile:1
ARG BASE=ghcr.io/cloudgeni-ai/opengeni-sandbox:latest
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive
RUN yes | unminimize || true && apt-get update && apt-get install -y --no-install-recommends \
      xserver-xorg x11-xserver-utils xvfb x11-utils x11-apps xauth \
      xfce4 xfce4-goodies dbus-x11 \
      x11vnc \
      xdotool scrot ffmpeg \
      libgl1-mesa-dri \
      net-tools netcat-openbsd curl wget git sudo util-linux \
      software-properties-common apt-transport-https libgtk-3-bin \
      firefox-esr \
 && rm -rf /var/lib/apt/lists/*
# noVNC + websockify, pinned (GROUND:desktop-stack §3)
RUN git clone -b v1.5.0 https://github.com/novnc/noVNC.git /opt/noVNC \
 && ln -sf /opt/noVNC/vnc.html /opt/noVNC/index.html \
 && git clone -b v0.12.0 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify
RUN dbus-uuidgen > /var/lib/dbus/machine-id
# The stream entrypoint is NOT CMD — whoever holds the resumed-by-id box runs
# ensureDisplayStack via session.exec (the API-direct handshake handler, or the
# agent turn). Keep the SDK's `sleep infinity` root process (Modal convention).
ENV OPENGENI_DESKTOP=1 OPENGENI_STREAM_PORT=6080
```

This image's registry ref becomes `settings.desktopImageRef` (per backend; for Modal it is the OCI tag passed to `ModalImageSelector.fromTag`). For e2b/blaxel, prefer their official XFCE+VNC templates (`e2b-dev/desktop`, `blaxel/xfce-vnc`) instead of this image — those resolve `getHost(6080)` / preview at port 6080 already; the `ensureDisplayStack` script is still run idempotently to guarantee the exact flags.

---

## 4. `exposeStreamPort` and token rotation (served API-direct)

This is the heart of Channel B's control plane. Per the **CORRECTED MODEL** `exposeStreamPort` is **not** a Temporal activity and there is **no `SandboxOwner` actor**. It is a plain function in the shared sandbox module (`packages/runtime/src/sandbox/`, re-exported under `@opengeni/runtime/sandbox`) that operates on a live `{client, session, sessionState}` triple. The **API process calls it directly, in-process**, inside the `GET /stream-capabilities` request handler: the API resumes the box **by id** from the group lease envelope, runs `ensureDisplayStack` + `resolveExposedPort(6080)` + mint + edge-register, returns the URL + token (plain JSON) as the HTTP response, and drops the handle. The pixel socket and the box handle never traverse Temporal or NATS — there is no workflow, no per-session queue, and no worker RPC in this path. (The same function is callable by the worker's agent-turn activity if a turn is the first to bring the box up, since it just needs a live handle — it carries zero Temporal coupling.) The class shape below is retained for provenance; read `SandboxOwner` as **"the API-direct handshake handler's call site, which holds the freshly-resumed live handle for the duration of the request."**

### 4.1 The owner-side signature

```ts
// packages/runtime/src/sandbox/stream.ts (desktop slice) — re-exported under
// @opengeni/runtime/sandbox; the API-direct /stream-capabilities handler calls
// exposeStreamPort() in-process on the freshly-resumed-by-id live handle.
import { ensureDisplayStack, STREAM_PORT, type DisplayStackConfig } from "./display-stack";
import { mintStreamToken, registerEdgeToken, revokeEdgeToken } from "./stream-token";
import type { ExposedPortEndpoint, SandboxSessionLike } from "@openai/agents-core/sandbox";

export type ExposeStreamPortInput = {
  sessionId: string;
  workspaceId: string;
  viewerHolderId: string;       // the sandbox_lease_holders row this URL is for
  leaseEpoch: number;           // fence — owner rejects if != its own epoch
  resolution: [number, number];
  recording: boolean;
  ttlSeconds: number;           // default 600; provider TTL is min(this, providerCap)
};

export type ExposeStreamPortResult = {
  dataPlaneUrl: string;         // urlForExposedPort(endpoint,'ws') + token query
  streamToken: string;
  expiresAt: string;            // ISO; min(tokenTtl, providerUrlTtl, leaseExpiry)
  leaseEpoch: number;
};

class SandboxOwner {
  // ...holds the ONE {client, session, sessionState}...
  private session!: SandboxSessionLike;
  private epoch!: number;
  private displayReady = false;

  async exposeStreamPort(input: ExposeStreamPortInput): Promise<ExposeStreamPortResult> {
    // (c) split-brain fence: a superseded owner must not mint a URL.
    if (input.leaseEpoch !== this.epoch) {
      throw new OwnerFencedError(this.epoch, input.leaseEpoch);
    }
    // 1. idempotently bring up Xvfb→xfce→x11vnc→websockify+noVNC
    if (!this.displayReady) {
      const cfg: DisplayStackConfig = {
        width: input.resolution[0], height: input.resolution[1], dpi: 96,
        recording: input.recording,
      };
      const { ready } = await ensureDisplayStack(this.session, cfg);
      if (!ready) throw new DisplayStackError(input.sessionId);
      this.displayReady = true;
    }
    // 2. resolve the provider tunnel for port 6080 (cached per provider)
    const endpoint = await this.session.resolveExposedPort!(STREAM_PORT);
    // 3. mint a scoped token (HMAC over {sessionId,viewerHolderId,epoch,exp})
    const ttl = clampTtl(input.ttlSeconds, providerUrlTtl(endpoint), this.leaseExpiry());
    const streamToken = mintStreamToken({
      sessionId: input.sessionId, workspaceId: input.workspaceId,
      viewerHolderId: input.viewerHolderId, leaseEpoch: this.epoch, ttlSeconds: ttl,
    });
    // 4. register the token at the in-box websockify edge → localhost:5900
    await registerEdgeToken(this.session, streamToken, ttl);
    // 5. assemble the direct-to-provider WS URL
    const dataPlaneUrl = buildStreamUrl(endpoint, streamToken);
    return {
      dataPlaneUrl, streamToken,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      leaseEpoch: this.epoch,
    };
  }
}
```

### 4.2 Provider-specific URL assembly (`buildStreamUrl`)

`session.resolveExposedPort(6080)` returns `ExposedPortEndpoint {host,port,tls,query,protocol,url}` (verified `session.d.ts:9`). The base helper `urlForExposedPort(endpoint,'ws')` (`session.d.ts:100`) yields the scheme+host+port; this module appends the noVNC path and the token. Per-provider specifics (verified against each `sandbox.js`):

| Provider | `resolveExposedPort(6080)` returns | URL assembly | Provider scoping |
|---|---|---|---|
| **Modal** | `{host, port, tls:true, query:''}` from `sandbox.tunnels(10_000)[6080]` (`modal/sandbox.js:261-303`) | `wss://${host}:${port}/websockify?token=${streamToken}` | **None** — raw L4 TLS-TCP passthrough; OpenGeni token at edge is the *only* auth. URL is reusable until box dies. |
| **Daytona** | parsed `{host,...}` from `getSignedPreviewUrl(port,ttl)` (`daytona/sandbox.js:256-278`), `withDaytonaPreviewExpiration` stamps TTL | `${signedPreviewUrl.replace('https','wss')}/websockify?token=${streamToken}` | **Provider TTL-signed** — `exposedPortUrlTtlS` bounds the URL; re-mintable/revocable. Double-scoped (provider TTL + OpenGeni token). |
| **Runloop** | tunnel URL string from `net.enableTunnel`+`getTunnelUrl(port)` (`runloop/sandbox.js:638-700`) | `${tunnelUrl.replace('https','wss')}/websockify?token=${streamToken}` | Bearer-token tunnel (Tunnels v2, one tunnel all ports); OpenGeni token at edge. |
| **e2b** | `{host}` from `getHost(6080)` (`e2b/sandbox.js:151-178`) | `wss://${host}/websockify?token=${streamToken}` | **None** at URL level — host is stable; OpenGeni token is the boundary. |
| **Blaxel** | parsed from `previews.createIfNotExists({port:6080, public})`; if `public:false`, `createBlaxelPreviewTokenQuery(preview, ttlS, port)` appends `query` (`blaxel/sandbox.js:155-195`) | `${url.replace('https','wss')}/websockify?${endpoint.query}&token=${streamToken}` | **Best** — `exposedPortPublic:false` → scoped `bl_preview_token` in `query`, TTL'd. Double-scoped. Set `settings.blaxelExposedPortPublic=false`. |
| **cloudflare** | **throws `SandboxUnsupportedFeatureError`** (`cloudflare/sandbox.js:264-274`) | n/a | headless-only → `desktopStream.transport:null` |
| **vercel** | `sandbox.domain(port)` works (`vercel/sandbox.js:96-113`) **but** no custom image / no XFCE / no PTY (5h cap) | n/a for desktop | headless-only by image constraint → `transport:null` |

```ts
function buildStreamUrl(endpoint: ExposedPortEndpoint, token: string): string {
  // urlForExposedPort returns ws://host:port or wss://host:port (tls-aware).
  const base = urlForExposedPort(endpoint, "ws");          // session.d.ts:100
  const u = new URL("/websockify", base);
  if (endpoint.query) {
    // Blaxel/Daytona provider token already in endpoint.query — preserve it.
    for (const [k, v] of new URLSearchParams(endpoint.query)) u.searchParams.set(k, v);
  }
  u.searchParams.set("token", token);
  return u.toString();
}

function providerUrlTtl(endpoint: ExposedPortEndpoint): number | undefined {
  // Daytona stamps an expiration; Blaxel TTL is in the token-query. Modal/e2b/
  // runloop have no per-URL TTL (only box lifetime). parseExposedPortEndpoint
  // does not surface TTL, so we read settings.<provider>ExposedPortUrlTtlS.
  return typeof endpoint.expiresAt === "number" ? endpoint.expiresAt : undefined;
}
```

### 4.3 Token / URL rotation is event-driven on box rollover — NOT a keep-alive timer

**Corrected model (supersedes the old per-owner `setInterval` keep-alive).** There is **no per-session keep-alive timer and no `ownerHeartbeat`** — the box stays warm on the **provider's existing idle-timeout** (`modalTimeoutSeconds`, `config/src/index.ts:241`); see `00-master-spine.md` §B.2. So rotation is **not** a periodic "re-mint before TTL" sweep. The data-plane URL needs a fresh value in exactly one situation: **the box rolls over / is re-keyed** (Modal 24h snapshot, or any death → re-establish-from-envelope under CAS), which produces a new `sandboxId` and therefore a new provider tunnel host (§7.7/§7.8). Rotation is **event-driven on that rollover**, and it is produced by whoever re-establishes the box under the new `lease_epoch`:

- **Common case — the next API-direct op re-mints inline.** A viewer's app-level heartbeat (or any `/stream-capabilities` re-handshake) lands on the API; the API resumes the box by id, and if the resume re-established a rolled-over box (new `sandboxId`, bumped `lease_epoch`), the same in-process handler re-runs `ensureDisplayStack` (idempotent), re-resolves `resolveExposedPort(6080)`, re-mints the token, and **returns the fresh `{dataPlaneUrl,streamToken,expiresAt,leaseEpoch}` as the HTTP response** (no separate rotation event needed for the requester). For **other** attached viewers of the same session, the handler emits `stream.url.rotated` on Channel A once per affected holder.
- **Backstop — the one global reaper Schedule.** If no viewer op happens to touch a rolled-over box promptly, the **single global reaper Schedule** (crosscut module — the same sweep that TTL-reaps viewer holders, resets warming-death, and terminates at `refcount=0`) detects the `lease_epoch` advance on a box that still has live viewer holders, re-mints under the new epoch, and emits `stream.url.rotated` to each holder. This is the **only** Temporal touch-point for rotation, and it is out of band — never in the synchronous handshake path.

Token TTL is set comfortably longer than the expected rollover-to-re-mint gap so the old URL/token stays valid through the hot-swap overlap window (§7.6). Both rotation producers call the same helper:

```ts
// packages/runtime/src/sandbox/stream.ts — pure function, no actor, no timer.
// Called in-process by the API-direct handler (for other viewers) and by the
// global reaper Schedule. Re-mints under the CURRENT lease_epoch and broadcasts.
async function rotateStreamForHolder(args: {
  session: SandboxSessionLike; db: Db; bus: Bus;
  sessionId: string; workspaceId: string; holder: ViewerHolder;
  leaseEpoch: number; resolution: [number, number]; recording: boolean;
  ttlSeconds: number;
}): Promise<ExposeStreamPortResult> {
  const next = await exposeStreamPort({
    session: args.session,
    sessionId: args.sessionId, workspaceId: args.workspaceId,
    viewerHolderId: args.holder.id, leaseEpoch: args.leaseEpoch,
    resolution: args.resolution, recording: args.recording, ttlSeconds: args.ttlSeconds,
  });
  // Channel-A signal — durable, sequenced, gap-filled to the client.
  // appendAndPublishEvents(db, bus, workspaceId, sessionId,
  //   [{ type:"stream.url.rotated", payload: StreamUrlRotatedPayload }])
  await publishStreamRotated(args.db, args.bus, args.workspaceId, args.sessionId, args.holder, next);
  return next;
}
```

**Invariant** (boot-validated, GROUND:prior-docs §E): `reaperPeriod < viewerHolderTTL < providerIdleTimeout`. There is **no** `keepAliveIntervalMs`/`rotateBeforeMs` (no per-session keep-alive timer): the box stays warm on the provider idle-timeout, and rotation fires only on box rollover/re-key (§4.3). The `streamToken` TTL is set comfortably longer than the rollover-to-re-mint gap so the old URL/token stays valid through the hot-swap overlap window — the client treats `stream.url.rotated` as a hot-swap (open new WS, then close old) to avoid a visible blink.

---

## 5. The websockify edge — the security boundary of the pixel plane

The token is validated **at the websockify edge inside the box**, not by URL secrecy (settled §H). Two layers:

1. **The provider tunnel** (Modal raw TLS / Daytona signed / Blaxel token-query) gates reaching port 6080 at all. For Modal/e2b this is open (host known) → the OpenGeni token is the *sole* boundary. For Daytona/Blaxel it is a second, provider-enforced scope.
2. **The websockify TokenFile plugin** maps `?token=<X>` → backend `localhost:5900`. The token file lives at `/tmp/novnc-tokens/<token>` containing `<token>: localhost:5900`. websockify re-reads the source dir per connection (verified behavior of `--token-plugin TokenFile --token-source`), so:
   - **mint** = `registerEdgeToken` writes the file (with an in-box `at`/cron self-delete at TTL).
   - **revoke** = `revokeEdgeToken` deletes the file → the next connect with that token is refused. Reaping a holder (disconnect, TTL, grant-revocation) calls this.

**New file: `packages/runtime/src/sandbox/stream-token.ts`** (re-exported under `@opengeni/runtime/sandbox`; called in-process by the **API-direct** handshake handler):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SandboxSessionLike } from "@openai/agents-core/sandbox";

export type StreamTokenClaims = {
  sessionId: string; workspaceId: string;
  viewerHolderId: string; leaseEpoch: number; ttlSeconds: number;
};

// HMAC token = base64url({claims,exp}) + "." + base64url(hmac). The SECRET is
// settings.streamTokenSecret (OPENGENI_STREAM_TOKEN_SECRET). The token is opaque
// to the client; OpenGeni validates it ONLY indirectly (the edge file gate) —
// the file's existence IS the validation. The HMAC body lets the API-direct
// handler / the global reaper Schedule reconstruct the exact filename to delete
// without DB state.
export function mintStreamToken(c: StreamTokenClaims): string { /* HMAC, exp */ }

// Writes /tmp/novnc-tokens/<token> = "<token>: localhost:5900" with a TTL self-
// destruct, so an attached viewer survives but a stale token cannot reconnect.
export async function registerEdgeToken(
  session: SandboxSessionLike, token: string, ttlSeconds: number,
): Promise<void> {
  const fname = tokenFilename(token);
  await session.exec!({
    cmd: `set -e
mkdir -p /tmp/novnc-tokens
printf '%s: localhost:5900\\n' ${shellQuote(token)} > /tmp/novnc-tokens/${fname}
( sleep ${ttlSeconds}; rm -f /tmp/novnc-tokens/${fname} ) >/dev/null 2>&1 &`,
    yieldTimeMs: 5_000,
  });
}

// Revocation: delete the edge file → the NEXT connect is refused. Existing live
// WS connections are NOT torn by file deletion (websockify only re-reads on
// connect), so revocation ALSO kills the live socket by bouncing the holder's
// VNC session — see §7.4 (revoke = delete file + pkill the matching x11vnc client).
export async function revokeEdgeToken(
  session: SandboxSessionLike, token: string,
): Promise<void> {
  await session.exec!({ cmd: `rm -f /tmp/novnc-tokens/${tokenFilename(token)}`, yieldTimeMs: 3_000 });
}
```

**Read-only vs interactive (§7.2):** v1 is **read-only**. The websockify/x11vnc path is made view-only by launching x11vnc with `-viewonly` **per the read-only default**, OR (preferred, so the agent's own input still flows) by keeping the *agent* input via the `computerTool` exec channel and disabling *viewer* input at the noVNC client (`?view_only=true` URL param) AND server-side with x11vnc `-viewonly`. The decisive enforcement is server-side `-viewonly`: a malicious client cannot inject input that would bypass the `approvalQueue`/`interrupt` gates (settled — a raw-pty writer bypasses approvals). `interactivity:"interactive"` (opt-in, future) drops `-viewonly` and is gated behind a `sessions:control`-equivalent grant, never `sessions:read`.

**Shared-live (§7.3):** the pixel plane is un-redacted. `sharedLive` defaults `false` and a second viewer on the same session is refused unless the session opted in (the handshake's `DesktopStreamCapability.sharedLive` is `true`). With `sharedLive:false`, `exposeStreamPort` mints a token scoped to exactly one `viewerHolderId` and the reaper enforces one concurrent viewer holder. With `sharedLive:true`, x11vnc `-shared` fans out and each viewer gets its own holder+token.

---

## 6. The control-plane handshake — `GET /sessions/:id/stream-capabilities` (API-DIRECT)

The exact 5-step sequence (settled §G), now with code anchors. **Per the CORRECTED MODEL the entire handshake is served `client → API → box`, in the API process, with no Temporal/worker/NATS hop.** The API imports the thin shared sandbox module (`@opengeni/runtime/sandbox`), resumes the box **by id** from the group lease envelope **in-process**, runs the cold→warming CAS as a Postgres transaction it owns, acquires a viewer-kind lease holder, calls `exposeStreamPort` directly on the live handle, and returns the URL + token as the HTTP response. The box handle and the pixel socket never traverse Temporal — there is no `signalWithStart`, no `openStreamRequest` workflow client method, no per-session task queue, and no result-poll.

### 6.1 Route (`apps/api/src/routes/sessions.ts`, new route near `:214`)

```ts
app.get("/v1/workspaces/:workspaceId/sessions/:sessionId/stream-capabilities", async (c) => {
  const { workspaceId, sessionId } = c.req.param();
  const grant = await requireAccessGrant(c, deps, workspaceId, "sessions:read");   // :216 pattern
  // Resolve the session's effective backend (turn override ?? settings).
  const session = await getSessionOrThrow(deps.db, workspaceId, sessionId);
  const backend = session.sandboxBackend as SandboxBackend;
  // Fast no-desktop path: pure capability resolution, NO box round-trip.
  if (!deploymentDesktopSupported(backend, deps.settings.desktopImageRefFor(backend))) {
    return c.json(StreamCapabilitiesResponse.parse({
      capabilities: resolveSessionCapabilities({ backend, desktopImageConfigured: false,
        reachable: true, sharedLiveAcknowledged: false, resolution: [0,0] }),
      dataPlaneUrl: null, streamToken: null, expiresAt: null, leaseEpoch: 0,
    }));
  }
  // Desktop path: API-DIRECT — acquire a VIEWER holder + expose the port IN-PROCESS.
  // No signalWithStart, no workflow, no per-session queue: the API itself resumes
  // the box by id and runs exposeStreamPort on the live handle. (mirrors the
  // Channel-A A2 API-direct seam, modules/08-channel-a.md §5.1.)
  const viewerHolderId = crypto.randomUUID();
  const result = await deps.streamControl.openStream({
    accountId: grant.accountId, workspaceId, sessionId,
    viewerHolderId, viewerGrantSubjectId: grant.subjectId,
    resolution: deps.clientConfig.desktopStream.defaultResolution,
    sharedLive: session.sharedLiveAcknowledged ?? false,
  });
  // result = { dataPlaneUrl, streamToken, expiresAt, leaseEpoch, capabilities }
  return c.json(StreamCapabilitiesResponse.parse(result));
});
```

### 6.2 The API-direct stream-control seam (`apps/api/src/dependencies.ts` + `@opengeni/runtime/sandbox`)

There is **no workflow client method.** The enabling refactor (master spine §B.2, Channel-A §5.1) extracts `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` into `@opengeni/runtime/sandbox`, so `apps/api` imports them **without** the `@openai/agents` agent-loop graph. `dependencies.ts` gains **one** field — a sandbox/Modal client built from settings (the Modal token is already parsed by the shared `getSettings`, `packages/config`; egress to `api.modal.com` is confirmed). `deps.streamControl.openStream` is then a plain in-process function:

```ts
// packages/runtime/src/sandbox/stream-control.ts (re-exported under
// @opengeni/runtime/sandbox). Called IN-PROCESS by the API route handler —
// NO Temporal, NO worker, NO NATS round-trip.
async function openStream({ accountId, workspaceId, sessionId, viewerHolderId,
                           viewerGrantSubjectId, resolution, sharedLive }): Promise<...> {
  return await withGroupLease(db, sessionId, async (tx, group) => {
    // 1. acquire a viewer lease holder + run the cold→warming CAS  (Postgres txn the API OWNS)
    const lease = await acquireLease(tx, { sessionId, kind: "viewer",
      holderId: viewerHolderId, grantSubjectId: viewerGrantSubjectId, sharedLive });
    // 2. resume the box BY ID from the group envelope, IN-PROCESS (per-call, no pool)
    const { client, session, sessionState } = await sandbox.resume(
      group.instanceId, deserializeSandboxSessionStateEnvelope(group.envelope));
    try {
      // 3. expose the port on the live handle (idempotent display stack + mint)
      const result = await exposeStreamPort({ session, sessionId, workspaceId,
        viewerHolderId, leaseEpoch: lease.leaseEpoch, resolution,
        recording: false, ttlSeconds: STREAM_TTL_S });
      return { ...result, capabilities: lease.capabilities };
    } finally {
      // 4. drop the handle on return (resume() is per-call, nothing to pool)
    }
  });
}
```

`ModalSandboxClient.resume()` is **per-call with no pool/singleton**, so this is the same shape as the API's existing outbound clients (Stripe/OpenAI/GitHub) plus its Postgres ownership. The cold→warming lease CAS is the **same Postgres transaction pattern** as `claimNextQueuedTurn` (`db/index.ts:3077`), run from the API. The single global Temporal Schedule reaper (crosscut module) is the only Temporal touch-point for the non-turn lifecycle, and it is never in this synchronous path.

### 6.3 Concurrency + double-spawn guard (no workflow signal handler)

There is **no `openStream` Temporal signal, no `openStreamQueue`, and no `proxyOwnerActivities`** — those routed the handshake through the session workflow's blocking claim loop, which is **superseded and deleted** (a viewer could otherwise block behind a multi-day turn; settled in `00-master-spine.md` §B.3 / OD-1). The viewer path is fully independent of the turn path: it runs in the API process.

> **Critical (carried from GROUND:prior-docs §B correction, restated for the API-direct model):** the viewer's `exposeStreamPort` runs **concurrently** with the agent turn — the turn runs in a worker activity, the handshake runs in the API process; they never serialize against each other. The `(workspace_id, session_id)` unique index + `SELECT … FOR UPDATE` in the API-owned `acquireLease` transaction is the sole double-spawn guard against the turn and the viewer racing to bring up the same box. `ensureDisplayStack`'s in-box `flock` (§3) is a second, in-box guard against two near-simultaneous `exposeStreamPort` calls double-launching the chain.

### 6.4 The API holds a sandbox client for the control plane (CORRECTED MODEL)

The earlier draft kept `dependencies.ts` at `{db,bus,workflowClient,objectStorage}` and asserted "API holds NO sandbox client," routing the pixel-port exposure through a worker activity so only plain JSON crossed the boundary. **That invariant is intentionally relaxed for the control plane** (master spine §B.3, Channel-A §5.1): the API **gains a sandbox client of its own** so it can resume the box by id and call `exposeStreamPort` in-process. `dependencies.ts` adds **one** field (a sandbox/Modal client built from settings). The handshake still returns only `{dataPlaneUrl,streamToken,expiresAt,leaseEpoch,capabilities}` (plain JSON) to the client, and the **pixel socket still bypasses OpenGeni entirely** (client → Modal-tunnel direct). What changed is only the control path: it is API-direct, not a Temporal activity.

---

## 7. Failure / edge-case matrix (exhaustive)

| # | Scenario | Detection | Handling |
|---|---|---|---|
| 7.0 | **Backend headless (cloudflare/vercel/local/none)** | `deploymentDesktopSupported`=false | Fast path: `desktopStream.transport:null`, `dataPlaneUrl/streamToken/expiresAt:null`. No box round-trip. Client renders Channel-A-only (terminal+files+git). |
| 7.1 | **Display stack fails to come up** (`xdpyinfo` never ready) | `ensureDisplayStack` exits non-zero | `DisplayStackError` is caught in the API-direct handler → the handshake returns `capabilities.desktopStream.transport:null` + `dataPlaneUrl:null`; client degrades, no exception to user. Retry on next handshake. |
| 7.2 | **Viewer attempts input on read-only stream** | x11vnc `-viewonly` + noVNC `?view_only=true` | Input dropped server-side; cannot reach `approvalQueue`/`interrupt`. Interactive requires opt-in grant. |
| 7.3 | **Second viewer on `sharedLive:false`** | Reaper sees viewer_holders would exceed 1 | `exposeStreamPort` refuses (or workflow rejects the signal); handshake returns existing-or-403 with a `sharedLive required` reason. With `sharedLive:true`, x11vnc `-shared` admits both. |
| 7.4 | **Grant revoked mid-stream** | Revocation hook → `stream.revoked` (Channel A) + holder reap | `revokeEdgeToken` deletes the token file (next connect refused) AND the live VNC client is bounced in-box (x11vnc `-disconnect`/pkill the matching client conn). Client receives `stream.revoked` and tears down noVNC. |
| 7.5 | **Token/URL expires before client re-handshakes** | `expiresAt` reached, no rotation consumed | Provider/edge refuses reconnect → noVNC `onclose`; client auto-issues a fresh `GET /stream-capabilities` (API-direct re-mint). Because the box stays warm on the provider idle-timeout and the URL only changes on rollover, this is rare; this is the backstop. |
| 7.6 | **Rotation race** (URL rotates while client mid-frame) | client receives `stream.url.rotated` (rollover-driven, §4.3) | Hot-swap: open new WS to new URL, wait for first frame, then close old WS. Overlap window (token TTL > rollover-to-re-mint gap) guarantees both valid briefly → no visible blink. |
| 7.7 | **Modal 24h lifetime → snapshot-rollover** | Box death detected → re-resume-from-envelope (lease primitive) | New `sandboxId`; the next op that re-establishes the box (an API-direct viewer op, or the global reaper Schedule) re-runs `ensureDisplayStack` (idempotent), re-resolves `resolveExposedPort` (new tunnel host), re-mints tokens, pushes `stream.url.rotated` to every viewer (§4.3). Brief desktop blink (settled). `displayReady` is per-handle, so a fresh resume starts unready. |
| 7.8 | **Box dies under a lone viewer (no turn)** | viewer's app-level heartbeat hits the API → API-direct resume fails / box-exec failure; or the global reaper Schedule sweep | Routes through the unified "re-establish-singleton-from-envelope-under-CAS" primitive, run in-process by the API on the next viewer op (or by the reaper sweep): re-resume by id, re-run `ensureDisplayStack` + re-mint, emit `stream.url.rotated`. Viewer sees a reconnect, not a failure. No owner process is involved. |
| 7.9 | **Worker restart, viewer-only (no liveness hole)** | n/a — there is no owner process to lose | **Corrected: this is not a hole.** Per master spine §B.2 there is **no `ownerHeartbeat` and no per-session keep-alive** — a viewer-only box stays warm on the **provider idle-timeout**. A worker restart cannot strand the box because no worker holds it between turns. Viewer TTL is refreshed by **app-level viewer heartbeats hitting the API directly**; rotation is event-driven on rollover (§4.3), produced by the next API-direct op or the global reaper Schedule. Nothing in this path depends on a worker staying up. |
| 7.10 | **Stale (superseded) epoch mints a stale URL** | `leaseEpoch !== <current epoch>` in `exposeStreamPort` | `OwnerFencedError` (retained name — "fenced by a newer `lease_epoch`") — the stale caller refuses to mint. The epoch is read and re-validated INSIDE the API-owned `FOR UPDATE` txn (pre-emptive, settled §c). Never `create()` on resume-conflict. |
| 7.11 | **Closed laptop / dead viewer** (TCP half-open) | Channel-A app-level viewer heartbeat; stale → `reapStaleLeaseHolders` (~90s) | Holder row deleted (idempotent), refcount recomputed, edge token revoked, `stream.closed{reason:reaped}` emitted; box drains at 0 after grace window. |
| 7.12 | **Flapping** (rapid open/close) | mandatory `draining` grace window (§lease) | N flaps collapse to 1 box; release-during-`warming` decrements refcount only; optional 500ms connect debounce on the client. |
| 7.13 | **Provider tunnel throttles fan-out** (R6 — the big unknown) | load test (§9), runtime: noVNC `onclose` with abnormal code under load | No published cap on any provider; if a viewer is throttled it auto-re-handshakes. Mitigation lever: cap `viewer_holders` per session via the lease (`maxViewersPerSession` setting). |
| 7.14 | **`resolveExposedPort` throws** (port not configured / provider down) | `SandboxProviderError` from the SDK | The in-process `exposeStreamPort` call throws → the handshake returns `transport:null` degradation (no exception to the user); logged with provider+port for the load-test/ops signal. cloudflare's hard `SandboxUnsupportedFeatureError` is pre-filtered by the capability resolver. |
| 7.15 | **6080 not in `exposedPorts`** | `assertConfiguredExposedPort` throws (`shared/ports.d.ts`) | The desktop image's settings MUST include 6080 in `exposedPorts` (config §8). Blaxel allows on-demand (`allowOnDemandExposedPorts:true`), others require pre-declaration. Boot validation: if backend is desktop-capable and image configured, assert 6080 ∈ exposedPorts. |

---

## 8. Config additions (`packages/config/src/index.ts`)

New settings fields (after `:244`), env mappings (after `:481`), and validation (after `:986`):

```ts
// settings schema
desktopImageRef: z.string().optional(),              // OCI ref of docker/desktop.Dockerfile build
desktopStreamPort: z.number().int().default(6080),
streamResolutionWidth: z.number().int().default(1280),
streamResolutionHeight: z.number().int().default(800),
streamTokenSecret: z.string().optional(),            // HMAC secret for §5
streamTokenTtlSeconds: z.number().int().default(600),
// NOTE: no streamRotateBeforeMs — rotation is event-driven on box rollover
// (§4.3), NOT a periodic re-mint timer. The box stays warm on the provider
// idle-timeout (modalTimeoutSeconds), so there is no per-session keep-alive.
maxViewersPerSession: z.number().int().default(8),   // R6 fan-out cap lever
blaxelExposedPortPublic: z.boolean().default(false), // false → scoped token query
recordingEnabled: z.boolean().default(false),
// env mapping (~:472-481 block)
//   OPENGENI_DESKTOP_IMAGE_REF, OPENGENI_STREAM_PORT, OPENGENI_STREAM_RESOLUTION,
//   OPENGENI_STREAM_TOKEN_SECRET, OPENGENI_STREAM_TOKEN_TTL_S,
//   OPENGENI_MAX_VIEWERS_PER_SESSION, OPENGENI_RECORDING_ENABLED
// validation (~:985 block): if deploymentDesktopSupported(backend, desktopImageRef)
//   then streamTokenSecret is REQUIRED (else throw config error).
```

`exposedPorts` for the desktop backend must include `6080`. For Modal this is `parseExposedPorts(settings.dockerExposedPorts)` in `createSandboxClient` (`packages/runtime/src/index.ts:773`) — set `OPENGENI_DOCKER_EXPOSED_PORTS=6080` (or a dedicated `OPENGENI_STREAM_PORT` merged into the exposed set). For e2b/blaxel/daytona/runloop branches, pass `exposedPorts:[...,6080]`.

---

## 9. Fan-out load-test plan (R6 — the single biggest unvalidated risk)

No provider publishes a per-port concurrent-WebSocket cap. `x11vnc -shared` is itself unbounded; the **provider tunnel** is the unknown. Must be measured before the headline ships.

**Harness** (new `tools/stream-loadtest/`):
- A headless noVNC client driver (Node + `ws` + a minimal RFB handshake, or `puppeteer` pointing N tabs at `vnc.html?token=...&view_only=true`).
- **Test matrix:** per provider in `{modal, daytona, runloop, e2b, blaxel}` × viewer counts `{1, 5, 10, 25, 50, 100}` × resolution `{1280×800, 1920×1080}`.
- **Drive load:** a synthetic agent loop running `xdotool` + a moving window (worst-case full-frame churn at 20fps, the `-wait 50` ceiling) so every viewer receives continuous deltas.
- **Metrics per viewer:** WS connect success rate, time-to-first-frame, frame latency p50/p95/p99 (timestamp injected into a corner pixel block, OCR/sample on the client), abnormal-close rate, and the provider-side: tunnel error codes, box CPU (via `session.exec` `top`), x11vnc CPU, bandwidth.
- **Pass bar (v1 headline):** ≥ 25 concurrent viewers per session at 1280×800 with p95 frame latency < 400ms and zero provider-imposed disconnects on at least **Modal + one of {Daytona, Runloop}**. Below that, set `maxViewersPerSession` to the measured knee and surface a "stream at capacity" handshake refusal (§7.13).
- **Failure-mode probes:** kill the box mid-test (7.7/7.8 recovery), revoke a grant mid-stream (7.4), force a rotation mid-stream (7.6) — assert all viewers recover or tear down cleanly.

---

## 10. File-by-file change list

| File | Change | Anchor |
|---|---|---|
| `packages/contracts/src/index.ts` | Add `StreamTransport`, `SessionCapabilities` + sub-schemas, `StreamCapabilitiesResponse`, 4 new `SessionEventType` members + their payload schemas, `ClientConfig.desktopStream` | `:13`, `:1270`, `:1425` |
| `packages/sdk/src/types.ts` | Mirror the above (parity gate): `SESSION_EVENT_TYPES` += 4, new types | `:100` |
| `packages/sdk/src/index.ts` | Re-export new types | `:21` |
| `packages/react/src/timeline.ts` | `switch` cases for `stream.opened/closed/revoked` (notice rows) | `:163` |
| `packages/react/src/` **(new)** `useDesktopStream.ts` | Hook: handshake → noVNC connect → subscribe `/events/stream` for `stream.url.rotated`/`stream.revoked` → hot-swap; `DesktopStreamProps {sessionId, workspaceId, viewOnly, onError}` | new |
| `packages/react/src/` **(new)** `DesktopStream.tsx` | noVNC `RFB` wrapper component; props `{dataPlaneUrl, streamToken, viewOnly, onRotated}`; mounts `@novnc/novnc` `RFB` on a canvas | new |
| `packages/runtime/src/stream/capabilities.ts` **(new)** | `resolveSessionCapabilities`, `deploymentDesktopSupported`, `DESKTOP_CAPABLE` | new |
| `packages/runtime/src/sandbox/display-stack.ts` **(new)** | `ensureDisplayStack`, `buildDisplayStackScript`, `STREAM_PORT` — re-exported under `@opengeni/runtime/sandbox` so the API-direct handler imports it without the agent-loop graph | new |
| `packages/runtime/src/sandbox/stream-token.ts` **(new)** | `mintStreamToken`, `registerEdgeToken`, `revokeEdgeToken`, `buildStreamUrl`, `providerUrlTtl` — `@opengeni/runtime/sandbox` | new |
| `packages/runtime/src/sandbox/stream-control.ts` **(new)** | `openStream` (API-direct: resume-by-id + viewer-holder acquire + cold→warming CAS + `exposeStreamPort`), `rotateStreamForHolder`, `publishStreamRotated`, `OwnerFencedError`/`DisplayStackError`; epoch fence. **No `SandboxOwner` actor, no Temporal.** Re-exported under `@opengeni/runtime/sandbox`; called in-process by `apps/api` (and reusable by the global reaper Schedule for rotation) | new |
| `apps/api/src/dependencies.ts` | Add **one** field: a sandbox/Modal client built from settings (the enabling refactor — Modal token already parsed by `getSettings`); exposes `deps.streamControl` over it | (control-plane seam) |
| `apps/api/src/routes/sessions.ts` | `GET /sessions/:sessionId/stream-capabilities` (`requireAccessGrant ... "sessions:read"`) → fast-path, or **API-direct** `deps.streamControl.openStream(...)` (resume-by-id in-process; NO `signalWithStart`, NO workflow, NO worker RPC) | `:214` |
| `packages/runtime/src/sandbox/index.ts` (barrel) | Re-export `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` + the stream module (extracted so `apps/api` imports them WITHOUT the `@openai/agents` agent-loop graph) under `@opengeni/runtime/sandbox` | new |
| `apps/worker/src/sandbox/reaper.ts` (crosscut module) | The **one global** Temporal **Schedule** reaper also drives rollover-rotation: on a `lease_epoch` advance for a box with live viewer holders, call `rotateStreamForHolder` per holder (the only Temporal touch-point for rotation) | (crosscut) |
| `apps/api/src/.../config route` | Populate `ClientConfig.desktopStream.supported` via `deploymentDesktopSupported` | `ClientConfig` build site |
| `packages/config/src/index.ts` | Desktop/stream settings fields + env mappings + `streamTokenSecret` required-when-desktop validation | `:244`, `:481`, `:986` |
| `docker/desktop.Dockerfile` **(new)** | XFCE+Xvfb+x11vnc+websockify+noVNC+ffmpeg image; `exposedPorts` includes 6080 | new |
| `packages/runtime/src/index.ts` | Ensure 6080 is in `exposedPorts` for desktop backends in `createSandboxClient` branches | `:763-795` |
| `tools/stream-loadtest/` **(new)** | R6 fan-out harness (§9) | new |

### Out of scope (owned by sibling modules, consumed here)
- `sandbox_leases` / `sandbox_lease_holders` DDL and the `acquireLease`/`releaseLease`/`reapStaleLeaseHolders` lease module (`packages/db/src/schema.ts:360` neighborhood) — this module calls `acquireLease(kind:"viewer")` and `reapStaleLeaseHolders` but does not define them.
- The ownership-inversion refactor of `runAgentStream` (`packages/runtime/src/index.ts:968,1044`) and the **enabling extraction** of the thin `@opengeni/runtime/sandbox` module (`createSandboxClient` + envelope (de)serializers, no agent-loop import) — owned by the owner module (`modules/02-owner.md`); this module consumes it to run `exposeStreamPort` API-direct, and adds the desktop stream functions to it.
- The **one global reaper Schedule** (crosscut module) — consumed here as the backstop driver for rollover-rotation (7.7/7.8) and viewer-holder TTL reaping. There is **no `ownerHeartbeat`** (deleted per master spine §B.2): a viewer-only box stays warm on the provider idle-timeout.

---

## 11. Load-bearing facts this spec depends on (verified against source)

- `ExposedPortEndpoint = {host,port,tls?,query?,protocol?,url?,[k]}` and `urlForExposedPort(endpoint,'http'|'ws')` — `@openai/agents-core@0.11.6/dist/sandbox/session.d.ts:9,100`.
- `SandboxRunConfig` accepts `session?` and `sessionState?` (the ownership-inversion target) — `client.d.ts:60-69`.
- Per-provider `resolveExposedPort` verified real for modal (`modal/sandbox.js:261-303`, `tls:true` raw tunnel), daytona (`daytona/sandbox.js:256-278`, signed-preview + TTL stamp), runloop (`runloop/sandbox.js:638-700`, `enableTunnel`+`getTunnelUrl`), e2b (`e2b/sandbox.js:151-178`, `getHost`), blaxel (`blaxel/sandbox.js:155-195`, preview + `createBlaxelPreviewTokenQuery` when `exposedPortPublic:false`); **hard stub** for cloudflare (`cloudflare/sandbox.js:264-274`).
- SSE gap-fill/replay contract that `stream.url.rotated` rides — `apps/api/src/http/sse.ts:5,20`; producer `appendAndPublishEvents` — `packages/events/src/index.ts:30`; `formatSse` emits `id:`=sequence — `:50`.
- Handshake is **API-direct**, NOT a Temporal signal: the API resumes the box by id in-process via the shared `@opengeni/runtime/sandbox` module (mirrors the Channel-A A2 seam, `modules/08-channel-a.md` §5.1), the same shape as the API's existing outbound HTTPS (Stripe/OpenAI/GitHub) — `apps/api/src/dependencies.ts`. `ModalSandboxClient.resume()` is per-call/no-pool; `packages/runtime` has no `@temporalio` dep. (The existing `signalInterrupt`/`signalWithStart`+`ALLOW_DUPLICATE` pattern at `apps/api/src/index.ts:61-78` is retained ONLY for the agent turn, not for this handshake.)
- Auth boundary `requireAccessGrant(c,deps,workspaceId,"sessions:read")` — `apps/api/src/access/index.ts:31`; `workspace:admin` super-permission — `:48`.
- `SandboxBackend` enum to read (no enum change needed for *this* module; provider registration is the sibling wiring module) — `packages/contracts/src/index.ts:13`; `SessionEventType` — `:1270`; `ClientConfig` — `:1425`.
- Capability decision basis (PTY/desktop matrix, only cloudflare `resolveExposedPort` throws) — GROUND:sdk-clients, confirmed in source above.

This is the complete, implementation-grade Channel B spec: contracts, capability resolver, in-box stack + Dockerfile, the **API-direct** `exposeStreamPort` + rollover-rotation, per-provider URL/token assembly, websockify edge security, the API-direct handshake route, the exhaustive failure matrix, config, and the R6 load-test plan — with every file-by-file change anchored to real lines.

---

## Adversarial Review

> **RESOLUTION NOTE (API-direct control-plane ruling).** This review was written against the **pre-correction** transport (handshake via `signalWithStart`/`openStreamRequest` → session workflow → `exposeStreamPort` activity on a per-session `sandbox-owner::<sessionId>` queue). **That transport is superseded** — see the SUPERSEDED note at the top of this module and `00-master-spine.md` §B.3/OD-1. Under the **CORRECTED MODEL** the handshake is served **API-direct** (the API process resumes the box by id in-process and calls `exposeStreamPort` synchronously; no workflow, no signal, no per-session queue, no result-poll). This **dissolves** the first BLOCKING finding below ("handshake mechanism cannot return a result" — there is no async Temporal round-trip to return from; the result is just the HTTP response) and removes the "claim-loop blocks behind a multi-day turn" concern entirely (the viewer path no longer touches the workflow). The review's **other** findings — `grant.id` doesn't exist (now `grant.subjectId`, fixed in §6.1), `endpoint.expiresAt` is dead, `buildStreamUrl` query-mangling, the HMAC-never-verified gap, the `flock`/`yieldTimeMs`/`exitCode==null` race, the `registerEdgeToken` self-destruct subshell, the Modal 6080 exposed-port wiring, and the fictional `SessionEvent.payload` discriminated union — are **code-correctness issues orthogonal to the routing model and still stand.** Read every "activity / signal / workflow / owner queue" framing below as historical context for the pre-correction transport.

## Channel B Spec — Adversarial Review Findings

I verified every load-bearing anchor against source. The spec is architecturally sound on the big rulings (split-plane, edge-token auth, epoch fencing, concurrent double-spawn guard) but contains several **blocking correctness bugs** and multiple **API/type mismatches that will not compile**. Findings below, ordered by severity, each with a concrete fix. (The "broken control-plane handshake mechanism" finding is dissolved by the API-direct ruling — see the RESOLUTION NOTE above.)

---

### ~~BLOCKING~~ — DISSOLVED by the API-direct ruling — handshake mechanism cannot return a result (§6.2)

> **Superseded.** This finding applied to the pre-correction `signalWithStart`/workflow-signal transport. The CORRECTED MODEL serves the handshake **API-direct** in-process, so there is no async Temporal round-trip whose result must be polled — `exposeStreamPort` is a synchronous in-process call and the result is the HTTP response. The "claim-loop blocks behind a multi-day turn" sub-finding is also moot (the viewer path no longer enters the workflow). Retained verbatim below for provenance; its recommended "Temporal Update / dedicated short-lived workflow" fix is **not** adopted — API-direct is simpler and is the ruling.

**Finding (correctness/architecture):** The spec claims `openStreamRequest` does `signalWithStart(...)` and then `return await pollStreamResult(handle, viewerHolderId, 30_000)`. But `temporal.workflow.signalWithStart` returns a `WorkflowHandle` **immediately** — it does not block on or carry the signal handler's result. The verified pattern at `apps/api/src/index.ts:50-78` (`wakeSessionWorkflow`, `signalInterrupt`) is strictly fire-and-forget; none of them read a result back. The spec then hand-waves "poll it via query (or a short-lived update handle)" — these are two very different mechanisms and neither is specified.

More fundamentally: a **Temporal signal handler cannot run an activity and have the route synchronously await its result.** Signal handlers (`setHandler` at `session.ts:69`) only mutate workflow state. The spec's §6.3 puts `await acquireLease(...)` and `await proxyOwnerActivities(...).exposeStreamPort(...)` inside a queue drained "in the claim loop" — but the claim loop blocks for up to 5s in `condition(...)` (`session.ts:156`) and is busy inside `runTurn` for potentially **days**. A viewer handshake would block until the current multi-day turn yields. The result is never delivered to the waiting HTTP route within the 30s poll.

**Fix:** Use **Temporal Update** (`workflowClient.executeUpdate` / `startUpdate`), not signal-with-start, for the request/response handshake. An Update handler *can* be async, *can* schedule activities via `await`, and *returns a value to the caller*. But Update handlers also don't run concurrently with a blocked main loop unless you explicitly architect for it — so the cleaner fix is: **do not route `exposeStreamPort` through the session workflow's main loop at all.** Instead, have the API schedule the `exposeStreamPort` activity **directly** on the `sandbox-owner::<sessionId>` task queue via a dedicated short-lived workflow (or `client.startUpdate` against a long-lived owner-liveness workflow), with the lease acquisition done inside that activity. The viewer path must be independent of the turn path's blocking loop — the grounding (§B "CRITICAL CORRECTION") explicitly says viewer `exposeStreamPort` runs **concurrently** with `runAgentSegment`, which the spec's "drain in the claim loop" design **violates**.

---

### BLOCKING — `grant.id` / `viewerGrantId` does not exist (§6.1)

**Finding (won't compile):** The route does `viewerGrantId: grant.id`. The verified `AccessGrant` schema (`packages/contracts/src/index.ts:137-144`) has fields `{workspaceId, accountId, subjectId, subjectLabel?, permissions, metadata?}` — **there is no `id`**. `grant.accountId` is valid (confirmed in use at `apps/api/src/routes/capabilities.ts:33`), but `grant.id` is `undefined`.

**Fix:** The lease/holder grant reference must be derived from something real — use `grant.subjectId` (the holder's principal) or generate the `viewerGrantId` server-side. The spec needs to define what `viewerGrantId` actually identifies; right now it references a non-existent field.

---

### BLOCKING — `SessionEvent.payload` is `z.unknown()`, not a discriminated union (§1.2)

**Finding (correctness):** The spec says new payloads should "mirror the `SessionEvent.payload` discriminated-by-`type` convention already used." **No such convention exists.** Verified at `packages/contracts/src/index.ts:1306-1316`: `payload: z.unknown().default({})`. Payloads are not validated against the event type at the contract level at all; `ClientSessionEvent` (`:1347`) is a discriminated union but that is the *inbound* client-POST type, a different schema. The four new `StreamUrlRotatedPayload`/`StreamOpenedPayload`/etc. schemas are fine to *define*, but the claim that they plug into an existing discriminated `SessionEvent.payload` is false, and there is no runtime gate that will enforce them.

**Fix:** Drop the "discriminated-by-type" framing. Define the payload schemas as standalone exports and parse them explicitly at the producer (`publishStreamRotated`) and consumer (the React hook). State plainly that `SessionEvent.payload` stays `z.unknown()` and the new schemas are applied manually.

---

### CORRECTNESS — `providerUrlTtl` reads a field that never exists (§4.2)

**Finding (bug):** `providerUrlTtl` returns `typeof endpoint.expiresAt === "number" ? endpoint.expiresAt : undefined`. Verified `ExposedPortEndpoint` (`session.d.ts:9-17`) = `{host, port, tls?, query?, protocol?, url?, [key: string]: unknown}` — there is **no `expiresAt`**. Modal's `resolveExposedPort` (`modal/sandbox.js:296-301`) returns exactly `{host, port, tls:true, query:''}`. Daytona's TTL is stamped into the signed URL itself, not surfaced as a numeric `expiresAt` on the endpoint. So `providerUrlTtl` **always returns `undefined`**, and `clampTtl(input.ttlSeconds, providerUrlTtl(endpoint), this.leaseExpiry())` silently loses the provider-URL-expiry clamp entirely. For Daytona/Blaxel this means OpenGeni can mint a `streamToken` TTL *longer* than the provider's signed-URL TTL → the URL dies before the token, breaking the rotation-overlap invariant in §4.3.

**Fix:** `expiresAt` is not available from the endpoint. Read the configured TTL from settings per provider (`settings.daytonaExposedPortUrlTtlS`, `settings.blaxelExposedPortUrlTtlS`) — these are the *inputs* OpenGeni passes to the provider, so OpenGeni already knows them. The spec even half-admits this ("parseExposedPortEndpoint does not surface TTL, so we read settings...") but then writes code that reads `endpoint.expiresAt` anyway. Make the code match the prose.

---

### CORRECTNESS — `buildStreamUrl` double-appends / mangles provider query strings (§4.2)

**Finding (bug):** `buildStreamUrl` does `urlForExposedPort(endpoint, "ws")` then `new URL("/websockify", base)`. Verified `urlForExposedPort` (`session.js:36-57`): when `endpoint.query` is set (Blaxel `bl_preview_token`, Daytona signed token), it returns `wss://host:port/?<query>`. Two bugs:
1. `new URL("/websockify", "wss://host/?token=abc")` produces `wss://host/websockify` — **the query string from `urlForExposedPort` is dropped** by the path-replacement. The spec then tries to re-add it by iterating `endpoint.query`, so the provider token survives by luck — but only because the code reads `endpoint.query` directly, making the `urlForExposedPort` call pointless and confusing.
2. The Blaxel table row writes the URL as `${url.replace('https','wss')}/websockify?${endpoint.query}&token=...`. A naive `.replace('https','wss')` also rewrites `https` anywhere it appears in the query (e.g. a redirect param), and appends `/websockify` after a URL that may already have `/?query` → produces `wss://host/?bl_preview_token=x/websockify?...` which is malformed. The per-provider table and the `buildStreamUrl` helper **disagree with each other** on assembly.

**Fix:** Use one assembly path. Build from endpoint fields directly: `const u = new URL(urlForExposedPort(endpoint, "ws"));` then `u.pathname = "/websockify";` (preserves existing query), then `u.searchParams.set("token", token)`. Delete the per-provider `.replace('https','wss')` string-munging rows — they're redundant with `urlForExposedPort` (which already does tls-aware scheme selection) and are buggy. Verify against an endpoint whose host is IPv6 (the helper brackets it at `session.js:50`; manual string-replace would not).

---

### CORRECTNESS — `flock -w 25` inside a 30s-yield exec is a deadlock/timeout race (§3)

**Finding (race condition):** The script does `flock -w 25 9` and the exec is called with `yieldTimeMs: 30_000`. If two `exposeStreamPort` calls race (turn + viewer, the exact scenario §6.3 calls out), the second blocks up to 25s on the lock, then runs the full Xvfb-readiness poll (`for i in $(seq 1 50); ... sleep 0.1` = up to 5s) plus xfce `sleep 1` → can exceed the 30s yield. More importantly, `yieldTimeMs` is **not a kill timeout** — it's how long the SDK waits before yielding the stream back; the bash process keeps running detached. But the spec treats `res.exitCode === 0` as "ready" — if the exec yields at 30s before `echo "display-stack-ready"`, `exitCode` is `undefined`/null, and `ensureDisplayStack` returns `{ready: false}` → spurious `DisplayStackError` → §7.1 degrades a perfectly-healthy desktop to `transport:null`.

**Fix:** Either (a) make the flock wait shorter than the readiness budget and the yield comfortably longer than the worst-case script runtime, with explicit accounting, or (b) decouple: the lock-holder fully launches the chain, the lock-waiter just polls `xdpyinfo`/port-6080 readiness and returns without re-running. Also handle `exitCode == null` (yielded, not exited) distinctly from `exitCode != 0` (failed) — they are verified-different per `SandboxExecResult.exitCode?: number | null` (`session.d.ts:54`).

---

### CORRECTNESS — websockify `--token-plugin TokenFile` token-file format and re-read semantics are wrong (§5)

**Finding (bug / unverified-as-stated):** The spec writes one file per token at `/tmp/novnc-tokens/<token>` containing `<token>: localhost:5900`, and asserts websockify "re-reads the source dir per connection" so deleting the file revokes live. Two problems:
1. The websockify TokenFile plugin reads files where **each line** is `token: host:port`; the filename is irrelevant and a directory of such files is concatenated. Using the token *as the filename* AND putting the same opaque token (which is HMAC base64url, possibly containing `-`/`_`, and potentially very long) as a filename is fragile — base64url is filesystem-safe, but the token can exceed `NAME_MAX` (255 bytes) for a long claims blob, and the spec's `tokenFilename(token)` is never defined (does it hash? truncate? — unspecified, and if it hashes, `revokeEdgeToken` must hash identically; if it truncates, collisions revoke the wrong viewer).
2. "re-reads per connection" is asserted as "verified behavior" but is **version-dependent**; some websockify versions cache the token map at startup. Pinning `websockify v0.12.0` (§3.1) without verifying its TokenFile re-read behavior is a load-bearing assumption presented as fact. If it caches, live revoke-by-delete (§7.4) silently does nothing.

**Fix:** Define `tokenFilename` explicitly (recommend: a SHA-256 hex of the token, so it's fixed-length, collision-safe, and identically reconstructable in revoke). State the file *content* line format correctly. **Verify** (don't assert) the v0.12.0 TokenFile re-read-per-connection behavior, or fall back to the §7.4 belt-and-suspenders `pkill`/`x11vnc -disconnect` as the *primary* revoke, treating file-delete as best-effort.

---

### CORRECTNESS — `registerEdgeToken` self-destruct `( sleep N; rm )` dies with the exec session (§5)

**Finding (bug):** `registerEdgeToken` backgrounds `( sleep ${ttlSeconds}; rm -f ... ) &` inside a `session.exec`. Whether this survives depends on the provider's exec implementation — for many, the backgrounded subshell is in the exec's process group and is reaped when the exec call returns. The spec elsewhere (the display-stack script) uses `nohup` + redirection precisely to detach long-lived processes, but here it does **not** — so the TTL self-delete likely dies immediately, meaning stale tokens are **never** cleaned up and accumulate, undermining the "stale token cannot reconnect" guarantee (§5).

**Fix:** Use the same `nohup ... >/dev/null 2>&1 &` detachment pattern (or, better, an `at`-job / a single reaper sweep the owner runs on its keep-alive timer that deletes expired token files by reconstructing filenames from active holders). Don't rely on a backgrounded subshell surviving exec teardown.

---

### GAP — `clampTtl`, `leaseExpiry`, `mintStreamToken` body, `OwnerFencedError`, `DisplayStackError`, `getSessionOrThrow` are all referenced but unspecified

> **Partially dissolved by the API-direct ruling.** `proxyOwnerActivities`, `pollStreamResult`, and `workflowIdForSession` no longer exist (the handshake is API-direct; there is no workflow client / activity proxy / result-poll — §6). The **still-open** gaps below are code-correctness, orthogonal to routing, and stand: `clampTtl`/`leaseExpiry`, the `mintStreamToken` body + the HMAC-never-verified contradiction, and `getSessionOrThrow`/`sharedLiveAcknowledged`.

**Finding (gaps):** These are all invoked but never defined:
- `clampTtl(ttl, providerTtl, leaseExpiry)` — return type and clamp semantics unspecified (and `leaseExpiry()` returns what — ms? a Date?).
- `mintStreamToken` body is literally `{ /* HMAC, exp */ }` — the exact wire format ("base64url(claims).base64url(hmac)") is described in a comment but not implemented, and there is **no `verifyStreamToken`** anywhere. The spec says "the file's existence IS the validation" — but then the HMAC is decorative: nothing ever checks the signature, so the `streamTokenSecret` provides **zero security** (any string written to the token-file dir authorizes). If the HMAC is truly unused, drop it and say so; if it's meant to gate, specify where verification happens (it can't be the websockify edge — TokenFile doesn't do HMAC).
- `getSessionOrThrow` and `session.sandboxBackend` / `session.sharedLiveAcknowledged` — `sharedLiveAcknowledged` is not a field on the verified `Session` schema; it's invented. Needs a DDL/contract addition (out of scope per the spec, but then where does it come from?).

**Fix:** Specify each. Critically, resolve the **HMAC-is-decorative** contradiction: either implement `verifyStreamToken` at a real choke point or remove the HMAC and the `streamTokenSecret` config requirement (§8 makes it `REQUIRED` when desktop is supported — a required secret that does nothing is a footgun).

---

### CORRECTNESS — Modal `exposedPorts` wiring is broken for 6080 (§3.1, §8)

**Finding (bug):** Verified `createSandboxClient` (`packages/runtime/src/index.ts:771-774`): the Modal branch sets `exposedPorts: parseExposedPorts(settings.dockerExposedPorts)` — it reads **`dockerExposedPorts`** even for Modal (a latent existing quirk). The spec's §8 says "set `OPENGENI_DOCKER_EXPOSED_PORTS=6080`" but the new `desktopStreamPort` (default 6080) config field it adds is **never threaded into `createSandboxClient`** — so adding `desktopStreamPort` does nothing; 6080 only reaches Modal if the operator also manually stuffs it into `dockerExposedPorts`. And `assertConfiguredExposedPort` (`modal/sandbox.js:257`) will throw `SandboxProviderError` at `resolveExposedPort(6080)` time if 6080 isn't in `configuredExposedPorts` (§7.15 acknowledges this but the wiring to prevent it is absent).

**Fix:** Thread `desktopStreamPort` into the exposed-ports set in `createSandboxClient` for every desktop-capable backend (merge it into the parsed set), not rely on the operator double-configuring `dockerExposedPorts`. Add the boot validation §7.15 promises (`6080 ∈ exposedPorts` when desktop-capable + image configured) as actual config-validation code, mirroring the `:985` both-or-neither pattern.

---

### GAP/CONTRADICTION — `restartDisplayStack` `pkill` will kill the agent's own X session and break "zero projection"

**Finding (correctness):** §3 "Resolution change" says `restartDisplayStack` `pkill`s Xvfb/x11vnc/xfce. But the agent's `computerTool` is drawing into the **same** `:0` (the whole "zero projection" thesis). Killing Xvfb mid-turn destroys the agent's desktop state (open windows, running browser) — not just the viewer transport. The spec marks this "not v1-required," but §7.7 (Modal 24h rollover) *does* require re-running `ensureDisplayStack` with `displayReady=false`, and on a fresh box that's fine — but if a resolution change is ever wired, it silently corrupts a live agent session.

**Fix:** Document that any Xvfb restart is destructive to agent desktop state and must be gated to box-create/rollover only (where state is already lost), never mid-session. Acceptable as-is for v1 since it's deferred, but the constraint must be explicit so a future implementer doesn't wire `stream.resize` to a live `pkill`.

---

### ~~MINOR~~ — DISSOLVED by the API-direct ruling — `keepAliveTimer` uses `setInterval` with an async callback (§4.3)

> **Superseded.** The corrected §4.3 **deletes the per-owner `setInterval` keep-alive timer entirely** (there is no `ownerHeartbeat`; the box stays warm on the provider idle-timeout). Rotation is event-driven on box rollover, produced by the next API-direct op or the one global reaper Schedule — so the re-entrancy, worker-restart, and timer-vs-`ownerHeartbeat` ambiguities below no longer exist. Retained verbatim for provenance.

**Finding (bug):** `setInterval(async () => { ... await ... })` — overlapping ticks if a rotation (which does a full `exposeStreamPort` round-trip including a `session.exec`) takes longer than `keepAliveIntervalMs` (~60s). Two `exposeStreamPort` calls can then overlap, and the in-box `flock` (§3) will serialize them, potentially blocking the second past its yield (compounds the §3 finding). Also, this timer lives in the worker process; on worker restart it's gone — which §7.9 correctly identifies as the liveness hole and pushes onto `ownerHeartbeat`, but then §4.3 *also* puts rotation on this `setInterval`, so after a worker restart **rotation stops** until re-election rebuilds the owner. The relationship between the `setInterval` keep-alive and the Temporal `ownerHeartbeat` activity is left ambiguous.

**Fix:** Guard against re-entrancy (a `rotating` flag, or `setTimeout`-reschedule-after-completion instead of `setInterval`). Clarify that rotation must be driven by the durable `ownerHeartbeat` activity (which survives worker restart via Temporal), not an in-memory `setInterval`, or the §7.9 liveness guarantee doesn't cover rotation.

---

### MINOR — timeline `switch` already has a `default:` (§1.4)

**Finding (minor correctness):** §1.4 says add `switch` cases at `timeline.ts:163`. Verified there's a `default:` at `:417` and `NoticeItem` (`:105`). New cases are fine, but the spec says `stream.url.rotated` is "consumed by the hook, NOT rendered" — since `buildTimeline` folds *all* events and has a `default` that presumably drops unknowns, `stream.url.rotated` will hit `default` harmlessly. Fine, but confirm `default` is a no-op drop (not a thrown "unhandled"), and confirm the SDK open-union (`SessionEventType = KnownSessionEventType | (string & {})`, `types.ts:141`) means old SDKs tolerate the 4 new types — which it does, so this part is correct.

**Fix:** None required; just verify `default` drops rather than throws.

---

### MINOR — SSE framing safety of `streamToken` in payloads (§1.2)

**Finding (low-risk correctness):** `formatSse` (`events/src/index.ts:50-58`) emits `data: ${JSON.stringify(event)}`. `JSON.stringify` escapes newlines, so a base64url token is SSE-safe. ✅ No bug — but worth noting the `StreamUrlRotatedPayload` carries the live `streamToken` over Channel A SSE, which is **auth-per-read** (`sessions:read`). That means anyone with `sessions:read` receives the pixel-plane token via the rotation event. Given §5 says the pixel plane is un-redacted and `sharedLive` must be acknowledged, broadcasting the token to all `sessions:read` subscribers may exceed the intended single-viewer scope (the token is minted per `viewerHolderId`, but the SSE stream is not per-holder).

**Fix:** Either scope rotation events to the specific viewer (not feasible on the shared session SSE stream), or mint a per-holder token and accept that `sessions:read` ⇒ can-view-pixels (which contradicts the §5 `sharedLive:false` single-viewer guarantee). This is a real tension between "rotation rides the shared Channel-A SSE" and "single-viewer-scoped token" — the spec should resolve it explicitly.

---

### Summary of must-fix before implementation
1. ~~**Handshake cannot return a result via `signalWithStart`** and routing `exposeStreamPort` through the blocking claim loop violates "viewer runs concurrently with turn"~~ — **DISSOLVED by the API-direct ruling.** The handshake is served API-direct in-process (§6); there is no `signalWithStart`, no claim-loop routing, and the result is the HTTP response. `grant.id` is replaced by `grant.subjectId` (§6.1). The remaining items below are code-correctness bugs orthogonal to the routing model and **still stand**.
2. **`grant.id` doesn't exist** — won't compile; corrected to `grant.subjectId` in §6.1 (§6.1).
3. **`endpoint.expiresAt` doesn't exist** — TTL clamp is dead code; read from settings (§4.2).
4. **`buildStreamUrl` drops/mangles provider query** and contradicts the per-provider table — single assembly path (§4.2).
5. **HMAC token is never verified** — `streamTokenSecret` is security theater unless a verify choke point is specified (§5).
6. **`flock`/`yieldTimeMs`/`exitCode==null` interplay** spuriously degrades healthy desktops (§3).
7. **`registerEdgeToken` self-destruct subshell** likely dies with the exec — stale tokens never cleaned (§5).
8. **Modal 6080 exposed-port wiring** is not actually threaded from the new `desktopStreamPort` config (§3.1/§8).
9. **`SessionEvent.payload` discriminated-union convention is fictional** — it's `z.unknown()` (§1.2).

The §2 capability resolver, §7 failure matrix (logic), §0/§4.3 invariant chain, and the per-provider desktop/headless verdicts are accurate against source and don't need changes. The control-plane transport is **API-direct** per the corrected model (§6); the old `signalWithStart`/workflow-signal/per-session-queue routing is superseded and retained only for provenance.
