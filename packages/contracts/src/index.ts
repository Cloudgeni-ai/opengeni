import { z } from "zod";

export const SessionStatus = z.enum([
  "queued",
  "running",
  "idle",
  "requires_action",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

// 11 backends; 3-way enum parity (contracts / sdk / deployment) is pinned by
// `packages/sdk/test/contract-parity.test.ts`. Every member is ADDITIVE AT THE
// END (the parity test pins positions): the original four, then the six cloud
// backends, then `selfhosted` (bring-your-own-compute — a user's own machine
// enrolled as a first-class sandbox).
export const SandboxBackend = z.enum([
  "docker",
  "modal",
  "local",
  "none",
  "daytona",
  "runloop",
  "e2b",
  "blaxel",
  "cloudflare",
  "vercel",
  "selfhosted",
]);
export type SandboxBackend = z.infer<typeof SandboxBackend>;

// OS axis. Only "linux" is reachable in v1; macos/windows are seam placeholders.
export const SandboxOs = z.enum(["linux", "macos", "windows"]);
export type SandboxOs = z.infer<typeof SandboxOs>;

// The five surfaceable sandbox capabilities (PascalCase, the canonical names).
export const SandboxCapabilityName = z.enum([
  "FileSystem", // Channel A: list/read/write/search (Pierre tree)
  "Terminal", // Channel A: command-output firehose (+ future pty-ws)
  "Git", // Channel A: status/diff/log/show (Pierre diff)
  "DesktopStream", // Channel B: noVNC pixels over a scoped tunnel URL
  "Recording", // ffmpeg x11grab -> object storage
]);
export type SandboxCapabilityName = z.infer<typeof SandboxCapabilityName>;

// How a backend exposes a network port to the data plane.
export type PortExposureKind = "provider-tunnel" | "preview-url" | "local-port" | "none";

// Static per-backend metadata — pure data, no runtime state. This table lives
// in CONTRACTS (not runtime) so config can read it without an import cycle
// through runtime (ledger CR8). Everything downstream (config boot-validation,
// OS image selection, capability negotiation, env/mount branch) reads this
// data, never a hard-coded backend name.
export type CapabilityDescriptor = {
  backend: SandboxBackend;
  backendId: string; // asserted === SDK client.backendId at registry build (deferred to P0.3)
  tier: "desktop" | "headless" | "dev" | "none";
  os: { supported: SandboxOs[]; default: SandboxOs };
  capabilities: {
    FileSystem: { available: boolean; readOnly: boolean };
    Terminal: { available: boolean; transport: "sse-events" | "pty-ws" | null; pty: boolean };
    Git: { available: boolean };
    DesktopStream: { available: boolean; transport: "vnc-ws" | "rdp-ws" | "webrtc" | null };
    // Feasibility only (== DesktopStream.available && os==linux); NOT a request.
    Recording: { available: boolean };
  };
  lifetime: {
    hardLifetimeMs?: number; // modal 24h, vercel 5h
    requiresSnapshotRollover: boolean;
    hasIdleKiller: boolean;
    supportsSuspendResume: boolean; // runloop/e2b/vercel/modal true
    resumeIsLockFree: boolean; // modal true (fromId, no lock)
    idleKillDisableHint?: string;
  };
  snapshot: {
    kind: "native-fs" | "native-dir" | "native-snapshot-id" | "tar-only" | "none";
    hasTarFallback: boolean;
  };
  portExposure: { kind: PortExposureKind; supportsOnDemandPorts: boolean }; // runloop=false; blaxel only true
  workspaceRoot: string; // os-overridable; per-backend default (providers owns; os defers)
  nativeBucketMount: boolean; // modal true -> mount/signed-download branch
  persistable: boolean;
  supportsRunAs: boolean;
};

// The websockify/noVNC desktop port that is merged into `exposedPorts` for
// every desktop-capable (backend, os). Asserted present by boot-validation.
export const DESKTOP_STREAM_PORT = 6080;

// The ttyd PTY-over-websocket port that is exposed over the SAME Modal raw-TLS
// tunnel as the desktop, for the REAL interactive terminal (Channel-B-symmetric).
// ttyd's default; the box bakes ttyd and launches it on this port. The pty-ws
// Terminal cell's `url` is the tunnel address resolved against this port.
export const TERMINAL_STREAM_PORT = 7681;

// The Part-D matrix (master-spine PART D + module 03-providers). One row per
// backend (10 rows). v1 reachable cells are all Linux; macos/windows are seam
// placeholders (no enum members shipped). Reading rule: a capability cell is
// `available:false` + a reason in the negotiated doc, never absent.
export const CAPABILITY_DESCRIPTORS: Record<SandboxBackend, CapabilityDescriptor> = {
  modal: {
    backend: "modal",
    backendId: "modal",
    tier: "desktop",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: true },
      Git: { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording: { available: true },
    },
    lifetime: {
      hardLifetimeMs: 24 * 60 * 60 * 1000,
      requiresSnapshotRollover: true,
      hasIdleKiller: true,
      supportsSuspendResume: true,
      resumeIsLockFree: true,
    },
    snapshot: { kind: "native-fs", hasTarFallback: true },
    portExposure: { kind: "provider-tunnel", supportsOnDemandPorts: false }, // pre-declare 6080
    workspaceRoot: "/workspace",
    nativeBucketMount: true,
    persistable: true,
    supportsRunAs: true,
  },
  daytona: {
    backend: "daytona",
    backendId: "daytona",
    tier: "desktop",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: true },
      Git: { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording: { available: true },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: true,
      supportsSuspendResume: true,
      resumeIsLockFree: false,
    },
    snapshot: { kind: "native-snapshot-id", hasTarFallback: true },
    portExposure: { kind: "preview-url", supportsOnDemandPorts: false },
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: true,
  },
  runloop: {
    backend: "runloop",
    backendId: "runloop",
    tier: "desktop",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: false },
      Git: { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording: { available: true },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: true,
      supportsSuspendResume: true,
      resumeIsLockFree: false,
    },
    snapshot: { kind: "native-snapshot-id", hasTarFallback: true },
    portExposure: { kind: "provider-tunnel", supportsOnDemandPorts: false }, // CR9: pre-declare 6080
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: false,
  },
  e2b: {
    backend: "e2b",
    backendId: "e2b",
    tier: "desktop",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: false }, // pty-until-proven=no
      Git: { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording: { available: true },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: true,
      supportsSuspendResume: true,
      resumeIsLockFree: false,
    },
    snapshot: { kind: "native-snapshot-id", hasTarFallback: true },
    portExposure: { kind: "preview-url", supportsOnDemandPorts: false },
    workspaceRoot: "/home/user",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: false,
  },
  blaxel: {
    backend: "blaxel",
    backendId: "blaxel",
    tier: "desktop",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: false }, // pty-until-proven=no
      Git: { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" },
      Recording: { available: true },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: true,
      supportsSuspendResume: false,
      resumeIsLockFree: false,
    },
    snapshot: { kind: "tar-only", hasTarFallback: true },
    portExposure: { kind: "provider-tunnel", supportsOnDemandPorts: true }, // only on-demand backend
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: false,
  },
  cloudflare: {
    backend: "cloudflare",
    backendId: "cloudflare",
    tier: "headless",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: true },
      Git: { available: true },
      DesktopStream: { available: false, transport: null },
      Recording: { available: false },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: true,
      supportsSuspendResume: false,
      resumeIsLockFree: false,
    },
    snapshot: { kind: "tar-only", hasTarFallback: true },
    portExposure: { kind: "provider-tunnel", supportsOnDemandPorts: false },
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: true,
  },
  vercel: {
    backend: "vercel",
    backendId: "vercel",
    tier: "headless",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: false },
      Git: { available: true },
      DesktopStream: { available: false, transport: null },
      Recording: { available: false },
    },
    lifetime: {
      hardLifetimeMs: 5 * 60 * 60 * 1000,
      requiresSnapshotRollover: true,
      hasIdleKiller: true,
      supportsSuspendResume: true,
      resumeIsLockFree: false,
    },
    snapshot: { kind: "tar-only", hasTarFallback: true },
    portExposure: { kind: "preview-url", supportsOnDemandPorts: false },
    workspaceRoot: "/vercel/sandbox",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: false,
  },
  docker: {
    backend: "docker",
    backendId: "docker",
    tier: "dev",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: true },
      Git: { available: true },
      DesktopStream: { available: false, transport: null }, // local
      Recording: { available: false },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: false,
      supportsSuspendResume: false,
      resumeIsLockFree: true,
    },
    snapshot: { kind: "native-dir", hasTarFallback: true },
    portExposure: { kind: "local-port", supportsOnDemandPorts: false },
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: true,
    supportsRunAs: true,
  },
  local: {
    backend: "local",
    // The SDK's UnixLocalSandboxClient reports backendId "unix_local" — this MUST
    // match it (it is the resume-fence field compared against client.backendId).
    backendId: "unix_local",
    tier: "dev",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "sse-events", pty: true },
      Git: { available: true },
      DesktopStream: { available: false, transport: null },
      Recording: { available: false },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: false,
      supportsSuspendResume: false,
      resumeIsLockFree: true,
    },
    snapshot: { kind: "native-dir", hasTarFallback: true },
    portExposure: { kind: "local-port", supportsOnDemandPorts: false },
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: false,
    supportsRunAs: false,
  },
  none: {
    backend: "none",
    backendId: "none",
    tier: "none",
    os: { supported: ["linux"], default: "linux" },
    capabilities: {
      FileSystem: { available: false, readOnly: true },
      Terminal: { available: false, transport: null, pty: false },
      Git: { available: false },
      DesktopStream: { available: false, transport: null },
      Recording: { available: false },
    },
    lifetime: {
      requiresSnapshotRollover: false,
      hasIdleKiller: false,
      supportsSuspendResume: false,
      resumeIsLockFree: true,
    },
    snapshot: { kind: "none", hasTarFallback: false },
    portExposure: { kind: "none", supportsOnDemandPorts: false },
    workspaceRoot: "/workspace",
    nativeBucketMount: false,
    persistable: false,
    supportsRunAs: false,
  },
  // Bring-your-own-compute: the user's OWN machine, enrolled via a Rust agent,
  // becomes ONE shared whole-machine sandbox (the agent IS the box). It is the
  // first backend to make macOS/Windows reachable (default linux). Desktop is
  // capability-PROCLAIMED ("vnc-ws") — the agent serves a native display stack
  // (Linux X11/Xvfb, macOS CGEvent/ScreenCaptureKit) consent-gated at enroll;
  // the online/offline/consent/display negotiation lives in select.ts (M3), this
  // row is the static feasibility ceiling. Always-on (process-lifetime, never
  // idle-reaped) and NOT persistable — OpenGeni cannot snapshot the user's disk,
  // so resume = "is the agent's subject live?", never a cold re-create. Ports
  // surface on-demand through the stateless relay edge, which lands behind the
  // `resolveExposedPort` swap-seam later; until then it reuses the existing
  // `provider-tunnel` exposure kind (the relay IS the provider tunnel for the
  // agent) so no new PortExposureKind literal — and no new switch arms — are
  // introduced. supportsOnDemandPorts:true: the agent opens a stream channel for
  // a port on request rather than pre-declaring 6080/7681 at construction.
  selfhosted: {
    backend: "selfhosted",
    backendId: "selfhosted",
    tier: "desktop",
    os: { supported: ["linux", "macos", "windows"], default: "linux" },
    capabilities: {
      FileSystem: { available: true, readOnly: false },
      Terminal: { available: true, transport: "pty-ws", pty: true }, // real PTY over the relay
      Git: { available: true },
      DesktopStream: { available: true, transport: "vnc-ws" }, // proclaimed; consent-gated at enroll
      Recording: { available: true }, // boot invariant: == DesktopStream.available
    },
    lifetime: {
      // Whole-machine, always-there: online while the agent process runs, offline
      // when it stops. The lease is NEVER idle-killed (it's the user's machine,
      // not a reapable cloud box) and there is nothing to suspend/resume — the
      // machine simply is or isn't reachable.
      requiresSnapshotRollover: false,
      hasIdleKiller: false,
      supportsSuspendResume: false,
      resumeIsLockFree: true, // resume = address the live NATS subject; no provider lock
    },
    // persistable:false forces snapshot.kind:"none" (the descriptor invariant
    // `persistable ⇒ snapshot.kind!=="none"`): OpenGeni cannot snapshot the
    // user's disk — the machine itself is the persistence.
    snapshot: { kind: "none", hasTarFallback: false },
    portExposure: { kind: "provider-tunnel", supportsOnDemandPorts: true },
    workspaceRoot: "/", // agent-reported machine root (the whole machine is the sandbox)
    nativeBucketMount: false,
    persistable: false,
    supportsRunAs: false,
  },
};

export const ReasoningEffort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

export const ErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "idempotency_conflict",
  "limit_exceeded",
  "provider_verification_failed",
  "upstream_unavailable",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

export const Permission = z.enum([
  "account:read",
  "account:admin",
  "members:manage",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "workspace:read",
  "workspace:admin",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  // Sandbox-surfacing (master-spine §C.3 / crosscut PART 1.2). stream:view is a
  // REAL, distinct permission — strictly BROADER than sessions:read — because the
  // pixel plane (Channel B) is UN-REDACTED: a viewer of raw pixels can see cloud
  // creds the agent cat's into a terminal, which the redacted Channel-A event log
  // never exposes. sessions:read is NOT permission to watch raw pixels.
  "stream:view",
  // SEPARATE from stream:view: raw input to the desktop (bypasses approvalQueue /
  // interrupt). NEVER granted by default in v1 (the input plane is OFF —
  // streamControlEnabled=false); the permission exists so later hardening is a
  // flag flip, not a redesign.
  "stream:control",
  // Accept the pixel-plane secret-leak acknowledgment (consent gate before the
  // un-redacted desktop URL is handed out).
  "stream:acknowledge",
  "files:upload",
  "files:read",
  // Channel-A structured write surface (FS writes / apply-patch); distinct from
  // files:read so a read-only viewer can't mutate the box filesystem.
  "files:write",
  // Attach to an interactive PTY (terminal-as-pty, Channel A); distinct from
  // sessions:read which only reads the command-output firehose.
  "terminal:attach",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "connections:read",
  "connections:write",
  "environments:manage",
  "environments:use",
  // Attach or rotate per-session third-party MCP server credentials. Deliberately
  // not part of the worker's default first-party MCP permission set: a sandboxed
  // agent must not be able to hand itself new bearer credentials.
  "mcp_servers:attach",
  // Programmatic sandbox -> tool access through the first-party MCP gate. This is
  // intentionally narrow and is never part of first-party MCP defaults; callers
  // must receive it through an explicit delegated `ogd_` mint carrying sessionId.
  "toolspace:call",
  "goals:manage",
  // Bring-your-own-compute (M5). enrollments:read lists a workspace's machines;
  // enrollments:manage approves a device-flow enrollment (the LOUD whole-machine
  // consent) + revokes a machine. Distinct from sessions/stream perms because an
  // enrollment grants WHOLE-MACHINE access to a user's own hardware — a high-trust,
  // admin-shaped action. workspace:admin is the super-wildcard over both.
  "enrollments:read",
  "enrollments:manage",
]);
export type Permission = z.infer<typeof Permission>;

export function prefixedMcpToolName(registryId: string, toolName: string): string {
  return `${registryId}__${toolName}`;
}

export const ProductAccessMode = z.enum(["local", "configured", "managed"]);
export type ProductAccessMode = z.infer<typeof ProductAccessMode>;

export const BillingMode = z.enum(["disabled", "stripe"]);
export type BillingMode = z.infer<typeof BillingMode>;

export const EntitlementsMode = z.enum(["none", "static", "managed"]);
export type EntitlementsMode = z.infer<typeof EntitlementsMode>;

export const UsageLimitsMode = z.enum(["none", "static", "managed"]);
export type UsageLimitsMode = z.infer<typeof UsageLimitsMode>;

export const AccountRole = z.enum(["owner", "admin", "member"]);
export type AccountRole = z.infer<typeof AccountRole>;

export const ManagedAccount = z.object({
  id: z.string().uuid(),
  name: z.string(),
  externalSource: z.string().nullable(),
  externalId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ManagedAccount = z.infer<typeof ManagedAccount>;

export const Workspace = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  name: z.string(),
  slug: z.string().nullable(),
  externalSource: z.string().nullable(),
  externalId: z.string().nullable(),
  // Per-workspace agent persona template (white-label override). null means
  // the deployment default (OPENGENI_AGENT_INSTRUCTIONS_TEMPLATE /
  // DEFAULT_AGENT_INSTRUCTIONS) is used. The runtime always injects the
  // non-bypassable CORE (goal-loop ownership + environment block), so an
  // override restyles the persona without dropping that contract.
  agentInstructions: z.string().nullable(),
  // Growth-ready per-workspace settings bag (migration 0045). Known keys are
  // validated by WorkspaceSettingsSchema; unknown keys are preserved across
  // PATCH merges so newer settings survive an older server.
  settings: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

// Validates the KNOWN keys of workspaces.settings; passthrough keeps unknown
// (future) keys rather than stripping them. memoryEnabled gates Workspace Memory
// V1 agent surfaces (turn injection + first-party memory tools); default false.
export const WorkspaceSettingsSchema = z.object({
  memoryEnabled: z.boolean().optional(),
}).passthrough();
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

// Resolve the effective memoryEnabled flag from a raw settings bag (default off).
export function resolveWorkspaceMemoryEnabled(settings: unknown): boolean {
  const parsed = WorkspaceSettingsSchema.safeParse(settings ?? {});
  return parsed.success ? parsed.data.memoryEnabled === true : false;
}

// PATCH body for workspace settings: a partial patch that deep-merges into the
// stored bag. memoryEnabled is the only typed key today; passthrough carries
// forward-compatible unknown keys through validation.
export const UpdateWorkspaceSettingsRequest = z.object({
  memoryEnabled: z.boolean().optional(),
}).passthrough();
export type UpdateWorkspaceSettingsRequest = z.infer<typeof UpdateWorkspaceSettingsRequest>;

export const AccountGrant = z.object({
  accountId: z.string().uuid(),
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  role: AccountRole.optional(),
  permissions: z.array(Permission),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AccountGrant = z.infer<typeof AccountGrant>;

export const AccessGrant = z.object({
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  permissions: z.array(Permission),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AccessGrant = z.infer<typeof AccessGrant>;

export const AccessContext = z.object({
  mode: ProductAccessMode,
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  accountGrants: z.array(AccountGrant),
  workspaceGrants: z.array(AccessGrant),
  defaultAccountId: z.string().uuid().nullable(),
  defaultWorkspaceId: z.string().uuid().nullable(),
});
export type AccessContext = z.infer<typeof AccessContext>;

export const DelegatedAccessTokenPayload = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string().min(1),
  subjectLabel: z.string().optional(),
  permissions: z.array(Permission).min(1),
  // Worker-asserted session scope for first-party MCP calls (HMAC-signed, not
  // agent-controlled); enables session-scoped tools such as goal management.
  sessionId: z.string().uuid().optional(),
  exp: z.number().int().positive(),
});
export type DelegatedAccessTokenPayload = z.infer<typeof DelegatedAccessTokenPayload>;

export async function signDelegatedAccessToken(secret: string, payload: DelegatedAccessTokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(DelegatedAccessTokenPayload.parse(payload)));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return `ogd_${encodedPayload}.${signature}`;
}

export async function verifyDelegatedAccessToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<DelegatedAccessTokenPayload | null> {
  if (!token.startsWith("ogd_")) {
    return null;
  }
  const withoutPrefix = token.slice("ogd_".length);
  const dot = withoutPrefix.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const encodedPayload = withoutPrefix.slice(0, dot);
  const signature = withoutPrefix.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  const payload = DelegatedAccessTokenPayload.safeParse(JSON.parse(base64UrlDecode(encodedPayload)));
  if (!payload.success || payload.data.exp < nowSeconds) {
    return null;
  }
  return payload.data;
}

// --- Enrollment bearer credential (bring-your-own-compute M5, dossier §10.2) ---
//
// The signed bearer the agent presents to the control plane after enrollment (the
// EnrollmentCredentials.bearer the poll returns). REUSES the SAME HMAC envelope as
// the delegated/stream tokens (base64Url payload + hmacSha256Base64Url) with a
// distinct `oge_` prefix so it can never be confused with an `ogd_` access token or
// an `ogs_` stream token. It binds (workspaceId, agentId, enrollmentId) so the
// control plane can verify the agent owns the subject `agent.<ws>.<id>` it
// subscribes to. Signed with resolveEnrollmentSigningSecret; the secret value is
// NEVER logged. The real per-workspace NATS Account creds binding is infra-deferred
// (M4/relay) — this bearer is the application-tier identity proof.
export const EnrollmentBearerPayload = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  // The Account-scoped control-plane subject prefix the agent subscribes to.
  subjectPrefix: z.string().min(1),
  exp: z.number().int().positive(),
});
export type EnrollmentBearerPayload = z.infer<typeof EnrollmentBearerPayload>;

export async function signEnrollmentBearer(secret: string, payload: EnrollmentBearerPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(EnrollmentBearerPayload.parse(payload)));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return `oge_${encodedPayload}.${signature}`;
}

export async function verifyEnrollmentBearer(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<EnrollmentBearerPayload | null> {
  if (!token.startsWith("oge_")) {
    return null;
  }
  const withoutPrefix = token.slice("oge_".length);
  const dot = withoutPrefix.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const encodedPayload = withoutPrefix.slice(0, dot);
  const signature = withoutPrefix.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  const payload = EnrollmentBearerPayload.safeParse(JSON.parse(base64UrlDecode(encodedPayload)));
  if (!payload.success || payload.data.exp < nowSeconds) {
    return null;
  }
  return payload.data;
}

// --- Non-interactive enroll token (self-hosted enrollment UX §A2.1) ----------
//
// The SHORT-TTL, secret, workspace-scoped token the headless/fleet enroll path
// presents to /v1/enrollments/token/exchange. The token IS the grant — there is
// no human approve step — so it is stateless-signed (no DB row): the holder of an
// unexpired token can enroll ONE machine identity into ONE workspace.
//
// It REUSES the SAME HMAC envelope as signEnrollmentBearer (base64Url payload +
// hmacSha256Base64Url) with a DISTINCT `oget_` prefix and a `typ: "enroll"` claim.
// DOMAIN SEPARATION: even though it shares the signing secret with the `oge_`
// bearer, the prefix + typ claim make an enroll token unusable as an `oge_`
// bearer (verifyEnrollmentBearer's `oge_` prefix check rejects it) and vice-versa
// (verifyEnrollToken's `oget_` prefix + typ check rejects an `oge_` bearer). The
// secret value is NEVER logged.
export const EnrollTokenPayload = z.object({
  // Domain-separation claim — fixed "enroll" so an `oge_`/`ogd_`/`ogs_` payload (no
  // typ, or a different typ) can never satisfy verifyEnrollToken even past the prefix.
  typ: z.literal("enroll"),
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
  // The screen-control consent baked into the token at mint (the minting user's
  // decision); the exchange records it as consentedScreenControl on the enrollment.
  allowScreenControl: z.boolean(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type EnrollTokenPayload = z.infer<typeof EnrollTokenPayload>;

export async function signEnrollToken(secret: string, payload: EnrollTokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(EnrollTokenPayload.parse(payload)));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return `oget_${encodedPayload}.${signature}`;
}

/**
 * Verify an enroll token: rejects (returns null) on a bad prefix (NOT `oget_`),
 * a malformed envelope, a bad HMAC signature (constant-time), schema-invalid
 * claims (which includes `typ !== "enroll"` — the `z.literal` rejects it), or an
 * expired token (`exp < now`). Mirrors verifyEnrollmentBearer exactly. An `oge_`
 * bearer fails the prefix gate; a same-secret token that lacks the typ claim fails
 * the schema gate — both halves of the domain separation are enforced here.
 */
export async function verifyEnrollToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<EnrollTokenPayload | null> {
  if (!token.startsWith("oget_")) {
    return null;
  }
  const withoutPrefix = token.slice("oget_".length);
  const dot = withoutPrefix.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const encodedPayload = withoutPrefix.slice(0, dot);
  const signature = withoutPrefix.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }
  const payload = EnrollTokenPayload.safeParse(decoded);
  if (!payload.success || payload.data.exp < nowSeconds) {
    return null;
  }
  return payload.data;
}

// --- Scoped data-plane stream token (master-spine §C.3 / crosscut PART 1.3) ---
//
// REUSES the existing HMAC envelope (sign/verifyDelegatedAccessToken's
// base64Url + hmacSha256Base64Url) — NOT a second crypto — but with a distinct
// `ogs_` prefix and a HARD-NARROW claim set. The token is a CLAIM the OpenGeni
// control plane mints; it is NOT the provider's tunnel secret. The browser
// receives { providerUrl, streamToken }; the provider tunnel URL is the
// transport, the streamToken is what the in-box edge validates (websockify
// TokenFile is later-hardening; in v1 the URL's short TTL + the acknowledged
// stream:view gate are the real boundary). The token is minted + recorded
// against the holder from day one. It is NEVER appended to the URL as a query
// param (the provider's own scoped token already lives in the URL).
//
// `leaseEpoch` is the fence: when the box is re-elected (warming→warm bumps the
// epoch) the URL is re-minted with epoch+1 and the old tunnel is torn down, so a
// stale token points at a dead tunnel. Epoch mismatch is enforced at USE (by the
// caller comparing the claim against the live lease), not inside verify.
export const StreamTokenPayload = z.object({
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  // Identifies the sandbox_lease_holders row (the viewer holder).
  viewerId: z.string().uuid(),
  // Fence: the token logically dies when the box is re-elected (epoch++).
  leaseEpoch: z.number().int().nonnegative(),
  // v1 is always "view"; "control" is the never-granted raw-input plane.
  mode: z.enum(["view", "control"]),
  // 6080 (noVNC); pins the token to ONE exposed port.
  port: z.number().int().positive(),
  // Short TTL (120s default); rotation is event-driven under the epoch fence,
  // not on a keepalive clock.
  exp: z.number().int().positive(),
});
export type StreamTokenPayload = z.infer<typeof StreamTokenPayload>;

export async function signStreamToken(secret: string, payload: StreamTokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(StreamTokenPayload.parse(payload)));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return `ogs_${encodedPayload}.${signature}`;
}

/**
 * Verify a stream token: rejects (returns null) on a bad prefix, malformed
 * envelope, bad HMAC signature (constant-time), schema-invalid claims, or an
 * expired token (`exp < now`). Mirrors verifyDelegatedAccessToken exactly.
 *
 * The epoch fence (claim.leaseEpoch vs the LIVE lease epoch) and the
 * workspace/session scope are checked by the CALLER at use against the live
 * lease + route params — verify proves the token is authentic + unexpired, the
 * caller proves it is for THIS box's current epoch and THIS workspace+session.
 */
export async function verifyStreamToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<StreamTokenPayload | null> {
  if (!token.startsWith("ogs_")) {
    return null;
  }
  const withoutPrefix = token.slice("ogs_".length);
  const dot = withoutPrefix.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const encodedPayload = withoutPrefix.slice(0, dot);
  const signature = withoutPrefix.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }
  const payload = StreamTokenPayload.safeParse(decoded);
  if (!payload.success || payload.data.exp < nowSeconds) {
    return null;
  }
  return payload.data;
}

// --- Relay PRODUCER token (bring-your-own-compute M8b, dossier §10.5) ---
//
// The token the AGENT presents to the relay edge when it registers a pty/desktop
// stream channel (role=AGENT) — distinct from the viewer's `ogs_` token. It is
// minted by the control plane at enrollment and threaded into EnrollmentCredentials
// (proto field `relay_token`); the relay verifies it on its own merits, then pairs
// the producer with the consumer by the shared channel key.
//
// REUSES the EXACT SAME HMAC envelope as the `ogs_`/`ogd_`/`oge_` tokens
// (base64Url JSON payload + hmacSha256Base64Url) — NOT a second crypto — with a
// distinct `ogr_` prefix so it can never be confused with the others. The claim
// set binds (workspaceId, agentId): the relay reads the channel-key's ws+agent
// from the StreamOpen and asserts the producer token claims the SAME pair, so a
// producer token for workspace A can never register a channel for workspace B.
// Signed with resolveRelayTokenSecret (the relay-token HMAC secret); the value is
// NEVER logged. Long-lived by design (it is enrollment-scoped, not per-stream —
// the agent presents it on every channel registration for the life of the
// enrollment); the relay additionally validates the channel key + (for the
// viewer's `ogs_`) the lease/active-epoch fence.
//
// The Rust relay re-implements this verify (the same base64url(JSON) + HMAC-SHA256
// + prefix split) so TS-mint and Rust-verify provably agree — see the cross-stack
// fixture in agent/crates/opengeni-relay/tests and the relay's `token` module doc.
export const RelayTokenPayload = z.object({
  // The workspace the agent (and its channels) belong to — the relay asserts this
  // equals the channel-key's ws so a producer can only register its own channels.
  workspaceId: z.string().uuid(),
  // The agent (machine) id — the relay asserts this equals the channel-key's agent.
  agentId: z.string().uuid(),
  // Expiry (unix seconds). Enrollment-scoped horizon (re-minted on re-enroll).
  exp: z.number().int().positive(),
});
export type RelayTokenPayload = z.infer<typeof RelayTokenPayload>;

export async function signRelayToken(secret: string, payload: RelayTokenPayload): Promise<string> {
  const encodedPayload = base64UrlEncode(JSON.stringify(RelayTokenPayload.parse(payload)));
  const signature = await hmacSha256Base64Url(secret, encodedPayload);
  return `ogr_${encodedPayload}.${signature}`;
}

/**
 * Verify a relay producer token: rejects (returns null) on a bad prefix, malformed
 * envelope, bad HMAC signature (constant-time), schema-invalid claims, or expiry.
 * Mirrors verifyStreamToken exactly. The relay (Rust) re-implements this verify;
 * the TS verify here proves the format for the cross-stack fixture + any TS caller.
 *
 * The channel-key scope (claim.workspaceId/agentId vs the StreamOpen channel key)
 * is enforced by the relay at USE — verify proves authenticity + freshness only.
 */
export async function verifyRelayToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<RelayTokenPayload | null> {
  if (!token.startsWith("ogr_")) {
    return null;
  }
  const withoutPrefix = token.slice("ogr_".length);
  const dot = withoutPrefix.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  const encodedPayload = withoutPrefix.slice(0, dot);
  const signature = withoutPrefix.slice(dot + 1);
  const expected = await hmacSha256Base64Url(secret, encodedPayload);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return null;
  }
  const payload = RelayTokenPayload.safeParse(decoded);
  if (!payload.success || payload.data.exp < nowSeconds) {
    return null;
  }
  return payload.data;
}

export const CreateWorkspaceRequest = z.object({
  accountId: z.string().uuid().optional(),
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  externalSource: z.string().min(1).optional(),
  externalId: z.string().min(1).optional(),
  // White-label persona override for this workspace's agent. null/omitted uses
  // the deployment default template.
  agentInstructions: z.string().min(1).nullable().optional(),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>;

export const UpdateWorkspaceRequest = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).nullable().optional(),
  // White-label persona override. Pass null to clear it back to the deployment
  // default; omit to leave it unchanged.
  agentInstructions: z.string().min(1).nullable().optional(),
});
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequest>;

export const ApiKey = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid().nullable(),
  name: z.string(),
  prefix: z.string(),
  permissions: z.array(Permission),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const CreateApiKeyRequest = z.object({
  name: z.string().min(1),
  workspaceId: z.string().uuid().optional(),
  permissions: z.array(Permission).min(1),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequest>;

export const CreateApiKeyResponse = z.object({
  apiKey: ApiKey,
  token: z.string().min(1),
});
export type CreateApiKeyResponse = z.infer<typeof CreateApiKeyResponse>;

// A person (or API key) with access to a workspace: one workspace_memberships
// row. `subjectId` is `user:<betterAuthUserId>` or `api_key:<id>`; the People
// surface lists the `user:` subjects (api_key subjects belong to API keys).
export const WorkspaceMember = z.object({
  subjectId: z.string().min(1),
  subjectLabel: z.string().nullable(),
  role: z.string(),
  permissions: z.array(Permission),
  createdAt: z.string(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;

export const ListWorkspaceMembersResponse = z.object({
  members: z.array(WorkspaceMember),
});
export type ListWorkspaceMembersResponse = z.infer<typeof ListWorkspaceMembersResponse>;

export const AddWorkspaceMemberRequest = z.object({
  // Resolved against the managed (Better Auth) users; email invites for
  // not-yet-registered users are deferred, so an unknown email returns 404.
  email: z.string().email(),
  role: z.string().min(1).optional(),
  permissions: z.array(Permission),
});
export type AddWorkspaceMemberRequest = z.infer<typeof AddWorkspaceMemberRequest>;

export const UpdateWorkspaceMemberRequest = z.object({
  role: z.string().min(1).optional(),
  permissions: z.array(Permission),
});
export type UpdateWorkspaceMemberRequest = z.infer<typeof UpdateWorkspaceMemberRequest>;

export const UsageEventType = z.enum([
  "agent_run.created",
  "agent_run.completed",
  "model.tokens",
  "model.cost",
  "file.uploaded",
  "file.deleted",
  "document.indexed",
  "scheduled_task.fired",
  "api_key.request",
  // --- sandbox warm-time metering (P2.1) ---
  // Wall-clock seconds a box was warm — the billable warm-time meter. Accrued on
  // the two stateless ticks (turn heartbeat + reaper sweep), idempotent on
  // (sandbox_group_id, lease_epoch, tick) so a shared box (N sessions) is metered
  // EXACTLY ONCE per tick (N sessions != N x bill). Orthogonal to model.tokens /
  // model.cost (model API cost vs provider compute cost — both real, no overlap).
  "sandbox.warm_seconds",
  // usd_micros: warm-seconds x the per-provider per-second warm rate.
  "sandbox.warm_cost",
]);
export type UsageEventType = z.infer<typeof UsageEventType>;

export const UsageEvent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
  subjectId: z.string().nullable(),
  eventType: UsageEventType,
  quantity: z.number(),
  unit: z.string(),
  sourceResourceType: z.string().nullable(),
  sourceResourceId: z.string().nullable(),
  idempotencyKey: z.string(),
  occurredAt: z.string(),
  recordedAt: z.string(),
  exportedToBillingAt: z.string().nullable(),
  billingProviderEventId: z.string().nullable(),
});
export type UsageEvent = z.infer<typeof UsageEvent>;

export const LimitAction = z.enum([
  "agent_run:create",
  "tokens:consume",
  "file:upload",
  "document:index",
  "schedule:create",
  "workspace:create",
  "api_key:create",
]);
export type LimitAction = z.infer<typeof LimitAction>;

export const StaticUsageLimits = z.object({
  maxWorkspacesPerAccount: z.number().int().positive().optional(),
  maxApiKeysPerWorkspace: z.number().int().positive().optional(),
  maxSchedulesPerWorkspace: z.number().int().positive().optional(),
  maxFileUploadBytes: z.number().int().positive().optional(),
  maxMonthlyAgentRunsPerWorkspace: z.number().int().positive().optional(),
  maxMonthlyTokensPerWorkspace: z.number().int().positive().optional(),
  maxMonthlyCostMicrosPerAccount: z.number().int().positive().optional(),
  maxDocumentIndexedChunksPerWorkspace: z.number().int().positive().optional(),
});
export type StaticUsageLimits = z.infer<typeof StaticUsageLimits>;

export const EntitlementValue = z.union([z.boolean(), z.string(), z.number(), z.array(z.string())]);
export type EntitlementValue = z.infer<typeof EntitlementValue>;

export const Entitlements = z.record(z.string().min(1), EntitlementValue);
export type Entitlements = z.infer<typeof Entitlements>;

export const LimitDecision = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }),
  z.object({ allowed: z.literal(false), code: z.string(), message: z.string() }),
]);
export type LimitDecision = z.infer<typeof LimitDecision>;

// ============ P3 — Entitlements port (§7.5) ============
//
// The host-providable admission seam over OpenGeni's TWO existing admission
// sites: the API edge (`checkLimit`/`requireLimit`, billing/limits.ts) AND the
// worker edge (`ensureRunAllowed`, agent-turn.ts — both turn-entry and the
// mid-stream budget valve). A host that owns its OWN ledger/meter binds this to
// keep OpenGeni from re-deriving admission from its local ledger.
//
// CRITICAL CONTRACT: `admitRun` returns a transport-neutral allow/deny decision
// (+ optional structured reason + the echoed quantity it admitted) and NEVER
// exposes `getBillingBalance` or any ledger internals — the host's balance math
// stays on the host side of the boundary. This is what lets the same port serve
// both PUSH (host funds OpenGeni's ledger; admission is a LOCAL read of that
// funded ledger) and PULL (a network callback to the host's own meter).
//
// `action` is a free `string` (NOT the internal `LimitAction` enum) so a host
// meter can key on actions OpenGeni does not model. `quantity` is the units the
// caller is about to consume (tokens, bytes, 1 run, …); the decision MAY echo
// the admitted quantity so a PULL host can grant a partial allowance.
export const EntitlementDecision = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true), quantity: z.number().optional() }),
  z.object({ allowed: z.literal(false), reason: z.string(), code: z.string().optional(), quantity: z.number().optional() }),
]);
export type EntitlementDecision = z.infer<typeof EntitlementDecision>;

export type AdmitRunInput = {
  accountId: string;
  workspaceId: string;
  action: string;
  quantity: number;
};

export type EntitlementsPort = {
  admitRun(input: AdmitRunInput): Promise<EntitlementDecision>;
};

export const GitCredentialProvider = z.enum(["github", "gitlab", "azure_devops"]);
export type GitCredentialProvider = z.infer<typeof GitCredentialProvider>;

const GitProviderRepositoryId = z.union([z.number().int().positive(), z.string().min(1)]);

export const GitCredentialRepositoryRef = z.object({
  provider: GitCredentialProvider.optional(),
  uri: z.string().min(1),
  ref: z.string().min(1),
  repositoryId: GitProviderRepositoryId.optional(),
  installationId: GitProviderRepositoryId.optional(),
  projectId: GitProviderRepositoryId.optional(),
  connectionId: z.string().min(1).optional(),
});
export type GitCredentialRepositoryRef = z.infer<typeof GitCredentialRepositoryRef>;

// ============ P4a — Connection-credential provider (§7.6) ============
//
// The host-providable per-run credential-mint seam over OpenGeni's TWO
// run-scoped credential sites in the worker:
//   - GIT credentials: run-scoped provider tokens minted in
//     `sandboxEnvironmentForRun` (standalone self-mints GitHub App tokens from
//     `settings`; embedded hosts can broker GitHub, GitLab, and Azure DevOps)
//     and seeded off-manifest into sandbox token files for git + provider CLIs.
//   - SANDBOX secrets: the decrypted workspace environment values loaded in
//     `loadWorkspaceEnvironmentForRun` (today decrypted with
//     `environmentsEncryptionKeyBytes(settings)`).
//
// In embedded/separate topologies the HOST owns these external connections
// (its GitHub App, its secret vault + encryption key). When a host binds this
// port, OpenGeni asks the host to mint/decrypt per-run instead of self-minting
// from `settings`. Unset (standalone default) → byte-for-byte today's
// self-mint.
//
// FORK-7 CROSS-CHECK (the host-mapping safety guardrail): a credential
// provider returns the `workspaceId` it scoped the credential to, and the
// activity ASSERTS it agrees with the run's workspace BEFORE injecting
// any git provider token seed (or applying decrypted environment values). A host mapping bug that
// returns tenant B's creds while the run is tenant A is thereby caught at the
// seam, never silently injected into tenant A's sandbox.

export type GitCredentialsRequest = {
  accountId: string;
  workspaceId: string;
  // Provider defaults to "github" for the legacy request shape. GitHub-only
  // hosts can keep reading installationId/repositoryIds exactly as before;
  // provider-aware hosts should branch on this and repositoryRefs.
  provider?: GitCredentialProvider;
  // Provider-neutral repository refs for hosts that broker non-GitHub tokens.
  // For GitHub requests these are additive to the legacy fields below.
  repositoryRefs?: GitCredentialRepositoryRef[];
  // Legacy GitHub App installation shape retained for 0.x compatibility.
  installationId: number;
  repositoryIds: number[];
};

export type GitCredentials = {
  // The minted provider token the activity writes into provider-specific
  // sandbox token files. The value never enters the manifest.
  token: string;
  // FORK-7 echo: the workspace the provider scoped this token to. The activity
  // asserts `workspaceId === request.workspaceId` before injecting.
  workspaceId: string;
  // Optional git identity override. When omitted the activity falls back to
  // today's `githubAppBotIdentity(settings)`.
  identity?: { name: string; email: string } | null;
};

export type SandboxSecretsRequest = {
  accountId: string;
  workspaceId: string;
  // The workspace environment the run's session declares (null = unattached;
  // the provider, like the self-mint path, returns null values for it).
  environmentId: string;
};

export type SandboxSecrets = {
  // The decrypted environment values the run injects, replacing the local
  // `environmentsEncryptionKeyBytes` decrypt. Same shape the self-mint path
  // produces (plaintext name→value).
  values: Record<string, string>;
  // FORK-7 echo: the workspace the provider scoped these secrets to.
  workspaceId: string;
  // Optional environment metadata; when omitted the activity uses the
  // environmentId as both id and name (the local decrypt carries the row's
  // id/name/description, but only `id` is load-bearing downstream).
  id?: string;
  name?: string;
  description?: string | null;
};

export type ConnectionCredentialsPort = {
  // Both legs are optional: a host may drive ONLY git creds (BYO-GitHub-App)
  // and leave sandbox secrets to OpenGeni's local decrypt, or vice-versa. An
  // unset leg falls through to today's self-mint for THAT leg only.
  gitCredentials?(input: GitCredentialsRequest): Promise<GitCredentials>;
  sandboxSecrets?(input: SandboxSecretsRequest): Promise<SandboxSecrets>;
};

// ============ P4a — GitHub App API port (BYO-App, §7.6 / SPIKE-2 remainder) ===
//
// The host-driven GitHub-API credential leg. SPIKE-2 closed the establishment +
// gate (storage) axis; this closes the credential leg by making the two live
// GitHub-API calls host-PROVIDABLE so a BYO-GitHub-App host drives its OWN App
// credentials (its own JWT-signing key, its own OAuth client) instead of
// OpenGeni self-minting from `settings`:
//   - verifyInstallationAccessForUser: the OAuth code→token + installation
//     lookup that PROVES the install is real (today
//     `verifyGitHubInstallationAccessForUser(settings, …)`).
//   - listRepositories: the installation-scoped repo listing behind
//     `GET /v1/workspaces/:id/github/repositories` (today
//     `listGitHubAppRepositories(settings, …)`).
//
// Unset (standalone default) → today's `settings`-based self-mint runs
// byte-for-byte (the live GitHub-API verify/list against OpenGeni's own App).

export type GitHubInstallationSummary = {
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  suspended: boolean;
};

export type GitHubAppApiPort = {
  verifyInstallationAccessForUser?: (input: {
    code: string;
    installationId: number;
  }) => Promise<GitHubInstallationSummary>;
  listRepositories?: (input: {
    installationIds?: number[];
  }) => Promise<GitHubRepository[]>;
};

export const BillingBalance = z.object({
  accountId: z.string().uuid(),
  balanceMicros: z.number().int(),
  currency: z.literal("usd"),
  updatedAt: z.string(),
});
export type BillingBalance = z.infer<typeof BillingBalance>;

export const CreateCheckoutRequest = z.object({
  accountId: z.string().uuid().optional(),
  amountUsd: z.number().min(5).max(10_000).refine(
    (value) => Number.isFinite(value) && Math.abs(value - Math.round(value * 100) / 100) < 1e-9,
    { message: "amountUsd must use cent precision" },
  ),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequest>;

export const CreateCheckoutResponse = z.object({
  checkoutSessionId: z.string(),
  url: z.string().url(),
});
export type CreateCheckoutResponse = z.infer<typeof CreateCheckoutResponse>;

export const RepositoryResourceRef = z.object({
  kind: z.literal("repository"),
  uri: z.string().min(1),
  ref: z.string().min(1),
  mountPath: z.string().min(1).optional(),
  subpath: z.string().min(1).optional(),
  provider: GitCredentialProvider.optional(),
  repositoryId: GitProviderRepositoryId.optional(),
  installationId: GitProviderRepositoryId.optional(),
  projectId: GitProviderRepositoryId.optional(),
  connectionId: z.string().min(1).optional(),
  githubInstallationId: z.number().int().positive().optional(),
  githubRepositoryId: z.number().int().positive().optional(),
});
export type RepositoryResourceRef = z.infer<typeof RepositoryResourceRef>;

export const FileResourceRef = z.object({
  kind: z.literal("file"),
  fileId: z.string().uuid(),
  mountPath: z.string().min(1).optional(),
});
export type FileResourceRef = z.infer<typeof FileResourceRef>;

export const ResourceRef = z.discriminatedUnion("kind", [RepositoryResourceRef, FileResourceRef]);
export type ResourceRef = z.infer<typeof ResourceRef>;

export const FileStatus = z.enum(["pending_upload", "ready", "failed", "expired", "deleted"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const FileUploadStatus = z.enum(["pending", "completed", "expired", "failed"]);
export type FileUploadStatus = z.infer<typeof FileUploadStatus>;

export const FileAsset = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  status: FileStatus,
  filename: z.string(),
  safeFilename: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  bucket: z.string(),
  objectKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FileAsset = z.infer<typeof FileAsset>;

export const CreateFileUploadRequest = z.object({
  filename: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().min(1).optional(),
});
export type CreateFileUploadRequest = z.infer<typeof CreateFileUploadRequest>;

export const CreateFileUploadResponse = z.object({
  fileId: z.string().uuid(),
  uploadId: z.string().uuid(),
  putUrl: z.string().url(),
  requiredHeaders: z.record(z.string(), z.string()),
  expiresAt: z.string(),
  maxSizeBytes: z.number().int().positive(),
});
export type CreateFileUploadResponse = z.infer<typeof CreateFileUploadResponse>;

export const CompleteFileUploadResponse = z.object({
  file: FileAsset,
});
export type CompleteFileUploadResponse = z.infer<typeof CompleteFileUploadResponse>;

export const FileDownloadUrlResponse = z.object({
  url: z.string().url(),
  expiresAt: z.string(),
});
export type FileDownloadUrlResponse = z.infer<typeof FileDownloadUrlResponse>;

export const DocumentStatus = z.enum(["queued", "indexing", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const KnowledgeSourceKind = z.enum(["manual_upload", "meeting_transcript", "repository", "email", "chat", "document", "web", "other"]);
export type KnowledgeSourceKind = z.infer<typeof KnowledgeSourceKind>;

export const DocumentSearchMode = z.enum(["hybrid", "vector", "keyword"]);
export type DocumentSearchMode = z.infer<typeof DocumentSearchMode>;

export const DocumentBase = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentBase = z.infer<typeof DocumentBase>;

export const Document = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  baseId: z.string().uuid(),
  fileId: z.string().uuid(),
  status: DocumentStatus,
  title: z.string(),
  parser: z.string(),
  chunkCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  sourceKind: KnowledgeSourceKind,
  sourceUri: z.string().nullable(),
  sourceExternalId: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceAuthor: z.string().nullable(),
  sourceCreatedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  aclTags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Document = z.infer<typeof Document>;

export const DocumentSearchResult = z.object({
  chunkId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  documentId: z.string().uuid(),
  baseId: z.string().uuid(),
  fileId: z.string().uuid(),
  title: z.string(),
  text: z.string(),
  score: z.number(),
  matchType: DocumentSearchMode,
  vectorScore: z.number().nullable(),
  keywordScore: z.number().nullable(),
  chunkIndex: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  sourceKind: KnowledgeSourceKind,
  sourceUri: z.string().nullable(),
  sourceExternalId: z.string().nullable(),
  sourceTitle: z.string().nullable(),
  sourceAuthor: z.string().nullable(),
  sourceCreatedAt: z.string().nullable(),
  sourceUpdatedAt: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  aclTags: z.array(z.string()),
});
export type DocumentSearchResult = z.infer<typeof DocumentSearchResult>;

export const CreateDocumentBaseRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateDocumentBaseRequest = z.infer<typeof CreateDocumentBaseRequest>;

export const AddDocumentRequest = z.object({
  fileId: z.string().uuid(),
  title: z.string().min(1).optional(),
  sourceKind: KnowledgeSourceKind.optional(),
  sourceUri: z.string().min(1).optional(),
  sourceExternalId: z.string().min(1).optional(),
  sourceTitle: z.string().min(1).optional(),
  sourceAuthor: z.string().min(1).optional(),
  sourceCreatedAt: z.string().datetime({ offset: true }).optional(),
  sourceUpdatedAt: z.string().datetime({ offset: true }).optional(),
  sourceVersion: z.string().min(1).optional(),
  aclTags: z.array(z.string().min(1)).optional(),
});
export type AddDocumentRequest = z.infer<typeof AddDocumentRequest>;

export const DocumentSearchRequest = z.object({
  query: z.string().min(1),
  baseIds: z.array(z.string().uuid()).optional(),
  mode: DocumentSearchMode.optional(),
  sourceKinds: z.array(KnowledgeSourceKind).optional(),
  aclTags: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(50).default(5),
});
export type DocumentSearchRequest = z.infer<typeof DocumentSearchRequest>;

// proposed/approved/rejected are the legacy curated-knowledge review states
// (docs-MCP memory_propose lane). active/superseded/archived are Workspace
// Memory V1: agent-written memories land `active` (usable immediately — human is
// auditor, not gatekeeper), get `superseded` when replaced, `archived` when
// retired. Agent-visible set = active ∪ approved.
export const KnowledgeMemoryStatus = z.enum([
  "proposed",
  "approved",
  "rejected",
  "active",
  "superseded",
  "archived",
]);
export type KnowledgeMemoryStatus = z.infer<typeof KnowledgeMemoryStatus>;

export const KnowledgeMemoryKind = z.enum(["semantic", "episodic", "procedural", "decision", "preference"]);
export type KnowledgeMemoryKind = z.infer<typeof KnowledgeMemoryKind>;

export const KnowledgeSourceRef = z.object({
  kind: z.enum(["document_chunk", "document", "session_event", "memory", "external"]),
  id: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type KnowledgeSourceRef = z.infer<typeof KnowledgeSourceRef>;

export const KnowledgeMemory = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  status: KnowledgeMemoryStatus,
  kind: KnowledgeMemoryKind,
  scope: z.string(),
  text: z.string(),
  sourceRefs: z.array(KnowledgeSourceRef),
  confidence: z.number().min(0).max(1),
  metadata: z.record(z.string(), z.unknown()),
  createdBySessionId: z.string().uuid().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  // Workspace Memory V1 fields. usageCount/lastUsedAt feed end-state ranking and
  // decay; supersedesId/supersededById link correction chains; validFrom/validUntil
  // are the point-in-time window. embedding/embeddingModel/textHash are internal
  // and never exposed on the wire.
  pinned: z.boolean(),
  usageCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
  supersedesId: z.string().uuid().nullable(),
  supersededById: z.string().uuid().nullable(),
  validFrom: z.string(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KnowledgeMemory = z.infer<typeof KnowledgeMemory>;

// Default status is `active`: a create through this request lands an
// agent-visible memory via the one write gate (saveWorkspaceMemory). Passing an
// explicit `proposed`/`approved`/`rejected` status routes to the legacy curated
// create instead (the docs-MCP memory_propose lane). pinned/replacesId apply to
// the active (memory) path.
export const CreateKnowledgeMemoryRequest = z.object({
  status: KnowledgeMemoryStatus.default("active"),
  kind: KnowledgeMemoryKind.default("semantic"),
  scope: z.string().min(1).default("workspace"),
  text: z.string().min(1),
  sourceRefs: z.array(KnowledgeSourceRef).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdBySessionId: z.string().uuid().optional(),
  pinned: z.boolean().optional(),
  replacesId: z.string().min(1).optional(),
});
export type CreateKnowledgeMemoryRequest = z.infer<typeof CreateKnowledgeMemoryRequest>;

export const UpdateKnowledgeMemoryRequest = z.object({
  status: KnowledgeMemoryStatus.optional(),
  kind: KnowledgeMemoryKind.optional(),
  scope: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  sourceRefs: z.array(KnowledgeSourceRef).optional(),
  confidence: z.number().min(0).max(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  reviewedBy: z.string().min(1).optional(),
  // Human audit action: pin (never decays) / unpin.
  pinned: z.boolean().optional(),
});
export type UpdateKnowledgeMemoryRequest = z.infer<typeof UpdateKnowledgeMemoryRequest>;

// GET list/filter over knowledge memories (curated + memory).
export const KnowledgeMemorySearchRequest = z.object({
  query: z.string().min(1).optional(),
  status: KnowledgeMemoryStatus.optional(),
  kind: KnowledgeMemoryKind.optional(),
  scope: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
});
export type KnowledgeMemorySearchRequest = z.infer<typeof KnowledgeMemorySearchRequest>;

export const WorkspaceMemorySearchMode = z.enum(["hybrid", "vector", "keyword"]);
export type WorkspaceMemorySearchMode = z.infer<typeof WorkspaceMemorySearchMode>;

// POST hybrid search over the workspace's agent-visible memory (active ∪ approved).
export const WorkspaceMemorySearchRequest = z.object({
  query: z.string().min(1),
  kind: KnowledgeMemoryKind.optional(),
  limit: z.number().int().positive().max(20).optional(),
  mode: WorkspaceMemorySearchMode.optional(),
});
export type WorkspaceMemorySearchRequest = z.infer<typeof WorkspaceMemorySearchRequest>;

export const WorkspaceMemorySearchResult = z.object({
  memory: KnowledgeMemory,
  score: z.number(),
  matchType: WorkspaceMemorySearchMode,
  vectorScore: z.number().nullable(),
  keywordScore: z.number().nullable(),
});
export type WorkspaceMemorySearchResult = z.infer<typeof WorkspaceMemorySearchResult>;

export const WorkspaceMemorySearchResponse = z.object({
  results: z.array(WorkspaceMemorySearchResult),
});
export type WorkspaceMemorySearchResponse = z.infer<typeof WorkspaceMemorySearchResponse>;

export const ToolRef = z.object({
  kind: z.literal("mcp"),
  id: z.string().min(1),
  // Non-fatal-on-connect marker for MCP server refs that can degrade
  // gracefully. Absent/false is STRICT: the id must be configured and an
  // unavailable server fails the turn. `optional:true` is preserved for known
  // servers and makes runtime connect/list failures skip that server; if the
  // deployment does not configure the id, validation drops the ref. The server
  // also sets this for auto-attached workspace-default capability MCPs.
  optional: z.boolean().optional(),
});
export type ToolRef = z.infer<typeof ToolRef>;

const registryId = /^[A-Za-z0-9_-]+$/;
const httpsUrl = z.string().url().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, { message: "URL must use https" });

export const SessionMcpServerInput = z.object({
  id: z.string().min(1).regex(registryId),
  name: z.string().min(1).optional(),
  url: httpsUrl,
  allowedTools: z.array(z.string().min(1)).optional(),
  timeoutMs: z.number().int().positive().optional(),
  cacheToolsList: z.boolean().optional(),
  // Human-approval policy for this server's tools. `true` = every tool of this
  // server requires approval before it runs (a `session.requiresAction` pause
  // the caller resolves with `user.approvalDecision`); a string[] = ONLY the
  // listed UNPREFIXED tool names require approval (e.g. reads auto-run, writes
  // ask); absent / `false` = auto-run everything (the historical default).
  requireApproval: z.union([z.boolean(), z.array(z.string().min(1))]).optional(),
  // Write-only credential headers. Values are encrypted at rest and never
  // returned in session responses or events; response metadata exposes names.
  headers: z.record(z.string(), z.string()).optional(),
});
export type SessionMcpServerInput = z.infer<typeof SessionMcpServerInput>;

export const SessionMcpCredentialUpdateInput = z.object({
  id: z.string().min(1).regex(registryId),
  headers: z.record(z.string(), z.string()),
});
export type SessionMcpCredentialUpdateInput = z.infer<typeof SessionMcpCredentialUpdateInput>;

export const SessionMcpServerMetadata = z.object({
  id: z.string().min(1).regex(registryId),
  name: z.string().min(1).nullable(),
  url: httpsUrl,
  headerNames: z.array(z.string()).default([]),
  credentialVersion: z.number().int().positive(),
}).strict();
export type SessionMcpServerMetadata = z.infer<typeof SessionMcpServerMetadata>;

export class ResourceRefConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRefConflictError";
  }
}

export function mergeToolRefs(existing: ToolRef[], additions: ToolRef[]): ToolRef[] {
  const byKey = new Map<string, ToolRef>();
  const order: string[] = [];
  for (const tool of [...existing, ...additions]) {
    const key = `${tool.kind}:${tool.id}`;
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, tool);
      order.push(key);
      continue;
    }
    // Strict wins: if the same server appears both optional and strict, the
    // strict occurrence upgrades the merged ref so an unavailable server fails
    // the turn. This preserves the fail-loud default when defaults, packs, and
    // per-turn tool selections are combined.
    if (prior.optional === true && tool.optional !== true) {
      const { optional: _dropped, ...strict } = prior;
      byKey.set(key, strict);
    }
  }
  return order.map((key) => byKey.get(key)!);
}

export function mergeResourceRefs(
  existing: ResourceRef[],
  additions: ResourceRef[],
  options: { rejectConflicts?: boolean } = {},
): ResourceRef[] {
  const out = [...existing];
  const mountPaths = new Map(existing.flatMap((resource) => resource.mountPath ? [[resource.mountPath, stableJson(resource)] as const] : []));
  const identities = new Map(existing.map((resource) => [resourceIdentityKey(resource), stableJson(resource)] as const));
  const exact = new Set(existing.map(stableJson));

  for (const resource of additions) {
    const serialized = stableJson(resource);
    if (exact.has(serialized)) {
      continue;
    }
    if (options.rejectConflicts) {
      const existingAtMount = resource.mountPath ? mountPaths.get(resource.mountPath) : undefined;
      if (existingAtMount && existingAtMount !== serialized) {
        throw new ResourceRefConflictError(`resource mount path is already attached: ${resource.mountPath}`);
      }
      const identity = resourceIdentityKey(resource);
      const existingIdentity = identities.get(identity);
      if (existingIdentity && existingIdentity !== serialized) {
        throw new ResourceRefConflictError(`resource is already attached with different settings: ${identity}`);
      }
    }
    out.push(resource);
    exact.add(serialized);
    identities.set(resourceIdentityKey(resource), serialized);
    if (resource.mountPath) {
      mountPaths.set(resource.mountPath, serialized);
    }
  }
  return out;
}

export function reasoningEffortForMetadata(metadata: Record<string, unknown>, fallback: ReasoningEffort): ReasoningEffort {
  const value = metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

export function resourceIdentityKey(resource: ResourceRef): string {
  if (resource.kind === "file") {
    return `file:${resource.fileId}`;
  }
  return `repository:${resource.uri}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}

export const SessionTurnStatus = z.enum(["queued", "running", "requires_action", "completed", "failed", "cancelled"]);
export type SessionTurnStatus = z.infer<typeof SessionTurnStatus>;

export const SessionTurnSource = z.enum(["user", "scheduled_task", "api", "goal"]);
export type SessionTurnSource = z.infer<typeof SessionTurnSource>;

export const SessionGoalStatus = z.enum(["active", "paused", "completed"]);
export type SessionGoalStatus = z.infer<typeof SessionGoalStatus>;

export const SessionGoalCreatedBy = z.enum(["api", "agent", "scheduled_task"]);
export type SessionGoalCreatedBy = z.infer<typeof SessionGoalCreatedBy>;

export const SessionGoalPausedReason = z.enum([
  "agent",
  "user_interrupt",
  "api",
  "no_progress",
  "max_auto_continuations",
  "limits",
]);
export type SessionGoalPausedReason = z.infer<typeof SessionGoalPausedReason>;

export const SessionGoal = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: SessionGoalStatus,
  text: z.string(),
  successCriteria: z.string().nullable(),
  evidence: z.string().nullable(),
  rationale: z.string().nullable(),
  pausedReason: z.string().nullable(),
  createdBy: SessionGoalCreatedBy,
  version: z.number().int().positive(),
  autoContinuations: z.number().int().nonnegative(),
  noProgressStreak: z.number().int().nonnegative(),
  maxAutoContinuations: z.number().int().positive().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionGoal = z.infer<typeof SessionGoal>;

export const GoalSpec = z.object({
  text: z.string().min(1),
  successCriteria: z.string().min(1).optional(),
  maxAutoContinuations: z.number().int().positive().optional(),
});
export type GoalSpec = z.infer<typeof GoalSpec>;

export const UpdateSessionGoalRequest = z.object({
  status: z.enum(["paused", "active"]),
  rationale: z.string().min(1).optional(),
});
export type UpdateSessionGoalRequest = z.infer<typeof UpdateSessionGoalRequest>;

export const UpdateSessionRequest = z.object({
  title: z.string().min(1).max(200),
});
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequest>;

// Operator context controls (slash-command palette: /clear, /compact). These
// are session/operator actions, NOT a structured way to talk to the agent —
// the human↔agent channel stays plain chat. Both require `sessions:control`.

/**
 * Clear a session's conversation context. `confirm` must be the literal `true`
 * so an accidental/empty POST cannot wipe context — the destructive intent is
 * explicit on the wire, mirroring the client-side confirm affordance.
 */
export const ClearSessionContextRequest = z.object({
  confirm: z.literal(true),
});
export type ClearSessionContextRequest = z.infer<typeof ClearSessionContextRequest>;

/**
 * The marker key on the sentinel run-state blob written by a context clear. The
 * blob ({@link CLEARED_RUN_STATE_BLOB}) is NOT a real Agents-SDK serialized run
 * state — it carries no `$schemaVersion`/history, so `RunState.fromString` would
 * throw on it. Every read path that deserializes a run-state blob MUST first
 * check {@link isClearedRunStateBlob} and treat a match as "no prior state"
 * (a fresh, empty start), which is exactly what a clear means. This is the
 * shared contract that keeps the db (writer) and the runtime (reader) in sync.
 */
export const CLEARED_RUN_STATE_MARKER = "$opengeniCleared" as const;

/** The canonical sentinel serializedRunState value a context clear stores. */
export const CLEARED_RUN_STATE_BLOB = JSON.stringify({ [CLEARED_RUN_STATE_MARKER]: true });

/**
 * True when a serialized run-state blob is the cleared sentinel rather than a
 * real Agents-SDK run state. Recognized leniently (any object carrying the
 * marker key set truthy) so a future field addition to the sentinel does not
 * resurrect the pre-clear context. Anything that is not the sentinel — including
 * malformed JSON — returns false so genuine blobs/corruption are handled by the
 * normal deserialize path.
 */
export function isClearedRunStateBlob(serialized: string | null | undefined): boolean {
  if (!serialized) {
    return false;
  }
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return typeof parsed === "object"
      && parsed !== null
      && (parsed as Record<string, unknown>)[CLEARED_RUN_STATE_MARKER] === true;
  } catch {
    return false;
  }
}

/** Trigger conversation compaction now. No body fields today (forward-room). */
export const CompactSessionContextRequest = z.object({}).strict();
export type CompactSessionContextRequest = z.infer<typeof CompactSessionContextRequest>;

/** Outcome of a manual /compact trigger. */
export const CompactSessionContextResult = z.object({
  // queued: a client-side (Azure) compaction will run before the next turn.
  // noop:   nothing to do (server-managed provider, mode off, or no history).
  status: z.enum(["queued", "noop"]),
  message: z.string(),
});
export type CompactSessionContextResult = z.infer<typeof CompactSessionContextResult>;

export const SessionTurn = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  triggerEventId: z.string().uuid(),
  temporalWorkflowId: z.string(),
  status: SessionTurnStatus,
  source: SessionTurnSource,
  position: z.number().int().positive(),
  prompt: z.string().min(1),
  resources: z.array(ResourceRef),
  tools: z.array(ToolRef),
  model: z.string().min(1),
  reasoningEffort: ReasoningEffort,
  sandboxBackend: SandboxBackend,
  // Per-turn OS override. NULL = inherit the session's sandboxOs.
  sandboxOs: SandboxOs.nullable(),
  metadata: z.record(z.string(), z.unknown()),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SessionTurn = z.infer<typeof SessionTurn>;

export const UpdateSessionTurnRequest = z.object({
  prompt: z.string().min(1).optional(),
  resources: z.array(ResourceRef).optional(),
  tools: z.array(ToolRef).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateSessionTurnRequest = z.infer<typeof UpdateSessionTurnRequest>;

export const ReorderSessionTurnsRequest = z.object({
  turnIds: z.array(z.string().uuid()).min(1),
});
export type ReorderSessionTurnsRequest = z.infer<typeof ReorderSessionTurnsRequest>;

export const WorkspaceEnvironmentVariableName = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(128);
export type WorkspaceEnvironmentVariableName = z.infer<typeof WorkspaceEnvironmentVariableName>;

// Metadata only by design: no schema in this file ever carries a variable value
// back to a client. Values are write-only and decrypted exclusively inside the
// worker at sandbox materialization time.
export const WorkspaceEnvironmentVariableMetadata = z.object({
  name: WorkspaceEnvironmentVariableName,
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceEnvironmentVariableMetadata = z.infer<typeof WorkspaceEnvironmentVariableMetadata>;

export const WorkspaceEnvironment = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  variables: z.array(WorkspaceEnvironmentVariableMetadata),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceEnvironment = z.infer<typeof WorkspaceEnvironment>;

export const CreateWorkspaceEnvironmentRequest = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  variables: z.array(z.object({
    name: WorkspaceEnvironmentVariableName,
    value: z.string().min(1).max(32768),
  })).default([]),
});
export type CreateWorkspaceEnvironmentRequest = z.infer<typeof CreateWorkspaceEnvironmentRequest>;

export const UpdateWorkspaceEnvironmentRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export type UpdateWorkspaceEnvironmentRequest = z.infer<typeof UpdateWorkspaceEnvironmentRequest>;

export const SetWorkspaceEnvironmentVariableRequest = z.object({
  value: z.string().min(1).max(32768),
});
export type SetWorkspaceEnvironmentVariableRequest = z.infer<typeof SetWorkspaceEnvironmentVariableRequest>;

export const ScheduledTaskStatus = z.enum(["active", "paused"]);
export type ScheduledTaskStatus = z.infer<typeof ScheduledTaskStatus>;

export const ScheduledTaskRunStatus = z.enum(["queued", "dispatched", "failed"]);
export type ScheduledTaskRunStatus = z.infer<typeof ScheduledTaskRunStatus>;

export const ScheduledTaskRunMode = z.enum(["new_session_per_run", "reusable_session"]);
export type ScheduledTaskRunMode = z.infer<typeof ScheduledTaskRunMode>;

export const ScheduledTaskOverlapPolicy = z.enum(["allow_concurrent", "skip", "buffer_one"]);
export type ScheduledTaskOverlapPolicy = z.infer<typeof ScheduledTaskOverlapPolicy>;

export const ScheduledTaskTriggerType = z.enum(["scheduled", "manual"]);
export type ScheduledTaskTriggerType = z.infer<typeof ScheduledTaskTriggerType>;

export const ScheduledTaskScheduleSpec = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    runAt: z.string().datetime({ offset: true }),
    timeZone: z.string().min(1).default("UTC"),
  }),
  z.object({
    type: z.literal("interval"),
    everySeconds: z.number().int().positive(),
    startAt: z.string().datetime({ offset: true }).optional(),
    endAt: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({
    type: z.literal("calendar"),
    timeZone: z.string().min(1).default("UTC"),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    daysOfWeek: z.array(z.enum(["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"])).min(1).optional(),
  }),
]);
export type ScheduledTaskScheduleSpec = z.infer<typeof ScheduledTaskScheduleSpec>;

export const ScheduledTaskAgentConfig = z.object({
  prompt: z.string().min(1),
  resources: z.array(ResourceRef).default([]),
  tools: z.array(ToolRef).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
  goal: GoalSpec.optional(),
});
export type ScheduledTaskAgentConfig = z.infer<typeof ScheduledTaskAgentConfig>;

export const ScheduledTask = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  status: ScheduledTaskStatus,
  schedule: ScheduledTaskScheduleSpec,
  temporalScheduleId: z.string(),
  runMode: ScheduledTaskRunMode,
  overlapPolicy: ScheduledTaskOverlapPolicy,
  agentConfig: ScheduledTaskAgentConfig,
  reusableSessionId: z.string().uuid().nullable(),
  environmentId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

export const ScheduledTaskRun = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  taskId: z.string().uuid(),
  status: ScheduledTaskRunStatus,
  triggerType: ScheduledTaskTriggerType,
  scheduledAt: z.string().nullable(),
  firedAt: z.string(),
  sessionId: z.string().uuid().nullable(),
  triggerEventId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTaskRun = z.infer<typeof ScheduledTaskRun>;

export const CreateScheduledTaskRequest = z.object({
  name: z.string().min(1),
  schedule: ScheduledTaskScheduleSpec,
  runMode: ScheduledTaskRunMode.default("new_session_per_run"),
  overlapPolicy: ScheduledTaskOverlapPolicy.default("allow_concurrent"),
  agentConfig: ScheduledTaskAgentConfig,
  status: ScheduledTaskStatus.default("active"),
  environmentId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateScheduledTaskRequest = z.infer<typeof CreateScheduledTaskRequest>;

export const UpdateScheduledTaskRequest = z.object({
  name: z.string().min(1).optional(),
  schedule: ScheduledTaskScheduleSpec.optional(),
  runMode: ScheduledTaskRunMode.optional(),
  overlapPolicy: ScheduledTaskOverlapPolicy.optional(),
  agentConfig: ScheduledTaskAgentConfig.optional(),
  status: ScheduledTaskStatus.optional(),
  environmentId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateScheduledTaskRequest = z.infer<typeof UpdateScheduledTaskRequest>;

/**
 * Manual-trigger body. `triggerId` is a client-supplied idempotency token: a
 * retried trigger that reuses the same token charges once and starts one run.
 * Omitting it makes each call a distinct trigger (the server mints a token).
 */
export const TriggerScheduledTaskRequest = z.object({
  triggerId: z.string().min(1).max(128).optional(),
});
export type TriggerScheduledTaskRequest = z.infer<typeof TriggerScheduledTaskRequest>;

export const CapabilityPackConnectorAuthModel = z.enum([
  "oauth2_authorization_code_pkce",
  "oauth2_authorization_code",
  "api_key",
  "credential_ref",
]);
export type CapabilityPackConnectorAuthModel = z.infer<typeof CapabilityPackConnectorAuthModel>;

export const CapabilityPackConnector = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  authModel: CapabilityPackConnectorAuthModel,
  providers: z.array(z.string().min(1)).default([]),
  scopes: z.array(z.string().min(1)).default([]),
  required: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityPackConnector = z.infer<typeof CapabilityPackConnector>;

export const CapabilityPackKnowledge = z.object({
  type: z.literal("document_base"),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  required: z.boolean().default(false),
});
export type CapabilityPackKnowledge = z.infer<typeof CapabilityPackKnowledge>;

export const CapabilityPackScheduledTaskTemplate = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultSchedule: ScheduledTaskScheduleSpec,
  defaultRunMode: ScheduledTaskRunMode.default("new_session_per_run"),
  defaultOverlapPolicy: ScheduledTaskOverlapPolicy.default("skip"),
  // Optional default agent prompt so registered pack manifests can ship fully
  // instantiable templates; built-in packs may instead build prompts in code.
  prompt: z.string().min(1).optional(),
});
export type CapabilityPackScheduledTaskTemplate = z.infer<typeof CapabilityPackScheduledTaskTemplate>;

// One file inside a pack skill directory. Paths are workspace-relative POSIX
// paths inside the skill directory (for example "SKILL.md" or
// "references/runbook.md"); content is UTF-8 text carried inline in the pack
// manifest, which is also how registered packs persist it (the manifest JSONB
// row in workspace_packs is the storage of record for pack skills).
export const CapabilityPackSkillFile = z.object({
  path: z.string().min(1).max(512).refine(isSafePackSkillRelativePath, {
    message: "skill file path must be a safe relative POSIX path without '..' segments",
  }),
  content: z.string().max(256 * 1024),
});
export type CapabilityPackSkillFile = z.infer<typeof CapabilityPackSkillFile>;

// A skill delivered by a capability pack. The name doubles as the skill
// directory under the sandbox skill index (skills/<name>), so it must be a
// single safe path segment. Every skill must ship a top-level SKILL.md.
export const CapabilityPackSkill = z.object({
  name: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
    message: "skill name must be a single path segment of letters, digits, '.', '_' or '-'",
  }),
  description: z.string().min(1).max(2048).optional(),
  files: z.array(CapabilityPackSkillFile).min(1).max(64),
}).superRefine((skill, ctx) => {
  const seen = new Set<string>();
  skill.files.forEach((file, index) => {
    if (seen.has(file.path)) {
      ctx.addIssue({ code: "custom", message: `duplicate skill file path: ${file.path}`, path: ["files", index, "path"] });
    }
    seen.add(file.path);
  });
  if (!skill.files.some((file) => file.path === "SKILL.md")) {
    ctx.addIssue({ code: "custom", message: "skill must include a top-level SKILL.md file", path: ["files"] });
  }
});
export type CapabilityPackSkill = z.infer<typeof CapabilityPackSkill>;

function isSafePackSkillRelativePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const CapabilityPack = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  category: z.string().min(1),
  version: z.string().min(1),
  // Container image ref (digest-pinned recommended) the pack's sessions run
  // in. At most one enabled pack per workspace may declare one; with none,
  // sessions use the deployment-wide image settings.
  sandboxImage: z.string().trim().min(1).max(512).optional(),
  // Skills delivered into the sandbox skill index when the pack is enabled.
  skills: z.array(CapabilityPackSkill).max(32).superRefine((skills, ctx) => {
    const seen = new Set<string>();
    skills.forEach((skill, index) => {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `duplicate pack skill name: ${skill.name}`, path: [index, "name"] });
      }
      seen.add(key);
    });
  }).default([]),
  tools: z.array(ToolRef).default([]),
  connectors: z.array(CapabilityPackConnector).default([]),
  knowledge: z.array(CapabilityPackKnowledge).default([]),
  scheduledTaskTemplates: z.array(CapabilityPackScheduledTaskTemplate).default([]),
  environment: z.object({
    description: z.string().min(1),
    requiredVariables: z.array(WorkspaceEnvironmentVariableName).default([]),
    required: z.boolean().default(false),
  }).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityPack = z.infer<typeof CapabilityPack>;

// Registering a pack stores the manifest itself; the request body is a full
// CapabilityPack manifest.
export const RegisterCapabilityPackRequest = CapabilityPack;
export type RegisterCapabilityPackRequest = z.infer<typeof RegisterCapabilityPackRequest>;

export const WorkspaceRegisteredPack = z.object({
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  pack: CapabilityPack,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkspaceRegisteredPack = z.infer<typeof WorkspaceRegisteredPack>;

export const PackInstallationStatus = z.enum(["active", "disabled"]);
export type PackInstallationStatus = z.infer<typeof PackInstallationStatus>;

export const PackInstallation = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  packId: z.string().min(1),
  status: PackInstallationStatus,
  metadata: z.record(z.string(), z.unknown()),
  enabledAt: z.string(),
  updatedAt: z.string(),
});
export type PackInstallation = z.infer<typeof PackInstallation>;

export const EnablePackRequest = z.object({
  environmentId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EnablePackRequest = z.infer<typeof EnablePackRequest>;

export const SocialProvider = z.enum([
  "x",
  "linkedin",
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "custom",
]);
export type SocialProvider = z.infer<typeof SocialProvider>;

export const SocialConnectionStatus = z.enum(["connected", "needs_reauth", "disabled"]);
export type SocialConnectionStatus = z.infer<typeof SocialConnectionStatus>;

export const SocialConnection = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  provider: SocialProvider,
  accountHandle: z.string().min(1),
  accountName: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  status: SocialConnectionStatus,
  scopes: z.array(z.string()),
  credentialRef: z.string().nullable(),
  tokenMetadata: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SocialConnection = z.infer<typeof SocialConnection>;

export const CreateSocialConnectionRequest = z.object({
  provider: SocialProvider,
  accountHandle: z.string().min(1),
  accountName: z.string().min(1).optional(),
  externalAccountId: z.string().min(1).optional(),
  status: SocialConnectionStatus.default("connected"),
  scopes: z.array(z.string().min(1)).default([]),
  credentialRef: z.string().min(1).optional(),
  tokenMetadata: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSocialConnectionRequest = z.infer<typeof CreateSocialConnectionRequest>;

export const SocialPost = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  provider: SocialProvider,
  externalPostId: z.string().nullable(),
  url: z.string().url().nullable(),
  authorHandle: z.string().nullable(),
  text: z.string(),
  publishedAt: z.string(),
  metrics: z.record(z.string(), z.number()),
  raw: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type SocialPost = z.infer<typeof SocialPost>;

export const CreateSocialPostRequest = z.object({
  connectionId: z.string().uuid(),
  externalPostId: z.string().min(1).optional(),
  url: z.string().url().optional(),
  authorHandle: z.string().min(1).optional(),
  text: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  metrics: z.record(z.string(), z.number()).default({}),
  raw: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSocialPostRequest = z.infer<typeof CreateSocialPostRequest>;

export const ConnectionKind = z.enum(["oauth2", "api_key", "app_install", "delegated"]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

export const ConnectionStatus = z.enum(["active", "needs_reauth", "revoked", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const McpServerConnectionRef = z.object({
  connectionId: z.string().uuid().optional(),
  providerDomain: z.string().min(1),
  kind: ConnectionKind.optional(),
  scopes: z.array(z.string().min(1)).optional(),
  resource: z.string().min(1).optional(),
  subjectScope: z.enum(["workspace", "subject"]).optional(),
}).strict();
export type McpServerConnectionRef = z.infer<typeof McpServerConnectionRef>;

export const ConnectionMetadata = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  subjectId: z.string().nullable(),
  providerDomain: z.string(),
  kind: ConnectionKind,
  status: ConnectionStatus,
  grantedScopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastRefreshAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  version: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()),
  createdBySubjectId: z.string().nullable(),
  updatedBySubjectId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ConnectionMetadata = z.infer<typeof ConnectionMetadata>;

export const ConnectionCredentialBundle = z.record(z.string(), z.unknown());
export type ConnectionCredentialBundle = z.infer<typeof ConnectionCredentialBundle>;

export const CreateConnectionRequest = z.object({
  providerDomain: z.string().min(1),
  kind: ConnectionKind,
  subjectId: z.string().min(1).nullable().optional(),
  credential: ConnectionCredentialBundle,
  grantedScopes: z.array(z.string().min(1)).default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

export const UpdateConnectionRequest = z.object({
  providerDomain: z.string().min(1).optional(),
  subjectId: z.string().min(1).nullable().optional(),
  kind: ConnectionKind.optional(),
  status: ConnectionStatus.optional(),
  credential: ConnectionCredentialBundle.optional(),
  grantedScopes: z.array(z.string().min(1)).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateConnectionRequest = z.infer<typeof UpdateConnectionRequest>;

export const ConnectionResponse = z.object({
  connection: ConnectionMetadata,
});
export type ConnectionResponse = z.infer<typeof ConnectionResponse>;

export const ListConnectionsResponse = z.object({
  connections: z.array(ConnectionMetadata),
});
export type ListConnectionsResponse = z.infer<typeof ListConnectionsResponse>;

export const OAuthStartRequest = z.object({
  providerDomain: z.string().min(1).optional(),
  mcpUrl: z.string().url().optional(),
  resource: z.string().url().optional(),
  requestedScopes: z.array(z.string().min(1)).default([]),
  returnPath: z.string().min(1).optional(),
  connectionId: z.string().uuid().optional(),
}).refine((value) => Boolean(value.mcpUrl ?? value.resource), {
  message: "mcpUrl is required",
  path: ["mcpUrl"],
});
export type OAuthStartRequest = z.infer<typeof OAuthStartRequest>;

export const OAuthStartResponse = z.object({
  state: z.string().min(1),
  authorizationUrl: z.string().url().nullable(),
  expiresAt: z.string(),
});
export type OAuthStartResponse = z.infer<typeof OAuthStartResponse>;

export const IntegrationClientMetadata = z.object({
  client_id: z.string().url(),
  client_name: z.literal("OpenGeni"),
  redirect_uris: z.array(z.string().url()),
  token_endpoint_auth_method: z.literal("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"])),
  response_types: z.array(z.literal("code")),
});
export type IntegrationClientMetadata = z.infer<typeof IntegrationClientMetadata>;

export const MarketingDailyAnalysisTaskRequest = z.object({
  name: z.string().min(1).optional(),
  connectionIds: z.array(z.string().uuid()).default([]),
  documentBaseIds: z.array(z.string().uuid()).default([]),
  timeZone: z.string().min(1).default("UTC"),
  hour: z.number().int().min(0).max(23).default(9),
  minute: z.number().int().min(0).max(59).default(0),
  promptInstructions: z.string().min(1).optional(),
  status: ScheduledTaskStatus.default("active"),
  runMode: ScheduledTaskRunMode.default("new_session_per_run"),
  overlapPolicy: ScheduledTaskOverlapPolicy.default("skip"),
});
export type MarketingDailyAnalysisTaskRequest = z.infer<typeof MarketingDailyAnalysisTaskRequest>;

export const CapabilityKind = z.enum(["pack", "mcp", "api", "skill", "plugin"]);
export type CapabilityKind = z.infer<typeof CapabilityKind>;

export const CapabilitySource = z.enum(["built_in", "configured", "public_registry", "registry", "manual"]);
export type CapabilitySource = z.infer<typeof CapabilitySource>;

export const CapabilityInstallationStatus = z.enum(["active", "disabled"]);
export type CapabilityInstallationStatus = z.infer<typeof CapabilityInstallationStatus>;

export const CapabilityCatalogAuthKind = z.enum(["oauth2", "api_key", "none", "unknown"]);
export type CapabilityCatalogAuthKind = z.infer<typeof CapabilityCatalogAuthKind>;

export const CapabilityCatalogTier = z.enum(["verified", "community"]);
export type CapabilityCatalogTier = z.infer<typeof CapabilityCatalogTier>;

export const CapabilityRuntime = z.object({
  available: z.boolean().default(false),
  mcpServerId: z.string().min(1).optional(),
  transport: z.string().min(1).optional(),
  notes: z.string().nullable().default(null),
});
export type CapabilityRuntime = z.infer<typeof CapabilityRuntime>;

export const CapabilityCatalogItem = z.object({
  id: z.string().min(1),
  accountId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  kind: CapabilityKind,
  source: CapabilitySource,
  name: z.string().min(1),
  description: z.string().nullable().default(null),
  category: z.string().min(1).default("custom"),
  tags: z.array(z.string().min(1)).default([]),
  homepageUrl: z.string().url().nullable().default(null),
  endpointUrl: z.string().url().nullable().default(null),
  installUrl: z.string().url().nullable().default(null),
  authModel: z.string().min(1).nullable().default(null),
  providerDomain: z.string().min(1).nullable().default(null),
  surfaceType: z.string().min(1).nullable().default(null),
  transport: z.string().min(1).nullable().default(null),
  mcpUrl: z.string().url().nullable().default(null),
  authKind: CapabilityCatalogAuthKind.nullable().default(null),
  credentialFacts: z.array(z.record(z.string(), z.unknown())).default([]),
  tier: CapabilityCatalogTier.nullable().default(null),
  provenance: z.string().min(1).nullable().default(null),
  logoAssetPath: z.string().min(1).nullable().default(null),
  importBatchId: z.string().uuid().nullable().default(null),
  stale: z.boolean().default(false),
  staleAt: z.string().nullable().default(null),
  tools: z.array(ToolRef).default([]),
  runtime: CapabilityRuntime.default({ available: false, notes: null }),
  enabled: z.boolean().default(false),
  enabledReason: z.string().nullable().default(null),
  // The connection backing this enabled installation, when the enable-time
  // connectionRef resolved to one (null for header/credential-free items —
  // that means "no connection involved", not "broken"). Lets the UI match
  // connection health by id instead of guessing from providerDomain alone.
  connectionRef: z.object({
    connectionId: z.string().min(1),
    providerDomain: z.string().min(1),
    kind: z.string().min(1),
  }).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type CapabilityCatalogItem = z.infer<typeof CapabilityCatalogItem>;

export const CapabilityInstallation = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  capabilityId: z.string().min(1),
  kind: CapabilityKind,
  status: CapabilityInstallationStatus,
  config: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()),
  enabledAt: z.string(),
  updatedAt: z.string(),
});
export type CapabilityInstallation = z.infer<typeof CapabilityInstallation>;

export const CreateCapabilityCatalogItemRequest = z.object({
  id: z.string().min(1).optional(),
  kind: CapabilityKind.exclude(["pack"]),
  source: CapabilitySource.default("manual"),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  category: z.string().min(1).default("custom"),
  tags: z.array(z.string().min(1)).default([]),
  homepageUrl: z.string().url().optional(),
  endpointUrl: z.string().url().optional(),
  installUrl: z.string().url().optional(),
  authModel: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateCapabilityCatalogItemRequest = z.infer<typeof CreateCapabilityCatalogItemRequest>;

export const EnableCapabilityRequest = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
  connectionRef: McpServerConnectionRef.optional(),
  /**
   * Credential headers for remote MCP capabilities (for example an
   * Authorization bearer token). Values are encrypted at rest with the
   * workspace-environments key, injected only into the runtime MCP client,
   * and never returned by the API — responses expose header names only.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /**
   * Initial environment attachment for kind=pack capabilities. Mirrors the
   * dedicated POST /packs/:id/enable body: required to enable an
   * environment.required pack through the unified capability-enable path,
   * optional otherwise. Ignored by non-pack capabilities.
   */
  environmentId: z.string().uuid().optional(),
});
export type EnableCapabilityRequest = z.infer<typeof EnableCapabilityRequest>;

export const CapabilityCatalogResponse = z.object({
  items: z.array(CapabilityCatalogItem),
  installations: z.array(CapabilityInstallation),
});
export type CapabilityCatalogResponse = z.infer<typeof CapabilityCatalogResponse>;

export const DiscoverMcpCapabilitiesResponse = z.object({
  items: z.array(CapabilityCatalogItem),
  source: z.literal("official_mcp_registry"),
  sourceUrl: z.string().url(),
});
export type DiscoverMcpCapabilitiesResponse = z.infer<typeof DiscoverMcpCapabilitiesResponse>;

export const Session = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  accountId: z.string().uuid(),
  status: SessionStatus,
  initialMessage: z.string(),
  title: z.string().nullable(),
  titleSource: z.enum(["user", "agent"]).nullable(),
  // Per-session agent persona/system instructions supplied at create. Org-visible
  // metadata (exposed like title/goal), never a secret and never a timeline event.
  // null when the session carried none.
  instructions: z.string().nullable(),
  resources: z.array(ResourceRef),
  tools: z.array(ToolRef),
  metadata: z.record(z.string(), z.unknown()),
  model: z.string(),
  sandboxBackend: SandboxBackend,
  // The OS the session's box runs. Defaults to 'linux' (today's only OS).
  sandboxOs: SandboxOs,
  // The shared-sandbox group the session's box belongs to. Equals the session's
  // own id for a singleton group (today's 1:1 default); equals the parent's
  // group when spawned shared (both sessions run in ONE box).
  sandboxGroupId: z.string().uuid(),
  // The first-class swappable-sandbox POINTER (bring-your-own-compute M2). NULL
  // resolves to the session's own group sandbox (the backward-compat default);
  // a swap sets it to the target sandbox row. active_epoch is the second epoch
  // ABOVE the lease epoch, bumped on every swap so the routing proxy can fence a
  // stale in-flight op and retry against the new active sandbox.
  activeSandboxId: z.string().uuid().nullable(),
  activeEpoch: z.number().int().nonnegative(),
  environmentId: z.string().uuid().nullable(),
  // Non-default first-party MCP token permissions (manager-style sessions);
  // null means the fixed worker default set.
  firstPartyMcpPermissions: z.array(Permission).nullable(),
  // Per-session third-party MCP servers, metadata only. Credential values are
  // write-only and never appear here.
  mcpServers: z.array(SessionMcpServerMetadata).default([]),
  // The manager session that spawned this one via session_create (set only
  // when the creating grant carried a worker-signed sessionId claim); null for
  // direct API creates and scheduled-task runs. When set, this session's
  // terminal-for-now transitions wake the parent.
  parentSessionId: z.string().uuid().nullable(),
  // Workspace-scoped CREATE idempotency key the session was created under (the
  // dedup target collapsing double-submit/retry races to one session); null
  // when the create carried no key.
  createIdempotencyKey: z.string().nullable(),
  temporalWorkflowId: z.string().nullable(),
  activeTurnId: z.string().uuid().nullable(),
  // Actual input tokens of the last model call of the most recent turn; the
  // pre-turn client-side context-compaction trigger reads it as its budget
  // signal. Null until a turn with usage has completed.
  lastInputTokens: z.number().int().nonnegative().nullable(),
  lastSequence: z.number().int().nonnegative(),
  // Multi-account Codex (P1). codexPinnedCredentialId: the account this session is
  // manually PINNED to (null ⇒ follow the workspace active pointer).
  // codexLastCredentialId: the account the most recent turn actually ran on (the
  // "Running on:" indicator's source). Both are credential-row ids, null until set.
  codexPinnedCredentialId: z.string().uuid().nullable(),
  codexLastCredentialId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

export type SessionSummary = Session;

// Recursive: the TS type is declared first so the schema annotation can carry
// the FULL recursive shape (a shallow annotation loses type information for
// contracts consumers after one level of nesting).
export type LineageNode = {
  session: SessionSummary;
  children: LineageNode[];
};
export const LineageNode: z.ZodType<LineageNode> = z.lazy(() => z.object({
  session: Session,
  children: z.array(LineageNode),
}));

export const SessionLineageResponse = z.object({
  ancestors: z.array(Session),
  children: z.array(LineageNode),
});
export type SessionLineageResponse = z.infer<typeof SessionLineageResponse>;

export const SessionEventType = z.enum([
  "session.created",
  "session.status.changed",
  "session.requiresAction",
  "session.context.compacted",
  "session.context.cleared",
  "user.message",
  "user.interrupt",
  "user.approvalDecision",
  "turn.queued",
  "turn.updated",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.preempted",
  "agent.message.delta",
  "agent.message.completed",
  "agent.reasoning.delta",
  "agent.toolCall.created",
  "agent.toolCall.output",
  "agent.model.usage",
  "tool.auth_needed",
  "agent.updated",
  "sandbox.operation.started",
  "sandbox.operation.completed",
  "sandbox.operation.failed",
  "sandbox.command.output.delta",
  "artifact.created",
  "goal.set",
  "goal.updated",
  "goal.completed",
  "goal.paused",
  "goal.resumed",
  "goal.continuation",
  "memory.saved",
  "memory.corrected",
  // Channel-B desktop pixel-plane signals (07-channel-b §1.2). The pixel socket
  // carries opaque RFB and cannot carry a control message the client can act on,
  // so these ride the durable, sequenced, gap-filled Channel-A SSE spine.
  "stream.url.rotated", // re-minted {url,token,expiresAt} on box rollover (event-driven)
  "stream.opened", // a viewer attached (audit + refcount visibility)
  "stream.closed", // a viewer detached / was reaped
  "stream.revoked", // a grant was revoked → connected clients MUST disconnect now
  // Channel-B recording signals (P4.3 / module 05 §3.4). The "agent films itself
  // proving the fix" loop: ffmpeg x11grab of the SAME :0 humans watch → artifact
  // → storage. The artifact ref rides the AVAILABLE event (storageKey, NOT a
  // long-lived URL — clients mint a short-TTL signed GET via the route).
  "recording.started", // ffmpeg launched on :0 (mode/codec/dimensions)
  "recording.available", // finalized: bytes PUT to storage, replayable
  "recording.failed", // ffmpeg/box-death/rollover/upload error — no artifact
  // Channel-A structured-service notifications (P4.4 / modules/08-channel-a.md
  // §2.2). The A2 reads (fs/git/terminal exec) are SYNCHRONOUS API-direct point
  // queries (their result is the HTTP response, NEVER an event). What rides A1
  // here are the side-effect NOTIFICATIONS — a path changed, git state changed,
  // a pty opened/printed/exited — durable, sequenced, gap-filled like every
  // other session event, so any viewer's Pierre tree / diff / terminal stays
  // live. fs.changed/git.changed are cache-invalidation signals; the pty.*
  // events carry the interactive terminal byte stream.
  "fs.changed", // a path was created/modified/deleted (write or agent mutation)
  "git.changed", // working-tree/index/HEAD changed (debounced re-probe)
  "terminal.pty.started", // an interactive PTY session opened (carries ptyId)
  "terminal.pty.output.delta", // PTY stdout/stderr bytes (separate from command.output)
  "terminal.pty.exited", // PTY session ended (exitCode/reason)
  "session.title_set",
  // Multi-account Codex (P1): the account a session's turn runs on changed
  // (manual switch in P1; failover/rotation in P3 reuse the same event). Drives
  // the in-session "Running on:" indicator's live flip.
  "codex.account.switched",
  // Sandbox durability observability (sandbox-file-persistence). The 2026-07
  // incidents (mid-session box death with /workspace loss; a fatal manifest-env
  // delta on a live box) were near-unattributable because box lifecycle left no
  // durable trace — only worker logs, which rotate within hours. These events
  // make every box transition and env recomputation drift readable from the DB
  // alone. Payloads carry ids/flags/key NAMES only — never env values (secrets).
  "sandbox.box.created", // box cold-created/cold-restored ({hydrated: "archive"|"none"})
  "sandbox.box.lost", // resume-by-id found the box gone (provider NotFound)
  "sandbox.box.terminated", // reaper drain terminated the box ({actor, persisted})
  "sandbox.box.snapshot", // mid-session /workspace snapshot persisted ({trigger})
  "sandbox.env.drift", // recomputed manifest env != live box env (key names only)
]);
export type SessionEventType = z.infer<typeof SessionEventType>;

export const ToolAuthNeededPayload = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1).nullable().optional(),
  providerDomain: z.string().min(1),
  connectionId: z.string().uuid().nullable().optional(),
  reason: z.enum(["missing_connection", "expired", "insufficient_scope", "refresh_failed"]),
  scopes: z.array(z.string().min(1)).optional(),
  resource: z.string().min(1).optional(),
  authorizationUrl: z.string().url().optional(),
  subjectId: z.string().min(1).nullable().optional(),
});
export type ToolAuthNeededPayload = z.infer<typeof ToolAuthNeededPayload>;

// Channel-B stream-event payloads (07-channel-b §1.2). SessionEvent.payload is
// z.unknown() (NOT a discriminated union) — these are standalone schemas parsed
// explicitly at the producer (the API-direct handshake/rotation) and the SDK/
// React consumer. The rotation payload carries the freshly-minted data-plane URL
// + the scoped stream token so a connected client hot-swaps its noVNC socket.
export const StreamUrlRotatedPayload = z.object({
  url: z.string().url(),
  token: z.string().nullable(),
  expiresAt: z.string().datetime().nullable(),
  // The epoch the new URL was minted under (the box-rollover fence the client
  // reconciles against). A client must drop a rotation event whose epoch it has
  // already advanced past.
  leaseEpoch: z.number().int().nonnegative(),
  transport: z.literal("vnc-ws"),
  // The viewer holder this URL is for (so a client filters out other viewers').
  viewerId: z.string().uuid().nullable().default(null),
});
export type StreamUrlRotatedPayload = z.infer<typeof StreamUrlRotatedPayload>;

export const StreamOpenedPayload = z.object({
  viewerId: z.string().uuid(),
  shared: z.boolean().default(false),
  viewerCount: z.number().int().nonnegative(),
});
export type StreamOpenedPayload = z.infer<typeof StreamOpenedPayload>;

export const StreamClosedPayload = z.object({
  viewerId: z.string().uuid(),
  reason: z.enum(["client-disconnect", "reaped", "revoked", "box-rollover"]),
  viewerCount: z.number().int().nonnegative(),
});
export type StreamClosedPayload = z.infer<typeof StreamClosedPayload>;

export const StreamRevokedPayload = z.object({
  viewerId: z.string().uuid().nullable().default(null),
  reason: z.enum(["grant-revoked", "session-failed", "admin"]),
});
export type StreamRevokedPayload = z.infer<typeof StreamRevokedPayload>;

// ── Recording payloads (P4.3 / module 05 §3.4) ──────────────────────────────
// SessionEvent.payload is z.unknown() (NOT a discriminated union) — these are
// standalone schemas parsed explicitly at the producer (the recording activity)
// and the SDK/React consumer. The codec/contentType pair stays consistent
// (h264-mp4↔video/mp4, vp9-webm↔video/webm).
export const RecordingMode = z.enum(["manual", "on-turn", "on-verify"]);
export type RecordingMode = z.infer<typeof RecordingMode>;
export const RecordingCodec = z.enum(["h264-mp4", "vp9-webm"]);
export type RecordingCodec = z.infer<typeof RecordingCodec>;
export const RecordingContentType = z.enum(["video/mp4", "video/webm"]);
export type RecordingContentType = z.infer<typeof RecordingContentType>;

export const RecordingStartedPayload = z.object({
  recordingId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  mode: RecordingMode,
  codec: RecordingCodec,
  dimensions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  framerate: z.number().int().positive(),
  startedAt: z.string(), // ISO
  // The verification rationale ("agent-verification: tf apply succeeded"). Agent-
  // authored free text — the producer caps + scrubs it before emit.
  reason: z.string().nullable().optional(),
});
export type RecordingStartedPayload = z.infer<typeof RecordingStartedPayload>;

export const RecordingAvailablePayload = z.object({
  recordingId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  codec: RecordingCodec,
  contentType: RecordingContentType,
  // The @opengeni/storage object key. NO long-lived URL in the event — clients
  // mint a short-TTL signed GET via GET …/recordings/:id/url.
  storageKey: z.string(),
  durationSeconds: z.number().nonnegative().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  dimensions: z.tuple([z.number().int().positive(), z.number().int().positive()]),
});
export type RecordingAvailablePayload = z.infer<typeof RecordingAvailablePayload>;

// `max-bytes-exceeded` is distinct from `timeout` (the -t ceiling hitting is a
// SUCCESSFUL finalize, never a failure) — the adversarial-review F7 fix.
export const RecordingFailedReason = z.enum([
  "ffmpeg-error",
  "box-death",
  "box-rollover",
  "upload-failed",
  "max-bytes-exceeded",
  "display-unavailable",
]);
export type RecordingFailedReason = z.infer<typeof RecordingFailedReason>;

export const RecordingFailedPayload = z.object({
  recordingId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  reason: RecordingFailedReason,
  // ffmpeg-stderr tail / error detail — agent/ffmpeg-controlled, so the producer
  // caps + scrubs it before emit (it rides redact() like every payload).
  detail: z.string().nullable().optional(),
});
export type RecordingFailedPayload = z.infer<typeof RecordingFailedPayload>;

// ── Channel-A structured services (P4.4 / modules/08-channel-a.md) ───────────
// Two transports on one spine: the A2 request/response shapes (FsNode tree,
// GitDiff hunks, terminal exec) are returned INLINE on synchronous API-direct
// routes (never the bus); the A1 notification payloads below ride the durable
// SSE event log so every viewer's Pierre tree / diff / terminal stays live.

// --- A1 event payloads -------------------------------------------------------

// The agent's command-output firehose, enriched. Backward-compatible widening
// of the existing sandbox.command.output.delta (consumers read `chunk`); the
// producer may now also stamp stream/commandId/seq for finer terminal rendering.
export const SandboxCommandOutputDeltaPayload = z.object({
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
  chunk: z.string(), // raw bytes, utf-8 (lossy) — terminal is opaque-ish
  commandId: z.string().optional(), // groups deltas to one agent command
  seq: z.number().int().nonnegative().optional(), // intra-command ordering hint
});
export type SandboxCommandOutputDeltaPayload = z.infer<typeof SandboxCommandOutputDeltaPayload>;

export const FsChangeKind = z.enum(["created", "modified", "deleted", "renamed"]);
export type FsChangeKind = z.infer<typeof FsChangeKind>;
export const FsChangedPayload = z.object({
  changes: z.array(z.object({
    path: z.string(), // workspace-relative POSIX path
    kind: FsChangeKind,
    isDir: z.boolean().default(false),
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
    oldPath: z.string().optional(), // for "renamed"
  })).min(1),
  source: z.enum(["write", "watch", "agent"]).default("write"),
  // Monotonic FS revision (per-lease, paired with leaseEpoch for staleness).
  revision: z.number().int().nonnegative(),
  // The lease epoch the revision was minted under: a client invalidates on a
  // (leaseEpoch, revision) tuple change, never a bare revision compare (H3 —
  // revision resets to 0 on box re-key, so a bare monotonic compare goes stale).
  leaseEpoch: z.number().int().nonnegative().default(0),
});
export type FsChangedPayload = z.infer<typeof FsChangedPayload>;

export const GitChangedPayload = z.object({
  head: z.string().nullable(), // current branch or detached SHA
  dirty: z.boolean(), // working tree has uncommitted changes
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  changedFileCount: z.number().int().nonnegative(),
  reason: z.enum(["commit", "checkout", "stage", "worktree", "fetch", "unknown"]).default("unknown"),
  revision: z.number().int().nonnegative().default(0),
  leaseEpoch: z.number().int().nonnegative().default(0),
});
export type GitChangedPayload = z.infer<typeof GitChangedPayload>;

export const TerminalPtyStartedPayload = z.object({
  ptyId: z.string().uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  shell: z.string(), // resolved shell, e.g. "/bin/bash"
  cwd: z.string(),
});
export type TerminalPtyStartedPayload = z.infer<typeof TerminalPtyStartedPayload>;

export const TerminalPtyOutputDeltaPayload = z.object({
  ptyId: z.string().uuid(),
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
  chunk: z.string(), // raw terminal bytes (incl. ANSI), utf-8 lossy
  seq: z.number().int().nonnegative(), // strict per-pty ordering (owner-assigned)
});
export type TerminalPtyOutputDeltaPayload = z.infer<typeof TerminalPtyOutputDeltaPayload>;

export const TerminalPtyExitedPayload = z.object({
  ptyId: z.string().uuid(),
  exitCode: z.number().int().nullable(),
  reason: z.enum(["exit", "killed", "owner_gone", "timeout"]),
});
export type TerminalPtyExitedPayload = z.infer<typeof TerminalPtyExitedPayload>;

// --- A2 FileSystem request/response (NOT events; returned inline) ------------
export const FsNodeType = z.enum(["file", "dir", "symlink", "other"]);
export type FsNodeType = z.infer<typeof FsNodeType>;
// The Pierre-tree node. `children` is present only when the dir was listed with
// depth>0; the tree lazy-expands via repeated depth-1 lists at deeper paths.
export interface FsTreeNode {
  name: string;
  path: string; // workspace-relative POSIX, no leading slash
  type: z.infer<typeof FsNodeType>;
  sizeBytes: number | null; // null for dirs
  mtimeMs: number | null;
  mode: number | null; // unix mode bits, for Pierre tree icons/perms
  children?: FsTreeNode[] | undefined;
  truncated: boolean; // dir had more entries than the cap
}
export const FsTreeNode: z.ZodType<FsTreeNode> = z.lazy(() => z.object({
  name: z.string(),
  path: z.string(),
  type: FsNodeType,
  sizeBytes: z.number().int().nonnegative().nullable(),
  mtimeMs: z.number().int().nonnegative().nullable(),
  mode: z.number().int().nullable(),
  children: z.array(FsTreeNode).optional(),
  truncated: z.boolean().default(false),
})) as z.ZodType<FsTreeNode>;

export const FsListRequest = z.object({
  path: z.string().default(""), // "" = workspace root
  depth: z.number().int().min(0).max(8).default(1),
  maxEntries: z.number().int().positive().max(20_000).default(2_000),
  includeHidden: z.boolean().default(true),
});
export type FsListRequest = z.infer<typeof FsListRequest>;
export const FsListResponse = z.object({
  root: FsTreeNode,
  revision: z.number().int().nonnegative(),
  truncated: z.boolean(), // global cap hit
});
export type FsListResponse = z.infer<typeof FsListResponse>;

export const FsEncoding = z.enum(["utf8", "base64"]);
export type FsEncoding = z.infer<typeof FsEncoding>;
export const FsReadRequest = z.object({
  path: z.string(),
  encoding: FsEncoding.default("utf8"),
  maxBytes: z.number().int().positive().max(25 * 1024 * 1024).default(5 * 1024 * 1024),
});
export type FsReadRequest = z.infer<typeof FsReadRequest>;
export const FsReadResponse = z.object({
  path: z.string(),
  encoding: FsEncoding,
  content: z.string(), // text or base64 per encoding
  sizeBytes: z.number().int().nonnegative(), // bytes returned (== content size)
  truncated: z.boolean(), // sizeBytes hit maxBytes; content is the prefix
  isBinary: z.boolean(), // sniffed NUL byte in first 8KB
  revision: z.number().int().nonnegative(),
});
export type FsReadResponse = z.infer<typeof FsReadResponse>;

export const FsWriteRequest = z.object({
  path: z.string(),
  encoding: FsEncoding.default("utf8"),
  content: z.string(),
  overwrite: z.boolean().default(true), // false + existing path => 409
  createParents: z.boolean().default(true),
});
export type FsWriteRequest = z.infer<typeof FsWriteRequest>;
export const FsWriteResponse = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), // == the fs.changed revision
});
export type FsWriteResponse = z.infer<typeof FsWriteResponse>;

export const FsDeleteRequest = z.object({
  path: z.string(),
  recursive: z.boolean().default(false), // required true to delete a non-empty dir
});
export type FsDeleteRequest = z.infer<typeof FsDeleteRequest>;
export const FsDeleteResponse = z.object({ revision: z.number().int().nonnegative() });
export type FsDeleteResponse = z.infer<typeof FsDeleteResponse>;

export const FsMoveRequest = z.object({
  path: z.string(),
  newPath: z.string(),
  overwrite: z.boolean().default(false), // false + existing destination => 409
  createParents: z.boolean().default(true),
});
export type FsMoveRequest = z.infer<typeof FsMoveRequest>;
export const FsMoveResponse = z.object({
  path: z.string(),
  newPath: z.string(),
  revision: z.number().int().nonnegative(), // == the fs.changed revision
});
export type FsMoveResponse = z.infer<typeof FsMoveResponse>;

export const FsMkdirRequest = z.object({
  path: z.string(),
  recursive: z.boolean().default(true), // false + existing path => 400
});
export type FsMkdirRequest = z.infer<typeof FsMkdirRequest>;
export const FsMkdirResponse = z.object({
  path: z.string(),
  revision: z.number().int().nonnegative(), // == the fs.changed revision
});
export type FsMkdirResponse = z.infer<typeof FsMkdirResponse>;

// --- A2 Git request/response (read-only; feeds Pierre diff/tree) -------------
export const GitFileStatusCode = z.enum([
  "added", "modified", "deleted", "renamed", "copied", "untracked", "ignored", "conflicted", "typechange",
]);
export type GitFileStatusCode = z.infer<typeof GitFileStatusCode>;
export const GitFileStatus = z.object({
  path: z.string(),
  oldPath: z.string().nullable(), // for renamed/copied
  index: GitFileStatusCode.nullable(), // staged change (X in porcelain XY)
  worktree: GitFileStatusCode.nullable(), // unstaged change (Y in porcelain XY)
  isConflicted: z.boolean().default(false),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;
export const GitStatusRequest = z.object({
  path: z.string().default(""), // repo root within workspace (multi-repo support)
});
export type GitStatusRequest = z.infer<typeof GitStatusRequest>;
export const GitStatusResponse = z.object({
  isRepo: z.boolean(),
  head: z.string().nullable(), // branch name
  detached: z.boolean().default(false),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  files: z.array(GitFileStatus),
  revision: z.number().int().nonnegative(),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponse>;

// The structured hunk shape that feeds Pierre diff — the whole point of Git.
export const GitDiffLineType = z.enum(["context", "add", "del", "meta"]);
export type GitDiffLineType = z.infer<typeof GitDiffLineType>;
export const GitDiffLine = z.object({
  type: GitDiffLineType,
  // null on the side that doesn't have the line (add => oldNo null; del => newNo null)
  oldNo: z.number().int().positive().nullable(),
  newNo: z.number().int().positive().nullable(),
  text: z.string(), // line WITHOUT leading +/-/space marker
});
export type GitDiffLine = z.infer<typeof GitDiffLine>;
export const GitDiffHunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  header: z.string(), // the @@ ... @@ section heading
  lines: z.array(GitDiffLine),
});
export type GitDiffHunk = z.infer<typeof GitDiffHunk>;
export const GitFileDiff = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: GitFileStatusCode,
  isBinary: z.boolean().default(false),
  isImage: z.boolean().default(false),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(GitDiffHunk), // empty if binary or truncated
  truncated: z.boolean().default(false), // diff exceeded maxBytes; hunks omitted
});
export type GitFileDiff = z.infer<typeof GitFileDiff>;
export const GitDiffRequest = z.object({
  path: z.string().default(""), // repo root
  // diff selectors, mutually exclusive precedence: refs > staged > worktree
  staged: z.boolean().default(false), // --cached (index vs HEAD)
  fromRef: z.string().optional(),
  toRef: z.string().optional(),
  pathspec: z.array(z.string()).default([]),
  contextLines: z.number().int().min(0).max(10).default(3),
  maxBytesPerFile: z.number().int().positive().max(2 * 1024 * 1024).default(512 * 1024),
});
export type GitDiffRequest = z.infer<typeof GitDiffRequest>;
export const GitDiffResponse = z.object({
  files: z.array(GitFileDiff),
  revision: z.number().int().nonnegative(),
});
export type GitDiffResponse = z.infer<typeof GitDiffResponse>;

export const GitLogRequest = z.object({
  path: z.string().default(""),
  ref: z.string().default("HEAD"),
  maxCount: z.number().int().positive().max(1_000).default(100),
  skip: z.number().int().nonnegative().default(0),
  pathspec: z.array(z.string()).default([]),
});
export type GitLogRequest = z.infer<typeof GitLogRequest>;
export const GitCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  parents: z.array(z.string()),
  author: z.object({ name: z.string(), email: z.string(), timestamp: z.number().int() }),
  committer: z.object({ name: z.string(), email: z.string(), timestamp: z.number().int() }),
  subject: z.string(),
  body: z.string(),
  refs: z.array(z.string()).default([]), // decorations: branch/tag pointers
});
export type GitCommit = z.infer<typeof GitCommit>;
export const GitLogResponse = z.object({ commits: z.array(GitCommit), hasMore: z.boolean() });
export type GitLogResponse = z.infer<typeof GitLogResponse>;

export const GitShowRequest = z.object({
  path: z.string().default(""),
  ref: z.string(), // a commit/tag/tree-ish
  filePath: z.string().optional(), // ref + filePath => raw blob ("open file at commit")
  encoding: FsEncoding.default("utf8"),
  maxBytesPerFile: z.number().int().positive().max(2 * 1024 * 1024).default(512 * 1024),
});
export type GitShowRequest = z.infer<typeof GitShowRequest>;
export const GitShowResponse = z.object({
  commit: GitCommit.nullable(), // null when fetching a raw blob
  files: z.array(GitFileDiff), // commit diff vs first parent
  blob: z.object({ content: z.string(), encoding: FsEncoding, sizeBytes: z.number().int(), truncated: z.boolean() }).nullable(),
  revision: z.number().int().nonnegative(),
});
export type GitShowResponse = z.infer<typeof GitShowResponse>;

// --- A2 Terminal exec (run a command in-box, stream stdout/stderr) -----------
// The command-output FIREHOSE rides A1 (sandbox.command.output.delta). This is
// the SYNCHRONOUS exec: run a bounded command and return its stdout/stderr +
// exit code inline (the result IS the HTTP response). Full interactive PTY
// (open/write/resize) layers on top via the pty.* events; exec ships now.
export const TerminalExecRequest = z.object({
  command: z.string().min(1),
  cwd: z.string().default(""), // workspace-relative
  // Soft per-call wall-clock bound (the box yields output back when reached).
  timeoutMs: z.number().int().positive().max(120_000).default(30_000),
  // Stream the deltas onto A1 as the agent firehose (so other viewers see it),
  // in addition to returning the buffered result inline.
  emitStream: z.boolean().default(true),
});
export type TerminalExecRequest = z.infer<typeof TerminalExecRequest>;
export const TerminalExecResponse = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  // True when the process was still running when the call yielded (a long
  // command); the remaining output drains onto A1 if emitStream was set.
  running: z.boolean(),
  wallTimeSeconds: z.number().nonnegative(),
});
export type TerminalExecResponse = z.infer<typeof TerminalExecResponse>;

// --- A2 Terminal PTY control (output rides A1) -------------------------------
export const PtyOpenRequest = z.object({
  cols: z.number().int().positive().max(500).default(80),
  rows: z.number().int().positive().max(300).default(24),
  cwd: z.string().default(""), // workspace-relative
  shell: z.string().optional(), // default: resolved login shell
});
export type PtyOpenRequest = z.infer<typeof PtyOpenRequest>;
export const PtyOpenResponse = z.object({
  ptyId: z.string().uuid(),
  // output streams as terminal.pty.output.delta on the SSE channel the client holds
  streamVia: z.literal("sse-events"),
  supportsInput: z.boolean(), // false on backends without writeStdin
});
export type PtyOpenResponse = z.infer<typeof PtyOpenResponse>;
export const PtyWriteRequest = z.object({ ptyId: z.string().uuid(), data: z.string() }); // utf-8 stdin
export type PtyWriteRequest = z.infer<typeof PtyWriteRequest>;
export const PtyResizeRequest = z.object({ ptyId: z.string().uuid(), cols: z.number().int().positive(), rows: z.number().int().positive() });
export type PtyResizeRequest = z.infer<typeof PtyResizeRequest>;
export const PtyCloseRequest = z.object({ ptyId: z.string().uuid() });
export type PtyCloseRequest = z.infer<typeof PtyCloseRequest>;

// Per-session structured-service capabilities (the Channel-A slice of the
// negotiation). The full SessionCapabilities doc already carries FileSystem /
// Terminal / Git blocks (P0.1); this is the compact projection the SDK mirrors.
export const SessionStructuredCapabilities = z.object({
  FileSystem: z.object({ available: z.boolean(), readOnly: z.boolean(), root: z.string() }),
  Terminal: z.object({
    events: z.boolean(), // command.output firehose (always on if a box exists)
    exec: z.boolean(), // synchronous terminal exec
    pty: z.object({ available: z.boolean() }), // interactive stdin (writeStdin)
  }),
  Git: z.object({ available: z.boolean(), repos: z.array(z.string()) }),
});
export type SessionStructuredCapabilities = z.infer<typeof SessionStructuredCapabilities>;

export const SessionEvent = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  sequence: z.number().int().positive(),
  type: SessionEventType,
  payload: z.unknown().default({}),
  occurredAt: z.string(),
  clientEventId: z.string().min(1).nullable().optional(),
  turnId: z.string().uuid().nullable().optional(),
});
export type SessionEvent = z.infer<typeof SessionEvent>;

export const CreateSessionRequest = z.object({
  initialMessage: z.string().min(1),
  // Per-session agent persona/system instructions (org-visible metadata, NOT a
  // secret). Rides the SAME system-level instructions channel the per-workspace
  // agentInstructions rides, composed AFTER the workspace persona so it refines
  // it for this one session — how a host delivers per-agent-type prompts without
  // leaking them into the user-visible timeline (it is NEVER emitted as an
  // event, unlike goal/initialMessage). Trimmed, non-empty. The 32768-char cap
  // matches the codebase's largest free-form string convention (workspace
  // environment variable values). Absent ⇒ byte-identical to today.
  instructions: z.string().trim().min(1).max(32768).optional(),
  resources: z.array(ResourceRef).default([]),
  tools: z.array(ToolRef).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
  // The enrolled machine (a sandbox id) to run this session on; seeds the
  // active-sandbox pointer at creation so the FIRST turn routes to the chosen
  // machine (race-free: the pointer is committed before the worker turn
  // workflow can read it). An invalid/unowned/offline target fails the create.
  targetSandboxId: z.string().uuid().optional(),
  // The working directory the targeted machine runs the session under — the
  // path/cwd base for its agent exec, terminal, and file dock. Free-form pass-
  // through: a launch-workspace_root-relative subdir or an absolute machine path
  // (the agent's resolve_cwd handles both). Only valid WITH targetSandboxId
  // (workingDir alone is a 422); omitted ⇒ the machine's default workspace_root.
  workingDir: z.string().min(1).optional(),
  // Workspace environment attachment is fixed at session creation; follow-up
  // user.message events cannot switch or add one.
  environmentId: z.string().uuid().optional(),
  goal: GoalSpec.optional(),
  clientEventId: z.string().min(1).optional(),
  // Workspace-scoped CREATE idempotency key: collapses concurrent/retried
  // create calls carrying the same key to a single session (partial unique
  // index on (workspace_id, create_idempotency_key)). Distinct from
  // clientEventId, whose uniqueness is per-session and so cannot dedup the
  // creation of a brand-new session. Absent means no create-dedup (each call
  // is an independent create).
  idempotencyKey: z.string().min(1).max(200).optional(),
  // Permissions the session's first-party MCP token should carry instead of
  // the fixed worker default — how an operator hands a manager-style session
  // the orchestration/environment/github tools. Capped at creation: every
  // requested permission must be held by the creating grant (no escalation).
  firstPartyMcpPermissions: z.array(Permission).optional(),
  // Third-party MCP servers attached only to this session. Credential headers are
  // write-only: create responses and events expose only SessionMcpServerMetadata.
  mcpServers: z.array(SessionMcpServerInput).default([]),
  // Shared-sandbox placement (addendum 05 §D.1). Three-way union; OMITTED ⇒
  // today's behavior (a context-dependent default resolved server-side: from
  // inside a session → "shared" with the creator's box, top-level → "new").
  //   - "shared":  join the CREATOR's box. Requires a parent session (inferred
  //                from the worker-signed sessionId claim, never caller-supplied);
  //                top-level "shared" is a 422.
  //   - "new":     mint a fresh singleton box (group ≡ the new session's id).
  //   - {groupId}: join a SPECIFIC sibling group in THIS workspace (manager
  //                fan-out). Validated workspace-scoped (cross-workspace → 404).
  // A shared spawn inherits the box's (backend, os) — it is literally the same
  // box; the child cannot pick its own backend. Cross-workspace sharing is
  // forbidden by construction (the parent/group reads are RLS-workspace-scoped).
  // ENV-AWARE: the box's environment is fixed at creation, so a share requires
  // the SAME environmentId as the creator's box. On a mismatch the inherited
  // default silently falls back to an own box; an explicit "shared"/{groupId}
  // request 422s at create (instead of the first turn dying on the SDK's
  // manifest-env guard).
  sandbox: z.union([
    z.literal("shared"),
    z.literal("new"),
    z.object({ groupId: z.string().uuid() }),
  ]).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export const ClientSessionEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user.message"),
    clientEventId: z.string().min(1).optional(),
    payload: z.object({
      text: z.string().min(1),
      resources: z.array(ResourceRef).default([]),
      tools: z.array(ToolRef).default([]),
      model: z.string().min(1).optional(),
      reasoningEffort: ReasoningEffort.optional(),
      // Header-value rotation only. URL/name/tool settings are immutable after
      // session create; persisted events expose metadata, never header values.
      mcpCredentialUpdates: z.array(SessionMcpCredentialUpdateInput).optional(),
    }),
  }),
  z.object({
    type: z.literal("user.interrupt"),
    clientEventId: z.string().min(1).optional(),
    payload: z.object({ reason: z.string().optional() }).default({}),
  }),
  z.object({
    type: z.literal("user.approvalDecision"),
    clientEventId: z.string().min(1).optional(),
    payload: z.object({
      approvalId: z.string().min(1),
      decision: z.enum(["approve", "reject"]),
      message: z.string().optional(),
    }),
  }),
]);
export type ClientSessionEvent = z.infer<typeof ClientSessionEvent>;

export const SessionBusMessage = z.object({
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  events: z.array(SessionEvent).min(1),
});
export type SessionBusMessage = z.infer<typeof SessionBusMessage>;

export const GitHubAppManifestCreate = z.object({
  appName: z.string().optional(),
  organization: z.string().optional(),
  public: z.boolean().default(false),
  includeCiPermissions: z.boolean().default(true),
});
export type GitHubAppManifestCreate = z.infer<typeof GitHubAppManifestCreate>;

export const GitHubRepository = z.object({
  id: z.number().int(),
  installationId: z.number().int(),
  fullName: z.string(),
  name: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  cloneUrl: z.string(),
  defaultBranch: z.string(),
  accountLogin: z.string(),
  accountType: z.string().nullable(),
});
export type GitHubRepository = z.infer<typeof GitHubRepository>;

export const ClientAuthConfig = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("deploymentKey"),
    headerName: z.literal("x-opengeni-access-key"),
  }),
  z.object({
    mode: z.literal("configuredToken"),
    headerName: z.literal("authorization"),
    scheme: z.literal("bearer"),
  }),
  z.object({
    mode: z.literal("managedSession"),
    session: z.literal("cookie"),
  }),
]);
export type ClientAuthConfig = z.infer<typeof ClientAuthConfig>;

// The negotiated capability handshake document (master-spine C.3). ONE shape;
// collapses the parallel per-module definitions. A capability cell is always
// present with `available`/`transport` + a `reason` when unavailable — never
// absent.
export const CapabilityUnavailableReason = z.enum([
  "backend_unsupported",
  "os_unsupported",
  "not_provisioned",
  "disabled_by_policy",
  "lease_cold",
  "tier_headless",
  // Selfhosted (bring-your-own-compute) negotiation states (M1 additive; the
  // selfhosted negotiation in select.ts wires them in M3):
  "agent_offline", // the enrolled agent process is not running / unreachable
  "agent_reconnecting", // a transient blip — the agent is reconnecting (warmable)
  "consent_required", // whole-machine / screen-control consent not yet acknowledged
  "display_unavailable", // headless machine with no display stack (no DesktopStream)
]);
export type CapabilityUnavailableReason = z.infer<typeof CapabilityUnavailableReason>;

export const SessionCapabilities = z.object({
  sessionId: z.string().uuid(),
  backend: SandboxBackend,
  os: SandboxOs,
  liveness: z.enum(["cold", "warming", "warm", "draining"]),
  // Echoed on viewer heartbeats (the split-brain fence).
  leaseEpoch: z.number().int().nonnegative(),
  viewerHeartbeatIntervalMs: z.number().int().positive().default(30_000),
  FileSystem: z.object({
    available: z.boolean(),
    readOnly: z.boolean(),
    root: z.string(),
    pathSep: z.enum(["/", "\\"]),
    treeMode: z.enum(["lazy", "snapshot"]),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  Terminal: z.object({
    transport: z.enum(["sse-events", "pty-ws"]).nullable(),
    ptyCapable: z.boolean(),
    shell: z.string(),
    // The direct-to-provider ttyd PTY-over-websocket URL (pty-ws) resolved on the
    // SAME tunnel as the desktop; null on a cold lease / read-only sse-events
    // firehose / degraded terminal. The scoped stream token is recorded against
    // the holder (NEVER a URL query param), symmetric with DesktopStream.
    url: z.string().url().nullable(),
    token: z.string().nullable(),
    // ISO absolute expiry of the minted stream token (symmetric with
    // DesktopStream.expiresAt). Null when no live URL/token is minted.
    expiresAt: z.string().nullable(),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  Git: z.object({
    available: z.boolean(),
    repos: z.array(z.string()),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  DesktopStream: z.object({
    // "relay-frames" is the selfhosted framebuffer stream: PNG-per-frame protobuf
    // datagrams spliced over the relay (NOT RFB). The viewer renders it with the
    // "frames" client (a canvas painter), distinct from Modal's "vnc-ws"/"novnc".
    transport: z.enum(["vnc-ws", "rdp-ws", "webrtc", "relay-frames"]).nullable(),
    client: z.enum(["novnc", "web-rdp", "frames"]).nullable(),
    mode: z.enum(["read-only", "interactive"]).default("read-only"),
    url: z.string().url().nullable(),
    token: z.string().nullable(),
    expiresAt: z.string().nullable(),
    resolution: z
      .tuple([z.number().int().positive(), z.number().int().positive()])
      .default([1024, 768]),
    // REQUIRED, no default (the server must assert un-redacted pixels).
    unredacted: z.boolean(),
    requiresAcknowledgment: z.boolean(),
    acknowledged: z.boolean(),
    // SHARED-EXPOSURE disclosure (addendum E.1). `shared` is true when the box's
    // group has >1 session: watching this desktop ALSO shows the sibling
    // sessions' agents on the one :0 framebuffer (the pixels cannot be redacted).
    // `sharedSessionIds` lists the OTHER sessions whose agents may appear — IDS
    // ONLY, never their goal/metadata/conversation (a viewer of A must not be
    // able to use "I can see B's id" to subscribe to B's events; stress g). When
    // shared, the consent gate requires the shared-exposure acknowledgment (409
    // shared_acknowledgment_required) before the desktop path is handed out.
    shared: z.boolean().default(false),
    sharedSessionIds: z.array(z.string().uuid()).default([]),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  Recording: z.object({
    available: z.boolean(),
    modes: z.array(z.enum(["manual", "on-turn", "on-verify"])),
    codecs: z.array(z.enum(["h264-mp4", "vp9-webm"])),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  // The AGENT drives the SAME :0 (xdotool/XTEST + scrot) the human watches; the
  // human viewer plane is read-only by default (§6). `available` == desktop-
  // capable backend && computerUseEnabled; `readOnly` reports whether the agent
  // driver itself is gated to no-op input (v1 default false — the agent clicks).
  ComputerUse: z.object({
    available: z.boolean(),
    readOnly: z.boolean(),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  negotiatedAt: z.string(),
});
export type SessionCapabilities = z.infer<typeof SessionCapabilities>;

// ── API-direct viewer attach (P1.4) ─────────────────────────────────────────
// A viewer holds the GROUP lease (keeping the box warm while watched). These
// shape the in-process attach/heartbeat/detach handlers. The scoped stream
// token + the un-redacted-pixel acknowledgment are P3/P4 — here it is the
// viewer-HOLDER lifecycle only.

// POST .../viewers — acquire a viewer holder. An omitted viewerId mints a fresh
// one (returned in the response, to carry through heartbeats + detach).
//
// `desktop` declares intent to attach the UN-REDACTED pixel plane (noVNC). ONLY
// that plane carries the consent gate (the un-redacted/shared acknowledgment). A
// terminal-only warm attach (`desktop:false`, the default) needs NO consent — a
// shell is interactive by nature and the gate is the scoped tunnel URL + stream
// token — so it warms the box and mints the pty-ws terminal cell WITHOUT a 409.
// Omitted defaults to `false` so a terminal-only client never trips the gate.
export const AttachViewerRequest = z.object({
  viewerId: z.string().uuid().optional(),
  desktop: z.boolean().optional(),
});
export type AttachViewerRequest = z.infer<typeof AttachViewerRequest>;

export const ViewerHolder = z.object({
  viewerId: z.string().uuid(),
  sandboxGroupId: z.string().uuid(),
  liveness: z.enum(["cold", "warming", "warm", "draining"]),
  // The epoch the viewer is fenced on; echoed back on heartbeats.
  leaseEpoch: z.number().int().nonnegative(),
  viewerHeartbeatIntervalMs: z.number().int().positive(),
  // The desktop pixel tunnel URL the viewer connects to directly; null until
  // P4 mints it (gated until then).
  dataPlaneUrl: z.string().nullable(),
});
export type ViewerHolder = z.infer<typeof ViewerHolder>;

// POST .../stream-capabilities/acknowledge — record the calling principal's
// acknowledgment of the un-redacted pixel plane (P3.2; modules/07-channel-b.md
// §6 + addendum E.1). Reuses the acknowledgment machinery — no new endpoint
// shape beyond this body, no new permission beyond stream:acknowledge.
//
// `acknowledgeShared` MUST be true when the box is shared (the group has >1
// session): the un-redacted desktop path returns 409 shared_acknowledgment_required
// until a shared box is acknowledged WITH the shared-exposure consent. For a
// solo box `acknowledgeShared` is irrelevant (the un-redacted ack alone gates).
export const AcknowledgeStreamRequest = z.object({
  // The principal accepts that the desktop pixel plane is un-redacted (can show
  // cloud creds the agent cat's into a terminal). Always true to record consent;
  // present for self-documentation + a future explicit withdraw.
  acknowledgeUnredacted: z.boolean().default(true),
  // The principal accepts the shared-exposure disclosure: watching this desktop
  // also shows sibling sessions' agents on the one framebuffer.
  acknowledgeShared: z.boolean().default(false),
});
export type AcknowledgeStreamRequest = z.infer<typeof AcknowledgeStreamRequest>;

export const AcknowledgeStreamResponse = z.object({
  acknowledged: z.boolean(),
  acknowledgedShared: z.boolean(),
});
export type AcknowledgeStreamResponse = z.infer<typeof AcknowledgeStreamResponse>;

// POST .../viewers/:viewerId/heartbeat — refresh the holder TTL. Epoch-fenced:
// a stale-epoch beat (a box re-established under a newer epoch) is rejected.
export const ViewerHeartbeatRequest = z.object({
  leaseEpoch: z.number().int().nonnegative(),
});
export type ViewerHeartbeatRequest = z.infer<typeof ViewerHeartbeatRequest>;

export const ViewerHeartbeatResponse = z.object({
  // false ⇒ the holder was reaped or the epoch is stale; the client re-attaches.
  alive: z.boolean(),
});
export type ViewerHeartbeatResponse = z.infer<typeof ViewerHeartbeatResponse>;

// =============================================================================
// Bring-your-own-compute (M5) — enrollment device-flow HTTP contract.
//
// The HTTP shapes mirror the @opengeni/agent-proto device-flow messages
// (DeviceAuthStart*, DeviceAuthPoll*, EnrollmentCredentials) so the Rust agent's
// `enroll` command (which runs the flow over HTTP before it has NATS creds)
// decodes the SAME field names (the proto's ts-proto JSON is camelCase). The
// request bodies additionally carry the consent-relevant fields the dossier brief
// mandates (the agent ed25519 pubkey + can-offer-display + requests-screen-control).
// =============================================================================

export const EnrollmentOs = z.enum(["linux", "macos", "windows"]);
export type EnrollmentOs = z.infer<typeof EnrollmentOs>;
export const EnrollmentArch = z.enum(["x86_64", "aarch64"]);
export type EnrollmentArch = z.infer<typeof EnrollmentArch>;

// POST /enrollments/device/start (agent-side, unauthenticated-at-the-user-level,
// rate-limited). The agent presents its ed25519 public key + os/arch + the
// requested whole-machine exposure + whether it can offer a display + whether it
// requests screen control.
export const DeviceEnrollmentStartRequest = z.object({
  // The agent's ed25519 public key (the machine identity the enrollment binds to).
  publicKey: z.string().min(1).max(1024),
  os: EnrollmentOs.default("linux"),
  arch: EnrollmentArch.default("x86_64"),
  // Human-friendly machine name (hostname by default).
  machineName: z.string().min(1).max(256).optional(),
  // v1 only supports whole-machine; kept explicit so the consent is recorded.
  exposure: z.literal("whole-machine").default("whole-machine"),
  // The agent can offer a display (a real screen / Xvfb is available).
  canOfferDisplay: z.boolean().default(false),
  // The agent requests screen control (computer-use); the user's allow_screen_control
  // at approve is the AUTHORITATIVE consent.
  requestsScreenControl: z.boolean().default(false),
  // The workspace this machine is enrolling into. The agent is told this at install
  // (the user picks the workspace, or the install/enroll token carries it). The user
  // who approves must hold a grant in THIS workspace — that binding is what makes
  // the (user-unauthenticated) start safe: it cannot grant access to a workspace no
  // authorized user later approves in.
  workspaceId: z.string().uuid(),
});
export type DeviceEnrollmentStartRequest = z.infer<typeof DeviceEnrollmentStartRequest>;

// The DeviceAuthStart response (field names match the proto's JSON).
export const DeviceEnrollmentStartResponse = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  intervalSeconds: z.number().int().positive(),
  expiresInSeconds: z.number().int().positive(),
});
export type DeviceEnrollmentStartResponse = z.infer<typeof DeviceEnrollmentStartResponse>;

// POST /enrollments/device/approve (USER-authenticated, workspace-gated). The
// LOUD CONSENT step. whole-machine is mandatory (implicit); screen-control is
// opt-in per allow_screen_control.
export const DeviceEnrollmentApproveRequest = z.object({
  userCode: z.string().min(1).max(64),
  allowScreenControl: z.boolean().default(false),
});
export type DeviceEnrollmentApproveRequest = z.infer<typeof DeviceEnrollmentApproveRequest>;

export const DeviceEnrollmentApproveResponse = z.object({
  approved: z.boolean(),
  enrollmentId: z.string().uuid(),
  sandboxId: z.string().uuid(),
  allowScreenControl: z.boolean(),
});
export type DeviceEnrollmentApproveResponse = z.infer<typeof DeviceEnrollmentApproveResponse>;

// POST /enrollments/device/poll (agent-side). The poll state machine.
export const DeviceEnrollmentPollRequest = z.object({
  deviceCode: z.string().min(1).max(256),
});
export type DeviceEnrollmentPollRequest = z.infer<typeof DeviceEnrollmentPollRequest>;

export const DeviceEnrollmentState = z.enum(["pending", "authorized", "denied", "expired", "disabled"]);
export type DeviceEnrollmentState = z.infer<typeof DeviceEnrollmentState>;

// The EnrollmentCredentials (field names match the proto's JSON). natsAccountCreds
// is a PLACEHOLDER — the real per-workspace NATS Account creds binding is
// infra-deferred (M4/relay); the bearer + subjectPrefix are the application-tier
// identity the agent presents today.
export const EnrollmentCredentialsResponse = z.object({
  agentId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  // The signed bearer the agent presents to the control plane (the `oge_` token).
  bearer: z.string(),
  // The Account-scoped control-plane subject prefix the agent subscribes to:
  // agent.<workspaceId>.<agentId>.
  subjectPrefix: z.string(),
  // Connect info for the control plane + stream relay (may be empty when not yet
  // configured for this deployment — the agent surfaces "control plane unconfigured").
  natsUrls: z.array(z.string()),
  relayUrl: z.string(),
  // The agent's PRODUCER token for the relay edge (the `ogr_` token; M8b). Presented
  // as StreamOpen.token when the agent registers a pty/desktop channel; the relay
  // verifies it then pairs the producer with the viewer (whose `ogs_` token the
  // relay also verifies). Empty when the relay-token plane is unconfigured for this
  // deployment (graceful degrade — the agent then presents an empty token the relay
  // rejects, surfacing the gap loudly rather than silently producing a dead stream).
  relayToken: z.string(),
  // VESTIGIAL (M-AUTH): there is no per-machine NATS Account creds file. The agent
  // presents the `bearer` above as the NATS connect AUTH-TOKEN; the server's
  // auth-callout responder validates it and mints a workspace-scoped user JWT. This
  // field echoes the bearer so a consumer reading it as the connect credential still
  // works; new consumers should read `bearer` directly.
  natsAccountCreds: z.string(),
  // The minisign public key the agent pins for self-update verification.
  updatePublicKey: z.string(),
  consentedWholeMachine: z.boolean(),
  consentedScreenControl: z.boolean(),
});
export type EnrollmentCredentialsResponse = z.infer<typeof EnrollmentCredentialsResponse>;

export const DeviceEnrollmentPollResponse = z.object({
  state: DeviceEnrollmentState,
  // Present only when state === "authorized".
  credentials: EnrollmentCredentialsResponse.optional(),
});
export type DeviceEnrollmentPollResponse = z.infer<typeof DeviceEnrollmentPollResponse>;

// GET /enrollments — a workspace's machines (the Machines dashboard surface).
export const EnrollmentSummary = z.object({
  id: z.string().uuid(),
  pubkey: z.string(),
  exposure: z.literal("whole-machine"),
  hasDisplay: z.boolean(),
  // Present (non-null) only when a display EXISTS but capture is blocked (macOS
  // Screen Recording / TCC not granted): a human, actionable reason so the UI can
  // show "display: capture not granted" instead of a bare "headless". null == capture
  // permitted OR genuinely headless.
  desktopUnavailableReason: z.string().nullish(),
  allowScreenControl: z.boolean(),
  status: z.enum(["active", "revoked"]),
  os: EnrollmentOs,
  arch: z.string(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type EnrollmentSummary = z.infer<typeof EnrollmentSummary>;

export const ListEnrollmentsResponse = z.object({
  enrollments: z.array(EnrollmentSummary),
});
export type ListEnrollmentsResponse = z.infer<typeof ListEnrollmentsResponse>;

export const RevokeEnrollmentResponse = z.object({
  revoked: z.boolean(),
});
export type RevokeEnrollmentResponse = z.infer<typeof RevokeEnrollmentResponse>;

// =============================================================================
// Enrollment UX (self-hosted enrollment UX, design 11): the click-Grant approve
// page lookup/deny + the headless enroll-token mint/exchange. These sit beside the
// device-flow contracts above and REUSE EnrollmentCredentialsResponse for the
// exchange's credential payload (identical shape to the poll authorized branch).
// =============================================================================

// POST /v1/enrollments/device/lookup (USER-authenticated, NO workspace in the
// path). The approve page (EnrollmentConsent) needs the machine details for a
// user_code WITHOUT consuming the request. The user_code is globally unique among
// pending rows; the route resolves its workspace, authorizes (enrollments:read),
// and returns the machine details — or 404 (never revealing cross-workspace
// existence) when the grant check fails or no live pending row matches.
export const DeviceEnrollmentLookupRequest = z.object({
  userCode: z.string().min(1).max(64),
});
export type DeviceEnrollmentLookupRequest = z.infer<typeof DeviceEnrollmentLookupRequest>;

// The presentational machine details the consent screen renders (a subset of the
// pending request — NO secrets, NO device_code).
export const DeviceEnrollmentLookupMachine = z.object({
  machineName: z.string().nullable(),
  os: EnrollmentOs,
  arch: z.string(),
  canOfferDisplay: z.boolean(),
  requestsScreenControl: z.boolean(),
});
export type DeviceEnrollmentLookupMachine = z.infer<typeof DeviceEnrollmentLookupMachine>;

export const DeviceEnrollmentLookupResponse = z.object({
  workspaceId: z.string().uuid(),
  userCode: z.string(),
  machine: DeviceEnrollmentLookupMachine,
  expiresAt: z.string(),
});
export type DeviceEnrollmentLookupResponse = z.infer<typeof DeviceEnrollmentLookupResponse>;

// POST /v1/workspaces/:workspaceId/enrollments/device/deny (USER-authenticated,
// enrollments:manage). The explicit "no" at the approve page — mirrors approve.
export const DeviceEnrollmentDenyRequest = z.object({
  userCode: z.string().min(1).max(64),
});
export type DeviceEnrollmentDenyRequest = z.infer<typeof DeviceEnrollmentDenyRequest>;

export const DeviceEnrollmentDenyResponse = z.object({
  denied: z.boolean(),
});
export type DeviceEnrollmentDenyResponse = z.infer<typeof DeviceEnrollmentDenyResponse>;

// POST /v1/workspaces/:workspaceId/enrollments/token (USER-authenticated,
// enrollments:manage). Mints the short-TTL headless enroll token (the `oget_`
// token). allowScreenControl bakes the screen-control consent into the token.
export const MintEnrollTokenRequest = z.object({
  allowScreenControl: z.boolean().default(false),
});
export type MintEnrollTokenRequest = z.infer<typeof MintEnrollTokenRequest>;

export const MintEnrollTokenResponse = z.object({
  // The `oget_` token. SECRET — the UI shows it once with a copy-now warning.
  token: z.string(),
  expiresAt: z.string(),
  expiresInSeconds: z.number().int().positive(),
});
export type MintEnrollTokenResponse = z.infer<typeof MintEnrollTokenResponse>;

// POST /v1/enrollments/token/exchange (UNAUTHENTICATED — the token IS the auth).
// The agent presents the same identity fields it sends to device/start plus the
// enroll token. On a valid token the control plane performs the SAME finalize as
// approve and returns the IDENTICAL EnrollmentCredentialsResponse shape (so the
// agent's existing credential parsing is reused).
export const EnrollTokenExchangeRequest = z.object({
  // The `oget_` enroll token (the auth + the workspace/account/consent grant).
  token: z.string().min(1),
  // The agent's ed25519 public key (the machine identity the enrollment binds to).
  publicKey: z.string().min(1).max(1024),
  os: EnrollmentOs.default("linux"),
  arch: EnrollmentArch.default("x86_64"),
  machineName: z.string().min(1).max(256).optional(),
  // v1 only supports whole-machine; kept explicit so the consent is recorded.
  exposure: z.literal("whole-machine").default("whole-machine"),
  canOfferDisplay: z.boolean().default(false),
  // The agent's REQUEST; the token's allowScreenControl is the AUTHORITATIVE consent.
  requestsScreenControl: z.boolean().default(false),
});
export type EnrollTokenExchangeRequest = z.infer<typeof EnrollTokenExchangeRequest>;

// The exchange wraps the EXISTING EnrollmentCredentialsResponse — IDENTICAL to the
// poll authorized branch's `credentials` (NOT a redefined credential shape).
export const EnrollTokenExchangeResponse = z.object({
  credentials: EnrollmentCredentialsResponse,
});
export type EnrollTokenExchangeResponse = z.infer<typeof EnrollTokenExchangeResponse>;

// ── Machines dashboard + per-machine metrics (M10, dossier §10.7) ────────────
//
// The SHARED data contract M10 (backend) implements + M9 (UI) renders. THE
// orchestrator owns this shape; M9 imports these types so the dashboard never
// drifts from the API. The fields mirror the agent's MetricsSample wire shape
// (`@opengeni/agent-proto`) projected to the dashboard's JSON, plus the derived
// machine state matrix (the M3 liveness + the consent/display reasons).

/**
 * A point-in-time machine metrics sample as the dashboard reads it. `cpuPct` and
 * the load averages are 0..N doubles; the byte figures are integers; `gpuUtilPct`
 * / `gpuMemBytes` are null when no GPU was present at sample time (the wire
 * contract: absence == not-reported, NEVER a real zero). `runQueue` is the
 * runnable-count contention signal. `sampledAt` is an ISO-8601 instant.
 */
export const MetricSample = z.object({
  cpuPct: z.number(),
  load1: z.number(),
  load5: z.number(),
  load15: z.number(),
  memUsedBytes: z.number().int(),
  memTotalBytes: z.number().int(),
  diskUsedBytes: z.number().int(),
  diskTotalBytes: z.number().int(),
  gpuUtilPct: z.number().nullable(),
  gpuMemBytes: z.number().int().nullable(),
  runQueue: z.number(),
  sampledAt: z.string(),
});
export type MetricSample = z.infer<typeof MetricSample>;

/** The derived dashboard state of a machine. The M3 liveness
 *  (online/reconnecting/offline) plus the enrollment-derived consent/display
 *  reasons (consent_required / display_unavailable) and the in-flight device-flow
 *  (enrolling). */
export const MachineState = z.enum([
  "online",
  "reconnecting",
  "offline",
  "consent_required",
  "display_unavailable",
  "enrolling",
]);
export type MachineState = z.infer<typeof MachineState>;

export const MachineKind = z.enum(["modal", "selfhosted"]);
export type MachineKind = z.infer<typeof MachineKind>;

/**
 * A machine as the Machines dashboard renders it. The workspace's enrolled
 * selfhosted machines PLUS the session's synthetic Modal group box
 * (`isSessionGroup: true`). `active` marks the session's currently-active
 * routing target. `sharedSessionCount` is the lease refcount (how many sessions
 * share this whole machine). `metrics` is the latest sample, or null when none
 * has landed yet (just enrolled / offline before a first heartbeat).
 */
export const MachineView = z.object({
  sandboxId: z.string(),
  enrollmentId: z.string().nullable(),
  name: z.string(),
  kind: MachineKind,
  state: MachineState,
  active: z.boolean(),
  isSessionGroup: z.boolean(),
  os: z.string(),
  arch: z.string(),
  hasDisplay: z.boolean(),
  // Non-null only when a display exists but capture is blocked (macOS Screen
  // Recording / TCC not granted) — the UI can surface "display: capture not granted".
  // null == capture permitted OR headless.
  desktopUnavailableReason: z.string().nullish(),
  allowScreenControl: z.boolean(),
  sharedSessionCount: z.number().int(),
  lastSeenAt: z.string().nullable(),
  metrics: MetricSample.nullable(),
});
export type MachineView = z.infer<typeof MachineView>;

/**
 * GET /v1/workspaces/:ws/machines — the dashboard list. `activeSandboxId` /
 * `activeEpoch` echo the session's epoch-fenced active-sandbox pointer (null
 * activeSandboxId == the session's own group box is active).
 */
export const MachinesResponse = z.object({
  activeSandboxId: z.string().nullable(),
  activeEpoch: z.number().int(),
  machines: z.array(MachineView),
});
export type MachinesResponse = z.infer<typeof MachinesResponse>;

/**
 * POST /v1/workspaces/:ws/sessions/:sessionId/active-sandbox — the user-
 * authenticated swap of a session's active sandbox (the same epoch-fenced
 * mechanic the M7 `sandbox_swap` MCP tool exposes to the agent). `target` is a
 * `MachinesResponse` machine's `sandboxId`, or "session"/"default" to swap back
 * to the session's own group box.
 */
export const SwapActiveSandboxRequest = z.object({
  target: z.string().min(1),
});
export type SwapActiveSandboxRequest = z.infer<typeof SwapActiveSandboxRequest>;

/**
 * The swap outcome (mirrors the server `FleetSwapResult`). `swapped` is true on a
 * successful repoint OR a no-op (already pointed there); `reason` carries the
 * failure detail (unowned/offline target, or a lost epoch fence) when false.
 */
export const SwapActiveSandboxResponse = z.object({
  swapped: z.boolean(),
  activeSandboxId: z.string().nullable(),
  activeEpoch: z.number().int(),
  reason: z.string().optional(),
});
export type SwapActiveSandboxResponse = z.infer<typeof SwapActiveSandboxResponse>;

/**
 * GET /v1/workspaces/:ws/machines/:enrollmentId/metrics/series?window=1h — the
 * downsampled (~1/min) history the dashboard time-range reads.
 */
export const MachineMetricsSeriesResponse = z.object({
  samples: z.array(MetricSample),
});
export type MachineMetricsSeriesResponse = z.infer<typeof MachineMetricsSeriesResponse>;

/**
 * A single host-exposed model + the provider that serves it, as surfaced to
 * clients (SDK + React composer) by GET /v1/config/client. The wire `api`
 * ("responses" | "chat") lets a client reason about provider capabilities; the
 * provider id/label drive the picker's grouping. This mirrors the runtime's
 * ConfiguredModel (packages/config) projected to the client-safe fields.
 */
export const ClientModel = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),        // provider id
  providerLabel: z.string(),
  api: z.enum(["responses", "chat"]),
  contextWindowTokens: z.number().int().positive().optional(),
});
export type ClientModel = z.infer<typeof ClientModel>;

export const ClientConfig = z.object({
  deploymentRevision: z.string(),
  // Release-train version of the server (absent on dev/source builds). The
  // compatibility policy lives in docs/architecture.md — clients within the
  // same major are supported; evolution is additive within a major.
  serverVersion: z.string().optional(),
  defaultModel: z.string(),
  allowedModels: z.array(z.string()).min(1),
  // Richer model list (provider-grouped) for the picker. Defaults to [] for
  // back-compat: callers that only read allowedModels are unaffected.
  models: z.array(ClientModel).default([]),
  defaultReasoningEffort: ReasoningEffort,
  allowedReasoningEfforts: z.array(ReasoningEffort).min(1),
  mcpServers: z.array(z.object({
    id: z.string(),
    name: z.string(),
  })).default([]),
  fileUploads: z.object({
    enabled: z.boolean(),
    maxSizeBytes: z.number().int().positive(),
  }),
  productAccessMode: ProductAccessMode,
  auth: ClientAuthConfig.default({ mode: "none" }),
  // Server-wide hint: does this deployment support Channel-A structured services
  // at all (P4.4). Per-session availability is negotiated on /stream-capabilities
  // (it depends on the session's pinned backend); this is the coarse on/off the
  // client uses to decide whether to even attempt the fs/git/terminal panels.
  structuredServices: z.object({
    fileSystem: z.boolean(),
    git: z.boolean(),
    terminalEvents: z.boolean(),
  }).default({ fileSystem: false, git: false, terminalEvents: false }),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

async function hmacSha256Base64Url(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(signature).toString("base64url");
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  if (actualBytes.length !== expectedBytes.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    diff |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return diff === 0;
}

export type HealthResponse = {
  service: string;
  environment: string;
  ok: boolean;
};
