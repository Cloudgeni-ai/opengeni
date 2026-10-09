import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  withRlsContext,
  withWorkspaceSubjectRls,
  setSubjectRlsContext,
  rawRows,
  type Database,
} from "./database";

export type ModelConnectionKind =
  | "codex"
  | "supergrok"
  | "vercel_gateway"
  | "openrouter"
  | "anthropic"
  | "claude_subscription"
  | "opper";
export type ModelConnectionAccess = {
  allowedModels: string[] | null;
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  version: number;
};
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
  if (
    target.kind === "codex" ||
    target.kind === "supergrok" ||
    target.kind === "claude_subscription"
  )
    return {
      table: sql.identifier(
        target.kind === "codex"
          ? "codex_subscription_credentials"
          : target.kind === "supergrok"
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

async function scoped<T>(
  db: Database,
  target: ModelConnectionTarget,
  use: (db: Database) => Promise<T>,
) {
  if (target.workspaceId !== null)
    return await withWorkspaceSubjectRls(db, target.workspaceId, target.subjectId, use);
  return await withRlsContext(
    db,
    { accountId: target.accountId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, target.subjectId);
      await tx.execute(
        sql`select get_organization_administration_overview(${target.accountId}::uuid, ${target.subjectId})`,
      );
      return await use(tx);
    },
  );
}

export async function getModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  return await scoped(db, target, async (tx) => {
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
 * A shared Codex connection's access policy on the shared subscription core
 * (M3 PR 3), in the legacy shape, for an organization whose Codex cutover is
 * enabled. The organization route reads an organization-managed connection
 * (as the legacy organization-authority row), the workspace route one that
 * workspace manages. `allowedWorkspaces` is the enumerated workspace scope
 * (null for organization scope). Read-only: the core has no access-policy
 * writer yet (the scope editor is M5), so callers refuse writes.
 */
export async function getSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  if (target.kind !== "codex") throw new Error("Only Codex connections are read from the core");
  return await scoped(db, target, async (tx) => {
    const [row] = await rawRows<ModelConnectionAccess>(
      tx,
      sql`select connection.allowed_model_ids as "allowedModels",
          case when connection.scope_kind = 'organization' then null
            else array(select assignment.workspace_id::text
              from subscription_connection_workspaces assignment
              where assignment.account_id = connection.account_id
                and assignment.connection_id = connection.id
              order by assignment.workspace_id) end as "allowedWorkspaces",
          connection.allow_personal_workspaces as "allowPersonalWorkspaces",
          connection.version
        from subscription_connections connection
        where connection.account_id = ${target.accountId}::uuid
          and connection.id = ${target.connectionId}::uuid
          and connection.provider = 'codex' and connection.kind = 'subscription'
          and connection.ownership = 'shared'
          and ${
            target.workspaceId === null
              ? sql`connection.managed_by_workspace_id is null`
              : sql`connection.managed_by_workspace_id = ${target.workspaceId}::uuid`
          }
        limit 1`,
    );
    return row ?? null;
  });
}

export async function updateModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  return await scoped(db, target, async (tx) => {
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
        throw new Error("A selected workspace is not in this organization");
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
