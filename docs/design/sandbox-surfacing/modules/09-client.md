# Module: Client surface (sdk + react + web)  (client)

## Specification

# IMPLEMENTATION SPEC — Module: Client Surface (contracts → sdk → react → web)

The capability-gated client for the sandbox-surfacing vision. This is the **last mile**: how a browser (or any 3rd-party SDK consumer) negotiates what this session+backend+OS can surface, then connects to **terminal**, **file browser**, **diff view**, and **desktop**. It is split-plane aware: structured services (terminal-as-events, files, git) ride **Channel A** (the existing SSE event spine, verbatim); desktop pixels ride **Channel B** (direct-to-provider noVNC against a scoped tunnel URL minted by the control plane).

This spec designs strictly *on top of* the settled architecture (singleton lease, **stateless per-turn resume-by-id** — no in-worker `SandboxOwner` actor, per the stateless-workers ruling in `00-master-spine.md` §B.2 / `modules/02-owner.md`; ownership inversion, `resolveExposedPort`-minted scoped URLs). It does not re-litigate any of it. The client surface is purely contract + components and is **unaffected** by that ruling (viewers connect directly to `data_plane_url`; nothing client-side ever addressed an owner). Everything below follows the exact existing propagation pattern: **declare once in `@opengeni/contracts` → mirror in `@opengeni/sdk` (parity-gated) → fold into `@opengeni/react` (timeline/hook/component) → consume in web**.

---

## 0. Scope boundary and the one cross-module dependency

This module owns the **client-facing contract and components**. It does **not** own: the lease DDL, the stateless resume-by-id path (no `SandboxOwner` actor; file `apps/worker/src/sandbox-resume.ts`), the worker workflow wiring, or the in-box desktop Dockerfile (those are the Backend/Worker and Desktop-Image modules). It **consumes** exactly two things those modules must provide:

1. A **capabilities document** per session, served by a new control-plane route (`GET …/stream-capabilities`). This module specifies the document's exact Zod shape and the route signature; the worker module fills `dataPlaneUrl`/`streamToken` by calling `session.resolveExposedPort(6080)` inside the owner activity.
2. Two new **Channel-A event types** (`stream.url.rotated`, `stream.viewer.heartbeat.ack`) that the worker emits and this module renders/consumes.

Everything else here is self-contained in the four client packages.

---

## 1. CONTRACTS (`packages/contracts/src/index.ts`) — the source of truth

### 1.1 Extend `SandboxBackend` (line 13)

The 7 first-class providers must be selectable. This is the one enum the parity test (`packages/sdk/test/contract-parity.test.ts:6`) pins, so it must be mirrored verbatim in the SDK.

```ts
// packages/contracts/src/index.ts:13  — REPLACE
export const SandboxBackend = z.enum([
  "docker", "modal", "local", "none",        // existing
  "daytona", "runloop", "e2b", "blaxel",     // desktop-capable additions
  "cloudflare", "vercel",                     // headless-only additions
]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;
```

(DB needs no migration — `sandbox_backend text` at `packages/db/src/schema.ts:117,260`. The Backend module owns the `createSandboxClient` branches; this enum change is shared but the client surface is the consumer that needs it for the provider-selection UX in §6.)

### 1.2 New `SandboxOperatingSystem` enum (net-new, after line 14)

OS is eventually selectable (Linux now; macOS/Windows if any provider offers it). Declare the axis now so the capability doc and create-request carry it from day one, even though only `linux` is wired.

```ts
export const SandboxOperatingSystem = z.enum(["linux", "macos", "windows"]);
export type SandboxOperatingSystem = z.infer<typeof SandboxOperatingSystem>;
```

### 1.3 The capability document — `SessionCapabilities` (net-new, place near `ClientConfig` ~line 1425)

This is the negotiation handshake's response body. It is the **single authority** on what a client may render for a given session. Degradation is **always a value here, never silent** (settled ruling H): an unsupported surface is present with `available:false`/`transport:null` + a `reason`, not omitted.

```ts
// ── Per-surface capability shapes ───────────────────────────────────────────

// Why a surface is unavailable — drives the client's fallback copy.
export const CapabilityUnavailableReason = z.enum([
  "backend_unsupported",   // provider can't do it at all (e.g. cloudflare desktop)
  "os_unsupported",        // this OS can't do it (e.g. PTY on a future windows box)
  "not_provisioned",       // box has no display stack / not yet warmed
  "disabled_by_policy",    // operator turned it off (e.g. read-only deployment)
  "lease_cold",            // no live sandbox right now (none-backend / between turns w/ no viewer)
  "tier_headless",         // deployment is on a headless-only tier
]);
export type CapabilityUnavailableReason = z.infer<typeof CapabilityUnavailableReason>;

// FILE BROWSER (Pierre tree fed by the FileSystem service over Channel A).
export const FileSystemCapability = z.object({
  available: z.boolean(),
  readOnly: z.boolean(),                 // v1 desktop is read-only; files may still be RW
  root: z.string(),                      // workspace root: "/workspace" | "/home/user" | …
  // Whether the Pierre tree should lazy-expand (listDir per node) vs. expect a
  // full snapshot. Backends without listDir fan-out fall back to "snapshot".
  treeMode: z.enum(["lazy", "snapshot"]).default("lazy"),
  reason: CapabilityUnavailableReason.nullable().default(null),
});
export type FileSystemCapability = z.infer<typeof FileSystemCapability>;

// TERMINAL. v1 transport is "sse-events" (terminal-as-events on Channel A);
// "pty-ws" is the later interactive upgrade (only where supportsPty()===true).
export const TerminalCapability = z.object({
  transport: z.enum(["sse-events", "pty-ws"]).nullable(),
  // Echoes the provider's supportsPty() so the client can show a future
  // "interactive terminal" affordance even while transport is "sse-events".
  ptyCapable: z.boolean().default(false),
  // For "pty-ws" only: a Channel-B-style scoped socket (NOT minted in v1).
  url: z.string().url().nullable().default(null),
  token: z.string().nullable().default(null),
  reason: CapabilityUnavailableReason.nullable().default(null),
});
export type TerminalCapability = z.infer<typeof TerminalCapability>;

// DIFF / GIT (Pierre diff fed by the Git service over Channel A).
export const GitCapability = z.object({
  available: z.boolean(),
  // Whether a repo resource is actually mounted (diff is empty-but-available
  // when true with no changes; unavailable when no repo at all).
  repoMounted: z.boolean().default(false),
  reason: CapabilityUnavailableReason.nullable().default(null),
});
export type GitCapability = z.infer<typeof GitCapability>;

// DESKTOP (noVNC → Channel-B scoped URL). The headline surface.
export const DesktopStreamCapability = z.object({
  transport: z.enum(["vnc-ws", "webrtc"]).nullable(),  // v1 = "vnc-ws"; webrtc = v3
  // READ-ONLY in v1 (ruling H: a raw-pty writer bypasses approval/interrupt).
  // "interactive" is the acknowledged-opt-in future mode.
  mode: z.enum(["read-only", "interactive"]).default("read-only"),
  // The direct-to-provider scoped URL (from session.resolveExposedPort(6080)).
  // Null when transport is null. Short-TTL; rotated via stream.url.rotated.
  url: z.string().url().nullable().default(null),
  token: z.string().nullable().default(null),     // scoped data-plane token
  expiresAt: z.string().nullable().default(null), // ISO; client must re-negotiate before this
  resolution: z.tuple([z.number().int().positive(), z.number().int().positive()])
    .default([1024, 768]),
  // The pixel plane is UN-REDACTED (can show live cloud creds). Shared-live is
  // OPT-IN/acknowledged (ruling H), surfaced so the client gates behind consent.
  unredacted: z.literal(true).default(true),
  reason: CapabilityUnavailableReason.nullable().default(null),
});
export type DesktopStreamCapability = z.infer<typeof DesktopStreamCapability>;

// RECORDING (ffmpeg x11grab → object storage). Read-only metadata in v1.
export const RecordingCapability = z.object({
  available: z.boolean(),
  mode: z.enum(["on-demand", "always", "off"]).default("off"),
  reason: CapabilityUnavailableReason.nullable().default(null),
});
export type RecordingCapability = z.infer<typeof RecordingCapability>;

// ── The negotiated document ─────────────────────────────────────────────────
export const SessionCapabilities = z.object({
  sessionId: z.string().uuid(),
  backend: SandboxBackend,
  operatingSystem: SandboxOperatingSystem,
  // The lease liveness at negotiation time. "warm" => surfaces with a live
  // box are usable now; "cold"/"warming" => client should retry/poll.
  liveness: z.enum(["cold", "warming", "warm", "draining"]),
  // Monotonic fence; the client echoes it on viewer heartbeats so a superseded
  // owner's URL can be rejected. Mirrors the lease_epoch (settled).
  leaseEpoch: z.number().int().nonnegative(),
  fileSystem: FileSystemCapability,
  terminal: TerminalCapability,
  git: GitCapability,
  desktop: DesktopStreamCapability,
  recording: RecordingCapability,
  // Channel-A viewer-liveness: the client POSTs a heartbeat at this cadence so
  // the reaper (settled ruling f) can drop a closed-laptop viewer within ~90s.
  viewerHeartbeatIntervalMs: z.number().int().positive().default(30_000),
  negotiatedAt: z.string(), // ISO
});
export type SessionCapabilities = z.infer<typeof SessionCapabilities>;
```

### 1.4 The negotiation request — `NegotiateStreamRequest` (net-new)

A viewer attaching is a **write** (it acquires a viewer lease holder, ruling: refcounted liveness). It POSTs intent so the control plane can `signalWithStart` the owner and mint the URL.

```ts
export const NegotiateStreamRequest = z.object({
  // Which surfaces the client intends to attach. The desktop attach is the one
  // that forces ensureDisplayStack + a viewer holder; the others ride Channel A
  // and need no spawn. Lets a files-only client avoid warming a desktop box.
  surfaces: z.array(z.enum(["fileSystem", "terminal", "git", "desktop", "recording"]))
    .min(1).default(["fileSystem", "terminal", "git"]),
  // Opt-in acknowledgement for the un-redacted shared-live pixel plane (H).
  // Required (and must be true) when "desktop" ∈ surfaces.
  acknowledgeUnredactedDesktop: z.boolean().default(false),
  // Preferred desktop geometry; the owner restarts Xvfb at this size on first
  // desktop attach (resolution is a stream-open param, not a live control).
  desktopResolution: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
}).superRefine((v, ctx) => {
  if (v.surfaces.includes("desktop") && !v.acknowledgeUnredactedDesktop) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["acknowledgeUnredactedDesktop"],
      message: "desktop attach requires acknowledging the un-redacted shared-live stream" });
  }
});
export type NegotiateStreamRequest = z.infer<typeof NegotiateStreamRequest>;
```

### 1.5 Two new event types — `SessionEventType` (line 1270) + payload docs

```ts
// add to the z.enum at packages/contracts/src/index.ts:1270, after "artifact.created":
  "stream.url.rotated",          // Channel A: desktop URL/token re-minted before TTL
  "stream.viewer.heartbeat.ack", // Channel A: server ack of a viewer-liveness ping (optional)
```

Documented payload shapes (the SSE payload is `z.unknown()` on the wire; these are what the worker emits):

```ts
// stream.url.rotated payload — the client swaps its noVNC socket to the new URL
// without re-negotiating. Carries the fence so a stale rotation is ignored.
export const StreamUrlRotatedPayload = z.object({
  surface: z.literal("desktop"),
  url: z.string().url(),
  token: z.string(),
  expiresAt: z.string(),
  leaseEpoch: z.number().int().nonnegative(),
});
export type StreamUrlRotatedPayload = z.infer<typeof StreamUrlRotatedPayload>;
```

### 1.6 Surface headless/desktop tier on `ClientConfig` (line 1425)

The deployment's tier is a *deployment-wide* fact (some deployments are headless-only); `ClientConfig` already advertises server capabilities. Add it so the client can choose a sensible default backend and pre-disable desktop UI before any session exists.

```ts
// add inside ClientConfig (packages/contracts/src/index.ts:1425):
  sandbox: z.object({
    defaultBackend: SandboxBackend,
    // Backends this deployment is configured to run (have creds/config). The
    // backend picker (§6) only offers these.
    allowedBackends: z.array(SandboxBackend).min(1),
    // Backends that can serve a desktop stream on THIS deployment (config +
    // provider capability). Empty => headless-only deployment.
    desktopCapableBackends: z.array(SandboxBackend).default([]),
    allowedOperatingSystems: z.array(SandboxOperatingSystem).min(1).default(["linux"]),
    defaultOperatingSystem: SandboxOperatingSystem.default("linux"),
  }),
```

The app.ts route at `apps/api/src/app.ts:162` fills this from settings (the Config module computes `desktopCapableBackends` by intersecting configured backends with the desktop matrix from GROUND:sdk-clients — modal/daytona/runloop/e2b/blaxel desktop-capable; cloudflare/vercel never).

### 1.7 New permission? — **No.**

Negotiation and viewing both gate on existing `sessions:read`; sending steering still gates on `sessions:control`. A viewer is a reader. No `Permission` enum change (avoids churn in `KNOWN_PERMISSIONS`, the access matrix, and the parity test). The data-plane scoped token (minted by the owner) is the *additional* boundary at the provider edge.

---

## 2. SDK (`packages/sdk`) — typed client + transports

The SDK keeps **zero runtime deps**; every contract type is hand-mirrored in `types.ts` and pinned by `test/contract-parity.test.ts`. New API methods go on `OpenGeniClient`; the noVNC desktop transport is a *thin, optional* helper (xterm.js / noVNC stay in `@opengeni/react`, not the framework-agnostic SDK).

### 2.1 Mirror the new types in `packages/sdk/src/types.ts`

```ts
// types.ts:14 — REPLACE to match contract 1.1 exactly (parity-gated):
export type SandboxBackend =
  | "docker" | "modal" | "local" | "none"
  | "daytona" | "runloop" | "e2b" | "blaxel" | "cloudflare" | "vercel";

// new, after SandboxBackend:
export type SandboxOperatingSystem = "linux" | "macos" | "windows";

export type CapabilityUnavailableReason =
  | "backend_unsupported" | "os_unsupported" | "not_provisioned"
  | "disabled_by_policy" | "lease_cold" | "tier_headless";

export type FileSystemCapability = {
  available: boolean; readOnly: boolean; root: string;
  treeMode: "lazy" | "snapshot"; reason: CapabilityUnavailableReason | null;
};
export type TerminalCapability = {
  transport: "sse-events" | "pty-ws" | null; ptyCapable: boolean;
  url: string | null; token: string | null; reason: CapabilityUnavailableReason | null;
};
export type GitCapability = {
  available: boolean; repoMounted: boolean; reason: CapabilityUnavailableReason | null;
};
export type DesktopStreamCapability = {
  transport: "vnc-ws" | "webrtc" | null; mode: "read-only" | "interactive";
  url: string | null; token: string | null; expiresAt: string | null;
  resolution: [number, number]; unredacted: true; reason: CapabilityUnavailableReason | null;
};
export type RecordingCapability = {
  available: boolean; mode: "on-demand" | "always" | "off"; reason: CapabilityUnavailableReason | null;
};
export type SessionCapabilities = {
  sessionId: string; backend: SandboxBackend; operatingSystem: SandboxOperatingSystem;
  liveness: "cold" | "warming" | "warm" | "draining"; leaseEpoch: number;
  fileSystem: FileSystemCapability; terminal: TerminalCapability; git: GitCapability;
  desktop: DesktopStreamCapability; recording: RecordingCapability;
  viewerHeartbeatIntervalMs: number; negotiatedAt: string;
};
export type NegotiateStreamRequest = {
  surfaces: ("fileSystem" | "terminal" | "git" | "desktop" | "recording")[];
  acknowledgeUnredactedDesktop: boolean;
  desktopResolution?: [number, number] | undefined;
};
export type StreamUrlRotatedPayload = {
  surface: "desktop"; url: string; token: string; expiresAt: string; leaseEpoch: number;
};
```

And extend `SESSION_EVENT_TYPES` (`types.ts:100`) with `"stream.url.rotated"`, `"stream.viewer.heartbeat.ack"` (parity-gated; **append**, since `SessionEventType = KnownSessionEventType | (string & {})` already tolerates unknown types — older SDKs degrade gracefully).

Mirror `ClientConfig`'s new `sandbox` block in the `ClientConfig` type in `types.ts` (search the existing `ClientConfig` mirror; add the `sandbox` field). Add `getClientConfig` to the parity-relevant exports.

### 2.2 New `OpenGeniClient` methods (`packages/sdk/src/client.ts`)

Follow the existing `requestJson` pattern verbatim (every method is one line). Insert after the events block (~line 224):

```ts
  // --- Stream capabilities (negotiation handshake) -------------------------

  /** Fetch this deployment's client config (models, file uploads, sandbox tiers). */
  async getClientConfig(): Promise<ClientConfig> {
    return await this.requestJson<ClientConfig>("GET", `/v1/config/client`);
  }

  /**
   * Negotiate stream surfaces for a session. Acquires a viewer lease holder
   * (refcounted liveness) and, for `desktop`, warms the display stack and mints
   * a short-TTL direct-to-provider URL. Idempotent per (grant, session): repeat
   * calls re-mint a fresh URL/token rather than stacking holders.
   */
  async negotiateStream(
    workspaceId: string, sessionId: string, request: NegotiateStreamRequest = { surfaces: ["fileSystem","terminal","git"], acknowledgeUnredactedDesktop: false },
  ): Promise<SessionCapabilities> {
    return await this.requestJson<SessionCapabilities>(
      "POST", `/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities`, request);
  }

  /** Read current capabilities WITHOUT attaching (no holder, no warm). Drives a
   *  pre-attach "Desktop available" affordance and the lease-liveness poll. */
  async getStreamCapabilities(workspaceId: string, sessionId: string): Promise<SessionCapabilities> {
    return await this.requestJson<SessionCapabilities>(
      "GET", `/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities`);
  }

  /** Heartbeat a viewer attachment (Channel-A app-level liveness, ruling f). A
   *  closed laptop stops sending these → reaper drops the holder within ~90s.
   *  Echoes leaseEpoch so a superseded epoch is rejected (split-brain fence). */
  async heartbeatViewer(
    workspaceId: string, sessionId: string, body: { leaseEpoch: number },
  ): Promise<{ ok: boolean; leaseEpoch: number }> {
    return await this.requestJson("POST",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities/heartbeat`, body);
  }

  /** Detach (delete this viewer's holder; idempotent — delete-my-row, ruling f). */
  async detachStream(workspaceId: string, sessionId: string): Promise<void> {
    await this.requestVoid("DELETE",
      `/v1/workspaces/${workspaceId}/sessions/${sessionId}/stream-capabilities`);
  }
```

Add the imports (`ClientConfig`, `SessionCapabilities`, `NegotiateStreamRequest`) to the `import type` block at `client.ts:3`. Export the new types from `packages/sdk/src/index.ts` (`export type { … }` block ~line 21).

### 2.3 noVNC transport helper — `packages/sdk/src/desktop.ts` (NEW, optional, zero-dep)

The SDK should not bundle the noVNC RFB library (it's a browser-only DOM dep). Instead it ships the **transport contract** + a tiny **URL assembler** + a **reconnect/rotation state machine** that the React component drives. The actual `RFB` import lives in `@opengeni/react`.

```ts
// packages/sdk/src/desktop.ts
import type { DesktopStreamCapability, StreamUrlRotatedPayload } from "./types";

/** Assemble the WebSocket URL the noVNC RFB client connects to, given the
 *  negotiated capability. The scoped token rides as a query param (Blaxel/
 *  Daytona style) OR is already embedded in `url` (Modal tunnels carry it in
 *  the host); we only append when `token` is present and not already in `url`. */
export function desktopSocketUrl(cap: Pick<DesktopStreamCapability, "url" | "token">): string {
  if (!cap.url) throw new Error("desktop capability has no url (transport is null)");
  const u = new URL(cap.url);
  if (cap.token && !u.searchParams.has("token") && !u.searchParams.has("password")) {
    u.searchParams.set("token", cap.token);
  }
  return u.toString();
}

/** The minimal RFB surface the React component drives — lets tests/3rd parties
 *  swap the noVNC implementation (or a WebRTC one in v3) without touching the
 *  component. Matches @novnc/novnc's RFB constructor + lifecycle. */
export interface DesktopRfbLike {
  viewOnly: boolean;
  scaleViewport: boolean;
  addEventListener(type: "connect" | "disconnect" | "securityfailure", cb: (e?: unknown) => void): void;
  disconnect(): void;
}
export type DesktopRfbFactory = (target: HTMLElement, url: string, opts: { credentials?: { password?: string } }) => DesktopRfbLike;

export type DesktopConnectionState =
  | "idle" | "negotiating" | "connecting" | "connected" | "rotating" | "reconnecting" | "error" | "ended";

/** Pure reducer for the desktop connection lifecycle. The component owns the
 *  RFB object + DOM; this owns the state transitions so they're unit-testable.
 *  Mirrors the Channel-A stream.ts reducer discipline. */
export function nextDesktopState(
  current: DesktopConnectionState,
  ev: { type: "negotiated" | "connected" | "disconnected" | "rotate" | "fail" | "abort" },
): DesktopConnectionState {
  switch (ev.type) {
    case "negotiated": return "connecting";
    case "connected": return "connected";
    case "rotate": return current === "connected" ? "rotating" : current;
    case "disconnected": return current === "ended" ? "ended" : "reconnecting";
    case "fail": return "error";
    case "abort": return "ended";
  }
}

/** Apply a stream.url.rotated event, fencing on leaseEpoch (split-brain). */
export function applyUrlRotation(
  cap: DesktopStreamCapability, p: StreamUrlRotatedPayload, knownEpoch: number,
): DesktopStreamCapability | null {
  if (p.leaseEpoch < knownEpoch) return null;          // stale rotation from a superseded owner
  return { ...cap, url: p.url, token: p.token, expiresAt: p.expiresAt };
}
```

Export from `index.ts`. The Channel-A terminal/file/git data continues to ride `streamEvents` (no new transport — they are event types), so **no SDK transport change for Channel A**: the terminal is `sandbox.command.output.delta` events the client already receives.

### 2.4 Parity test additions (`packages/sdk/test/contract-parity.test.ts`)

Add value-level + type-level pins for: `SandboxBackend` (now 10 values), `SandboxOperatingSystem`, `SessionCapabilities`, `NegotiateStreamRequest`, the two new `SESSION_EVENT_TYPES`. Pattern is identical to the existing `SandboxBackend`/`SESSION_EVENT_TYPES` pins at the top of that file.

---

## 3. REACT (`packages/react`) — hooks + components

Three new hooks (negotiation, desktop, terminal/file/git projections) and four new components (terminal, file browser, diff, desktop). All re-exported from `packages/react/src/index.ts`. The structural client slice (`client.ts`) grows the new methods.

### 3.1 Extend `SessionClientLike` (`packages/react/src/client.ts:8`)

```ts
// add to the Pick<OpenGeniClient, …> union:
  // Stream surfacing
  | "getClientConfig"
  | "negotiateStream"
  | "getStreamCapabilities"
  | "heartbeatViewer"
  | "detachStream"
```

### 3.2 `useStreamCapabilities` (NEW — `packages/react/src/hooks/use-stream-capabilities.ts`)

The negotiation hook. Owns: the negotiate call, the viewer heartbeat timer, the `stream.url.rotated` subscription (folding it back into the capability), detach-on-unmount, and lease-liveness polling while `cold`/`warming`.

```ts
export type UseStreamCapabilitiesOptions = ClientOverride & {
  /** Which surfaces to attach. Default: structured only (no desktop warm). */
  surfaces?: ("fileSystem" | "terminal" | "git" | "desktop" | "recording")[] | undefined;
  /** Pass the user's explicit consent for the un-redacted desktop stream. */
  acknowledgeUnredactedDesktop?: boolean | undefined;
  desktopResolution?: [number, number] | undefined;
  /** Hold off negotiating (e.g. panel collapsed). Default true once sessionId set. */
  enabled?: boolean | undefined;
  /** Live event log to fold stream.url.rotated from (usually useSessionEvents().events). */
  events?: SessionEvent[] | undefined;
};

export type UseStreamCapabilitiesResult = {
  capabilities: SessionCapabilities | null;
  state: "idle" | "negotiating" | "ready" | "cold" | "error";
  error: Error | null;
  /** Force a re-negotiation (e.g. after a resolution change or manual reconnect). */
  renegotiate: () => void;
};
```

**Behavior contract (exhaustive):**
- On mount with `enabled && sessionId`: call `negotiateStream`. If `liveness === "warm"` → `state:"ready"`. If `cold`/`warming` → `state:"cold"`, poll `getStreamCapabilities` every 1.5 s until `warm` or unmount (no holder churn — GET doesn't acquire).
- Start a `setInterval(heartbeatViewer, capabilities.viewerHeartbeatIntervalMs)`; on a `409`/epoch-rejection response, set `state:"error"` (superseded owner) and re-negotiate once.
- Watch `options.events` for `stream.url.rotated`; fold via `applyUrlRotation(cap, payload, cap.leaseEpoch)` (drop stale epochs). This keeps the desktop socket fresh without a round trip.
- On unmount / `enabled:false` / sessionId change: `clearInterval` + `void client.detachStream(...)` (fire-and-forget; idempotent delete-my-row).
- `negotiateStream` failures: `403` → `state:"error"` with a permission Error; transient → retry with the same backoff shape as `streamSessionEvents` (500 ms→10 s).

### 3.3 `useDesktopStream` (NEW — `packages/react/src/hooks/use-desktop-stream.ts`)

Drives the noVNC `RFB` lifecycle from a `DesktopStreamCapability`, using the SDK's `desktop.ts` reducer + `desktopSocketUrl`. Imports `@novnc/novnc` lazily (dynamic `import()`) so SSR/non-desktop bundles don't pull it.

```ts
export type UseDesktopStreamOptions = {
  capability: DesktopStreamCapability | null;
  /** The mount target. The hook attaches RFB here on connect. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Read-only by default (v1 ruling H). interactive only if cap.mode allows. */
  interactive?: boolean | undefined;
  scaleViewport?: boolean | undefined;
  /** Custom RFB factory (tests / WebRTC swap). Defaults to @novnc/novnc. */
  rfbFactory?: DesktopRfbFactory | undefined;
};
export type UseDesktopStreamResult = {
  state: DesktopConnectionState;
  error: Error | null;
  /** Manual reconnect (e.g. after a securityfailure once a fresh URL arrives). */
  reconnect: () => void;
};
```

**Contract:** when `capability.transport === "vnc-ws"` and `capability.url`, build the socket via `desktopSocketUrl`, instantiate `RFB(container, url, { credentials: { password: token } })`, set `viewOnly = !interactive || capability.mode === "read-only"`. Wire `connect`/`disconnect`/`securityfailure` to `nextDesktopState`. On a capability prop change whose `url` differs (a rotation), transition `connected → rotating`, `disconnect()` the old RFB, reconnect to the new URL — **no flicker if same box** (Modal snapshot-rollover gives a new `sandboxId` → a hard reconnect, acceptable "desktop blink" per Modal facts). When `transport === null`, stay `idle` and surface `capability.reason` to the component.

### 3.4 `useSandboxTerminal` (NEW — `packages/react/src/hooks/use-sandbox-terminal.ts`)

**Channel-A only** — the terminal is a projection of `sandbox.command.output.delta` + `sandbox.operation.*` events, *not* a new socket in v1. Folds the event log into an xterm-writable byte stream. This is the "terminal-as-events" the data path settled on.

```ts
export type UseSandboxTerminalOptions = ClientOverride & {
  events: SessionEvent[];          // usually useSessionEvents().events
  /** Render only this operation's output, or interleave all (default). */
  operationName?: string | undefined;
};
export type UseSandboxTerminalResult = {
  /** Ordered, deduped output chunks to write() into xterm.js. */
  chunks: { id: string; text: string; seq: number }[];
  /** Whether a command is currently running (drives the prompt/spinner). */
  running: boolean;
  /** Future: when terminal.transport === "pty-ws", an interactive write fn. */
  write: ((data: string) => void) | null;  // null in v1 (sse-events transport)
};
```

The hook reuses the timeline folding discipline (it can sit on top of `buildTimeline`'s `SandboxItem`s, or fold raw events for byte-fidelity). `write` is `null` in v1 (read-only terminal-as-events); when the deployment offers `pty-ws` it becomes a function that opens a scoped WS and pipes keystrokes — the same Channel-B-style transport as desktop.

### 3.5 `useSandboxFiles` / `useSandboxGit` (NEW)

These project the FileSystem and Git services. **The events that feed them are the FileSystem/Git Channel-A event types owned by the Backend module** (out of this module's scope to define — they emit `sandbox.fs.*` / `sandbox.git.*` events). This module specifies the *consumer-side data contract* the Pierre components expect:

```ts
// packages/react/src/hooks/use-sandbox-files.ts
export type FileTreeNode = {
  path: string;             // absolute, rooted at capability.fileSystem.root
  name: string;
  kind: "file" | "dir";
  children?: FileTreeNode[] | undefined;  // undefined = unexpanded (lazy treeMode)
  size?: number | undefined;
  status?: "added" | "modified" | "deleted" | "untracked" | undefined; // git overlay
};
export type UseSandboxFilesResult = {
  tree: FileTreeNode[];
  /** Lazy expansion: calls the FileSystem service (listDir) for a dir node. */
  expand: (path: string) => Promise<void>;
  /** Read a file's content for the preview pane. */
  readFile: (path: string) => Promise<{ text: string; truncated: boolean }>;
  loading: boolean; error: Error | null;
};
```

```ts
// packages/react/src/hooks/use-sandbox-git.ts — the Pierre DIFF data contract
export type DiffHunk = {
  oldStart: number; oldLines: number; newStart: number; newLines: number;
  lines: { type: "context" | "add" | "del"; text: string; oldNo: number | null; newNo: number | null }[];
};
export type FileDiff = {
  path: string; oldPath: string | null;     // oldPath set on rename
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  hunks: DiffHunk[];
  additions: number; deletions: number;
};
export type UseSandboxGitResult = {
  /** Working-tree diff vs HEAD (what the Pierre diff view renders). */
  diff: FileDiff[];
  branch: string | null;
  ahead: number; behind: number;
  loading: boolean; error: Error | null;
};
```

`DiffHunk`/`FileDiff` is the **hunk data contract** the Pierre diff component consumes — unified-diff hunks with per-line old/new line numbers, rename detection, binary flag, and per-file add/del counts. The Git service computes it (via `git diff` in the box) and ships it either as a `sandbox.git.diff` event payload or a request/response method; the component is agnostic.

### 3.6 Components — prop contracts

All four follow the existing component conventions: `className`, optional render-prop overrides, `cn()` for styling, themeable via the Tailwind `@source` directive (existing pattern documented in `index.ts:3`).

#### `SandboxTerminal` — xterm.js component (`packages/react/src/components/sandbox-terminal.tsx`)
```ts
export type SandboxTerminalProps = {
  result: UseSandboxTerminalResult;       // from useSandboxTerminal
  /** Theme tokens forwarded to xterm.js ITheme (background, foreground, …). */
  theme?: Partial<XtermTheme> | undefined;
  fontFamily?: string | undefined;
  fontSize?: number | undefined;
  /** Read-only by default; interactive only when result.write !== null. */
  readOnly?: boolean | undefined;
  className?: string | undefined;
};
```
Lazy-imports `@xterm/xterm` + `@xterm/addon-fit`. Writes `result.chunks` deltas into the terminal (tracking a written-cursor by `seq` to avoid re-writing on re-render). When `result.write` is non-null and `!readOnly`, wires `onData` → `write`. Disposes the terminal on unmount.

#### `FileBrowser` — Pierre tree component (`packages/react/src/components/file-browser.tsx`)
```ts
export type FileBrowserProps = {
  result: UseSandboxFilesResult;          // from useSandboxFiles
  /** Pierre tree availability/fallback: when the Pierre lib is absent or
   *  capability is unavailable, render this instead (default: a plain <ul>). */
  fallback?: ReactNode | undefined;
  /** Selection callback for the preview pane. */
  onSelectFile?: ((path: string) => void) | undefined;
  selectedPath?: string | undefined;
  /** Render-prop to theme/replace a row entirely. */
  renderNode?: ((node: FileTreeNode, depth: number) => ReactNode) | undefined;
  className?: string | undefined;
};
```
**Pierre availability/fallback:** the component attempts to render with the Pierre tree primitive (a `@pierre/tree`-style dep, dynamically imported / peer-optional). If the import fails or `result` indicates unavailability, it renders `fallback` (or a built-in minimal tree). This keeps `@opengeni/react` installable without the Pierre dep — Pierre is an *optional peer* surfaced through `renderNode`/`fallback`. The `status` overlay (git-modified files tinted) is driven by `FileTreeNode.status`.

#### `DiffView` — Pierre diff component (`packages/react/src/components/diff-view.tsx`)
```ts
export type DiffViewProps = {
  diff: FileDiff[];                        // from useSandboxGit().diff
  /** Pierre diff availability/fallback (same pattern as FileBrowser). */
  fallback?: ReactNode | undefined;
  /** unified | split. Default "unified". */
  layout?: "unified" | "split" | undefined;
  /** Theme tokens for add/del/context line backgrounds. */
  theme?: Partial<DiffTheme> | undefined;
  onSelectFile?: ((path: string) => void) | undefined;
  className?: string | undefined;
};
```
Feeds `FileDiff[].hunks` into the Pierre diff renderer; falls back to a built-in unified-diff `<pre>` when Pierre is absent.

#### `DesktopViewer` — noVNC component (`packages/react/src/components/desktop-viewer.tsx`)
```ts
export type DesktopViewerProps = {
  capability: DesktopStreamCapability | null;   // from useStreamCapabilities().capabilities.desktop
  /** read-only vs interactive. Forced read-only when capability.mode === "read-only". */
  interactive?: boolean | undefined;
  scaleViewport?: boolean | undefined;
  /** Required consent gate UI when capability.unredacted — render before connecting. */
  renderConsentGate?: ((onAccept: () => void) => ReactNode) | undefined;
  /** What to show when transport is null (headless backend). Defaults to a
   *  reason-aware notice ("Desktop isn't available on this sandbox"). */
  renderUnavailable?: ((reason: CapabilityUnavailableReason | null) => ReactNode) | undefined;
  /** What to show while liveness is cold/warming (box warming up). */
  renderWarming?: (() => ReactNode) | undefined;
  className?: string | undefined;
};
```
Owns the mount `<div ref>`, drives `useDesktopStream`, and renders the read-only/interactive/unavailable/warming states. The **read-only vs interactive** decision is enforced at three layers: `capability.mode` (server authority) → `interactive` prop → `RFB.viewOnly`. v1 always resolves to read-only.

### 3.7 Timeline: surface stream rotation as a notice (`packages/react/src/timeline.ts`)

Add a `case "stream.url.rotated":` that pushes a quiet `NoticeItem` (or is silently ignored — design choice: ignore by default, since rotation is plumbing). Add `case "stream.viewer.heartbeat.ack":` → ignore. No new `TimelineItem` variant needed; the desktop/terminal surfaces are *panels beside* the timeline, not timeline items. This keeps `buildTimeline` unchanged in shape (only two ignore-cases, matching how `agent.updated` is handled).

### 3.8 Re-exports (`packages/react/src/index.ts`)

Add to the Hooks block and Components block: `useStreamCapabilities`, `useDesktopStream`, `useSandboxTerminal`, `useSandboxFiles`, `useSandboxGit`, `SandboxTerminal`, `FileBrowser`, `DiffView`, `DesktopViewer` + all their option/result/prop types and the data-contract types (`FileTreeNode`, `FileDiff`, `DiffHunk`).

---

## 4. WEB (consuming app)

The web app composes the four surfaces into a **session workbench** beside the existing `MessageTimeline`. Minimal wiring (the app already has `OpenGeniProvider` + `useSession` + `useSessionEvents`):

```tsx
function SessionWorkbench({ sessionId }: { sessionId: string }) {
  const { events } = useSessionEvents(sessionId);
  const { capabilities, state } = useStreamCapabilities(sessionId, {
    events,
    surfaces: ["fileSystem", "terminal", "git", "desktop"],
    acknowledgeUnredactedDesktop: userConsented,   // gated by a consent toggle
  });
  const terminal = useSandboxTerminal({ events });
  const files = useSandboxFiles(sessionId, { events });
  const git = useSandboxGit(sessionId, { events });

  return (
    <Tabs>
      <Tab label="Chat"><MessageTimeline events={events} /></Tab>
      <Tab label="Terminal"><SandboxTerminal result={terminal} /></Tab>
      <Tab label="Files"><FileBrowser result={files} /></Tab>
      <Tab label="Diff"><DiffView diff={git.diff} /></Tab>
      {capabilities?.desktop.transport && (
        <Tab label="Desktop">
          <DesktopViewer capability={capabilities.desktop}
            renderConsentGate={(accept) => <ConsentBanner onAccept={accept} />} />
        </Tab>
      )}
    </Tabs>
  );
}
```

The desktop tab **only appears when `capabilities.desktop.transport` is non-null** — the capability doc drives UI presence (no hardcoded backend checks in the app). On a headless backend the tab is absent; the user sees terminal/files/diff only.

---

## 5. 3rd-party SDK consumer — minimal wiring + theming/replacement

A 3rd-party consumer who routes through *their own* API (the proxy pattern in `packages/sdk/src/proxy.ts`) needs:

1. **Server side:** proxy `negotiateStream`/`heartbeatViewer`/`detachStream` through their API exactly like they already proxy `streamEvents` (the OpenGeni key never reaches the browser). The desktop `url`/`token` are *direct-to-provider* — the proxy passes them through untouched (they are already scoped + short-TTL; this is the split-plane design). The proxy must **not** rewrite the desktop URL (it's a different origin than the proxy's API).
2. **Client side:** build a `SessionClientLike` whose five new methods hit their proxy endpoints, pass it to `OpenGeniProvider`. All four components work unchanged.
3. **Theming/replacement:** every component takes `className` + theme tokens (`SandboxTerminalProps.theme`, `DiffViewProps.theme`) and render-prop escape hatches (`FileBrowserProps.renderNode`, `DesktopViewerProps.renderUnavailable/renderConsentGate`, `MessageTimelineProps.renderMessageText`). A consumer who wants a totally different file tree passes `fallback` or swaps `useSandboxFiles` + their own component (the hook is the reusable part). noVNC/xterm/Pierre are all swappable: `useDesktopStream` takes a `rfbFactory`; `SandboxTerminal` could be replaced wholesale by consuming `useSandboxTerminal().chunks`; `FileBrowser`/`DiffView` fall back to built-ins when Pierre is absent.

---

## 6. Provider + OS + tier selection UX

Two selection points, both driven by `ClientConfig.sandbox` (§1.6) and per-session `SessionCapabilities`:

**At session create** (`CreateSessionRequest` already has `sandboxBackend`; add `operatingSystem`):
- Add `operatingSystem: SandboxOperatingSystem.optional()` to `CreateSessionRequest` (contracts line 1319) + the SDK mirror.
- The create form offers `ClientConfig.sandbox.allowedBackends` (only configured ones) and `allowedOperatingSystems`. Backends in `desktopCapableBackends` get a "Desktop" badge; others a "Headless" badge. Default to `defaultBackend`/`defaultOperatingSystem`.
- **Tier selection** is implicit: choosing a headless-only backend (cloudflare/vercel) or a deployment with empty `desktopCapableBackends` means no desktop tab will appear later — the form shows this consequence inline ("This sandbox is headless: terminal, files, and diff only").

**At view time** (per session): `SessionCapabilities` is authoritative. The workbench reads `capabilities.backend`/`operatingSystem`/per-surface `reason` and renders enabled/disabled tabs with reason-aware copy (e.g. desktop tab hidden with tooltip "Desktop isn't available on Cloudflare sandboxes" when `desktop.reason === "backend_unsupported"`). OS selection is **create-time only** in v1 (Linux); the axis exists in the contract so macOS/Windows light up without a schema change when a provider offers them.

---

## 7. Failure / edge-case matrix (exhaustive)

| Case | Detection | Client behavior |
|---|---|---|
| Backend is `none` / headless tier | `desktop.transport === null`, `reason: "backend_unsupported"`/`"tier_headless"` | Desktop tab absent; terminal/files/diff still work (Channel A). |
| Lease `cold`/`warming` at negotiate | `liveness !== "warm"` | `useStreamCapabilities` → `state:"cold"`, poll `getStreamCapabilities` every 1.5 s; `DesktopViewer` shows `renderWarming`. |
| Box warming, never reaches warm (spawner died mid-resume) | poll keeps returning `warming` past a deadline (~30 s) | Surface an error notice; offer manual `renegotiate()`. (Backend's `warming` lease-TTL → cold recovers the lease.) |
| URL TTL expiry | `desktop.expiresAt` passed without a rotation event | `useStreamCapabilities` proactively `renegotiate()` ~10 s before `expiresAt`; if a `stream.url.rotated` arrived first, no round trip. |
| `stream.url.rotated` from superseded owner | `payload.leaseEpoch < knownEpoch` | `applyUrlRotation` returns `null` → ignored (split-brain fence, ruling c). |
| noVNC `securityfailure` (stale/revoked token) | RFB `securityfailure` event | `useDesktopStream` → `error`; `useStreamCapabilities` re-negotiates once; if it fails again → `state:"error"` with "reconnect" affordance. |
| Provider fan-out cap hit (the unvalidated R6 risk) | RFB never fires `connect`, or `disconnect` immediately | `connecting → reconnecting` with backoff; after `maxReconnectAttempts`, `error` with "too many viewers" copy. (Client can't distinguish cap from transient; copy is generic.) |
| Modal 24h snapshot-rollover | `stream.url.rotated` with a new host (new `sandboxId`) | Desktop hard-reconnects to the new URL — a brief "desktop blink" (accepted, Modal facts). |
| Viewer heartbeat rejected (epoch moved) | `heartbeatViewer` → `409`/`{leaseEpoch}` mismatch | Re-negotiate; if still mismatched, `state:"error"` (a newer owner owns the box). |
| Closed laptop | client stops heartbeating | Server reaper drops the holder in ~90 s (ruling f); no client action. On wake, the stream is stale → reconnect re-negotiates. |
| Consent not given for desktop | `acknowledgeUnredactedDesktop:false` with `desktop` in `surfaces` | `negotiateStream` rejects (`422`, Zod `superRefine`); `DesktopViewer` shows `renderConsentGate` until accepted. |
| `sessions:read` revoked mid-view | `negotiateStream`/heartbeat → `403` | `state:"error"` (forbidden); detach; tear down RFB. Grant-revocation ties to holder reap (ruling h). |
| PTY-incapable backend (vercel/runloop) for interactive terminal | `terminal.ptyCapable === false`, `transport: "sse-events"` | Terminal is read-only event projection; no interactive affordance shown. |
| Git: no repo mounted | `git.repoMounted === false`, `available:true` | DiffView shows "no repository mounted" empty state (vs. "no changes" when mounted+empty). |
| Pierre lib absent in consumer bundle | dynamic import throws | `FileBrowser`/`DiffView` render `fallback` (or built-in). No crash. |
| SSR / no DOM | `useDesktopStream`/`SandboxTerminal` mounted server-side | Lazy imports gated behind `useEffect`; render placeholder until client hydration. |
| Older SDK, new server event type | unknown `SessionEventType` | Tolerated (`KnownSessionEventType | (string & {})`); `buildTimeline` ignores; no break. |

---

## 8. File-by-file change list

**`packages/contracts/src/index.ts`**
- L13: extend `SandboxBackend` (10 values). 
- L14 (after): add `SandboxOperatingSystem`.
- ~L1270: add `stream.url.rotated`, `stream.viewer.heartbeat.ack` to `SessionEventType`.
- ~L1319: add `operatingSystem` to `CreateSessionRequest`.
- ~L1425: add `sandbox` block to `ClientConfig`.
- New section (near `ClientConfig`): `CapabilityUnavailableReason`, `FileSystemCapability`, `TerminalCapability`, `GitCapability`, `DesktopStreamCapability`, `RecordingCapability`, `SessionCapabilities`, `NegotiateStreamRequest`, `StreamUrlRotatedPayload`.

**`packages/sdk/src/types.ts`** — mirror all of the above (parity-gated). 
**`packages/sdk/src/client.ts`** — add `getClientConfig`, `negotiateStream`, `getStreamCapabilities`, `heartbeatViewer`, `detachStream` + imports. 
**`packages/sdk/src/desktop.ts`** (NEW) — `desktopSocketUrl`, `DesktopRfbLike`/`DesktopRfbFactory`, `DesktopConnectionState`, `nextDesktopState`, `applyUrlRotation`. 
**`packages/sdk/src/index.ts`** — export new types + `desktop.ts` symbols. 
**`packages/sdk/test/contract-parity.test.ts`** — pin new enums/shapes.

**`packages/react/src/client.ts`** — add 5 methods to `SessionClientLike`. 
**`packages/react/src/hooks/use-stream-capabilities.ts`** (NEW). 
**`packages/react/src/hooks/use-desktop-stream.ts`** (NEW). 
**`packages/react/src/hooks/use-sandbox-terminal.ts`** (NEW). 
**`packages/react/src/hooks/use-sandbox-files.ts`** (NEW). 
**`packages/react/src/hooks/use-sandbox-git.ts`** (NEW). 
**`packages/react/src/components/sandbox-terminal.tsx`** (NEW). 
**`packages/react/src/components/file-browser.tsx`** (NEW). 
**`packages/react/src/components/diff-view.tsx`** (NEW). 
**`packages/react/src/components/desktop-viewer.tsx`** (NEW). 
**`packages/react/src/timeline.ts`** — two ignore-cases for the new event types. 
**`packages/react/src/index.ts`** — re-export 5 hooks + 4 components + their types + data-contract types. 
**`packages/react/package.json`** — add `@novnc/novnc`, `@xterm/xterm`, `@xterm/addon-fit`, and the Pierre tree/diff libs as **optional peers** (dynamically imported; not hard deps).

**API (consumed, specified here, implemented by Worker module):**
- `apps/api/src/app.ts:162` — extend the `/v1/config/client` handler to fill `ClientConfig.sandbox`.
- `apps/api/src/routes/sessions.ts` — add `POST/GET/DELETE …/stream-capabilities`, `POST …/stream-capabilities/heartbeat`, all behind `requireAccessGrant(c, deps, workspaceId, "sessions:read")`, following the existing route pattern (parse `NegotiateStreamRequest`, `signalWithStart` the owner workflow to mint the URL, return `SessionCapabilities`).

---

## 9. Route signatures (the control-plane contract this module depends on)

```ts
// apps/api/src/routes/sessions.ts  (implemented by Worker module; signature owned here)
app.post("/v1/workspaces/:workspaceId/sessions/:sessionId/stream-capabilities", async (c) => {
  await requireAccessGrant(c, deps, workspaceId, "sessions:read");
  const req = NegotiateStreamRequest.parse(await c.req.json());
  // → signalWithStart(sessionWorkflow, openStreamRequest{ grantId, surfaces, ack, resolution })
  //   → acquireLease(viewer) + (if desktop) ensureDisplayStack + resolveExposedPort(6080) + mint token
  return c.json(SessionCapabilities.parse(caps));
});
app.get(".../stream-capabilities", …);            // no holder; reads lease + caps
app.post(".../stream-capabilities/heartbeat", …); // refresh viewer holder TTL; fence on leaseEpoch
app.delete(".../stream-capabilities", …);         // delete viewer holder (idempotent)
```

---

### Key load-bearing decisions

1. **Channel A needs zero new transport** — terminal/files/git are *event projections* (`sandbox.command.output.delta`, plus Backend-owned `sandbox.fs.*`/`sandbox.git.*`), consumed via the existing `streamEvents`. The only new transport is the desktop noVNC socket (Channel B, direct-to-provider).
2. **The capability doc is the single source of UI truth** — every surface's presence, read-only-ness, and unavailability reason is a server value, never a client-side backend check. Degradation is explicit.
3. **No new permission** — viewers are readers (`sessions:read`); the data-plane scoped token is the second boundary at the provider edge.
4. **noVNC/xterm/Pierre are optional peers, dynamically imported** — `@opengeni/react` stays installable headless-only, and all three are swappable via factory/render-prop/fallback, satisfying the 3rd-party theming/replacement requirement.
5. **Parity-gated** — every contract addition is mirrored in `packages/sdk/src/types.ts` and pinned by `contract-parity.test.ts`, matching the existing discipline.

Files cited (absolute): contracts `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/contracts/src/index.ts` (L13 SandboxBackend, L1270 SessionEventType, L1306 SessionEvent, L1319 CreateSessionRequest, L1347 ClientSessionEvent, L1425 ClientConfig); SDK `…/packages/sdk/src/{client.ts,types.ts,stream.ts,proxy.ts,index.ts}` + `test/contract-parity.test.ts`; React `…/packages/react/src/{client.ts,provider.tsx,timeline.ts,index.ts,hooks/use-session-events.ts,components/message-timeline.tsx}`; API `…/apps/api/src/{app.ts:162,routes/sessions.ts:214}`; SDK provider clients `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/{modal,blaxel,e2b}/sandbox.js` (resolveExposedPort) and `…/@openai/agents-core@0.11.6@@@1/dist/sandbox/session.d.ts:9` (`ExposedPortEndpoint`).

---

## Adversarial Review

# Adversarial Review — Client Surface spec (contracts → sdk → react → web)

I verified every cited anchor against HEAD. The spec is broadly well-grounded and the architecture is sound, but it has several concrete bugs, wrong status-code claims, and gaps that would not compile/run as written. Findings below, each with a fix, ordered by severity.

## CORRECTNESS BUGS

**1. `getClientConfig` returns a `ClientConfig` SDK type that does not exist — and the spec's instruction to "search the existing `ClientConfig` mirror" is factually false.**
`packages/sdk/src/types.ts` has **no** `ClientConfig` type, `packages/sdk/src/index.ts` does not export one, and `client.ts` does not import one (verified: zero matches for `ClientConfig` across `packages/sdk/src/`). §2.1 says "search the existing `ClientConfig` mirror; add the `sandbox` field" — there is nothing to search. §2.2's `getClientConfig(): Promise<ClientConfig>` references an undefined type → **won't compile**.
**Fix:** the spec must specify the *full* net-new `ClientConfig` SDK mirror (all existing fields: `deploymentRevision, defaultModel, allowedModels, defaultReasoningEffort, allowedReasoningEfforts, mcpServers, fileUploads, productAccessMode, auth`, plus the new `sandbox` block), add it to `types.ts`, export from `index.ts`, and pin it in the parity test. Also note `ClientAuthConfig`/`ProductAccessMode` are dependencies that must be mirrored too if not already present.

**2. `GET /v1/config/client` already exists and is auth-exempt — the spec treats it as something to "extend the handler" but never reconciles the auth model with the new `sandbox` block.**
The route is live at `apps/api/src/app.ts:162` and is in the unauthenticated allowlist (`apps/api/src/http/auth.ts:25`, `isAuthExempt`). The spec's §1.6/§8 say "extend the `/v1/config/client` handler to fill `ClientConfig.sandbox`" — fine — but it advertises `allowedBackends`/`desktopCapableBackends` **pre-auth, to any unauthenticated caller**. That's a deployment-topology disclosure decision the spec never flags. Not necessarily wrong (it's already public), but it's an undocumented exposure of backend inventory.
**Fix:** state explicitly that backend inventory is published unauthenticated (consistent with existing `mcpServers`/`allowedModels` exposure), or move the sandbox block behind an authenticated config endpoint if that's not acceptable.

**3. `desktopSocketUrl` token handling is wrong for Blaxel and contradicts `useDesktopStream`'s own credential passing.**
The spec asserts the scoped token "rides as a query param (Blaxel/Daytona style)" and appends it as `?token=`. Verified against the grounding: Blaxel's scoped token is `bl_preview_token` (GROUND:desktop-stack: `createBlaxelPreviewTokenQuery`), not `token`. The function checks only `token`/`password` keys, so for a Blaxel URL it appends a useless `?token=…` the provider ignores (confirmed by repro: `bl_preview_token=xyz&token=abc`). Worse, §3.3 `useDesktopStream` passes the same token as the **RFB password** (`{ credentials: { password: token } }`) — so the token is simultaneously claimed to be a URL query param *and* the VNC auth password. These are two different auth mechanisms; the box runs `-nopw` in v1 (GROUND:desktop-stack), so the RFB password is meaningless, and the real auth is the provider tunnel token already baked into `url` by `resolveExposedPort`.
**Fix:** Drop the query-param append entirely for v1. The scoped provider token is already embedded in the `url` minted by `session.resolveExposedPort(6080)` (Modal host, Blaxel `bl_preview_token`, Daytona signed-preview). `desktopSocketUrl` should just translate the `https://…/vnc.html` (or host) into the `wss://` socket path noVNC needs and return it unchanged. Remove `cap.token` from the URL logic; if box-level VNC auth is ever enabled (v2), pass it via RFB `credentials.password` only — never both.

**4. Spec claims consent-missing → `422` and heartbeat epoch-mismatch → `409`, but the codebase's error pipeline turns raw `ZodError` and un-typed throws into `500`.**
The global middleware (`apps/api/src/app.ts:121–142`) re-throws to Hono's default handler, which only renders `HTTPException` with its status; everything else (including `ZodError` from `NegotiateStreamRequest.parse()`) becomes **500** (`httpStatusForError`, `app.ts:222`). Existing routes call `.parse()` directly (e.g. `sessions.ts:238,301`) and inherit this. So §7's "`negotiateStream` rejects (`422`, Zod `superRefine`)" is wrong — as written it's a 500. The `409` for heartbeat epoch-mismatch is also not automatic; nothing maps it.
**Fix:** the route handlers must explicitly translate: wrap `NegotiateStreamRequest.parse()` in a try/catch that throws `new HTTPException(400, …)` on `ZodError` (or use `@hono/zod-validator`, already a dep — `apps/api/src/routes/api-keys.ts:3` — which returns 400, not 422), and throw `new HTTPException(409, …)` explicitly on the epoch fence in the heartbeat handler. Then align the SDK/React error copy to **400** (not 422) for consent, since the prevailing validation status in this codebase is 400.

**5. `heartbeatViewer` uses `requestJson` (throws `OpenGeniApiError` on non-2xx), so the spec's "on `409` → set state:error / re-negotiate" cannot inspect a `409` body as a normal return.**
`requestJson` throws `OpenGeniApiError(status, text)` for any non-ok (`client.ts:830-ish`). The spec's `heartbeatViewer(...)Promise<{ ok; leaseEpoch }>` implies a `409` returns a parseable body; instead it throws. The React hook's "on a 409/epoch-rejection response, set state:error" must catch `OpenGeniApiError` and check `err.status === 409`, not read a result field.
**Fix:** specify that the hook catches `OpenGeniApiError` and branches on `.status` (409 → renegotiate, 403 → error). Note this error class exists (`packages/sdk/src/errors.ts`) and is the established pattern.

## GAPS

**6. §3.7 timeline "add two ignore-cases" is redundant and the rationale ("matching how `agent.updated` is handled") is false.**
`buildTimeline`'s switch already has `default: break` (`timeline.ts:417`) that silently drops any unknown type. `agent.updated` is NOT an explicit case — it falls through to `default` (verified: no `agent.updated` case exists). So `stream.url.rotated`/`stream.viewer.heartbeat.ack` are already ignored with zero changes.
**Fix:** drop §3.7's instruction to add cases (it's a no-op churn), or keep it only as documentation comments. The "matching `agent.updated`" justification should be corrected to "matching the existing `default: break`."

**7. Route-label allowlist not updated — new routes will be bucketed as unknown in metrics/observability.**
`apps/api/src/app.ts:228+` (`routeLabelPatterns`) is an explicit regex allowlist feeding `routeLabel()` for per-route metrics/tracing. The spec adds four routes (`…/stream-capabilities` GET/POST/DELETE, `…/stream-capabilities/heartbeat` POST) but the file-by-file list (§8) never adds label patterns. They'll fall to whatever the default label is (likely `unknown`), polluting metrics.
**Fix:** add `routeLabelPatterns` entries for the four new routes to §8's `apps/api/src/app.ts` change list.

**8. `assertSessionExists` is omitted from the route signatures.**
Every existing session sub-route calls `assertSessionExists(db, workspaceId, sessionId)` after `requireAccessGrant` (e.g. `sessions.ts:217,228`). §9's signatures jump straight from `requireAccessGrant` to `signalWithStart`. Without the existence check, a negotiate against a bogus `sessionId` would `signalWithStart` a workflow for a non-existent session.
**Fix:** add `await assertSessionExists(db, workspaceId, sessionId)` to all four route signatures.

**9. Hook `workspaceId` provenance is never stated.**
The SDK methods all take `(workspaceId, sessionId, …)`, but the React hooks (`useStreamCapabilities(sessionId, options)`) and the web example pass only `sessionId`. The `workspaceId` must come from `useOpenGeni(options)` context (`provider.tsx:32`), exactly like `useSessionEvents`. The spec's option/result types never mention it, leaving the implementer to infer it.
**Fix:** state that the hooks resolve `{ client, workspaceId }` via `useOpenGeni(options)` and that `UseStreamCapabilitiesOptions extends ClientOverride` (it does, via `ClientOverride &`), so `workspaceId` is context- or override-supplied.

**10. `negotiateStream`/`detachStream`/`heartbeatViewer` added to `SessionClientLike`, but the proxy-pattern consumer (§5) needs the *real* OpenGeniClient to declare them first — confirmed fine, but the desktop `url`/`token` pass-through claim has a hole.**
§5.1 says "the proxy must not rewrite the desktop URL (it's a different origin)." Correct, but `proxy.ts` today only proxies the *event stream* (`streamEvents`); there is no generic JSON-method proxy helper. The spec hand-waves "proxy `negotiateStream`/… exactly like they already proxy `streamEvents`" — but `streamEvents` proxying is a bespoke SSE re-stream (`sessionEventsToSseStream`), not a JSON passthrough. A consumer can't "exactly like" proxy a POST that returns JSON using the SSE helper.
**Fix:** acknowledge the consumer writes plain JSON passthrough handlers (their framework's normal POST/GET/DELETE proxying) for these three methods — this is unlike the SSE re-stream and needs no SDK helper. Optionally note that the desktop `url`/`token` in the JSON body must be returned verbatim.

## CONSISTENCY / GROUNDING CONTRADICTIONS

**11. `viewerHeartbeatIntervalMs` default `30_000` vs settled reaper math.**
GROUND:prior-docs §E sets the invariant `reaperPeriod < viewerHolderTTL(~90s) < modalIdleTimeout(900s)` and §J(f) "reaper drops within ~90s." A 30s client heartbeat with a 90s TTL gives 3 missed beats before reap — fine. But the spec's §3.2 also says "on unmount, fire-and-forget detach" AND polls `getStreamCapabilities` every 1.5s while cold. Nothing t*ies the heartbeat interval to the server-advertised TTL; if an operator lowers `viewerHolderTTL` below 60s, a 30s heartbeat with jitter risks false reaps.
**Fix:** state the invariant `viewerHeartbeatIntervalMs * 3 ≤ viewerHolderTTL` and have the server compute `viewerHeartbeatIntervalMs` from its configured TTL rather than hardcoding 30s on the client side independently.

**12. `desktop.resolution` default `[1024,768]` as a `z.tuple` with `.default` is valid Zod, but `DesktopStreamCapability.unredacted: z.literal(true).default(true)` is pointless and slightly dangerous.**
A field that can only ever be `true` carries no information and a malicious/old server omitting it still yields `true` — which is the *unsafe* default (claims un-redacted consent semantics). If the intent is "this plane is always unredacted," a literal is correct; but defaulting it means a server that forgets to send it still asserts unredacted. Combined with the client gating consent on this flag, a missing field silently asserts the riskier state.
**Fix:** make it required (no `.default`) so the server must explicitly assert it, or invert to a `redacted: boolean` that defaults to the *safe* value. Minor, but it's a security-relevant default per ruling H.

**13. `terminal.transport: "sse-events"` is asserted, but two desktop-capable backends can't even do PTY and the spec never maps `ptyCapable` to real provider facts.**
GROUND:sdk-clients: Vercel and Runloop hardcode `supportsPty()=false`; e2b/daytona/blaxel are *runtime-conditional*. The spec's `ptyCapable` is "echoes the provider's supportsPty()" — but for the conditional providers, `supportsPty()` can only be known by *calling it on a live session*, which the negotiation may not have. The capability doc would have to lie or warm a box just to answer `ptyCapable`.
**Fix:** specify `ptyCapable` is derived from a static per-backend matrix at the control plane (vercel/runloop=false, modal/cloudflare=true, e2b/daytona/blaxel=best-effort/false-until-proven), not from a live `supportsPty()` call — otherwise it forces a warm or returns unknown.

## MINOR / NON-BLOCKING

**14. `StreamUrlRotatedPayload` is declared but the spec also needs a payload doc for `stream.viewer.heartbeat.ack` (it says "optional") — it's never given a shape, so the SDK can't type it.** Either define it or state explicitly it carries `{ leaseEpoch }` and is ignore-only.

**15. §2.4 parity test says "SandboxBackend (now 10 values)."** Correct count (4 existing + 6 new = 10), but the parity test asserts `SESSION_EVENT_TYPES` via exact sorted equality (`contract-parity.test.ts:39`) — so the two new event types MUST be appended to *both* the contracts enum and the SDK array in the same change or the gate fails. The spec says "append… older SDKs degrade gracefully" — true at runtime, but the *parity test in this repo* will fail until both sides match. Make that ordering constraint explicit (it's a same-PR requirement, not optional).

**16. `CreateSessionRequest` `operatingSystem` addition (§6) is genuinely net-new** (verified absent at `contracts:1319`) — fine, but it must also be mirrored in the three SDK `CreateSessionRequest`/turn type mirrors (`types.ts:207,236,424,438` all carry `sandboxBackend?`) and the MCP server's loose `z4.string().optional()` validator, none of which §6/§8 enumerate.

### Net assessment
The architecture (capability doc as single UI truth, Channel-A event projections needing no new transport, no new permission, optional-peer dynamic imports, parity-gating) is correct and consistent with the settled rulings. The blocking issues are: **#1** (undefined `ClientConfig` SDK type — won't compile), **#3** (broken/contradictory desktop token mechanism), and **#4** (wrong HTTP status mapping — the API pipeline yields 500, not 422/409, for the cases the entire §7 matrix depends on). Fix those three and the spec is implementable.

Key files for the fixes (absolute):
- `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/sdk/src/types.ts` (add full `ClientConfig` mirror)
- `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/sdk/src/index.ts` (export it)
- `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/sdk/src/desktop.ts` (`desktopSocketUrl` token logic)
- `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/apps/api/src/app.ts:121-142,222-242` (error mapping + route-label patterns) and `/home/jorge/.../apps/api/src/routes/sessions.ts` (explicit `HTTPException` translation + `assertSessionExists`)
- `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/react/src/timeline.ts:417` (default-break already covers the new events — drop §3.7 churn)
