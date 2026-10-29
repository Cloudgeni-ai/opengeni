import type { ClientConfig, InferenceFeatureId } from "@opengeni/sdk";
import type { OpenGeniText } from "./messages/runtime";

/**
 * EU-only inference in the UI. The server decides what an EU-only workspace
 * can use from its residency records and reports anything switched off with
 * the reason `region_restricted`: on models (`availability.reason`), live
 * voice models (`unavailableCode`), transcription models and errors, agent
 * capabilities, and every model-backed feature in
 * `ClientConfig.inferenceFeatures`. Each surface passes the reason it got
 * through here, so they all say "Not supported in EU". Nothing here reads a
 * model's or provider's name.
 */
export const REGION_RESTRICTED = "region_restricted";

/**
 * The text agent capabilities carry as their reason (`ClientAgentConfig`),
 * which has no code; the server writes this exact text.
 */
const REGION_RESTRICTED_SERVER_TEXT = "Not supported in EU";

/** Whether a reason the server reported means "switched off for EU-only". */
export function isRegionRestricted(reason: string | null | undefined): boolean {
  return reason === REGION_RESTRICTED || reason === REGION_RESTRICTED_SERVER_TEXT;
}

/** "Not supported in EU" for a region restriction, otherwise null. */
export function regionRestrictedText(
  t: OpenGeniText,
  reason: string | null | undefined,
): string | null {
  return isRegionRestricted(reason) ? t("inferenceRegion.notSupportedInEu") : null;
}

/**
 * "Not supported in EU" when the server switched this feature off for the
 * workspace, otherwise null. Older servers don't report features: null.
 */
export function inferenceFeatureRestriction(
  t: OpenGeniText,
  config: Pick<ClientConfig, "inferenceFeatures"> | null | undefined,
  feature: InferenceFeatureId,
): string | null {
  const entry = config?.inferenceFeatures?.find((candidate) => candidate.id === feature);
  if (!entry || entry.available) return null;
  return regionRestrictedText(t, entry.unavailableReason);
}
