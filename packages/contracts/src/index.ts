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

// 10 backends; 3-way enum parity (contracts / sdk / deployment) is pinned by
// `packages/sdk/test/contract-parity.test.ts`. The existing four keep their
// positions; the six new backends are additive.
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

export const PageInfo = z.object({
  limit: z.number().int().positive(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfo>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    page: PageInfo,
  });
}

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
  "environments:manage",
  "environments:use",
  "goals:manage",
]);
export type Permission = z.infer<typeof Permission>;

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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

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
  chunkIndex: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
});
export type DocumentSearchResult = z.infer<typeof DocumentSearchResult>;

export const CreateDocumentBaseRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateDocumentBaseRequest = z.infer<typeof CreateDocumentBaseRequest>;

export const AddDocumentRequest = z.object({
  fileId: z.string().uuid(),
});
export type AddDocumentRequest = z.infer<typeof AddDocumentRequest>;

export const DocumentSearchRequest = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
});
export type DocumentSearchRequest = z.infer<typeof DocumentSearchRequest>;

export const ToolRef = z.object({
  kind: z.literal("mcp"),
  id: z.string().min(1),
});
export type ToolRef = z.infer<typeof ToolRef>;

export class ResourceRefConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceRefConflictError";
  }
}

export function mergeToolRefs(existing: ToolRef[], additions: ToolRef[]): ToolRef[] {
  const seen = new Set<string>();
  const out: ToolRef[] = [];
  for (const tool of [...existing, ...additions]) {
    const key = `${tool.kind}:${tool.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
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

export const CapabilitySource = z.enum(["built_in", "configured", "public_registry", "manual"]);
export type CapabilitySource = z.infer<typeof CapabilitySource>;

export const CapabilityInstallationStatus = z.enum(["active", "disabled"]);
export type CapabilityInstallationStatus = z.infer<typeof CapabilityInstallationStatus>;

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
  tools: z.array(ToolRef).default([]),
  runtime: CapabilityRuntime.default({ available: false, notes: null }),
  enabled: z.boolean().default(false),
  enabledReason: z.string().nullable().default(null),
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
  environmentId: z.string().uuid().nullable(),
  // Non-default first-party MCP token permissions (manager-style sessions);
  // null means the fixed worker default set.
  firstPartyMcpPermissions: z.array(Permission).nullable(),
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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof Session>;

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
]);
export type SessionEventType = z.infer<typeof SessionEventType>;

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
  resources: z.array(ResourceRef).default([]),
  tools: z.array(ToolRef).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  model: z.string().min(1).optional(),
  reasoningEffort: ReasoningEffort.optional(),
  sandboxBackend: SandboxBackend.optional(),
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
    url: z.string().url().nullable(),
    token: z.string().nullable(),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  Git: z.object({
    available: z.boolean(),
    repos: z.array(z.string()),
    reason: CapabilityUnavailableReason.nullable(),
  }),
  DesktopStream: z.object({
    transport: z.enum(["vnc-ws", "rdp-ws", "webrtc"]).nullable(),
    client: z.enum(["novnc", "web-rdp"]).nullable(),
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
    reason: CapabilityUnavailableReason.nullable(),
  }),
  Recording: z.object({
    available: z.boolean(),
    modes: z.array(z.enum(["manual", "on-turn", "on-verify"])),
    codecs: z.array(z.enum(["h264-mp4", "vp9-webm"])),
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
export const AttachViewerRequest = z.object({
  viewerId: z.string().uuid().optional(),
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

export const ClientConfig = z.object({
  deploymentRevision: z.string(),
  defaultModel: z.string(),
  allowedModels: z.array(z.string()).min(1),
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
