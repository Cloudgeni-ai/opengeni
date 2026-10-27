import {
  SIDE_FEATURE_ROUTE_IDS,
  sideFeatureRouteAllowed,
  sideFeatureRouteFeatures,
  type SideFeatureResidencySettings,
  type SideFeatureRouteId,
} from "@opengeni/config";
import {
  INFERENCE_FEATURE_IDS,
  REGION_RESTRICTED,
  REGION_RESTRICTED_MESSAGE,
  type InferenceFeatureAvailability,
  type InferenceFeatureId,
} from "@opengeni/contracts";
import { isWorkspaceEuOnly, type Database } from "@opengeni/db";

/**
 * Whether EU-only inference leaves this feature a route: without the EU
 * requirement always, under it only when one of the feature's routes has an
 * EU residency record. This is the region answer only; whether the feature
 * is configured at all is reported where it always was.
 */
export function inferenceFeatureRegionAllowed(
  settings: SideFeatureResidencySettings,
  feature: InferenceFeatureId,
): boolean {
  if (settings.requiredModelGeography !== "eu") return true;
  return SIDE_FEATURE_ROUTE_IDS.some(
    (route) =>
      sideFeatureRouteFeatures(route).includes(feature) && sideFeatureRouteAllowed(settings, route),
  );
}

/**
 * Every side feature's region availability for settings already narrowed
 * with `settingsWithInferenceResidency`: the one list clients read to show
 * "Not supported in EU".
 */
export function inferenceFeatureAvailability(
  settings: SideFeatureResidencySettings,
): InferenceFeatureAvailability[] {
  return INFERENCE_FEATURE_IDS.map((id) => {
    const available = inferenceFeatureRegionAllowed(settings, id);
    return { id, available, unavailableReason: available ? null : REGION_RESTRICTED };
  });
}

/** The unavailable reason for a route under these settings, or null when it may run. */
export function sideFeatureRouteUnavailableReason(
  settings: SideFeatureResidencySettings,
  route: SideFeatureRouteId,
): typeof REGION_RESTRICTED_MESSAGE | null {
  return sideFeatureRouteAllowed(settings, route) ? null : REGION_RESTRICTED_MESSAGE;
}

/**
 * Whether a side-feature call for this workspace may use the route, for
 * calls that run outside a turn: the workspace's EU-only setting is read
 * (a failed read throws), and under EU only a route with an EU residency
 * record passes.
 */
export async function sideFeatureAllowedForWorkspace(
  db: Database,
  settings: SideFeatureResidencySettings | undefined,
  scope: { accountId: string; workspaceId: string },
  route: SideFeatureRouteId,
  isEuOnly: typeof isWorkspaceEuOnly = isWorkspaceEuOnly,
): Promise<boolean> {
  const euOnly = settings?.requiredModelGeography === "eu" || (await isEuOnly(db, scope));
  if (!euOnly) return true;
  return sideFeatureRouteAllowed({ ...settings, requiredModelGeography: "eu" }, route);
}
