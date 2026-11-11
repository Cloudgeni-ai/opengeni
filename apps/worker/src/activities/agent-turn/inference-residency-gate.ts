import type { Settings } from "@opengeni/config";
import { isEuResidency } from "@opengeni/contracts";
import { isWorkspaceEuOnly, type Database } from "@opengeni/db";
import { InferenceRegionRestrictedError, resolveInferenceResidency } from "@opengeni/runtime";

/**
 * The worker's EU-only gate, run on every attempt right after the claim and
 * before any model call. The workspace's setting is read again, so a setting
 * turned on after the claim still applies. Returns the settings the attempt
 * must use from here on: under EU they carry `requiredModelGeography`, so
 * every resolution refuses a non-EU route and every client built from them
 * binds the requirement. The attempt's transport context is narrowed to the
 * same requirement (never widened).
 */
export async function settingsWithTurnInferenceResidency(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  settings: Settings;
  isEuOnly?: typeof isWorkspaceEuOnly;
}): Promise<Settings> {
  const euOnly =
    input.settings.requiredModelGeography === "eu" ||
    (await (input.isEuOnly ?? isWorkspaceEuOnly)(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    }));
  const settings: Settings =
    euOnly && input.settings.requiredModelGeography !== "eu"
      ? { ...input.settings, requiredModelGeography: "eu" }
      : input.settings;
  resolveInferenceResidency(settings);
  return settings;
}

/**
 * Under EU, refuse a turn whose resolved route is not EU, or that did not
 * resolve to a configured route at all (the legacy global client is never an
 * EU route). Resolution already refuses with these settings; this also
 * covers an injected runtime.
 */
export function assertTurnModelInferenceResidency(input: {
  settings: Pick<Settings, "requiredModelGeography">;
  resolvedModel: { configured: { residency?: unknown } } | null;
  productModelId: string;
}): void {
  if (input.settings.requiredModelGeography !== "eu") return;
  if (!input.resolvedModel || !isEuResidency(input.resolvedModel.configured.residency)) {
    throw new InferenceRegionRestrictedError(input.productModelId);
  }
}
