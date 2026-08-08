import type { Settings } from "@opengeni/config";
import type { CapabilityPack } from "@opengeni/contracts";

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
    // A rig image has no provider-native identity. Clear a lower-precedence
    // provider ID so it cannot silently select the wrong immutable image.
    modalImageId: undefined,
  };
}
