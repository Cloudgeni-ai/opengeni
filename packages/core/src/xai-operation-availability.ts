import type { Settings } from "@opengeni/config";
import {
  readSubscriptionCoreProviderRouteForWorkspace,
  SUBSCRIPTION_CORE_XAI,
  SUBSCRIPTION_CORE_XAI_PROVIDER,
  subscriptionCoreOperationConnections,
  type Database,
} from "@opengeni/db";

/**
 * Whether SuperGrok can serve a workspace-level operation (video funding,
 * realtime catalog, transcription): "a shared xAI candidate exists for
 * this workspace" on the shared core, organization- or workspace-scoped
 * shared connections only, never the viewer's personal accounts (design 5.3,
 * EP-N11). Any route other than `core` (maintenance, or no receipt, which
 * this binary's readiness check refuses) serves nothing.
 */
export async function workspaceXaiOperationAvailable(
  db: Database,
  settings: Settings,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  const route = await readSubscriptionCoreProviderRouteForWorkspace(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    provider: SUBSCRIPTION_CORE_XAI_PROVIDER,
  });
  if (route !== "core" || !settings.supergrokSubscriptionEnabled) return false;
  const candidates = await subscriptionCoreOperationConnections(
    SUBSCRIPTION_CORE_XAI,
  ).listSubscriptionCoreOperationCandidates(db, { kind: "workspace", ...input });
  return candidates.length > 0;
}
