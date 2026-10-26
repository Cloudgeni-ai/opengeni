import type { Settings } from "@opengeni/config";
import { isEuResidency } from "@opengeni/contracts";
import { isWorkspaceEuOnly, type Database } from "@opengeni/db";
import { InferenceRegionRestrictedError, resolveInferenceResidency } from "@opengeni/runtime";

/**
 * The worker's EU-only gate, run on every attempt before any model call. The
 * workspace's setting is read again (a setting turned on after the claim
 * still applies). Under EU the attempt's transport context is narrowed to EU
 * routes for the rest of the attempt, and a turn whose live route is not EU,
 * or did not resolve to a configured route, is refused.
 */
export async function assertTurnInferenceResidency(input: {
  db: Database;
  accountId: string;
  workspaceId: string;
  settings: Settings;
  resolvedModel: { configured: { residency?: unknown } } | null;
  productModelId: string;
  isEuOnly?: typeof isWorkspaceEuOnly;
}): Promise<void> {
  const euOnly =
    input.settings.requiredModelGeography === "eu" ||
    (await (input.isEuOnly ?? isWorkspaceEuOnly)(input.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
    }));
  if (!euOnly) return;
  resolveInferenceResidency({ ...input.settings, requiredModelGeography: "eu" });
  if (!input.resolvedModel || !isEuResidency(input.resolvedModel.configured.residency)) {
    throw new InferenceRegionRestrictedError(input.productModelId);
  }
}
