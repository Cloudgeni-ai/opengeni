import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import { SUBSCRIPTION_CORE_CODEX_PROVIDER } from "./subscription-core-codex-provider";
import {
  getSubscriptionCoreModelConnectionAccess,
  ModelConnectionWorkspaceNotInOrganizationError,
  readSubscriptionCoreModelConnectionAccess,
  updateSubscriptionCoreModelConnectionAccess,
  withModelConnectionAccessScope,
  type ModelConnectionAccess,
} from "./subscription-core/access-editor";
import type { SubscriptionCoreAccess } from "./subscription-core/access";

// The policy shape, its errors and the route scope are shared with the
// provider-neutral core editor; the public names stay exported from here.
export {
  ModelConnectionAccessForbiddenError,
  ModelConnectionWorkspaceNotInOrganizationError,
  type ModelConnectionAccess,
} from "./subscription-core/access-editor";

export type ModelConnectionKind =
  | "codex"
  | "supergrok"
  | "vercel_gateway"
  | "openrouter"
  | "anthropic"
  | "claude_subscription"
  | "opper";
export type ModelConnectionTarget = {
  accountId: string;
  workspaceId: string | null;
  subjectId: string;
  kind: ModelConnectionKind;
  connectionId: string;
};

export function connectionModelAllowed(
  allowedModels: readonly string[] | null | undefined,
  modelId: string,
): boolean {
  return allowedModels == null || allowedModels.includes(modelId);
}

/**
 * Replace a default only when it is outside the assigned pool. An assigned
 * paused/unhealthy default remains explicit intent: rotation-off must wait,
 * not silently change the billed subscription. Allocation checks health later.
 */
export function assignedConnectionDefault(
  preferred: string | null,
  accounts: readonly { id: string; status: string; allocatorEnabled: boolean }[],
): string | null {
  return accounts.some((account) => account.id === preferred)
    ? preferred
    : (accounts.find((account) => account.status === "active" && account.allocatorEnabled)?.id ??
        null);
}

function relation(target: ModelConnectionTarget): { table: SQLWrapper; condition: SQL } {
  if (target.kind === "codex") throw new Error("Codex access policies use the shared core");
  if (target.kind === "supergrok" || target.kind === "claude_subscription")
    return {
      table: sql.identifier(
        target.kind === "supergrok"
          ? "xai_subscription_credentials"
          : "claude_subscription_credentials",
      ),
      condition: sql`id = ${target.connectionId}::uuid AND account_id = ${target.accountId}::uuid AND ${
        target.workspaceId === null
          ? sql`authority_scope = 'organization'`
          : sql`workspace_id = ${target.workspaceId}::uuid AND authority_scope <> 'organization'`
      }`,
    };
  if (target.workspaceId === null)
    return {
      table: sql.identifier("organization_model_provider_connections"),
      condition: sql`account_id = ${target.accountId}::uuid AND provider_kind = ${target.kind} AND status = 'active'
        AND ${target.connectionId === "current" ? sql`true` : sql`id::text = ${target.connectionId}`}`,
    };
  return {
    table: sql.identifier("connections"),
    condition: sql`account_id = ${target.accountId}::uuid AND workspace_id = ${target.workspaceId}::uuid
      AND id = ${target.connectionId}::uuid AND subject_id IS NULL AND kind = 'api_key' AND status = 'active'
      AND metadata->>'credentialRole' = ${target.kind === "vercel_gateway" ? "vercel_ai_gateway" : target.kind}
      ${target.kind === "anthropic" ? sql`AND lower(provider_domain) = 'api.anthropic.com'` : sql``}
      ${target.kind === "opper" ? sql`AND lower(provider_domain) = 'api.opper.ai'` : sql``}`,
  };
}

export async function getModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  if (target.kind === "codex")
    return await getSubscriptionCoreCodexModelConnectionAccess(db, target);
  return await withModelConnectionAccessScope(db, target, async (tx) => {
    const { table, condition } = relation(target);
    const [row] = await rawRows<ModelConnectionAccess>(
      tx,
      sql`SELECT
      allowed_model_ids AS "allowedModels", allowed_workspace_ids AS "allowedWorkspaces",
      allow_personal_workspaces AS "allowPersonalWorkspaces", access_policy_version AS version
      FROM ${table} WHERE ${condition} LIMIT 1`,
    );
    return row ?? null;
  });
}

/**
 * A shared Codex connection's access on the shared subscription core, with
 * the workspaces that use it as their own and its delegated manager.
 */
export async function readSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<SubscriptionCoreAccess | null> {
  if (target.kind !== "codex") throw new Error("Only Codex connections are read from the core");
  return await readSubscriptionCoreModelConnectionAccess(
    db,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    target,
  );
}

/** A shared Codex connection's access policy on the shared subscription core. */
export async function getSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  if (target.kind !== "codex") throw new Error("Only Codex connections are read from the core");
  return await getSubscriptionCoreModelConnectionAccess(
    db,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    target,
  );
}

/** Save what a shared Codex connection serves on the core. */
export async function updateSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  if (target.kind !== "codex") throw new Error("Only Codex connections are written to the core");
  return await updateSubscriptionCoreModelConnectionAccess(
    db,
    SUBSCRIPTION_CORE_CODEX_PROVIDER,
    target,
    policy,
  );
}

export async function updateModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  if (target.kind === "codex") return null;
  if (policy.allowedPeople != null)
    throw new Error("Only accounts on the shared subscription core can be limited to people");
  return await withModelConnectionAccessScope(db, target, async (tx) => {
    const { table, condition } = relation(target);
    if (target.workspaceId !== null && policy.allowedWorkspaces !== null)
      throw new Error("Workspace connections cannot assign other workspaces");
    if (target.workspaceId === null && policy.allowedWorkspaces !== null) {
      const allowed = await rawRows<{ workspace_id: string }>(
        tx,
        sql`select workspace_id from list_organization_workspace_ids(${target.accountId}::uuid)`,
      );
      const ids = new Set(allowed.map((row) => row.workspace_id));
      if (policy.allowedWorkspaces.some((id) => !ids.has(id)))
        throw new ModelConnectionWorkspaceNotInOrganizationError();
    }
    const [row] = await rawRows<ModelConnectionAccess>(
      tx,
      sql`UPDATE ${table} SET
      allowed_model_ids = ${policy.allowedModels === null ? sql`NULL` : sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(policy.allowedModels)}::jsonb))`}, allowed_workspace_ids = ${policy.allowedWorkspaces === null ? sql`NULL` : sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(policy.allowedWorkspaces)}::jsonb)::uuid)`},
      allow_personal_workspaces = ${policy.allowPersonalWorkspaces}, access_policy_version = access_policy_version + 1,
      access_policy_updated_by = ${target.subjectId}, access_policy_updated_at = now()
      WHERE ${condition} AND access_policy_version = ${policy.version}
      RETURNING allowed_model_ids AS "allowedModels", allowed_workspace_ids AS "allowedWorkspaces",
        allow_personal_workspaces AS "allowPersonalWorkspaces", access_policy_version AS version`,
    );
    return row ?? null;
  });
}
