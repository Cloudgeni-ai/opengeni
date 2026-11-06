import {
  deploymentSandboxBackend,
  hostSandboxBackendRefused,
  sandboxImageAllowlist,
  UNSERVED_HOST_SANDBOX_BACKEND_MESSAGE,
  type Settings,
} from "@opengeni/config";
import {
  resolveWorkspaceDefaultSandboxImage,
  type AccessGrant,
  type RigVersion,
  type Session,
  type SandboxBackend,
  type SandboxOs,
} from "@opengeni/contracts";
import {
  getRigVersion,
  getScheduledScopedRigVersionMetadata,
  getWorkspace,
  nestedPostgresSqlState,
  type Database,
} from "@opengeni/db";
import {
  computeSourceImage,
  resolveComputeProviderBinding,
  resolveModalCheckpointProviderBinding,
} from "@opengeni/runtime/sandbox";
import { HTTPException } from "hono/http-exception";
import {
  grantHasAgentAttemptAuthority,
  requireLiveAgentAttemptAuthorization,
} from "../session-authorization";
import {
  rigProviderImageContentHash,
  rigProviderImageMatchesDefinition,
  rigProviderImageProviderBindingKeyHash,
} from "../rigs/provider-images";

export type ManagedSessionGroupBackend = Exclude<SandboxBackend, "none" | "selfhosted">;

/**
 * Resolve the provider backend behind a session's synthetic managed group.
 *
 * A machine-home session keeps `selfhosted` as its durable policy while a
 * non-null active pointer selects the enrolled machine. Clearing that pointer
 * is an explicit switch to the deployment's managed group, so API readiness,
 * viewer attachment, Channel-A, and worker turns must all select the same
 * provider. Deployments configured with `none` or `selfhosted` have no managed
 * fallback to expose.
 */
export function managedSessionGroupBackend(
  deploymentBackend: SandboxBackend,
  sessionBackend: SandboxBackend,
): ManagedSessionGroupBackend | null {
  if (sessionBackend === "none") return null;
  const backend = sessionBackend === "selfhosted" ? deploymentBackend : sessionBackend;
  return backend === "none" || backend === "selfhosted" ? null : backend;
}

const SESSION_GROUP_MACHINE_NAMES: Record<ManagedSessionGroupBackend, string> = {
  local: "this computer",
  docker: "Docker",
  modal: "Modal",
  daytona: "Daytona",
  runloop: "Runloop",
  e2b: "E2B",
  blaxel: "Blaxel",
  cloudflare: "Cloudflare",
  vercel: "Vercel",
  opensandbox: "OpenSandbox",
  compute: "Opengeni compute",
};

/** Display name and kind for the session's own managed box. The kind is the
 * real provider. Callers must not collapse local, Docker, or other providers
 * into Modal. */
export function sessionGroupMachinePresentation(backend: ManagedSessionGroupBackend): {
  name: string;
  kind: ManagedSessionGroupBackend;
} {
  return { name: SESSION_GROUP_MACHINE_NAMES[backend], kind: backend };
}

/** A machine-home row carries the machine's host OS; its managed group uses the
 * platform's canonical managed-sandbox OS instead. Ordinary sessions preserve
 * their explicitly selected OS. */
export function managedSessionGroupOs(
  sessionBackend: SandboxBackend,
  sessionOs: SandboxOs,
): SandboxOs {
  return sessionBackend === "selfhosted" ? "linux" : sessionOs;
}

/**
 * Apply a workspace's selected sandbox image. The deployment keeps authority:
 * only an image that is on its allowlist right now is used, so removing an
 * entry returns every workspace that chose it to the deployment image. The
 * lease treats the image as shared state, so a change rotates a live box
 * through the normal capture-and-restore path instead of reusing it.
 */
export function settingsWithWorkspaceSandboxImage(
  settings: Settings,
  workspaceSettings: unknown,
  backend: SandboxBackend,
): Settings {
  const image = resolveWorkspaceDefaultSandboxImage(workspaceSettings);
  if (!image || !sandboxImageAllowlist(settings).includes(image)) return settings;
  if (backend === "docker") return { ...settings, dockerImage: image };
  if (backend === "modal") {
    return { ...settings, modalImageRef: image, modalImageId: undefined };
  }
  return settings;
}

export function settingsWithRigImage(settings: Settings, rigImage: string | null): Settings {
  // Explicit Rig image overrides are intentionally inert. Preserve this helper
  // as a compatibility seam for callers and historical rows while ensuring the
  // deployment-owned platform image remains authoritative.
  void rigImage;
  return settings;
}

export function rigProviderImageSourceImage(
  settings: Settings,
  backend: SandboxBackend,
): string | null {
  if (backend === "modal") return settings.modalImageId ?? settings.modalImageRef ?? null;
  if (backend === "docker") return settings.dockerImage ?? null;
  return null;
}

/**
 * The base image a prebuilt Sandbox Environment is defined over, for its
 * content identity. It equals the lease's logical image except on compute,
 * whose lease keeps no image: there a template is captured over the image new
 * sandboxes boot, and keeps that image's guest when the image moves on, so a
 * change of that image must make the template stale. A digest-pinned image
 * names its content. A plain image name (such as one the control service
 * points at each release's sandbox image) does not, so it is identified with
 * the deployment revision that chose it: each release rebuilds over its own
 * image. Without either, compute has no content identity and cannot prebuild.
 */
export function rigProviderImageContentSourceImage(
  settings: Settings,
  backend: SandboxBackend,
): string | null {
  if (backend === "compute") return computeImageContentIdentity(settings);
  return rigProviderImageSourceImage(settings, backend);
}

function computeImageContentIdentity(settings: Settings): string | null {
  const image = computeSourceImage(settings);
  if (!image) return null;
  const revision = settings.deploymentRevision?.trim();
  if (!revision || revision === "dev") return null;
  return `${image} release ${revision}`;
}

/**
 * Whether this deployment can prebuild a verified Sandbox Environment for
 * `backend`. A compute template keeps the guest it was captured on and does
 * not follow image releases, so compute needs an explicitly configured image
 * with a content identity whose change is noticed and rebuilt over.
 */
export function rigProviderImageBuildSupported(
  settings: Settings,
  backend: SandboxBackend,
): boolean {
  if (backend === "modal") return true;
  if (backend === "compute") return computeImageContentIdentity(settings) !== null;
  return false;
}

/** Settings that boot fresh sandboxes from one verified prebuilt image. */
export function settingsWithProviderImageId(
  settings: Settings,
  backend: SandboxBackend,
  imageId: string,
): Settings {
  if (backend === "compute") return { ...settings, computeTemplate: imageId };
  return { ...settings, modalImageId: imageId };
}

/** The provider namespace a prebuilt image lives in, for the backend. */
export async function resolveRigProviderImageBinding(
  settings: Settings,
  backend: SandboxBackend,
): Promise<{ key: string }> {
  if (backend === "compute") return await resolveComputeProviderBinding(settings);
  return await resolveModalCheckpointProviderBinding(settings);
}

export type RigProviderImageSelectionReason =
  | "selected"
  | "missing"
  | "unbuilt"
  | "build_abandoned"
  | "provider_unsupported"
  | "not_ready"
  | "not_cold_boot_validated"
  | "content_mismatch"
  | "provider_binding_unavailable"
  | "provider_binding_mismatch";

/** A build record still `building` after this long was abandoned (its worker
 * stopped); a new build may take it over. Matches the build claim's
 * staleness window in the worker. */
export const RIG_PROVIDER_IMAGE_BUILD_STALE_AFTER_MS = 20 * 60_000;

export function resolveRigProviderImageSelection(
  settings: Settings,
  version: RigVersion | null,
  backend: SandboxBackend,
  currentProviderBindingKeyHash: string | null,
  nowMs: number = Date.now(),
): {
  settings: Settings;
  reason: RigProviderImageSelectionReason;
  contentHash: string | null;
  imageId: string | null;
} {
  if (!version) return { settings, reason: "missing", contentHash: null, imageId: null };
  if (!rigProviderImageBuildSupported(settings, backend)) {
    return { settings, reason: "provider_unsupported", contentHash: null, imageId: null };
  }
  const sourceImage = rigProviderImageContentSourceImage(settings, backend);
  const expectedContentHash = rigProviderImageContentHash({
    backend,
    sourceImage,
    definition: version,
  });
  const image = version.providerImages[backend];
  if (backend === "compute") {
    // A compute template is captured over one release's image, so each
    // release builds again; every way a build can end up missing asks for one
    // (see requestStaleRigProviderImageRefresh), except a failed build of
    // this exact content, which waits for the content to change.
    const rebuild = computeRebuildReason(version, image, expectedContentHash, nowMs);
    if (rebuild === "missing")
      return { settings, reason: "missing", contentHash: null, imageId: null };
    if (rebuild)
      return { settings, reason: rebuild, contentHash: expectedContentHash, imageId: null };
  }
  if (!image) return { settings, reason: "missing", contentHash: null, imageId: null };
  if (image.status !== "ready" || !image.imageId) {
    return {
      settings,
      reason: "not_ready",
      contentHash: image.contentHash,
      imageId: image.imageId,
    };
  }
  if (image.coldBootValidation?.version !== 1) {
    return {
      settings,
      reason: "not_cold_boot_validated",
      contentHash: image.contentHash,
      imageId: null,
    };
  }
  if (
    image.sourceImage !== sourceImage ||
    image.contentHash !== expectedContentHash ||
    !rigProviderImageMatchesDefinition(image, version)
  ) {
    return {
      settings,
      reason: "content_mismatch",
      contentHash: expectedContentHash,
      imageId: null,
    };
  }
  if (!image.providerBindingKeyHash || !currentProviderBindingKeyHash) {
    return {
      settings,
      reason: "provider_binding_unavailable",
      contentHash: expectedContentHash,
      imageId: null,
    };
  }
  if (image.providerBindingKeyHash !== currentProviderBindingKeyHash) {
    return {
      settings,
      reason: "provider_binding_mismatch",
      contentHash: expectedContentHash,
      imageId: null,
    };
  }
  return {
    settings: settingsWithProviderImageId(settings, backend, image.imageId),
    reason: "selected",
    contentHash: expectedContentHash,
    imageId: image.imageId,
  };
}

/** Why a compute Sandbox Environment without a usable template should be
 * built again, "missing" when there is nothing to build, or null when the
 * record is for the current content and needs no rebuild. */
function computeRebuildReason(
  version: RigVersion,
  image: RigVersion["providerImages"][SandboxBackend],
  expectedContentHash: string,
  nowMs: number,
): "unbuilt" | "build_abandoned" | "content_mismatch" | "missing" | null {
  if (!image || image.status === "unsupported") {
    // Never built for compute, or recorded before compute could build:
    // worth building once when there is setup to skip.
    return (version.setupScript ?? "").trim() ? "unbuilt" : "missing";
  }
  if (image.status === "ready") return null;
  // A record for other content: an earlier release's build that failed or
  // stopped. It must not hold back this release's build.
  if (image.contentHash !== expectedContentHash) return "content_mismatch";
  if (image.status === "building") {
    const startedAtMs = Date.parse(image.startedAt);
    if (
      !Number.isFinite(startedAtMs) ||
      nowMs - startedAtMs >= RIG_PROVIDER_IMAGE_BUILD_STALE_AFTER_MS
    )
      return "build_abandoned";
  }
  return null;
}

export async function resolveRigProviderImageForRun(
  settings: Settings,
  version: RigVersion | null,
  backend: SandboxBackend,
  resolveBinding: RigProviderImageBindingResolver = resolveRigProviderImageBinding,
): Promise<ReturnType<typeof resolveRigProviderImageSelection>> {
  const image = rigProviderImageBuildSupported(settings, backend)
    ? version?.providerImages[backend]
    : null;
  if (image?.status !== "ready" || !image.providerBindingKeyHash) {
    return resolveRigProviderImageSelection(settings, version, backend, null);
  }
  const structural = resolveRigProviderImageSelection(
    settings,
    version,
    backend,
    image.providerBindingKeyHash,
  );
  if (structural.reason !== "selected") return structural;
  let currentProviderBindingKeyHash: string | null = null;
  try {
    const binding = await resolveBinding(settings, backend);
    currentProviderBindingKeyHash = rigProviderImageProviderBindingKeyHash(binding.key);
  } catch {
    // A provider-native image is an optimization. The exact logical image is
    // still the correct cold-create fallback when provider identity is absent.
  }
  return resolveRigProviderImageSelection(
    settings,
    version,
    backend,
    currentProviderBindingKeyHash,
  );
}

export async function settingsWithRigProviderImage(
  settings: Settings,
  version: RigVersion | null,
  backend: SandboxBackend,
  resolveBinding: RigProviderImageBindingResolver = resolveRigProviderImageBinding,
): Promise<Settings> {
  return (await resolveRigProviderImageForRun(settings, version, backend, resolveBinding)).settings;
}

export type RigProviderImageBindingResolver = (
  settings: Settings,
  backend: SandboxBackend,
) => Promise<{ key: string }>;

export type SessionSandboxRuntime = {
  /** Exact logical image/rig settings used to fence the durable group lease. */
  settings: Settings;
  image: string | null;
  rigVersion: RigVersion | null;
};

/** The subject a direct attach resolves under when no human subject drives it.
 *  It holds no organization membership, so it can resolve organization and
 *  workspace Sandbox Environments but never a personal one. */
const SESSION_ATTACH_SUBJECT = "session-attach";

/** Who a direct attach resolves a session's Sandbox Environment as: an explicit
 *  subject (null for a service attach), or the authenticated route grant. */
export type SessionAttachRigAuthority = { subjectId: string | null } | { grant: AccessGrant };

/**
 * The subject whose scoped visibility applies. An agent-attempt grant carries a
 * technical worker identity with no organization membership, so it resolves as
 * its live attempt's frozen initiating human, as the MCP Sandbox Environment and
 * fleet tools do; an attempt without one resolves as the service sentinel.
 */
async function sessionAttachRigSubjectId(
  db: Database,
  authority: SessionAttachRigAuthority,
): Promise<string | null> {
  if (!("grant" in authority)) return authority.subjectId;
  const { grant } = authority;
  if (!grantHasAgentAttemptAuthority(grant)) return grant.subjectId;
  const callerSessionId = grant.metadata?.["sessionId"];
  if (typeof callerSessionId !== "string") return null;
  const actor = await requireLiveAgentAttemptAuthorization(db, grant, callerSessionId);
  return actor.initiatingHumanSubjectId;
}

/** The scoped seam's refusal for a subject that is an organization member but
 *  has no current access to the session's workspace. Other 42501 failures
 *  (grants, capability rows) remain errors. */
function isWorkspaceAccessRefusal(error: unknown): boolean {
  if (nestedPostgresSqlState(error) !== "42501") return false;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current.message.includes("lacks current workspace access")) return true;
    current = current.cause;
  }
  return false;
}

/**
 * The exact frozen Sandbox Environment version a session is bound to, resolved
 * for a direct attach (terminal, Files, desktop viewer, Browser, Computer).
 *
 * A version homed in the session's own workspace resolves physically under the
 * session access the route already enforced, exactly as before. An
 * organization Sandbox Environment, or a personal one used outside its home
 * workspace, keeps its versions in that home workspace, so those resolve
 * through the same scoped authority scheduled tasks use: same organization, active, and visible to the attaching
 * subject in the session's workspace.
 */
async function resolveSessionRigVersion(
  db: Database,
  session: Pick<Session, "accountId" | "workspaceId"> & { rigId: string; rigVersionId: string },
  authority: SessionAttachRigAuthority,
): Promise<RigVersion | null> {
  const local = await getRigVersion(db, session.workspaceId, session.rigId, session.rigVersionId);
  if (local) return local;
  const subjectId = await sessionAttachRigSubjectId(db, authority);
  let scoped: Awaited<ReturnType<typeof getScheduledScopedRigVersionMetadata>>;
  try {
    scoped = await getScheduledScopedRigVersionMetadata(
      db,
      {
        accountId: session.accountId,
        workspaceId: session.workspaceId,
        subjectId: subjectId ?? SESSION_ATTACH_SUBJECT,
      },
      session.rigId,
      session.rigVersionId,
    );
  } catch (error) {
    if (!isWorkspaceAccessRefusal(error)) throw error;
    console.warn("[session-attach] sandbox environment refused without workspace access", {
      workspaceId: session.workspaceId,
      rigId: session.rigId,
      rigVersionId: session.rigVersionId,
    });
    return null;
  }
  return scoped?.version.rigId === session.rigId ? scoped.version : null;
}

export async function resolveSessionSandboxRuntime(
  db: Database,
  settings: Settings,
  session: Pick<Session, "accountId" | "workspaceId" | "sandboxBackend" | "rigId" | "rigVersionId">,
  /** Who drives the attach; pass the route grant whenever one exists. */
  authority: SessionAttachRigAuthority,
): Promise<SessionSandboxRuntime> {
  // Every API surface that can build or attach a session's box (Channel A
  // terminal/files/browser/computer, viewers, rematerialization) resolves its
  // runtime here first. A stored row on a host backend this deployment does not
  // serve gets a plain 409 before any box, hook or credential exists.
  const builtBackend = managedSessionGroupBackend(
    deploymentSandboxBackend(settings),
    session.sandboxBackend,
  );
  if (builtBackend && hostSandboxBackendRefused(settings, builtBackend)) {
    throw new HTTPException(409, { message: UNSERVED_HOST_SANDBOX_BACKEND_MESSAGE });
  }
  const rigVersion =
    session.rigId && session.rigVersionId
      ? await resolveSessionRigVersion(
          db,
          { ...session, rigId: session.rigId, rigVersionId: session.rigVersionId },
          authority,
        )
      : null;
  if (session.rigVersionId && !rigVersion) {
    throw new HTTPException(403, {
      message: "This session's Sandbox Environment version is not available.",
    });
  }
  // Setup and checks layer on the deployment image, or on the workspace's
  // allowlisted selection of one.
  const logicalSettings = sandboxImageAllowlist(settings).length
    ? settingsWithWorkspaceSandboxImage(
        settings,
        (await getWorkspace(db, session.workspaceId))?.settings,
        session.sandboxBackend,
      )
    : settings;
  return {
    settings: {
      ...logicalSettings,
      sandboxBackend: session.sandboxBackend,
    },
    image: rigProviderImageSourceImage(logicalSettings, session.sandboxBackend),
    rigVersion,
  };
}

/** Resolve provider-native cold-create optimization only for the single CAS
 * winner. Ordinary API calls never perform provider identity I/O. */
export async function providerSettingsForSessionSandboxRuntime(
  runtime: SessionSandboxRuntime,
  backend: SandboxBackend,
): Promise<Settings> {
  return await settingsWithRigProviderImage(runtime.settings, runtime.rigVersion, backend);
}
