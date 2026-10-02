import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  normalizeOrganizationAccessPolicy,
  type OrganizationWorkspaceScope,
  type Permission,
} from "@opengeni/contracts";
import { rawRows, withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export class OrganizationApiKeyWorkspaceScopeError extends Error {
  constructor() {
    super("Selected workspaces must belong to this organization and be shared workspaces");
    this.name = "OrganizationApiKeyWorkspaceScopeError";
  }
}

/** Caller already holds the organization key row lock through commit. */
export function organizationApiKeyWorkspaceAllowedSql(
  accountId: string,
  workspaceId: string,
  key: { id: SQL; workspaceScope: SQL },
): SQL {
  return sql`exists(select 1 from workspaces w
    where w.id = ${workspaceId}::uuid and w.account_id = ${accountId}::uuid
      and get_workspace_kind(w.account_id, w.id) = 'shared'
      and (${key.workspaceScope} = 'all' or exists(
        select 1 from organization_api_key_workspaces s
        where s.api_key_id = ${key.id} and s.account_id = w.account_id and s.workspace_id = w.id)))`;
}

/** Resolve scope only after locking the key: a predicate evaluated while
 * waiting for that lock could otherwise use a pre-narrowing statement snapshot. */
export async function organizationApiKeyAllowsWorkspace(
  tx: Database,
  key: Pick<typeof schema.apiKeys.$inferSelect, "id" | "accountId" | "workspaceScope">,
  workspaceId: string,
): Promise<boolean> {
  return withRlsContext(tx, { accountId: key.accountId, workspaceId }, async (scoped) => {
    const [row] = await rawRows<{ allowed: boolean }>(
      scoped,
      sql`select ${organizationApiKeyWorkspaceAllowedSql(key.accountId, workspaceId, {
        id: sql`${key.id}::uuid`,
        workspaceScope: sql`${key.workspaceScope}`,
      })} as allowed`,
    );
    return row?.allowed === true;
  });
}

export async function validateOrganizationApiKeyWorkspaceScope(
  tx: Database,
  accountId: string,
  scope: OrganizationWorkspaceScope,
): Promise<void> {
  if (scope.kind === "all") return;
  const rows = await tx
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.accountId, accountId),
        inArray(schema.workspaces.id, scope.workspaceIds),
      ),
    )
    .orderBy(schema.workspaces.id)
    .for("key share");
  if (rows.length !== scope.workspaceIds.length) throw new OrganizationApiKeyWorkspaceScopeError();
  for (const row of rows) {
    const shared = await withRlsContext(tx, { accountId, workspaceId: row.id }, async (scoped) => {
      const [kind] = await rawRows<{ kind: string }>(
        scoped,
        sql`select get_workspace_kind(${accountId}::uuid, ${row.id}::uuid) as kind`,
      );
      return kind?.kind === "shared";
    });
    if (!shared) throw new OrganizationApiKeyWorkspaceScopeError();
  }
}

export async function replaceOrganizationApiKeyWorkspaceScope(
  tx: Database,
  accountId: string,
  apiKeyId: string,
  scope: OrganizationWorkspaceScope,
): Promise<void> {
  await tx
    .delete(schema.organizationApiKeyWorkspaces)
    .where(
      and(
        eq(schema.organizationApiKeyWorkspaces.accountId, accountId),
        eq(schema.organizationApiKeyWorkspaces.apiKeyId, apiKeyId),
      ),
    );
  if (scope.kind === "selected")
    await tx
      .insert(schema.organizationApiKeyWorkspaces)
      .values(scope.workspaceIds.map((workspaceId) => ({ accountId, apiKeyId, workspaceId })));
}

export async function readOrganizationApiKeyWorkspaceScopes(
  tx: Database,
  rows: (typeof schema.apiKeys.$inferSelect)[],
): Promise<Map<string, string[]>> {
  const selected = rows.filter(
    (row) => row.credentialKind === "organization" && row.workspaceScope === "selected",
  );
  const result = new Map<string, string[]>();
  // Every call site is account scoped, including the exact hash authentication
  // lane. Keep the account predicate explicit rather than relying only on RLS.
  for (const accountId of new Set(selected.map((row) => row.accountId))) {
    const scopes = await tx
      .select()
      .from(schema.organizationApiKeyWorkspaces)
      .where(
        and(
          eq(schema.organizationApiKeyWorkspaces.accountId, accountId),
          inArray(
            schema.organizationApiKeyWorkspaces.apiKeyId,
            selected.filter((row) => row.accountId === accountId).map((row) => row.id),
          ),
        ),
      )
      .orderBy(schema.organizationApiKeyWorkspaces.workspaceId);
    for (const scope of scopes) {
      const ids = result.get(scope.apiKeyId) ?? [];
      ids.push(scope.workspaceId);
      result.set(scope.apiKeyId, ids);
    }
  }
  return result;
}

export function organizationApiKeyPolicyProjection(
  row: typeof schema.apiKeys.$inferSelect,
  workspaceIds: string[] = [],
) {
  if (row.credentialKind !== "organization") return {};
  const workspaceScope: OrganizationWorkspaceScope =
    row.workspaceScope === "selected" ? { kind: "selected", workspaceIds } : { kind: "all" };
  // The deferred scope lifecycle revokes empty selected keys at commit. Do
  // not publish an invalid transient selected set or rewrite legacy storage.
  const normalized = normalizeOrganizationAccessPolicy({
    preset: "custom",
    permissions: row.permissions as Permission[],
    workspaceScope,
  });
  return {
    permissionMode: row.permissionMode,
    workspaceScope,
    policy: normalized,
  };
}
