import type { Settings } from "@opengeni/config";
import type { CapabilityPack, RigVersion, SandboxBackend } from "@opengeni/contracts";
import {
  rigProviderImageContentHash,
  rigProviderImageMatchesDefinition,
  rigProviderImageProviderBindingKeyHash,
} from "@opengeni/core";
import { resolveModalCheckpointProviderBinding } from "@opengeni/runtime/sandbox";

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
  if (!rigImage) return settings;
  return {
    ...settings,
    dockerImage: rigImage,
    modalImageRef: rigImage,
    // A logical rig image invalidates a lower-precedence pack/deployment
    // provider ID. A verified version-bound provider ID is applied separately
    // after this precedence step.
    modalImageId: undefined,
  };
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
  if (!version) {
    return { settings, reason: "missing", contentHash: null, imageId: null };
  }
  if (backend !== "modal") {
    return { settings, reason: "provider_unsupported", contentHash: null, imageId: null };
  }
  const image = version.providerImages[backend];
  if (!image) {
    return { settings, reason: "missing", contentHash: null, imageId: null };
  }
  if (image.status !== "ready" || !image.imageId) {
    return {
      settings,
      reason: "not_ready",
      contentHash: image.contentHash,
      imageId: image.imageId,
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
    // Keep modalImageRef unchanged: the lease continues to fence the logical
    // rig/pack/deployment image, so a newly available build optimization never
    // rotates an already-warm or archive-backed box. modalImageId affects only
    // genuinely fresh provider creation.
    settings: { ...settings, modalImageId: image.imageId },
    reason: "selected",
    contentHash: expectedContentHash,
    imageId: image.imageId,
  };
}

export async function settingsWithRigProviderImage(
  settings: Settings,
  version: RigVersion | null,
  backend: SandboxBackend,
  resolveBinding: typeof resolveModalCheckpointProviderBinding = resolveModalCheckpointProviderBinding,
): Promise<Settings> {
  const image = backend === "modal" ? version?.providerImages.modal : null;
  if (image?.status !== "ready" || !image.providerBindingKeyHash) {
    return resolveRigProviderImageSelection(settings, version, backend, null).settings;
  }
  const structural = resolveRigProviderImageSelection(
    settings,
    version,
    backend,
    image.providerBindingKeyHash,
  );
  if (structural.reason !== "selected") return structural.settings;
  let currentProviderBindingKeyHash: string | null = null;
  try {
    const binding = await resolveBinding(settings);
    currentProviderBindingKeyHash = rigProviderImageProviderBindingKeyHash(binding.key);
  } catch {
    // Provider identity is an authority check, not a reason to fail the turn.
    // Preserve the logical image so fresh creation and runtime setup remain the
    // truthful fallback when the identity lookup is unavailable.
  }
  return resolveRigProviderImageSelection(settings, version, backend, currentProviderBindingKeyHash)
    .settings;
}
