import { inferenceFeatureRegionAllowed, settingsWithInferenceResidency } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";

/**
 * EU-only inference for voice input: true when the workspace is EU-only and
 * no speech-to-text route here has an EU residency record, so the request is
 * refused with `region_restricted` before any audio is read or sent.
 */
export async function voiceInputRegionRestricted(
  deps: Pick<ApiRouteDeps, "db" | "settings">,
  scope: { accountId: string; workspaceId: string },
): Promise<boolean> {
  const settings = await settingsWithInferenceResidency(deps.db, {
    ...scope,
    settings: deps.settings,
  });
  return !inferenceFeatureRegionAllowed(settings, "voice_input");
}
