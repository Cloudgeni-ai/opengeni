/**
 * Codex readiness for catalog, default-model and admission reads on the
 * shared subscription core: "is Codex ready in this workspace, and which
 * models may its connections serve?", answered from the provider-neutral
 * serving set (`subscription-core/catalog`) bound to Codex.
 */
import type { Database } from "./database";
import {
  listSubscriptionCoreServingConnections,
  subscriptionCoreConnectionAllowlist,
  subscriptionCoreConnectionAllowsModel,
  subscriptionCoreWorkspaceReady,
  type SubscriptionCoreServingConnection,
} from "./subscription-core/catalog";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";

export type SubscriptionCoreCodexServingConnection = SubscriptionCoreServingConnection;

/** Placement's static model admission for one connection (allowlists and exclusions). */
export const subscriptionCoreCodexConnectionAllowsModel = subscriptionCoreConnectionAllowsModel;

/**
 * The connection's admitted models as one allowlist (null: every model), for
 * the catalog's per-provider restriction union. Exclusions without an
 * allowlist cannot be listed; placement still refuses those models.
 */
export const subscriptionCoreCodexConnectionAllowlist = subscriptionCoreConnectionAllowlist;

/**
 * The core Codex connections that can serve new work of `subjectId` in this
 * workspace. A null or non-human subject
 * sees shared capacity only.
 */
export async function listSubscriptionCoreCodexServingConnections(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
  now: Date = new Date(),
): Promise<SubscriptionCoreCodexServingConnection[]> {
  return await listSubscriptionCoreServingConnections(db, SUBSCRIPTION_CORE_CODEX, input, now);
}

/**
 * Codex readiness on the core: at least one connection can serve new work of
 * this subject here.
 */
export async function subscriptionCoreCodexWorkspaceReady(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
): Promise<boolean> {
  return await subscriptionCoreWorkspaceReady(db, SUBSCRIPTION_CORE_CODEX, input);
}
