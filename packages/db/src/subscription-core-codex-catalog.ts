/**
 * Codex readiness for catalog, default-model and admission reads on the
 * shared subscription core (M3 PR 3 review fix), under the names M3 shipped.
 *
 * After the drained cutover (0681) the legacy Codex tables are frozen and
 * their ciphertext is blank, so "is Codex ready in this workspace, and which
 * models may its connections serve?" must be answered from the core for an
 * organization with an enabled Codex cutover row. Callers decide by
 * `readCodexCutoverDisposition` (or `readCodexCutoverDispositionForWorkspace`):
 * a disabled row reports Codex as not ready (fail closed) without reading a
 * legacy table, and an enabled row reads only the provider-neutral serving
 * set (`subscription-core/catalog`), which this module binds to Codex.
 */
import type { Database } from "./database";
import {
  listSubscriptionCoreServingConnections,
  readSubscriptionCoreCutoverDispositionForWorkspace,
  subscriptionCoreConnectionAllowlist,
  subscriptionCoreConnectionAllowsModel,
  subscriptionCoreWorkspaceReady,
  type SubscriptionCoreServingConnection,
} from "./subscription-core/catalog";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";
import type { CodexCutoverDisposition } from "./subscription-core-codex-compat";

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
 * The cutover disposition for a workspace whose organization the caller does
 * not hold. One extra workspace-to-organization lookup.
 */
export async function readCodexCutoverDispositionForWorkspace(
  db: Database,
  workspaceId: string,
  accountId?: string | null,
): Promise<{ accountId: string; disposition: CodexCutoverDisposition }> {
  return await readSubscriptionCoreCutoverDispositionForWorkspace(
    db,
    SUBSCRIPTION_CORE_CODEX,
    workspaceId,
    accountId,
  );
}

/**
 * The core Codex connections that can serve new work of `subjectId` in this
 * workspace. Empty without an enabled cutover. A null or non-human subject
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
 * this subject here. False without an enabled cutover.
 */
export async function subscriptionCoreCodexWorkspaceReady(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
): Promise<boolean> {
  return await subscriptionCoreWorkspaceReady(db, SUBSCRIPTION_CORE_CODEX, input);
}
