import { sandboxImageAllowlist, type Settings } from "@opengeni/config";
import {
  resolveWorkspaceDefaultSandboxImage,
  type RigVersion,
  type Session,
  type SandboxBackend,
  type SandboxOs,
} from "@opengeni/contracts";
import { getRigVersion, getWorkspace, type Database } from "@opengeni/db";
import { resolveModalCheckpointProviderBinding } from "@opengeni/runtime/sandbox";
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

export type RigProviderImageSelectionReason =
  | "selected"
  | "missing"
  | "provider_unsupported"
  | "not_ready"
  | "not_cold_boot_validated"
  | "content_mismatch"
  | "provider_binding_unavailable"
  | "provider_binding_mismatch";

export function resolveRigProviderImageSelection(
  settings: Settings,
  version: RigVersion | null,
  backend: SandboxBackend,
  currentProviderBindingKeyHash: string | null,
): {
  settings: Settings;
  reason: RigProviderImageSelectionReason;
  contentHash: string | null;
  imageId: string | null;
} {
  if (!version) return { settings, reason: "missing", contentHash: null, imageId: null };
  if (backend !== "modal") {
    return { settings, reason: "provider_unsupported", contentHash: null, imageId: null };
  }
  const image = version.providerImages[backend];
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
  const sourceImage = rigProviderImageSourceImage(settings, backend);
  const expectedContentHash = rigProviderImageContentHash({
    backend,
    sourceImage,
    definition: version,
  });
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
    settings: { ...settings, modalImageId: image.imageId },
    reason: "selected",
    contentHash: expectedContentHash,
    imageId: image.imageId,
  };
}

export async function resolveRigProviderImageForRun(
  settings: Settings,
  version: RigVersion | null,
  backend: SandboxBackend,
  resolveBinding: typeof resolveModalCheckpointProviderBinding = resolveModalCheckpointProviderBinding,
): Promise<ReturnType<typeof resolveRigProviderImageSelection>> {
  const image = backend === "modal" ? version?.providerImages.modal : null;
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
    const binding = await resolveBinding(settings);
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
  resolveBinding: typeof resolveModalCheckpointProviderBinding = resolveModalCheckpointProviderBinding,
): Promise<Settings> {
  return (await resolveRigProviderImageForRun(settings, version, backend, resolveBinding)).settings;
}

export type SessionSandboxRuntime = {
  /** Exact logical image/rig settings used to fence the durable group lease. */
  settings: Settings;
  image: string | null;
  rigVersion: RigVersion | null;
};

export async function resolveSessionSandboxRuntime(
  db: Database,
  settings: Settings,
  session: Pick<Session, "workspaceId" | "sandboxBackend" | "rigId" | "rigVersionId">,
): Promise<SessionSandboxRuntime> {
  const rigVersion =
    session.rigId && session.rigVersionId
      ? await getRigVersion(db, session.workspaceId, session.rigId, session.rigVersionId)
      : null;
  if (session.rigVersionId && !rigVersion) {
    throw new Error(`Frozen sandbox environment version ${session.rigVersionId} is unavailable`);
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
