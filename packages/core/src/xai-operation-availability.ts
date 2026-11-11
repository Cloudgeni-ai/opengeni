import type { Settings } from "@opengeni/config";
import {
  SUBSCRIPTION_CORE_XAI,
  subscriptionCoreOperationConnections,
  type Database,
} from "@opengeni/db";

/**
 * Whether SuperGrok can serve a workspace-level operation (video funding,
 * realtime catalog, transcription): "a shared xAI candidate exists for
 * this workspace" on the shared core, organization- or workspace-scoped
 * shared connections only, never the viewer's personal accounts (design 5.3,
 * EP-N11).
 */
export async function workspaceXaiOperationAvailable(
  db: Database,
  settings: Settings,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  if (!settings.supergrokSubscriptionEnabled) return false;
  const candidates = await subscriptionCoreOperationConnections(
    SUBSCRIPTION_CORE_XAI,
  ).listSubscriptionCoreOperationCandidates(db, { kind: "workspace", ...input });
  return candidates.length > 0;
}
