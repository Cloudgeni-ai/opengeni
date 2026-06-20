# Module: Provider registry + capability/lifetime descriptors + config/secrets + selection  (providers)

## Specification

# MODULE SPEC — Provider Registry + Capability/Lifetime Descriptors + Config/Secrets + Selection

**Module owner surface:** `createSandboxClient` (the provider factory), the `SandboxBackend` enum across 3 packages, a NEW static `CapabilityDescriptor` registry, per-provider config/secret wiring, and the backend+capability **selection/negotiation/degradation** function that other modules (lease, owner, handshake) call.

This module is **pure construction + static metadata + selection**. It owns no runtime state, no lease, no owner. It produces: (a) a constructed-and-validated provider client, (b) a static descriptor answering "what can this backend do", (c) a `NegotiatedCapabilities` value the handshake module returns to clients.

---

## 0. Scope boundary (what this module does NOT do)

- Does NOT build the lease tables or the resume-by-id path (that is the lease/owner module — `apps/worker/src/sandbox-resume.ts`, `sandbox_leases`). *(Under the stateless-workers ruling there is no `SandboxOwner` actor and no per-session/per-group Temporal queue; the old `sandbox-owner.ts` is the stateless `sandbox-resume.ts` — see `00-master-spine.md` §B.2 and `modules/02-owner.md`. This module is provider-blind and unaffected.)*
- Does NOT mint tunnel URLs or run `resolveExposedPort` (the handshake module does that; this module only **declares** via the descriptor whether a port-exposure mechanism exists and which kind).
- Does NOT launch the desktop chain (that is the owner's `ensureDisplayStack`; this module declares `capabilities.DesktopStream` static-feasibility only).
- DOES own: the enum, the factory registry, the descriptor table-as-data, config schema/env/validation, and `selectBackend()` / `negotiateCapabilities()` / `degrade()`.

---

## 1. The `SandboxBackend` enum expansion (10 values, back-compat)

### 1.1 Final enum (additive — existing 4 values keep position)

```ts
// docker/local/none = infra tiers; modal..vercel = the 7 first-class providers
export const SandboxBackend = z.enum([
  "docker",      // local/dev container (headless)
  "modal",       // PRIMARY cloud provider (desktop-capable)
  "local",       // UnixLocalSandboxClient, dev only (headless)
  "none",        // no sandbox (factory returns undefined)
  "daytona",     // desktop-capable
  "runloop",     // desktop-capable
  "e2b",         // desktop-capable
  "blaxel",      // desktop-capable
  "cloudflare",  // HEADLESS-ONLY (resolveExposedPort throws)
  "vercel",      // HEADLESS-ONLY (5h cap, no custom image, no PTY)
]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;
```

### 1.2 The three declaration sites (must all match — a parity test pins them)

| File:line | Declaration | Change |
|---|---|---|
| `packages/contracts/src/index.ts:13` | wire/API enum (reused at `:696,711,812,1244,1326`) | append 6 values |
| `packages/deployment/src/index.ts:34` | deployment-contract enum (`SandboxSpec.backend` `:184`) | append 6 values |
| `packages/sdk/src/types.ts:14` | hand-written SDK mirror (`SandboxBackend`) | append 6 values; keep the `| (string & {})` open-union tolerance if present so older SDKs don't break |

**Back-compat guarantees:**
- DB needs **NO migration**: `sandbox_backend` is `text NOT NULL` (`packages/db/src/schema.ts:117` sessions, `:260` sessionTurns), read-cast as `SandboxBackend` (`packages/db/src/index.ts:3549,3592`). Existing rows (`docker|modal|local|none`) re-validate unchanged.
- `apps/api/src/mcp/server.ts:528` already takes `z4.string().optional()` (looser) — no change, but now the registry validates the string at construction time, so an unknown backend fails fast with a typed error (see §5.4).
- `packages/config/src/index.ts:235` default stays `"docker"` — unchanged.
- Per-session/per-turn override path is untouched in shape: `turn.sandboxBackend ?? settings.sandboxBackend` (`apps/worker/src/activities/scheduled-tasks.ts:60`), `runSettings.sandboxBackend = turn.sandboxBackend` (`apps/worker/src/activities/agent-turn.ts:366`).

### 1.3 Parity test (NEW)

`packages/sdk/test/contract-parity.test.ts` already fails on drift between contracts and `sdk/types.ts`. Add an assertion that `SandboxBackend.options` (contracts) deep-equals the SDK array AND the deployment enum array — three-way, so a future provider can't be added to one and forgotten in another.

---

## 2. The `CapabilityDescriptor` type (static, per-provider)

### 2.1 The type (NEW file `packages/runtime/src/sandbox/capabilities.ts`)

```ts
import type { SandboxBackend } from "@opengeni/contracts";

/** Which of the 5 surfaced capabilities a backend can do, statically. */
export type CapabilityName = "FileSystem" | "Terminal" | "Git" | "DesktopStream" | "Recording";

/** How a terminal is surfaced. sse-events = ride Channel A; pty-ws = real PTY socket. */
export type TerminalTransport = "sse-events" | "pty-ws" | null;

/** How desktop pixels reach a viewer. vnc-ws = v1 noVNC; webrtc = v3 future. */
export type DesktopTransport = "vnc-ws" | "webrtc" | null;

/** Provider-native snapshot kind backing persistWorkspace/hydrate. */
export type SnapshotKind =
  | "native-fs"          // modal snapshot_filesystem, e2b snapshot, runloop snapshotDisk
  | "native-dir"         // modal snapshot_directory
  | "native-snapshot-id" // vercel snapshot({expiration}) -> snapshotId
  | "tar-only"           // daytona, blaxel, cloudflare (persistWorkspaceTar)
  | "none";              // local / docker dev

/** How an exposed port becomes a viewer-reachable URL. */
export type PortExposureKind =
  | "tunnel-tls-tcp"        // modal tunnels() — raw L4 TLS-TCP passthrough
  | "signed-preview-url"    // daytona getSignedPreviewUrl(port, ttl)
  | "tunnel-v2"             // runloop net.enableTunnel + getTunnelUrl
  | "preview-token"         // blaxel previews.createIfNotExists (public | bl_preview_token)
  | "get-host"              // e2b getHost(port)
  | "domain"                // vercel sandbox.domain(port) — headless tier only
  | "none";                 // cloudflare (resolveExposedPort THROWS), local, none

export type SandboxOs = "linux"; // macOS/Windows reserved; no provider offers them today

/** Lifetime quirks that the owner/keep-alive and rollover logic must respect. */
export interface LifetimeDescriptor {
  /** Hard wall-clock ceiling in ms, after which the box dies. undefined = none published. */
  hardLifetimeMs?: number;
  /** Whether crossing hardLifetime requires a snapshot-rollover (new instance id). */
  requiresSnapshotRollover: boolean;
  /** Provider has an idle/inactivity killer that keep-alive must defeat. */
  hasIdleKiller: boolean;
  /** The config knob that disables/extends idle-kill, if any (doc only). */
  idleKillDisableHint?: string;
  /** Native suspend/resume (pause the box, resume cheaply) vs only delete+recreate. */
  supportsSuspendResume: boolean;
  /** resume()/fromId takes NO lock — a 2nd control handle is SAFE (Modal R4). */
  resumeIsLockFree: boolean;
}

export interface CapabilityDescriptor {
  backend: SandboxBackend;
  /** Matches SandboxClient.backendId from the SDK (assert at registry build). */
  backendId: string;
  tier: "desktop" | "headless" | "dev" | "none";

  capabilities: {
    FileSystem:    { available: boolean; readOnly: boolean };
    Terminal:      { available: boolean; transport: TerminalTransport };
    Git:           { available: boolean };
    DesktopStream: { available: boolean; transport: DesktopTransport };
    Recording:     { available: boolean; mode?: "ffmpeg-x11grab" };
  };

  os: { supported: SandboxOs[]; default: SandboxOs };

  lifetime: LifetimeDescriptor;
  snapshot: { kind: SnapshotKind; hasTarFallback: boolean };
  portExposure: { kind: PortExposureKind; supportsOnDemandPorts: boolean };

  /** True only when create+resume+serialize are all implemented (singleton-safe). */
  persistable: boolean;
  /** Supports SDK runAs (multi-user) — affects desktop user separation. */
  supportsRunAs: boolean;

  /** Human note carried into negotiation diagnostics. */
  notes: string;
}
```

### 2.2 The descriptor table — AS DATA (the authoritative matrix)

Every field below is grounded in the SDK `dist/sandbox/<p>/sandbox.{d.ts,js}` survey (GROUND:sdk-clients) and the desktop survey (GROUND:capability-pattern §K).

```ts
export const CAPABILITY_DESCRIPTORS: Record<SandboxBackend, CapabilityDescriptor> = {
  modal: {
    backend: "modal", backendId: "modal", tier: "desktop",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "pty-ws" },   // supportsPty()=true hardcoded
      Git:        { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording:  { available: true, mode: "ffmpeg-x11grab" },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: 24 * 60 * 60 * 1000,    // hard 24h
      requiresSnapshotRollover: true,
      hasIdleKiller: true, idleKillDisableHint: "idleTimeoutMs (raise) + keep-alive exec",
      supportsSuspendResume: true,             // snapshotFilesystem + fromId resume
      resumeIsLockFree: true,                  // R4 SAFE: fromId no-lock, per-call (no pool) — a 2nd control handle is safe
    },
    snapshot: { kind: "native-fs", hasTarFallback: true },     // snapshot_filesystem|snapshot_directory|tar
    portExposure: { kind: "tunnel-tls-tcp", supportsOnDemandPorts: false }, // ports pre-declared
    persistable: true, supportsRunAs: true,
    notes: "PRIMARY. Clears all desktop gates. 24h -> snapshot-rollover. R4 second-handle safe.",
  },

  daytona: {
    backend: "daytona", backendId: "daytona", tier: "desktop",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "pty-ws" },   // process.createPty conditional
      Git:        { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording:  { available: true, mode: "ffmpeg-x11grab" },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: 24 * 60 * 60 * 1000,
      requiresSnapshotRollover: false,         // tar persist, no hard rollover semantics
      hasIdleKiller: true, idleKillDisableHint: "autoStopInterval=0 disables idle-kill",
      supportsSuspendResume: false,            // stop/recreate; tar-only
      resumeIsLockFree: false,                 // routes through assertResumeRecreateAllowed
    },
    snapshot: { kind: "tar-only", hasTarFallback: true },
    portExposure: { kind: "signed-preview-url", supportsOnDemandPorts: false }, // ports pre-declared, TTL'd token-in-URL
    persistable: true, supportsRunAs: true,
    notes: "Cleanest signed token-in-URL preview. 4vCPU/8GB/10GB ceiling. Recommended 2nd provider.",
  },

  runloop: {
    backend: "runloop", backendId: "runloop", tier: "desktop",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "sse-events" }, // supportsPty()=FALSE -> events only
      Git:        { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording:  { available: true, mode: "ffmpeg-x11grab" },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: undefined,
      requiresSnapshotRollover: false,
      hasIdleKiller: true, idleKillDisableHint: "timeouts.keepAlive / keep_alive_time_seconds",
      supportsSuspendResume: true,             // snapshotDisk + suspend/resume (Pro tier $250/mo)
      resumeIsLockFree: false,
    },
    snapshot: { kind: "native-fs", hasTarFallback: true },
    portExposure: { kind: "tunnel-v2", supportsOnDemandPorts: true }, // Tunnels v2: one tunnel all ports, bearer token
    persistable: true, supportsRunAs: false,   // runAs throws
    notes: "Best lifecycle (keepAlive, native suspend/resume). No PTY -> terminal-as-events.",
  },

  e2b: {
    backend: "e2b", backendId: "e2b", tier: "desktop",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "pty-ws" },   // pty?.create conditional
      Git:        { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" }, // official e2b-dev/desktop XFCE+VNC+noVNC
      Recording:  { available: true, mode: "ffmpeg-x11grab" },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: 24 * 60 * 60 * 1000,     // 24h Pro / 1h Hobby
      requiresSnapshotRollover: false,
      hasIdleKiller: true, idleKillDisableHint: "timeoutAction='pause' + autoResume",
      supportsSuspendResume: true,             // createSnapshot + pause; native fs snapshot
      resumeIsLockFree: false,
    },
    snapshot: { kind: "native-fs", hasTarFallback: true },
    portExposure: { kind: "get-host", supportsOnDemandPorts: false }, // exposedPorts must be configured
    persistable: true, supportsRunAs: false,
    notes: "R1 PROVEN via official desktop image. Documented multi-client connect-by-id. ~150ms cold.",
  },

  blaxel: {
    backend: "blaxel", backendId: "blaxel", tier: "desktop",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "pty-ws" },   // Boolean(sandboxUrl && apiKey) conditional
      Git:        { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" }, // official blaxel/xfce-vnc
      Recording:  { available: true, mode: "ffmpeg-x11grab" },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: undefined,
      requiresSnapshotRollover: false,
      hasIdleKiller: true, idleKillDisableHint: "ttl / pauseOnExit",
      supportsSuspendResume: false,            // tar-only, no native fs snapshot (CONFIRMED no)
      resumeIsLockFree: false,
    },
    snapshot: { kind: "tar-only", hasTarFallback: true },
    portExposure: { kind: "preview-token", supportsOnDemandPorts: true }, // ANY port on-demand, public|bl_preview_token, re-mintable
    persistable: true, supportsRunAs: false,
    notes: "Most flexible port exposure (on-demand any port, scoped frontend tokens via fromSession). R4 undocumented.",
  },

  cloudflare: {
    backend: "cloudflare", backendId: "cloudflare", tier: "headless",
    capabilities: {
      FileSystem: { available: true, readOnly: false },        // /workspace root LOCKED
      Terminal:   { available: true, transport: "pty-ws" },    // supportsPty()=true hardcoded
      Git:        { available: true },
      DesktopStream: { available: false, transport: null },    // resolveExposedPort THROWS (sandbox.js:264)
      Recording:  { available: false },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: undefined,
      requiresSnapshotRollover: false,
      hasIdleKiller: true, idleKillDisableHint: "keepAlive/sleepAfter NOT exposed by SDK",
      supportsSuspendResume: false,            // fresh-disk-after-sleep, tar-only
      resumeIsLockFree: false,
    },
    snapshot: { kind: "tar-only", hasTarFallback: true },
    portExposure: { kind: "none", supportsOnDemandPorts: false }, // STUB
    persistable: true, supportsRunAs: true,
    notes: "HEADLESS-ONLY. resolveExposedPort hard-throws SandboxUnsupportedFeatureError. /workspace root lock.",
  },

  vercel: {
    backend: "vercel", backendId: "vercel", tier: "headless",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "sse-events" }, // supportsPty()=FALSE
      Git:        { available: true },
      DesktopStream: { available: false, transport: null },     // headless: no custom image, no port-to-VNC
      Recording:  { available: false },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: 5 * 60 * 60 * 1000,      // hard 5h cap
      requiresSnapshotRollover: false,
      hasIdleKiller: false,                    // timeoutMs governs; no separate idle killer
      supportsSuspendResume: true,             // snapshot({expiration}) -> snapshotId
      resumeIsLockFree: false,                 // 2nd handle SHARES the one VM (422 on concurrent exec)
    },
    snapshot: { kind: "native-snapshot-id", hasTarFallback: true },
    portExposure: { kind: "domain", supportsOnDemandPorts: false }, // resolves, but no custom-image desktop
    persistable: true, supportsRunAs: false,
    notes: "HEADLESS tier. 5h cap, node/python runtimes only, no PTY, single-session (2nd handle shares VM).",
  },

  docker: {
    backend: "docker", backendId: "docker", tier: "dev",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "pty-ws" },
      Git:        { available: true },
      DesktopStream: { available: false, transport: null },     // headless sandbox.Dockerfile; desktop image net-new
      Recording:  { available: false },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: undefined, requiresSnapshotRollover: false,
      hasIdleKiller: false, supportsSuspendResume: false, resumeIsLockFree: true,
    },
    snapshot: { kind: "none", hasTarFallback: false },
    portExposure: { kind: "none", supportsOnDemandPorts: false }, // local docker; reachable:false in deployed mode
    persistable: false, supportsRunAs: true,
    notes: "Dev/local container. Channel A only unless a desktop image + host port-publish is added.",
  },

  local: {
    backend: "local", backendId: "local", tier: "dev",
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal:   { available: true, transport: "pty-ws" },
      Git:        { available: true },
      DesktopStream: { available: false, transport: null },
      Recording:  { available: false },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: undefined, requiresSnapshotRollover: false,
      hasIdleKiller: false, supportsSuspendResume: false, resumeIsLockFree: true,
    },
    snapshot: { kind: "none", hasTarFallback: false },
    portExposure: { kind: "none", supportsOnDemandPorts: false },
    persistable: false, supportsRunAs: false,
    notes: "UnixLocalSandboxClient. Dev only. reachable:false when deployed -> Channel-A-only degrade.",
  },

  none: {
    backend: "none", backendId: "none", tier: "none",
    capabilities: {
      FileSystem: { available: false, readOnly: true },
      Terminal:   { available: false, transport: null },
      Git:        { available: false },
      DesktopStream: { available: false, transport: null },
      Recording:  { available: false },
    },
    os: { supported: ["linux"], default: "linux" },
    lifetime: {
      hardLifetimeMs: undefined, requiresSnapshotRollover: false,
      hasIdleKiller: false, supportsSuspendResume: false, resumeIsLockFree: false,
    },
    snapshot: { kind: "none", hasTarFallback: false },
    portExposure: { kind: "none", supportsOnDemandPorts: false },
    persistable: false, supportsRunAs: false,
    notes: "No sandbox. Factory returns undefined. All capabilities false.",
  },
};
```

### 2.3 Boot-time descriptor invariants (a registry self-test, run once)

```ts
export function assertDescriptorRegistryInvariants(): void {
  for (const b of SandboxBackend.options) {
    const d = CAPABILITY_DESCRIPTORS[b];
    if (!d) throw new Error(`No CapabilityDescriptor for backend "${b}"`);
    if (d.backend !== b) throw new Error(`Descriptor.backend mismatch for "${b}"`);

    // DesktopStream implies a non-null port-exposure mechanism (split-plane B).
    if (d.capabilities.DesktopStream.available && d.portExposure.kind === "none")
      throw new Error(`"${b}" claims DesktopStream but portExposure.kind=none`);

    // DesktopStream implies Recording feasibility (same Xvfb display).
    if (d.capabilities.DesktopStream.available && !d.capabilities.Recording.available)
      throw new Error(`"${b}" desktop without recording — Xvfb supports x11grab`);

    // Persistable backends MUST be the only ones the lease can re-establish from envelope.
    if (d.persistable && d.snapshot.kind === "none")
      throw new Error(`"${b}" persistable but snapshot.kind=none`);
  }
}
```

This is called once from the registry module-init and from a unit test. It is the guardrail that keeps the descriptor table honest as providers are added.

---

## 3. The provider registry (replacing the if/else)

### 3.1 Per-provider module shape (NEW dir `packages/runtime/src/sandbox/providers/`)

One file per provider implementing a uniform `ProviderRegistration`. This replaces the flat if-chain at `packages/runtime/src/index.ts:763-795`.

```ts
// packages/runtime/src/sandbox/providers/types.ts
import type { Settings } from "@opengeni/config";
import type { SandboxBackend } from "@opengeni/contracts";
import type { CapabilityDescriptor } from "../capabilities";

export interface ProviderConstructionContext {
  settings: Settings;
  /** The env map for the box (collectSandboxEnvironment / per-run environment). */
  environment: Record<string, string>;
  /** Parsed exposed ports (config string -> number[]); includes the desktop port (6080) when desktop tier. */
  exposedPorts: number[];
}

export interface ProviderRegistration {
  backend: SandboxBackend;
  descriptor: CapabilityDescriptor;
  /**
   * Validate that the settings carry the credentials/config this provider
   * REQUIRES. Throw SandboxConfigError on any missing/contradictory field.
   * Pure — no network. Called by both the factory and a deploy-time preflight.
   */
  validateCredentials(settings: Settings): void;
  /**
   * Build the raw SDK SandboxClient. May return undefined ONLY for "none".
   * Throws SandboxConfigError if validateCredentials would have thrown
   * (factory calls validateCredentials first, so build can assume valid).
   */
  build(ctx: ProviderConstructionContext): unknown;
}
```

### 3.2 Example registration — Modal (the others mirror this exactly)

```ts
// packages/runtime/src/sandbox/providers/modal.ts
import { ModalImageSelector, ModalSandboxClient } from "@openai/agents-extensions/sandbox/modal";
import { CAPABILITY_DESCRIPTORS } from "../capabilities";
import { SandboxConfigError } from "../errors";
import type { ProviderRegistration } from "./types";

export const modalProvider: ProviderRegistration = {
  backend: "modal",
  descriptor: CAPABILITY_DESCRIPTORS.modal,
  validateCredentials(settings) {
    // both-or-neither (preserves existing validation at config:985)
    if (Boolean(settings.modalTokenId) !== Boolean(settings.modalTokenSecret))
      throw new SandboxConfigError("modal", "OPENGENI_MODAL_TOKEN_ID and OPENGENI_MODAL_TOKEN_SECRET must both be set or both omitted");
    if (!settings.modalAppName)
      throw new SandboxConfigError("modal", "OPENGENI_MODAL_APP_NAME is required");
  },
  build({ settings, environment, exposedPorts }) {
    const options: ConstructorParameters<typeof ModalSandboxClient>[0] = {
      appName: settings.modalAppName,
      timeoutMs: settings.modalTimeoutSeconds * 1000,
      ...(settings.modalIdleTimeoutSeconds ? { idleTimeoutMs: settings.modalIdleTimeoutSeconds * 1000 } : {}), // GAP fill
      ...(settings.modalWorkspacePersistence ? { workspacePersistence: settings.modalWorkspacePersistence } : {}),
      exposedPorts,
      env: environment,
    };
    if (settings.modalImageRef) options.image = ModalImageSelector.fromTag(settings.modalImageRef);
    if (settings.modalTokenId) options.tokenId = settings.modalTokenId;
    if (settings.modalTokenSecret) options.tokenSecret = settings.modalTokenSecret;
    if (settings.modalEnvironment) options.environment = settings.modalEnvironment;
    return new ModalSandboxClient(options);
  },
};
```

### 3.3 The registry index + new `createSandboxClient`

```ts
// packages/runtime/src/sandbox/providers/index.ts
import type { SandboxBackend } from "@opengeni/contracts";
import { dockerProvider } from "./docker";
import { modalProvider } from "./modal";
import { localProvider } from "./local";
import { noneProvider } from "./none";
import { daytonaProvider } from "./daytona";
import { runloopProvider } from "./runloop";
import { e2bProvider } from "./e2b";
import { blaxelProvider } from "./blaxel";
import { cloudflareProvider } from "./cloudflare";
import { vercelProvider } from "./vercel";
import type { ProviderRegistration } from "./types";

export const PROVIDER_REGISTRY: Record<SandboxBackend, ProviderRegistration> = {
  docker: dockerProvider, modal: modalProvider, local: localProvider, none: noneProvider,
  daytona: daytonaProvider, runloop: runloopProvider, e2b: e2bProvider,
  blaxel: blaxelProvider, cloudflare: cloudflareProvider, vercel: vercelProvider,
};
```

```ts
// packages/runtime/src/index.ts  (REPLACES :763-795)
export function createSandboxClient(
  settings: Settings,
  environment = collectSandboxEnvironment(settings),
): unknown {
  const reg = PROVIDER_REGISTRY[settings.sandboxBackend];
  if (!reg) {
    throw new SandboxConfigError(settings.sandboxBackend, `Unknown sandbox backend "${settings.sandboxBackend}"`);
  }
  if (reg.backend === "none") return undefined;
  reg.validateCredentials(settings);  // fail-fast, typed
  const exposedPorts = parseExposedPorts(settings.dockerExposedPorts);
  const raw = reg.build({ settings, environment, exposedPorts });
  // Docker network decoration stays backend-specific (only docker).
  return reg.backend === "docker" ? withDockerNetwork(raw as SandboxClient, settings.dockerNetwork) : raw;
}
```

**Decoration stack preserved:** `withDockerNetwork` (`:797`) stays docker-only; `withManifestRefreshOnResume` (`:1090`, applied `:1007`), `withSandboxFileDownloads` (`:1012`), `withSandboxLifecycleHooks` (`:1018`) all wrap the **return value of `createSandboxClient`** in `runAgentStream` and are backend-agnostic (spread pattern). No change to those — they wrap whatever the registry returns. Resume/serialize plumbing (`restoredSandboxSessionState` `:1637`, `deserializeSandboxSessionStateEnvelope` `:1700`) is already backend-generic via `client.backendId` + `client.deserializeSessionState` — **no change** (the `backendId` assertions at `:1654,:1694` now correctly fence a session to its origin provider).

### 3.4 `exposedPorts` ownership note (desktop port)

The desktop port (`6080`, per GROUND:desktop-stack) is NOT this module's to launch, but it MUST be in `exposedPorts` at construction for the providers whose `supportsOnDemandPorts: false` (modal, daytona, e2b, vercel) — otherwise `resolveExposedPort(6080)` will reject. The registry's `build` receives `exposedPorts` already including the desktop port when `descriptor.capabilities.DesktopStream.available && settings.sandboxDesktopEnabled`. The desktop-port-injection rule:

```ts
// in createSandboxClient, before build:
const exposedPorts = parseExposedPorts(settings.dockerExposedPorts);
if (reg.descriptor.capabilities.DesktopStream.available
    && settings.sandboxDesktopEnabled
    && !reg.descriptor.portExposure.supportsOnDemandPorts
    && !exposedPorts.includes(DESKTOP_STREAM_PORT)) {
  exposedPorts.push(DESKTOP_STREAM_PORT); // 6080
}
```

For `runloop`/`blaxel` (`supportsOnDemandPorts: true`) the port is resolved on demand by the handshake module; no pre-declaration needed.

---

### 3.5 The shared `@opengeni/runtime/sandbox` access module (extraction + API import + Modal-token wiring)

**Why this section exists.** Under the corrected control-plane model (`00-master-spine.md` §B, `02-owner.md` §6.3), the **control plane is API-DIRECT: client → `apps/api` → box**. For ALL non-turn ops — viewer attach, mint/rotate the desktop tunnel URL, FileSystem list/read for the Pierre tree, Git status/diff, capability negotiation — the `apps/api` process itself does `resume()`-by-id from the lease envelope, `session.exec`/`readFile`, and `resolveExposedPort` **in-process**, and runs the cold→warming lease CAS as a Postgres transaction it owns. There is **no Temporal, no worker RPC, and no NATS request-reply in the synchronous control path.** Temporal hosts exactly two things (the long-running agent **turn** via `sessionWorkflow`, and **one global reaper** as a Temporal Schedule); nothing in this module routes through either.

For the API to do this, it must import the provider factory + the envelope (de)serializers **without** dragging in the `@openai/agents` / `@openai/agents-extensions` agent-loop graph that `packages/runtime/src/index.ts` wires through `runAgentStream`/`Runner` (the model-provider, tools, streaming machinery the API has no business loading). That is a packaging refactor, not a behavioral change — the functions already have **zero coupling** to the agent loop or Temporal (`packages/runtime` has **no `@temporalio` dep**; verified `packages/runtime/package.json`).

**The barrel today.** `packages/runtime/package.json` has `main`/`types` → `./src/index.ts` and **no `exports` map**, so any importer of `@opengeni/runtime` transitively loads `index.ts`, whose top-level `import` pulls in `@openai/agents-extensions/sandbox/modal` (`index.ts:57`) and the whole agent-loop graph. A subpath that resolves to a leaf module is required so `apps/api` imports the sandbox-access symbols **without** that graph.

**3.5.1 — Symbols to extract into the leaf module.** Pull these out of the `@opengeni/runtime` barrel into a self-contained `packages/runtime/src/sandbox/index.ts` (alongside the registry/descriptor/select files this module already introduces) so they live behind a `@openai/agents`-free import boundary:

- `createSandboxClient` (the provider factory; today `index.ts:763`, after this module it is registry-driven per §3.3)
- `deserializeSandboxSessionStateEnvelope` (today `index.ts:1700`)
- `restoredSandboxSessionStateFromEntry` (today `index.ts:1690`)
- `sandboxStateEntryFromRunState` (today `index.ts:1665`)
- the construction helpers they transitively need that are likewise agent-loop-free: `collectSandboxEnvironment`, `parseExposedPorts`, `withDockerNetwork`, and the `SandboxConfigError` (§5.1) + `PROVIDER_REGISTRY`/`CAPABILITY_DESCRIPTORS`/`negotiateCapabilities` symbols this module already defines.

The `02-owner.md` consumers `establishSandboxSessionFromEnvelope` and `exposeStreamPort` (§6.3 there) are **thin wrappers the owner module adds on top of these primitives** — they belong in the same leaf module and are likewise agent-loop-free (`establishSandboxSessionFromEnvelope` reuses `deserializeSandboxSessionStateEnvelope`; `exposeStreamPort` is a `resolveExposedPort` call on the resumed handle). Naming them here keeps the cross-reference honest; their bodies are specified in `02-owner.md`.

The `SandboxSessionState` type and the SDK `SandboxClient`/`ExposedPortEndpoint` types these signatures mention come from `@openai/agents-core/sandbox` (the **core** sandbox types, no agent-loop runtime), so they cross the boundary as types only — no runtime agent-loop import.

**3.5.2 — Subpath export + dependency edges.** Give the leaf module a stable specifier and keep the existing barrel working:

```jsonc
// packages/runtime/package.json — add an exports map (the barrel stays the default)
"exports": {
  ".":        { "import": "./src/index.ts", "types": "./src/index.ts" },        // unchanged: agent-loop-bearing barrel for apps/worker
  "./sandbox":{ "import": "./src/sandbox/index.ts", "types": "./src/sandbox/index.ts" } // NEW: agent-loop-FREE access module for apps/api
}
```

- `packages/runtime/src/index.ts` **re-exports** the moved symbols from `./sandbox` (`export * from "./sandbox"`) so `apps/worker` and every existing importer of `@opengeni/runtime` is unchanged (no churn at call sites; the worker's turn path keeps importing `runAgentStream` + the sandbox fns from the barrel).
- `apps/api/package.json` — **add `"@opengeni/runtime": "workspace:*"`** (it currently deps `@opengeni/config`/`@opengeni/contracts`/`@opengeni/db` only; verified). `apps/api` imports the access symbols **exclusively** via `@opengeni/runtime/sandbox`, never the bare `@opengeni/runtime` barrel — this is the line that keeps the `@openai/agents` graph out of the API process. A lint/grep guard (no `from "@opengeni/runtime"` without `/sandbox` in `apps/api/src`) pins the boundary.
- **Boundary invariant (assert in CI):** `packages/runtime/src/sandbox/**` must not transitively `import` from `@openai/agents` or `@openai/agents-extensions` **runtime** entry points (type-only imports from `@openai/agents-core/sandbox` are allowed). `index.ts:57`'s `ModalSandboxClient`/`ModalImageSelector`/`ModalCloudBucketMountStrategy` import moves **into the per-provider module** `packages/runtime/src/sandbox/providers/modal.ts` (already the case per §3.2), so the leaf module's only `@openai/agents-extensions` touch is the per-provider `build()` import — which is the **provider SDK**, not the agent loop. (If a future bundler complains that `@openai/agents-extensions/sandbox/modal` drags the agent loop, the §4.5 dynamic-`import` escape hatch applies here too.)

**3.5.3 — Plumb the Modal token into the API's Modal-client construction.** The API constructs its Modal client the same way the worker does — through `createSandboxClient(settings, …)` (§3.3) — so the Modal credentials must reach the API process's `settings`:

- The Modal token is **already parsed by the shared `getSettings()`** (`packages/config/src/index.ts:405`), which reads `OPENGENI_MODAL_TOKEN_ID`/`OPENGENI_MODAL_TOKEN_SECRET`/`OPENGENI_MODAL_APP_NAME` from env (`:476,:479,:480`). `apps/api` already deps `@opengeni/config`, so it calls the same `getSettings()` and gets the same `settings.modalTokenId`/`modalTokenSecret`/`modalAppName`. **No new config field, no new parse path** — the API hands those settings to `createSandboxClient`, and `modalProvider.build()` (§3.2) sets `options.tokenId`/`options.tokenSecret` from them. The both-or-neither validation (§3.2 / `config:985`) applies identically in the API process.
- **Deployment wiring:** the `apps/api` runtime env must therefore carry `OPENGENI_MODAL_TOKEN_ID`/`OPENGENI_MODAL_TOKEN_SECRET` (delivered as secrets) and `OPENGENI_MODAL_APP_NAME` — the **same** `SANDBOX_REQUIRED_ENV[backend]` set (§6.1) that the worker already receives, now also injected into the API deployment. Today only the worker gets the Modal secret; the API-direct control plane means the API needs it too. (The descriptor/registry/config schema are otherwise unchanged by this — the API and worker share one provider registry and one settings shape.)
- **Egress:** the API process must reach `api.modal.com` (the Modal control endpoint `resume()`/`fromId`/`resolveExposedPort` call). The API **already** makes outbound HTTPS to third parties (Stripe/OpenAI/GitHub), so this is an additional allowed egress host, not a new network capability. For non-Modal providers the analogous host is the provider's API base (`daytonaApiUrl`, `runloopBaseUrl`, etc., §4.1) — same pattern.

**3.5.4 — What does NOT change.** Providers, descriptors, the enum, the config schema, the selection/negotiation functions (§1–§2, §4–§5) are **unchanged** by the extraction — this is a packaging/import-boundary refactor plus a deployment-env addition, not a redesign. `createSandboxClient`'s signature and body (§3.3) are identical whether called from the worker (turn path) or the API (non-turn ops); the same registry, the same descriptors, the same `validateCredentials`. The extraction only changes **which file** the symbols live in and **which packages** can import them without the agent loop.

---

## 4. Config schema + env + validation (per provider)

### 4.1 New settings fields (`packages/config/src/index.ts`, after `:244`)

Grounded field-by-field against the SDK `*ClientOptions` interfaces dumped in the investigation. Only the **load-bearing** knobs are surfaced as settings; the rest take SDK defaults.

```ts
  // --- modal gap fill (idleTimeoutMs + workspacePersistence were unmapped) ---
  modalIdleTimeoutSeconds: z.coerce.number().int().positive().optional(),
  modalWorkspacePersistence: z.enum(["tar", "snapshot_filesystem", "snapshot_directory"]).optional(),

  // --- shared desktop toggle (this module reads it; owner module acts on it) ---
  sandboxDesktopEnabled: EnvBoolean.default(false),

  // --- daytona ---
  daytonaApiKey: z.string().optional(),
  daytonaApiUrl: z.string().url().optional(),
  daytonaTarget: z.string().optional(),
  daytonaImage: z.string().optional(),
  daytonaSnapshotName: z.string().optional(),
  daytonaAutoStopInterval: z.coerce.number().int().nonnegative().optional(), // 0 disables idle-kill
  daytonaTimeoutSeconds: z.coerce.number().int().positive().optional(),
  daytonaExposedPortUrlTtlSeconds: z.coerce.number().int().positive().optional(),

  // --- runloop ---
  runloopApiKey: z.string().optional(),
  runloopBaseUrl: z.string().url().optional(),
  runloopBlueprintName: z.string().optional(),
  runloopBlueprintId: z.string().optional(),
  runloopTunnel: EnvBoolean.default(true),            // tunnel?: boolean
  runloopKeepAliveSeconds: z.coerce.number().int().positive().optional(),

  // --- e2b (SDK reads E2B_API_KEY from env; we mirror to settings for validation+forwarding) ---
  e2bApiKey: z.string().optional(),
  e2bTemplate: z.string().optional(),
  e2bTimeoutSeconds: z.coerce.number().int().positive().optional(),
  e2bTimeoutAction: z.enum(["pause", "kill"]).optional(),
  e2bAllowInternetAccess: EnvBoolean.optional(),
  e2bAutoResume: EnvBoolean.optional(),
  e2bWorkspacePersistence: z.enum(["tar", "snapshot"]).optional(), // SDK also accepts `true`

  // --- blaxel ---
  blaxelApiKey: z.string().optional(),
  blaxelImage: z.string().optional(),
  blaxelRegion: z.string().optional(),
  blaxelExposedPortPublic: EnvBoolean.optional(),     // public vs bl_preview_token
  blaxelExposedPortUrlTtlSeconds: z.coerce.number().int().positive().optional(),
  blaxelMemoryMb: z.coerce.number().int().positive().optional(),
  blaxelTtl: z.string().optional(),

  // --- cloudflare (headless) ---
  cloudflareWorkerUrl: z.string().url().optional(),   // REQUIRED iff backend===cloudflare
  cloudflareApiKey: z.string().optional(),

  // --- vercel (headless) ---
  vercelToken: z.string().optional(),
  vercelProjectId: z.string().optional(),
  vercelTeamId: z.string().optional(),
  vercelRuntime: z.string().optional(),
  vercelTimeoutSeconds: z.coerce.number().int().positive().optional(), // capped 5h by provider
```

### 4.2 New env mappings (`packages/config/src/index.ts`, after `:481`)

```ts
    modalIdleTimeoutSeconds: optional("OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS"),
    modalWorkspacePersistence: optional("OPENGENI_MODAL_WORKSPACE_PERSISTENCE"),
    sandboxDesktopEnabled: optional("OPENGENI_SANDBOX_DESKTOP_ENABLED"),

    daytonaApiKey: optional("OPENGENI_DAYTONA_API_KEY"),
    daytonaApiUrl: optional("OPENGENI_DAYTONA_API_URL"),
    daytonaTarget: optional("OPENGENI_DAYTONA_TARGET"),
    daytonaImage: optional("OPENGENI_DAYTONA_IMAGE"),
    daytonaSnapshotName: optional("OPENGENI_DAYTONA_SNAPSHOT_NAME"),
    daytonaAutoStopInterval: optional("OPENGENI_DAYTONA_AUTO_STOP_INTERVAL"),
    daytonaTimeoutSeconds: optional("OPENGENI_DAYTONA_TIMEOUT_SECONDS"),
    daytonaExposedPortUrlTtlSeconds: optional("OPENGENI_DAYTONA_EXPOSED_PORT_URL_TTL_SECONDS"),

    runloopApiKey: optional("OPENGENI_RUNLOOP_API_KEY"),
    runloopBaseUrl: optional("OPENGENI_RUNLOOP_BASE_URL"),
    runloopBlueprintName: optional("OPENGENI_RUNLOOP_BLUEPRINT_NAME"),
    runloopBlueprintId: optional("OPENGENI_RUNLOOP_BLUEPRINT_ID"),
    runloopTunnel: optional("OPENGENI_RUNLOOP_TUNNEL"),
    runloopKeepAliveSeconds: optional("OPENGENI_RUNLOOP_KEEP_ALIVE_SECONDS"),

    e2bApiKey: optional("OPENGENI_E2B_API_KEY"),       // also exported AS E2B_API_KEY for SDK (see 4.4)
    e2bTemplate: optional("OPENGENI_E2B_TEMPLATE"),
    e2bTimeoutSeconds: optional("OPENGENI_E2B_TIMEOUT_SECONDS"),
    e2bTimeoutAction: optional("OPENGENI_E2B_TIMEOUT_ACTION"),
    e2bAllowInternetAccess: optional("OPENGENI_E2B_ALLOW_INTERNET_ACCESS"),
    e2bAutoResume: optional("OPENGENI_E2B_AUTO_RESUME"),
    e2bWorkspacePersistence: optional("OPENGENI_E2B_WORKSPACE_PERSISTENCE"),

    blaxelApiKey: optional("OPENGENI_BLAXEL_API_KEY"),
    blaxelImage: optional("OPENGENI_BLAXEL_IMAGE"),
    blaxelRegion: optional("OPENGENI_BLAXEL_REGION"),
    blaxelExposedPortPublic: optional("OPENGENI_BLAXEL_EXPOSED_PORT_PUBLIC"),
    blaxelExposedPortUrlTtlSeconds: optional("OPENGENI_BLAXEL_EXPOSED_PORT_URL_TTL_SECONDS"),
    blaxelMemoryMb: optional("OPENGENI_BLAXEL_MEMORY_MB"),
    blaxelTtl: optional("OPENGENI_BLAXEL_TTL"),

    cloudflareWorkerUrl: optional("OPENGENI_CLOUDFLARE_WORKER_URL"),
    cloudflareApiKey: optional("OPENGENI_CLOUDFLARE_API_KEY"),

    vercelToken: optional("OPENGENI_VERCEL_TOKEN"),
    vercelProjectId: optional("OPENGENI_VERCEL_PROJECT_ID"),
    vercelTeamId: optional("OPENGENI_VERCEL_TEAM_ID"),
    vercelRuntime: optional("OPENGENI_VERCEL_RUNTIME"),
    vercelTimeoutSeconds: optional("OPENGENI_VERCEL_TIMEOUT_SECONDS"),
```

### 4.3 Cross-field validation (`packages/config/src/index.ts`, after `:986`)

Validation is **backend-gated** — only enforce a provider's required creds when that backend is actually selected. This keeps a Modal-only deployment from needing Daytona keys. The `validateCredentials` in each `ProviderRegistration` (§3.1) is the authoritative copy; config-level validation calls the same predicate logic for the *currently selected default backend*, but per-turn overrides are validated at construction in `createSandboxClient`.

```ts
  // existing modal both-or-neither stays at :985

  const reqd = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  switch (settings.sandboxBackend) {
    case "daytona":
      reqd(!!settings.daytonaApiKey, "daytona backend requires OPENGENI_DAYTONA_API_KEY");
      break;
    case "runloop":
      reqd(!!settings.runloopApiKey, "runloop backend requires OPENGENI_RUNLOOP_API_KEY");
      reqd(!!(settings.runloopBlueprintName || settings.runloopBlueprintId),
           "runloop backend requires OPENGENI_RUNLOOP_BLUEPRINT_NAME or _ID");
      break;
    case "e2b":
      reqd(!!settings.e2bApiKey, "e2b backend requires OPENGENI_E2B_API_KEY");
      break;
    case "blaxel":
      reqd(!!settings.blaxelApiKey, "blaxel backend requires OPENGENI_BLAXEL_API_KEY");
      break;
    case "cloudflare":
      reqd(!!settings.cloudflareWorkerUrl, "cloudflare backend requires OPENGENI_CLOUDFLARE_WORKER_URL");
      break;
    case "vercel":
      reqd(!!settings.vercelToken && !!settings.vercelProjectId,
           "vercel backend requires OPENGENI_VERCEL_TOKEN and OPENGENI_VERCEL_PROJECT_ID");
      break;
  }

  // Desktop coherence: desktop requested on a headless-only backend is a misconfig.
  if (settings.sandboxDesktopEnabled
      && !CAPABILITY_DESCRIPTORS[settings.sandboxBackend].capabilities.DesktopStream.available) {
    throw new Error(`OPENGENI_SANDBOX_DESKTOP_ENABLED=true but backend "${settings.sandboxBackend}" is headless-only`);
  }
```

### 4.4 E2B env-var passthrough (special case)

E2B's SDK reads `E2B_API_KEY` from `process.env` directly (no `apiKey` constructor field). The registry's `e2b.build()` must, before constructing, ensure `process.env.E2B_API_KEY ??= settings.e2bApiKey` (or pass through the box `env`). Document this as the one provider whose credential is an env var, not a constructor arg. Vercel similarly resolves `VERCEL_TOKEN`/`VERCEL_PROJECT_ID`/`VERCEL_TEAM_ID` from env if the constructor fields are omitted — but we always pass them explicitly.

### 4.5 Peer-dep additions (`packages/runtime/package.json:15`)

`@openai/agents-extensions` declares these as optional peers (`peerDependenciesMeta.*.optional=true`). Add as direct deps so the registry's `import` resolves at runtime:

```
"@daytonaio/sdk": "^0.162.0",
"@runloop/api-client": "^1.16.2",
"@e2b/code-interpreter": "^2.3.3",
"e2b": "^2.14.1",
"@blaxel/core": "^0.2.82",
"@vercel/sandbox": "^1.9.3"
```

(`@cloudflare/sandbox` is bundled inside `@openai/agents-extensions`; no peer.) Each provider module's `import` is top-level; a missing optional dep surfaces as a module-resolution error at registry init — acceptable since the registry only imports a provider when its file is loaded, and all files are loaded at index time. **Decision:** keep all imports eager (the deps are small and the descriptor table needs no dynamic import); if bundle size matters later, switch the per-provider `build` to a dynamic `await import(...)` guarded by `descriptor` lookup.

---

## 5. Selection / negotiation / degradation (the consumer-facing API)

### 5.1 `SandboxConfigError` (NEW `packages/runtime/src/sandbox/errors.ts`)

```ts
export class SandboxConfigError extends Error {
  constructor(public readonly backend: string, message: string) {
    super(`[sandbox:${backend}] ${message}`);
    this.name = "SandboxConfigError";
  }
}
```

Maps to contract `ErrorCode.validation_failed` at the API boundary (`packages/contracts/src/index.ts:19`). Construction-time credential failure for a per-turn override surfaces here.

### 5.2 Backend selection (per session/workspace)

```ts
// packages/runtime/src/sandbox/select.ts
export interface BackendSelectionInput {
  /** Per-turn override (turn.sandboxBackend), highest precedence. */
  turnBackend?: SandboxBackend;
  /** Per-session pin (sessions.sandbox_backend), set at create. */
  sessionBackend?: SandboxBackend;
  /** Deployment default (settings.sandboxBackend). */
  defaultBackend: SandboxBackend;
  /** Whether the caller wants the desktop tier (session preference). */
  desktopRequested: boolean;
}

/** Precedence: turn > session > default. NEVER silently substitutes a provider. */
export function selectBackend(i: BackendSelectionInput): SandboxBackend {
  return i.turnBackend ?? i.sessionBackend ?? i.defaultBackend;
}
```

Selection is **pinning, not routing** — a session pinned to a provider stays on it for life (the `backendId` envelope assertions at `runtime:1654,1694` enforce this; you cannot resume a Modal envelope on an E2B client). Cross-provider migration is explicitly out of scope.

### 5.3 Capability negotiation + degradation (the handshake's source of truth)

```ts
// The value the control-plane handshake returns to a client (mirrors GROUND:capability-pattern §H).
export interface NegotiatedCapabilities {
  backend: SandboxBackend;
  reachable: boolean;                 // false for deployed local/docker (no provider tunnel)
  FileSystem:    { available: boolean; readOnly: boolean };
  Terminal:      { transport: TerminalTransport };
  Git:           { available: boolean };
  DesktopStream: { transport: DesktopTransport };   // null => degraded to Channel-A-only
  Recording:     { available: boolean };
  degradations: string[];             // human-readable reasons, ALWAYS surfaced, never silent
}

export function negotiateCapabilities(
  backend: SandboxBackend,
  opts: { desktopRequested: boolean; deployed: boolean },
): NegotiatedCapabilities {
  const d = CAPABILITY_DESCRIPTORS[backend];
  const degradations: string[] = [];

  // Rule 1: deployed dev backends are not viewer-reachable (no provider tunnel).
  const reachable = !(opts.deployed && (backend === "local" || backend === "docker"));
  if (!reachable) degradations.push(`backend "${backend}" not viewer-reachable when deployed; Channel-A only`);

  // Rule 2: desktop requested on a headless-only backend -> degrade, don't fail.
  let desktopTransport: DesktopTransport = d.capabilities.DesktopStream.transport;
  if (opts.desktopRequested && !d.capabilities.DesktopStream.available) {
    desktopTransport = null;
    degradations.push(`backend "${backend}" is headless-only (${d.portExposure.kind === "none" ? "no port exposure" : "no desktop image"}); desktop unavailable`);
  }
  if (!opts.desktopRequested) desktopTransport = null;

  return {
    backend, reachable,
    FileSystem: d.capabilities.FileSystem,
    Terminal: { transport: reachable ? d.capabilities.Terminal.transport : "sse-events" },
    Git: { available: d.capabilities.Git.available && reachable },
    DesktopStream: { transport: reachable ? desktopTransport : null },
    Recording: { available: d.capabilities.Recording.available && reachable && desktopTransport !== null },
    degradations,
  };
}
```

**Degradation invariant (settled):** degradation is ALWAYS a returned value, NEVER a silent fallback. A client asking for desktop on Cloudflare gets `DesktopStream:{transport:null}` + a `degradations[]` entry, and falls back to terminal+files+git on Channel A. The factory never substitutes a different provider.

### 5.4 Contract surface (`packages/contracts/src/index.ts`)

Add `NegotiatedCapabilities` as a Zod schema near `ClientConfig` (`:1425`) so the handshake route response is validated, and mirror into `packages/sdk/src/types.ts`. The `SessionCapabilities` shape from GROUND §H is the client-facing projection (drop `reachable`/`degradations` internals if desired, or surface them as advisory).

---

## 6. Deployment wiring (`packages/deployment/src/index.ts`)

### 6.1 Per-backend required-env blocks (two sites)

Replace the single `if (contract.sandbox.backend === "modal")` blocks at **`:863`** (`requiredRuntimeEnvVars`) and **`:1419`** (`buildRuntimeEnv`) with a table-driven map keyed by backend. Each provider declares its `requiredEnv` (must be present, delivered as secret) and `valueEnv` (rendered into config):

```ts
const SANDBOX_REQUIRED_ENV: Record<SandboxBackend, { secret: string[]; value: Array<[string, (s: SandboxSpec) => string | undefined]> }> = {
  modal:      { secret: ["OPENGENI_MODAL_TOKEN_ID", "OPENGENI_MODAL_TOKEN_SECRET"], value: [["OPENGENI_MODAL_APP_NAME", s => s.modalAppName]] },
  daytona:    { secret: ["OPENGENI_DAYTONA_API_KEY"], value: [] },
  runloop:    { secret: ["OPENGENI_RUNLOOP_API_KEY"], value: [["OPENGENI_RUNLOOP_BLUEPRINT_NAME", s => s.runloopBlueprintName]] },
  e2b:        { secret: ["OPENGENI_E2B_API_KEY"], value: [] },
  blaxel:     { secret: ["OPENGENI_BLAXEL_API_KEY"], value: [] },
  cloudflare: { secret: ["OPENGENI_CLOUDFLARE_API_KEY"], value: [["OPENGENI_CLOUDFLARE_WORKER_URL", s => s.cloudflareWorkerUrl]] },
  vercel:     { secret: ["OPENGENI_VERCEL_TOKEN"], value: [["OPENGENI_VERCEL_PROJECT_ID", s => s.vercelProjectId], ["OPENGENI_VERCEL_TEAM_ID", s => s.vercelTeamId]] },
  docker:     { secret: [], value: [] },
  local:      { secret: [], value: [] },
  none:       { secret: [], value: [] },
};
```

Both sites iterate `SANDBOX_REQUIRED_ENV[contract.sandbox.backend]`. `valueEnv("OPENGENI_SANDBOX_BACKEND", contract.sandbox.backend)` at `:1349` and Helm `config.OPENGENI_SANDBOX_BACKEND` at `:1546` are unchanged. `sandbox-readiness` check at `:768` (`backend !== "none"`) unchanged.

### 6.2 Profile defaults

`SandboxSpec.backend` (`:184`) hardcoded-modal profiles (`:342,:699,:713`) and docker (`:441`) stay. New desktop-capable preparation profiles for daytona/e2b/runloop are additive `SandboxSpec` entries — out of scope for this module beyond the enum acceptance; the profile authoring is a deployment-package concern.

---

## 7. Runtime env-mount generalization (backend-aware, this module supplies the data)

This module's descriptor is the **single source** the environment/mount code consults instead of hardcoding modal/docker. Two consumers:

### 7.1 `HOME` / workspace-root default (`apps/worker/src/activities/environment.ts:80-82`)

Today: `HOME ??= "/workspace"` only for docker/modal. Generalize via a descriptor-adjacent constant (the workspace root is a provider fact, add to the descriptor):

```ts
// add to CapabilityDescriptor:
workspaceRoot: string;   // modal:/workspace, runloop:/home/user, e2b:/home/user, cloudflare:/workspace (locked), ...
```

Then environment.ts reads `CAPABILITY_DESCRIPTORS[backend].workspaceRoot` for the `HOME` default. (Cloudflare's `/workspace` is hard-locked by the SDK — `sandbox.js:923`; descriptor records it.)

### 7.2 Storage×backend mount + signed-download matrices

- `objectStorageFileMount` (`packages/runtime/src/index.ts:1481-1509`) throws for `azure-blob`+`modal` and `aws-s3`/`gcs`. Each new backend × storage combo needs a row decided. This module does NOT decide the mount strategy (that is the file-resource module) — but the descriptor should carry `nativeBucketMount: boolean` (modal has `ModalCloudBucketMountStrategy` + `nativeCloudBucketSecretName`; others materialize via signed download). Add `nativeBucketMount` to the descriptor and let the mount code branch on it instead of `backend === "modal"`.
- `requiresSignedFileResourceDownloads` (`apps/worker/src/activities/agent-turn.ts:1059-1062`) keyed to `(docker,s3-compatible)` and `(modal,azure-blob)` — extend to a function over `(backend, storageBackend)` using `descriptor.nativeBucketMount` (native-mount backends don't need signed downloads; the rest do).

---

## 8. File-by-file change list (exhaustive)

| # | File | Change |
|---|---|---|
| 1 | `packages/contracts/src/index.ts:13` | extend `SandboxBackend` enum to 10 values |
| 2 | `packages/contracts/src/index.ts` (near `:1425`) | add `NegotiatedCapabilities`/`SessionCapabilities` Zod schema |
| 3 | `packages/deployment/src/index.ts:34` | extend `SandboxBackend` enum to 10 values |
| 4 | `packages/deployment/src/index.ts:863,:1419` | replace single modal-if with `SANDBOX_REQUIRED_ENV` table iteration |
| 5 | `packages/sdk/src/types.ts:14` | mirror enum; add capability types |
| 6 | `packages/sdk/test/contract-parity.test.ts` | three-way enum parity assertion |
| 7 | `packages/config/src/index.ts:244+` | add ~30 per-provider settings fields + modal gap-fills + `sandboxDesktopEnabled` |
| 8 | `packages/config/src/index.ts:481+` | add matching `OPENGENI_*` env mappings |
| 9 | `packages/config/src/index.ts:986+` | backend-gated required-cred validation + desktop coherence check |
| 10 | `packages/runtime/src/sandbox/capabilities.ts` (NEW) | `CapabilityDescriptor` type + `CAPABILITY_DESCRIPTORS` table + `assertDescriptorRegistryInvariants` |
| 11 | `packages/runtime/src/sandbox/errors.ts` (NEW) | `SandboxConfigError` |
| 12 | `packages/runtime/src/sandbox/providers/types.ts` (NEW) | `ProviderRegistration` interface |
| 13 | `packages/runtime/src/sandbox/providers/{modal,docker,local,none,daytona,runloop,e2b,blaxel,cloudflare,vercel}.ts` (NEW, 10 files) | per-provider `validateCredentials` + `build` |
| 14 | `packages/runtime/src/sandbox/providers/index.ts` (NEW) | `PROVIDER_REGISTRY` map |
| 15 | `packages/runtime/src/sandbox/select.ts` (NEW) | `selectBackend` + `negotiateCapabilities` + `NegotiatedCapabilities` |
| 16 | `packages/runtime/src/sandbox/index.ts` (NEW leaf module, §3.5) | hosts the registry-driven `createSandboxClient` (replaces the `index.ts:763-795` if-chain; desktop-port injection; keep `withDockerNetwork`) + the extracted access symbols `deserializeSandboxSessionStateEnvelope`/`restoredSandboxSessionStateFromEntry`/`sandboxStateEntryFromRunState`/`collectSandboxEnvironment`/`parseExposedPorts`. Agent-loop-FREE (no `@openai/agents`/`-extensions` runtime import; only the per-provider SDK `build()` import). |
| 17 | `packages/runtime/src/index.ts:27-31,:57,:763-795,:1665,:1690,:1700` | move the access symbols + factory into `./sandbox` and `export * from "./sandbox"` (barrel unchanged for `apps/worker`); move the `ModalSandboxClient`/`ModalImageSelector` import (`:57`) into `providers/modal.ts`; export registry + descriptors + selection via the leaf |
| 18a | `packages/runtime/package.json` (`exports` map) | add `"./sandbox": "./src/sandbox/index.ts"` subpath so `apps/api` imports the access module WITHOUT the agent-loop barrel; `.` stays the barrel (§3.5.2) |
| 18b | `apps/api/package.json:18` | add `"@opengeni/runtime": "workspace:*"`; API imports access symbols ONLY via `@opengeni/runtime/sandbox` (lint/grep guard), and inject `OPENGENI_MODAL_TOKEN_ID`/`_SECRET`/`OPENGENI_MODAL_APP_NAME` into the API runtime env so its `getSettings()`→`createSandboxClient` Modal-client construction has creds (§3.5.3) |
| 18 | `packages/runtime/package.json:15` | add 6 optional-peer SDK deps |
| 19 | `apps/worker/src/activities/environment.ts:80` | backend-aware `HOME`/`workspaceRoot` from descriptor |
| 20 | `apps/worker/src/activities/agent-turn.ts:1059` | `requiresSignedFileResourceDownloads` keyed on `descriptor.nativeBucketMount` |
| 21 | `packages/runtime/src/index.ts:1481` | `objectStorageFileMount` branch on `descriptor.nativeBucketMount` not `=== "modal"` |
| 22 | `apps/api/src/mcp/server.ts:528` | (no code change; now validated downstream) — add a comment noting the registry validates |

**Unchanged-by-design (verified backend-generic):** resume/serialize plumbing `restoredSandboxSessionState` (`:1637`), `restoredSandboxSessionStateFromEntry` (`:1690`), `deserializeSandboxSessionStateEnvelope` (`:1700`); decoration wrappers `withManifestRefreshOnResume`/`withSandboxFileDownloads`/`withSandboxLifecycleHooks`; SSE/bus/DB; the per-session/per-turn override flow.

---

## 9. Failure / edge-case matrix

| Case | Behavior |
|---|---|
| Unknown backend string (e.g. typo'd override) | `createSandboxClient` throws `SandboxConfigError("…", "Unknown sandbox backend")` → API `validation_failed`. |
| Backend selected but creds missing | `validateCredentials` throws `SandboxConfigError` at construction (per-turn) or at config-load (default backend). Fail-fast, never a half-built client. |
| `none` backend | Factory returns `undefined` (unchanged); all capabilities `available:false`; runtime runs sandbox-less. |
| Desktop requested on cloudflare/vercel | `negotiateCapabilities` returns `DesktopStream:{transport:null}` + degradation reason; client falls back to Channel A. NEVER errors, NEVER substitutes provider. |
| Deployed `local`/`docker` | `reachable:false` → Terminal forced to `sse-events`, Git/Desktop unavailable; degradation surfaced. |
| Desktop port not in `exposedPorts` on a non-on-demand provider | Registry injects `DESKTOP_STREAM_PORT` (6080) before `build()` when `sandboxDesktopEnabled` + descriptor desktop-capable; otherwise `resolveExposedPort(6080)` would reject downstream (handshake module's concern, but prevented here). |
| Per-turn override to a different provider than the session envelope's origin | `deserializeSandboxSessionStateEnvelope` `backendId` assertion (`:1654,:1694`) throws — sessions are pinned; cross-provider resume is correctly rejected. This is the desired fence, not a bug. |
| E2B without `E2B_API_KEY` in `process.env` | `e2b.build()` sets `process.env.E2B_API_KEY ??= settings.e2bApiKey`; if still empty, `validateCredentials` already threw. |
| Optional peer SDK not installed | Module-resolution error at registry index import — surfaced at worker boot, not per-turn. Acceptable (deploy declares the dep). |
| Modal 24h hard lifetime crossed | Descriptor `lifetime.requiresSnapshotRollover:true` signals the owner/keep-alive module to snapshot-roll (new `instanceId`); this module only declares the quirk. |
| Headless backend with `sandboxDesktopEnabled=true` in config | Config validation throws at load (`§4.3` desktop coherence) — caught before any session. |
| `runloop`/`vercel` PTY-less terminal | Descriptor `Terminal.transport:"sse-events"` → client renders terminal-as-events, not a PTY socket. Negotiation surfaces it. |

---

## 10. Grounding references (real files / docs)

- Current factory (replaced): `packages/runtime/src/index.ts:763-795`; decoration `:797-820`; resume/serialize `:1637,:1665,:1690,:1700`; mount throw `:1481-1509`.
- Access-module extraction (§3.5): `packages/runtime/package.json` has `main`/`types`→`./src/index.ts` and **no `exports` map** (must add `./sandbox`); `packages/runtime` has **no `@temporalio` dep** (deps: `@opengeni/config`, `@opengeni/contracts`, `@openai/agents`, `@openai/agents-extensions`, `modal`, `openai`) → the agent-loop coupling is the `@openai/agents*` graph reached via `index.ts:57`, isolated by the subpath. `apps/api/package.json:18-20` deps `@opengeni/config`/`@opengeni/contracts`/`@opengeni/db` but **NOT** `@opengeni/runtime` (must add). Modal token already parsed by shared `getSettings()` (`packages/config/src/index.ts:405`; env reads `:476,:479,:480`; both-or-neither validation `:985`). Cross-ref: `02-owner.md` §6.3 (the API-direct viewer-attach + non-turn handlers that import this leaf) and `00-master-spine.md` §B.
- Enums: `packages/contracts/src/index.ts:13`; `packages/deployment/src/index.ts:34`; `packages/sdk/src/types.ts:14`. DB text columns (no migration): `packages/db/src/schema.ts:117,:260`.
- Config: settings `packages/config/src/index.ts:235-244`; env map `:472-481`; validation `:985-986`.
- Deployment required-env: `packages/deployment/src/index.ts:863,:1419`; readiness `:768`; Helm value `:1546`.
- Env-mount asymmetry: `apps/worker/src/activities/environment.ts:80-82`; signed-download `apps/worker/src/activities/agent-turn.ts:1059-1062`.
- SDK option interfaces (verbatim, all confirmed this session): `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/{modal,daytona,runloop,e2b,blaxel,cloudflare,vercel}/sandbox.d.ts` — `ModalSandboxClientOptions` (modal `:93`, incl. `idleTimeoutMs`, `workspacePersistence:'tar'|'snapshot_filesystem'|'snapshot_directory'` `:75`), `DaytonaSandboxClientOptions` (daytona `:52`), `RunloopSandboxClientOptions` (runloop `:96`, `tunnel?:boolean|Record`), `E2BSandboxClientOptions` (e2b `:69`, `workspacePersistence:true|'tar'|'snapshot'` `:67`, `timeoutAction:'pause'|'kill'` `:68`), `BlaxelSandboxClientOptions` (blaxel `:55`, `exposedPortPublic`), `CloudflareSandboxClientOptions` (cloudflare `:5`, `workerUrl` required), `VercelSandboxClientOptions` (vercel `:37`, `workspacePersistence:'tar'|'snapshot'` `:36`).
- Cloudflare desktop disqualifier: `…/cloudflare/sandbox.js:264` (`resolveExposedPort` throws `SandboxUnsupportedFeatureError`), `:923` (`/workspace` root lock).
- Modal R4 lock-free resume: `…/modal/sandbox.js:896-953` (`fromId`, throws only if `poll()!==null`).
- `SandboxClient`/`ExposedPortEndpoint` canonical: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/{client.d.ts:49,session.d.ts:9}`.
- Provider docs: modal.com/docs/guide/sandboxes; e2b.dev/docs; daytona.io/docs; docs.runloop.ai/docs/devboxes; docs.blaxel.ai/Sandboxes; vercel.com/docs/vercel-sandbox; developers.cloudflare.com/sandbox.

**One open decision flagged for the caller:** §4.5/§7.2 add `workspaceRoot` and `nativeBucketMount` fields to `CapabilityDescriptor` so the worker's env/mount code (`environment.ts:80`, `agent-turn.ts:1059`, `runtime:1481`) can branch on descriptor data instead of hardcoded backend names. This couples the descriptor to two consumers outside this module's strict scope, but is the cleanest way to kill the modal/docker hardcoding. If you prefer those facts to live in the env/mount module's own table, drop the two fields from the descriptor and keep §7 as a cross-reference only.

---

## Adversarial Review

## Adversarial review: Provider Registry + Capability/Lifetime Descriptors + Config/Secrets + Selection

### CRITICAL — won't compile / circular dependency

**C1. §4.3 config-level validation imports `CAPABILITY_DESCRIPTORS` from runtime → circular dependency (build break).**
The desktop-coherence check in §4.3 references `CAPABILITY_DESCRIPTORS[settings.sandboxBackend]`. That table lives in `packages/runtime/src/sandbox/capabilities.ts` (§2.1). But `packages/runtime` depends on `@opengeni/config` (`packages/runtime/package.json:12`), and `@opengeni/config` depends only on `@opengeni/contracts` (`packages/config/package.json:12`). Importing the descriptor table into config creates `config → runtime → config`, which will fail the build (and Zod schema construction runs at import time, so it's not even a lazy cycle).
**Fix:** Move `CAPABILITY_DESCRIPTORS` (or at least a minimal `headless-only` predicate set) into `@opengeni/contracts` (which both config and runtime already depend on), OR drop the descriptor-based desktop-coherence check from config and do it only inside `createSandboxClient`/`validateCredentials` in runtime. Given §2.1 already imports `SandboxBackend` from contracts, hosting the descriptor table in contracts is the clean fix — but note the table imports nothing SDK-specific, so it's contract-safe.

**C2. §1.3 three-way parity test requires a dependency the SDK test package doesn't have.**
`packages/sdk/test/contract-parity.test.ts` imports only from `@opengeni/contracts` and the SDK itself (verified: no `@opengeni/deployment` import, no deployment dep in `packages/sdk/package.json`). The spec says add an assertion that `SandboxBackend.options` "deep-equals the SDK array AND the deployment enum array — three-way." That requires importing `@opengeni/deployment` into the SDK test, adding a new package dep, and likely a devDependency edge that doesn't exist.
**Fix:** Either (a) add `@opengeni/deployment` as a devDependency of `@opengeni/sdk` and import its enum, or (b) put the contracts↔deployment parity assertion in a test that lives in the deployment or contracts package (which can legitimately depend on contracts), and keep the SDK test doing only contracts↔SDK. Option (b) is cleaner — the SDK has no business knowing about the deployment package.

**C3. §1.1 / §1.2 claim a `| (string & {})` open-union in the SDK mirror that does not exist.**
`packages/sdk/src/types.ts:14` is `export type SandboxBackend = "docker" | "modal" | "local" | "none";` — a closed union, no `(string & {})`. §1.2 row 3 says "keep the `| (string & {})` open-union tolerance **if present** so older SDKs don't break." It is not present, so the hedge is moot, but the back-compat narrative ("older SDKs don't break") is also false for the closed union: an older SDK build literally cannot produce the new string-literal members, and the parity test will hard-fail until the SDK array is updated in lockstep — there is no graceful tolerance. This isn't a bug per se but the spec's stated guarantee is wrong.
**Fix:** Drop the "if present" language; state plainly that all three enums must be updated atomically in the same change (the parity test enforces it), and that the SDK union is closed.

### CRITICAL — wrong descriptor data (will cause runtime throws)

**C4. `runloop.portExposure.supportsOnDemandPorts: true` is WRONG — runloop requires pre-declared ports.**
Verified in the SDK: `allowOnDemandExposedPorts()` returns `false` in the shared base (`shared/sessionBase.js:201`) and is overridden to `true` **only by blaxel** (`blaxel/sandbox.js:149`). Runloop uses the base default → `false`. `assertConfiguredExposedPort` (`shared/ports.js`) throws `SandboxConfigurationError` when `allowOnDemand` is false and the port isn't in `configuredExposedPorts`. So §3.4's desktop-port-injection rule — which skips injection for runloop because `supportsOnDemandPorts:true` — will let `resolveExposedPort(6080)` throw on runloop. The `runloop.tunnel?: boolean` flag is a one-tunnel-all-ports toggle, not on-demand arbitrary-port resolution; the brief's prose ("Tunnels v2: one tunnel all ports") was over-read into the SDK's `allowOnDemand` semantic.
**Fix:** Set `runloop.portExposure.supportsOnDemandPorts: false` and ensure 6080 is injected into `exposedPorts` for runloop (it falls into the same injection branch as modal/daytona/e2b). Only `blaxel` is truly on-demand. Add a registry invariant: `supportsOnDemandPorts === (CLIENT.allowOnDemandExposedPorts())` is impossible to assert statically, so at minimum cite the SDK line per provider in the table to prevent this class of drift.

### MAJOR — implementation gaps / wrong interface mappings

**G1. Per-provider `build()` field mappings are unspecified for 6 of 7 providers, and the one knob name in §4.1 doesn't match the SDK.**
Only Modal's `build()` is shown (§3.2). The SDK option field names differ from the config field names in ways that the (unshown) build functions must translate, and several spec config names imply a unit/shape the SDK doesn't take:
- E2B: SDK field is `timeout` (a number — verified `E2BSandboxClientOptions.timeout`), not `timeoutMs`; spec config `e2bTimeoutSeconds` must `*1000`? No — E2B `timeout` is **milliseconds** per the SDK. Also there is **no `apiKey` field** on `E2BSandboxClientOptions` (confirmed) — §4.4 correctly notes the env-var passthrough, but `e2bApiKey` is otherwise dead config unless build sets `process.env`. The spec's `e2bTimeoutAction` maps to `onTimeout` **or** `timeoutAction` (both exist on the interface) — unspecified which.
- Daytona: SDK fields are `timeoutSec`, `exposedPortUrlTtlS`, `autoStopInterval` (verified). Spec config `daytonaTimeoutSeconds`/`daytonaExposedPortUrlTtlSeconds` must map to `timeoutSec`/`exposedPortUrlTtlS` — the conversion is unstated.
- Vercel: SDK `timeoutMs` (ms), spec config `vercelTimeoutSeconds` (sec) → `*1000` needed; unstated.
- Runloop: `keepAliveTimeoutMs` is under `timeouts: RunloopSandboxTimeouts`, not a top-level `keepAlive`; spec config `runloopKeepAliveSeconds` must be folded into `{ timeouts: { keepAliveTimeoutMs: x*1000 } }`. Unstated.
**Fix:** Specify each provider's `build()` field-by-field with explicit unit conversion, mirroring §3.2's Modal example. Pin each mapped SDK field to its `*.d.ts` line. Don't leave "the others mirror this exactly" — they don't; the option interfaces diverge (top-level vs nested `timeouts`, sec vs ms, `apiKey` present vs env-only).

**G2. §6.1 `SANDBOX_REQUIRED_ENV` value-getters read fields that don't exist on `SandboxSpec`, and the table shape matches neither call site.**
The table uses `value: [["OPENGENI_MODAL_APP_NAME", s => s.modalAppName]]` typed `(s: SandboxSpec) => ...`. But `SandboxSpec` (`packages/deployment/src/index.ts:183-188`) has exactly three fields: `backend`, `preparationProfiles`, `envAllowlist`. `s.modalAppName`, `s.runloopBlueprintName`, `s.cloudflareWorkerUrl`, `s.vercelProjectId` etc. do not exist → type error. Moreover the two real call sites have different shapes: `requiredRuntimeEnvVars` (`:863`) just `vars.push(...strings)` (no value-getter at all), and `buildRuntimeEnv` (`:1419`) reads from the `env: Record<string,string|undefined>` argument via `requiredEnv("NAME", env.NAME)` / `valueEnv("NAME", env.NAME)` — not from `SandboxSpec`. The unified table can't drive both as written.
**Fix:** Source values from the `env` record (as the existing modal block does), not from `SandboxSpec`. Split into two projections: a `string[]` of required var names for `:863`, and `(env) => RuntimeEnvEntry[]` for `:1419`. Drop the `(s: SandboxSpec) => string` getters entirely.

**G3. §5.3 `negotiateCapabilities` return type drops `url`/`token` that GROUND §H's `SessionCapabilities` requires — contradiction with grounding and with the handshake's needs.**
GROUND §H defines `Terminal: { transport; url?; token? }` and `DesktopStream: { transport; url?; token? }` — the URL and scoped token are the whole point of the split-plane handshake (step 4: `{ capabilities, dataPlaneUrl, streamToken }`). §5.3's `NegotiatedCapabilities` has `Terminal: { transport }` and `DesktopStream: { transport }` with no url/token. The spec hand-waves this in §5.4 ("drop `reachable`/`degradations` internals if desired"). But this module is declared the "source of truth" the handshake returns; without url/token it's not the client-facing capability value, it's a strict subset, and §5.4 doesn't define the mapping to GROUND §H's shape.
**Fix:** Either explicitly scope `negotiateCapabilities` as static-feasibility-only (no url/token — the handshake module overlays the minted URL/token) and rename to avoid implying it's the wire value, or include `url?`/`token?` and state they're populated downstream. The spec must pick one; currently §5.3 and GROUND §H disagree silently.

**G4. §3.3 `createSandboxClient` desktop-port injection mutates a possibly-shared array and the `DESKTOP_STREAM_PORT` constant is never defined/imported.**
`exposedPorts.push(DESKTOP_STREAM_PORT)` — `DESKTOP_STREAM_PORT` (6080) is referenced in §3.4 and §9 but never declared, imported, or sourced (GROUND:desktop-stack says 6080 but no constant export is specified). Also `parseExposedPorts` returns a fresh array each call so mutation is locally safe, but the value comes from `settings.dockerExposedPorts` parsing — if a future caller passes a cached array this push is a latent aliasing bug.
**Fix:** Define and export `DESKTOP_STREAM_PORT = 6080` (in capabilities.ts or a desktop constants module) and import it; build a new array (`[...exposedPorts, DESKTOP_STREAM_PORT]`) rather than `.push`.

**G5. `validateCredentials` is called in `createSandboxClient` only AFTER the `none` short-circuit but the registry lookup can still be `undefined` for an out-of-enum string that passed the looser MCP boundary.**
§1.2 notes `apps/api/src/mcp/server.ts:528` is `z4.string().optional()` (accepts anything). §3.3 guards `if (!reg) throw SandboxConfigError(...)` — good — but `PROVIDER_REGISTRY` is typed `Record<SandboxBackend, ProviderRegistration>`, so `PROVIDER_REGISTRY[settings.sandboxBackend]` is typed as always-defined; TypeScript will flag `if (!reg)` as an always-false check under `noUncheckedIndexedAccess=false` (the default), or the runtime `undefined` is real but the type lies. Either way the guard's correctness depends on a runtime value the type says can't be undefined.
**Fix:** Type the lookup as `PROVIDER_REGISTRY[settings.sandboxBackend as SandboxBackend] as ProviderRegistration | undefined`, or look up via `Object.hasOwn`. Keep the runtime guard; make the type honest.

### MODERATE — correctness / invariant issues

**M1. §2.3 invariant "DesktopStream implies Recording" is asserted as a registry self-test but `docker`/`local` desktop=false/recording=false pass, while the descriptor table sets cloudflare/vercel Recording=false with DesktopStream=false — fine — yet the invariant text claims Xvfb feasibility. The invariant is sound, but there's a latent contradiction: the table marks every desktop-capable provider `Recording.available: true` unconditionally, including providers where the desktop image (and thus ffmpeg/x11grab) is net-new and unproven (daytona/runloop per GROUND).** This is a static-feasibility claim presented as fact. Not a compile bug, but the descriptor asserts capability the foundation hasn't built. Flag: `Recording.available` should arguably track "desktop image includes ffmpeg" which is image-dependent, not provider-static.
**Fix:** Either keep it as pure feasibility (document that `available` means "the platform permits it once the image ships") or gate it on an image/profile fact. At minimum note the semantic.

**M2. §5.3 Rule for `Recording.available` ties it to `desktopTransport !== null`, but `desktopTransport` is forced `null` whenever `!opts.desktopRequested`. So a session that has a desktop-capable box but didn't *request* desktop reports `Recording.available:false`.** If recording is meant for the "dual-use verification video" path (GROUND:desktop-stack §1 recording, workspace-surfacing memory), that path may want recording without a viewer requesting the live desktop. Coupling recording to `desktopRequested` may be wrong.
**Fix:** Decide whether recording feasibility depends on desktop being *requested* (live viewer) or merely *available* (box can run ffmpeg). The current coupling silently disables the verification-video use case unless a viewer is attached.

**M3. §3.2 Modal `build()` spreads `idleTimeoutMs` and `workspacePersistence` from settings that §4.1 declares, but `modalWorkspacePersistence` enum in config is `["tar","snapshot_filesystem","snapshot_directory"]` and the SDK type `ModalWorkspacePersistence` matches — good — however the Modal build does not pass `gpu`, `imageTag`, `sandbox` (resume selector) or `nativeCloudBucketSecretName`, which §7.2 then wants for `nativeBucketMount`.** The `nativeCloudBucketSecretName` is on `ModalSandboxClientOptions` and is load-bearing for the §7.2 `nativeBucketMount:true` branch, but no config field or build mapping is specified for it. §7.2 adds `nativeBucketMount: boolean` to the descriptor but never wires the secret name through `build()`.
**Fix:** If `nativeBucketMount` is in scope, add the `modalNativeCloudBucketSecretName` config field + env + build mapping; otherwise explicitly defer the mount machinery (the spec's own §7.2 open-decision flag covers this, but the descriptor field is presented as settled in §2.1's add-to-type instruction inconsistently).

**M4. §4.1 `e2bWorkspacePersistence: z.enum(["tar","snapshot"])` drops the SDK-accepted `true` value.** `E2BWorkspacePersistence = true | 'tar' | 'snapshot'` (verified). The spec's own comment says "SDK also accepts `true`" but the Zod enum can't represent boolean `true`. Minor, but if someone sets it expecting `true`, config rejects a valid SDK value.
**Fix:** `z.union([z.literal("tar"), z.literal("snapshot"), z.literal(true)])` or document that `true` is intentionally unsupported via config (the env-var path can't carry a boolean cleanly anyway → acceptable, but state it).

**M5. §4.3 validation runs `switch (settings.sandboxBackend)` for the *default* backend only, but per-turn overrides to a credential-less provider are caught at construction.** Correct for the design — but `validateCredentials` (§3.1) and the config switch (§4.3) duplicate the predicate with no shared source, and they already diverge: §3.1 modal validates `modalAppName` presence; §4.3 modal case is absent (relies on existing `:985` both-or-neither, which does NOT check `modalAppName`). So a default-modal deployment missing `OPENGENI_MODAL_APP_NAME` passes config validation but `modalAppName` has a `.default("opengeni-sandbox")` (`config:239`) so it's never empty — meaning §3.2's `modalProvider.validateCredentials` throw on `!settings.modalAppName` is dead code (the default guarantees a value).
**Fix:** Note that `modalAppName` is always set (has a default) so the `validateCredentials` check is unreachable; remove it or make it meaningful (e.g. reject the literal default in production). Unify the predicate: have config call the same per-provider `validateCredentials` for the selected backend instead of re-implementing a parallel switch.

**M6. §3.1 `ProviderRegistration.build` returns `unknown` and §3.3 casts `raw as SandboxClient` only in the docker branch; the non-docker path returns `raw` (unknown) directly.** `createSandboxClient`'s return type is `unknown` (matches today's signature), so this type-checks, but the decoration wrappers (`withManifestRefreshOnResume` etc.) at the call site in `runAgentStream` expect a `SandboxClient`. The cast is deferred to the caller, which is the existing behavior — acceptable — but `withDockerNetwork(raw as SandboxClient, ...)` casts only for docker, so docker is decorated as `SandboxClient` while others stay `unknown` until `runAgentStream`. Inconsistent but not broken.
**Fix:** None required; note the cast asymmetry is intentional. Consider typing `build()` to return `SandboxClient | undefined` for clarity rather than `unknown`.

### MINOR — clarity / completeness

- **§2.2 `vercel.portExposure.kind: "domain"` with `supportsOnDemandPorts:false`** — vercel `resolveExposedPort` resolves via `sandbox.domain(port)` and the descriptor invariant §2.3 doesn't fire (DesktopStream=false), so it's consistent. Fine.
- **§4.5 peer-dep versions** are asserted but unverified against the installed `peerDependenciesMeta`; the spec lists 6 deps but says "5 optional peer SDKs" in GROUND. The count mismatch (`e2b` + `@e2b/code-interpreter` are two packages) should be reconciled — 6 package entries, but e2b is two of them.
- **§2.1 `LifetimeDescriptor.resumeIsLockFree` for docker/local = `true`** — docker/local don't implement `resume` meaningfully; "lock-free" is vacuously true but misleading. Document the semantic (no provider lock to contend) vs "resume unsupported."
- **§9 "E2B without `E2B_API_KEY`" row** says `validateCredentials already threw` — but §3.1 says `build` may assume valid because factory calls `validateCredentials` first; yet §4.4's `process.env.E2B_API_KEY ??= settings.e2bApiKey` happens in `build`, after validation. If `e2bApiKey` is set in settings but `process.env.E2B_API_KEY` is unset, validation passes (checks `settings.e2bApiKey`) and build sets the env — correct. But if BOTH are unset, validation throws — correct. The edge where `process.env.E2B_API_KEY` is set but `settings.e2bApiKey` is unset: validation throws on `!settings.e2bApiKey` even though the SDK would have worked from env. That's an over-strict rejection.
  **Fix:** e2b `validateCredentials` should accept `settings.e2bApiKey || process.env.E2B_API_KEY`.

### Summary of must-fix before implementation
1. **C1** circular dep (config→runtime) — blocks build. Host descriptors in contracts.
2. **C4/G1** runloop `supportsOnDemandPorts` wrong + per-provider build field/unit mappings unspecified — runtime throws / wrong behavior.
3. **G2** deployment `SANDBOX_REQUIRED_ENV` reads non-existent `SandboxSpec` fields and fits neither call site.
4. **C2** SDK parity test can't do three-way without a deployment dep it lacks.
5. **G3** negotiation shape contradicts GROUND §H (missing url/token).

Files cited for the fixes: `packages/config/package.json:12`, `packages/runtime/package.json:12`, `packages/contracts/src/index.ts:13`, `packages/sdk/src/types.ts:14`, `packages/sdk/test/contract-parity.test.ts:47-51`, `packages/deployment/src/index.ts:183-188,863,1419`, `packages/config/src/index.ts:235-244,985`, and SDK `shared/sessionBase.js:201` / `blaxel/sandbox.js:149` / `e2b/sandbox.d.ts` (no `apiKey`, `timeout` field) / `daytona/sandbox.d.ts` (`timeoutSec`,`exposedPortUrlTtlS`) / `runloop/sandbox.d.ts` (`timeouts.keepAliveTimeoutMs`) / `cloudflare/sandbox.js:264`.
