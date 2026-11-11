import {
  sideFeatureRouteAllowed,
  type CodeOwnedSideFeatureRouteId,
  type SideFeatureResidencySettings,
  type SideFeatureTarget,
} from "@opengeni/config";
import { REGION_RESTRICTED_MESSAGE } from "@opengeni/contracts";
import { isWorkspaceEuOnly, type Database } from "@opengeni/db";
import type { DocumentEmbedder } from "@opengeni/documents";

/**
 * Side-feature route checks that callers use before sending: kept apart from
 * the availability list, which builds the speech-to-text deployment, so a
 * feature such as Knowledge search does not load the voice providers.
 */

/** The route a Knowledge embedder sends texts to, with its endpoint. */
export function knowledgeEmbeddingTarget(
  embedder: Pick<DocumentEmbedder, "endpoint">,
): SideFeatureTarget {
  return { route: "knowledge.embeddings", endpoint: embedder.endpoint };
}

/** The unavailable reason for a code-owned route under these settings, or null when it may run. */
export function sideFeatureRouteUnavailableReason(
  settings: SideFeatureResidencySettings,
  route: CodeOwnedSideFeatureRouteId,
): typeof REGION_RESTRICTED_MESSAGE | null {
  return sideFeatureRouteAllowed(settings, route) ? null : REGION_RESTRICTED_MESSAGE;
}

/**
 * Whether a side-feature call for this workspace may use the route, for
 * calls that run outside a turn: the workspace's EU-only setting is read
 * (a failed read throws), and under EU only a route with an EU residency
 * record for the endpoint it calls passes.
 */
export async function sideFeatureAllowedForWorkspace(
  db: Database,
  settings: SideFeatureResidencySettings | undefined,
  scope: { accountId: string; workspaceId: string },
  target: SideFeatureTarget,
  isEuOnly: typeof isWorkspaceEuOnly = isWorkspaceEuOnly,
): Promise<boolean> {
  const euOnly = settings?.requiredModelGeography === "eu" || (await isEuOnly(db, scope));
  if (!euOnly) return true;
  return sideFeatureRouteAllowed({ ...settings, requiredModelGeography: "eu" }, target);
}
