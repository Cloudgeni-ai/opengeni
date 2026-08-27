import type { Settings } from "@opengeni/config";
import {
  CapabilityPack,
  type RigVersion,
  type Session,
  type SandboxBackend,
} from "@opengeni/contracts";
import {
  getRigVersion,
  getWorkspacePack,
  listPackInstallations,
  type Database,
} from "@opengeni/db";
import { resolveModalCheckpointProviderBinding } from "@opengeni/runtime/sandbox";
import {
  rigProviderImageContentHash,
  rigProviderImageMatchesDefinition,
  rigProviderImageProviderBindingKeyHash,
} from "../rigs/provider-images";

/** Pre-V2 Packs are the sole compatibility path where a Pack can still own a
 * sandbox image. V2 installations select a Rig instead. Keep this predicate at
 * the shared runtime boundary so turns, API-direct tools, viewers, Browser and
 * Computer cannot resolve different physical machines for the same session. */
export function packInstallationUsesLegacyRuntime(input: {
  manifestSnapshot: unknown | null;
  manifestDigest: string | null;
}): boolean {
  return input.manifestSnapshot === null && input.manifestDigest === null;
}

export async function resolveWorkspaceLegacyRuntimePacks(
  db: Database,
  workspaceId: string,
): Promise<CapabilityPack[]> {
  const installations = await listPackInstallations(db, workspaceId);
  const packs: CapabilityPack[] = [];
  for (const installation of installations) {
    if (installation.status !== "active" || !packInstallationUsesLegacyRuntime(installation)) {
      continue;
    }
    const registration = await getWorkspacePack(db, workspaceId, installation.packId);
    const parsed = CapabilityPack.safeParse(registration?.pack);
    if (parsed.success) packs.push(parsed.data);
  }
  return packs;
}

export function legacySandboxRuntimeFromPacks(packs: readonly CapabilityPack[]): {
  sandboxImage: string | null;
  sandboxProviderImages: CapabilityPack["sandboxProviderImages"] | null;
} {
  const imagePacks = packs.filter(
    (pack) => typeof pack.sandboxImage === "string" && pack.sandboxImage.trim().length > 0,
  );
  if (imagePacks.length > 1) {
    const ids = imagePacks
      .map((pack) => pack.id)
      .sort()
      .join(", ");
    throw new Error(
      `Multiple enabled packs declare a sandbox image (${ids}). Only one enabled pack per workspace may declare sandboxImage; disable the others and retry.`,
    );
  }
  return {
    sandboxImage: imagePacks[0]?.sandboxImage?.trim() ?? null,
    sandboxProviderImages: imagePacks[0]?.sandboxProviderImages ?? null,
  };
}

export function settingsWithPackSandboxImage(
  settings: Settings,
  sandboxImage: string | null,
  sandboxProviderImages: CapabilityPack["sandboxProviderImages"] | null = null,
): Settings {
  if (!sandboxImage) return settings;
  return {
    ...settings,
    dockerImage: sandboxImage,
    modalImageRef: sandboxImage,
    modalImageId: sandboxProviderImages?.modal?.imageId,
  };
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
  const [packs, rigVersion] = await Promise.all([
    resolveWorkspaceLegacyRuntimePacks(db, session.workspaceId),
    session.rigId && session.rigVersionId
      ? getRigVersion(db, session.workspaceId, session.rigId, session.rigVersionId)
      : Promise.resolve(null),
  ]);
  if (session.rigVersionId && !rigVersion) {
    throw new Error(`Frozen rig version ${session.rigVersionId} is unavailable`);
  }
  const legacy = legacySandboxRuntimeFromPacks(packs);
  // A Rig is always a setup/check layer over the deployment-owned platform
  // sandbox. Legacy pre-v2 Pack image compatibility remains available only to
  // rig-less sessions; it cannot replace the base beneath a Rig.
  const logicalSettings = rigVersion
    ? settings
    : settingsWithPackSandboxImage(settings, legacy.sandboxImage, legacy.sandboxProviderImages);
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
