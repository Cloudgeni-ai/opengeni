import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import {
  withRlsContext,
  withWorkspaceSubjectRls,
  setSubjectRlsContext,
  rawRows,
  type Database,
} from "./database";
import { resolveSubscriptionConnectionId } from "./subscription-core-repository";

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

/** A requested access policy names a workspace outside the organization's shared workspaces. */
export class ModelConnectionWorkspaceNotInOrganizationError extends Error {
  constructor() {
    super("A selected workspace is not in this organization");
    this.name = "ModelConnectionWorkspaceNotInOrganizationError";
  }
}

/** The viewer can read a connection's access but may not change it. */
export class ModelConnectionAccessForbiddenError extends Error {
  constructor() {
    super("You can't change what this account serves");
    this.name = "ModelConnectionAccessForbiddenError";
  }
}

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
  if (target.kind === "codex")
    return await getSubscriptionCoreCodexModelConnectionAccess(db, target);
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

type CoreCodexAccessRow = {
  id: string;
  allowed_model_ids: string[] | null;
  scope_kind: "organization" | "workspaces" | "people";
  allow_personal_workspaces: boolean;
  allocator_enabled: boolean;
  access_version: number | string;
};

/** The shared Codex connection the route may edit: organization-managed or this workspace's. */
async function coreCodexAccessConnection(
  tx: Database,
  target: ModelConnectionTarget,
  lock: boolean,
): Promise<CoreCodexAccessRow | null> {
  const connectionId = await resolveSubscriptionConnectionId(tx, {
    accountId: target.accountId,
    provider: "codex",
    connectionId: target.connectionId,
  });
  if (!connectionId) return null;
  const [row] = await rawRows<CoreCodexAccessRow>(
    tx,
    sql`select connection.id::text as id, connection.allowed_model_ids, connection.scope_kind,
        connection.allow_personal_workspaces, connection.allocator_enabled, connection.access_version
      from subscription_connections connection
      where connection.account_id = ${target.accountId}::uuid
        and connection.id = ${connectionId}::uuid
        and connection.provider = 'codex' and connection.kind = 'subscription'
        and connection.ownership = 'shared' and connection.disconnected_at is null
        and ${
          target.workspaceId === null
            ? sql`connection.managed_by_workspace_id is null`
            : sql`connection.managed_by_workspace_id = ${target.workspaceId}::uuid`
        }
      ${lock ? sql`for update` : sql``}`,
  );
  return row ?? null;
}

async function organizationSharedWorkspaceIds(tx: Database, accountId: string) {
  const rows = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select workspace_id::text as workspace_id
      from list_organization_workspace_ids(${accountId}::uuid)`,
  );
  return new Set(rows.map((row) => row.workspace_id));
}

async function coreCodexAccessPolicy(
  tx: Database,
  target: ModelConnectionTarget,
  connection: CoreCodexAccessRow,
): Promise<ModelConnectionAccess> {
  const version = Number(connection.access_version);
  // A workspace's own account is never offered to other workspaces.
  if (target.workspaceId !== null)
    return {
      allowedModels: connection.allowed_model_ids,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: false,
      version,
    };
  if (connection.scope_kind === "organization")
    return {
      allowedModels: connection.allowed_model_ids,
      allowedWorkspaces: null,
      allowPersonalWorkspaces: true,
      version,
    };
  const [reach] = await rawRows<{
    reach: { sharedWorkspaces: boolean; personalWorkspaces: boolean } | null;
  }>(
    tx,
    sql`select opengeni_private.subscription_codex_reach(
      ${target.accountId}::uuid, ${connection.id}::uuid) as reach`,
  );
  let allowedWorkspaces: string[] | null = null;
  if (!reach?.reach?.sharedWorkspaces) {
    // Personal workspaces are listed too (their assignment is what admits
    // them); the policy shape names only shared workspaces.
    const shared = await organizationSharedWorkspaceIds(tx, target.accountId);
    // A workspace assigned only for its own local copy is not an
    // organization-pool choice: without a policy row the organization pool
    // serves it, otherwise only an organization-pool row does.
    const listed = await rawRows<{ workspace_id: string }>(
      tx,
      sql`select assignment.workspace_id::text as workspace_id
        from subscription_connection_workspaces assignment
        where assignment.account_id = ${target.accountId}::uuid
          and assignment.connection_id = ${connection.id}::uuid
          and (exists (select 1 from subscription_connection_assignment_policies policy
              where policy.account_id = assignment.account_id
                and policy.connection_id = assignment.connection_id
                and policy.workspace_id = assignment.workspace_id
                and policy.inference_pool = 'organization')
            or not exists (select 1 from subscription_connection_assignment_policies policy
              where policy.account_id = assignment.account_id
                and policy.connection_id = assignment.connection_id
                and policy.workspace_id = assignment.workspace_id))
        order by assignment.workspace_id`,
    );
    allowedWorkspaces = listed.map((row) => row.workspace_id).filter((id) => shared.has(id));
  }
  return {
    allowedModels: connection.allowed_model_ids,
    allowedWorkspaces,
    allowPersonalWorkspaces: connection.allow_personal_workspaces,
    version,
  };
}

/**
 * A shared Codex connection's access policy on the shared subscription core,
 * in the legacy shape. The organization route reads an organization-managed
 * connection, the workspace route one that workspace manages.
 * `allowedWorkspaces` is null when every shared workspace, including ones
 * created later, may use it.
 */
export async function getSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
): Promise<ModelConnectionAccess | null> {
  if (target.kind !== "codex") throw new Error("Only Codex connections are read from the core");
  return await scoped(db, target, async (tx) => {
    const connection = await coreCodexAccessConnection(tx, target, false);
    return connection ? await coreCodexAccessPolicy(tx, target, connection) : null;
  });
}

function textArray(values: readonly string[] | null) {
  return values === null
    ? sql`null::text[]`
    : sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;
}

function uuidArray(values: Iterable<string>) {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify([...values])}::jsonb)::uuid)`;
}

/**
 * Save what a shared Codex connection serves on the core. Null when the
 * connection is gone or its access changed since `policy.version` was read.
 *
 * At organization scope the connection's scope, its workspace assignments,
 * the organization-pool policy rows and the reach for workspaces created later
 * change together, in one transaction:
 * - every shared and Personal workspace: `organization` scope;
 * - otherwise `workspaces` scope over the chosen shared workspaces (all of
 *   today's when the choice is "all, including new ones") plus every Personal
 *   workspace when they are allowed, with the reach kept for later ones.
 * A workspace's own local copy (its workspace-pool row) is never removed. In
 * a workspace, only the models of the account that workspace manages change.
 */
export async function updateSubscriptionCoreCodexModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  if (target.kind !== "codex") throw new Error("Only Codex connections are written to the core");
  if (target.workspaceId !== null && policy.allowedWorkspaces !== null)
    throw new Error("Workspace connections cannot assign other workspaces");
  return await scoped(db, target, async (tx) => {
    const current = await coreCodexAccessConnection(tx, target, true);
    if (!current) {
      // Locking needs the write policy: a readable row it hides is a refusal.
      if (await coreCodexAccessConnection(tx, target, false))
        throw new ModelConnectionAccessForbiddenError();
      return null;
    }
    if (Number(current.access_version) !== policy.version) return null;
    const id = current.id;
    const models = textArray(policy.allowedModels);
    if (target.workspaceId !== null) {
      const [updated] = await rawRows<CoreCodexAccessRow>(
        tx,
        sql`update subscription_connections set allowed_model_ids = ${models},
            access_version = access_version + 1, updated_at = clock_timestamp()
          where account_id = ${target.accountId}::uuid and id = ${id}::uuid
          returning id::text as id, allowed_model_ids, scope_kind, allow_personal_workspaces,
            allocator_enabled, access_version`,
      );
      if (!updated) return null;
      await tx.execute(sql`update subscription_connection_assignment_policies
        set allowed_model_ids = ${models}, updated_at = clock_timestamp()
        where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
          and workspace_id = ${target.workspaceId}::uuid and inference_pool = 'workspace'`);
      return await coreCodexAccessPolicy(tx, target, updated);
    }

    const shared = await organizationSharedWorkspaceIds(tx, target.accountId);
    if (policy.allowedWorkspaces?.some((workspaceId) => !shared.has(workspaceId)))
      throw new ModelConnectionWorkspaceNotInOrganizationError();
    const accountWorkspaces = await rawRows<{ id: string }>(
      tx,
      sql`select id::text as id from workspaces where account_id = ${target.accountId}::uuid`,
    );
    const personal = accountWorkspaces
      .map((row) => row.id)
      .filter((workspaceId) => !shared.has(workspaceId));
    const organizationScope = policy.allowedWorkspaces === null && policy.allowPersonalWorkspaces;
    // A workspace with its own local copy stays assigned whatever the
    // organization chooses, so that copy keeps working.
    const local = (
      await rawRows<{ workspace_id: string }>(
        tx,
        sql`select workspace_id::text as workspace_id
          from subscription_connection_assignment_policies
          where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
            and inference_pool = 'workspace'`,
      )
    ).map((row) => row.workspace_id);
    // Organization scope admits every workspace; only a workspace that also
    // has its own local copy needs explicit rows for both pools.
    const desired = new Set(
      organizationScope
        ? local
        : [
            ...(policy.allowedWorkspaces ?? shared),
            ...(policy.allowPersonalWorkspaces ? personal : []),
          ],
    );
    const [updated] = await rawRows<CoreCodexAccessRow>(
      tx,
      sql`update subscription_connections set allowed_model_ids = ${models},
          scope_kind = ${organizationScope ? "organization" : "workspaces"},
          allow_personal_workspaces = ${policy.allowPersonalWorkspaces},
          access_version = access_version + 1, updated_at = clock_timestamp()
        where account_id = ${target.accountId}::uuid and id = ${id}::uuid
        returning id::text as id, allowed_model_ids, scope_kind, allow_personal_workspaces,
          allocator_enabled, access_version`,
    );
    if (!updated) return null;
    const keep = uuidArray(desired);
    const assigned = uuidArray(new Set([...desired, ...local]));
    await tx.execute(sql`delete from subscription_connection_assignment_policies
      where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
        and inference_pool = 'organization' and managed_by_workspace_id is null
        and workspace_id <> all(${keep})`);
    await tx.execute(sql`delete from subscription_connection_workspaces assignment
      where assignment.account_id = ${target.accountId}::uuid
        and assignment.connection_id = ${id}::uuid
        and assignment.workspace_id <> all(${assigned})
        and not exists (select 1 from subscription_connection_assignment_policies policy
          where policy.account_id = assignment.account_id
            and policy.connection_id = assignment.connection_id
            and policy.workspace_id = assignment.workspace_id)`);
    await tx.execute(sql`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
      select ${target.accountId}::uuid, ${id}::uuid, workspace_id
      from unnest(${assigned}) as workspace_id
      on conflict do nothing`);
    await tx.execute(sql`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
        allowed_model_ids, excluded_models, managed_by_workspace_id
      )
      select ${target.accountId}::uuid, ${id}::uuid, workspace_id, 'organization',
        ${updated.allocator_enabled}, ${models}, '{}'::text[], null
      from unnest(${keep}) as workspace_id
      on conflict do nothing`);
    await tx.execute(sql`update subscription_connection_assignment_policies
      set allowed_model_ids = ${models}, updated_at = clock_timestamp()
      where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
        and inference_pool = 'organization'`);
    await tx.execute(sql`select opengeni_private.set_subscription_codex_reach(
      ${target.accountId}::uuid, ${id}::uuid,
      ${!organizationScope && policy.allowedWorkspaces === null}::boolean,
      ${!organizationScope && policy.allowPersonalWorkspaces}::boolean)`);
    return await coreCodexAccessPolicy(tx, target, updated);
  });
}

export async function updateModelConnectionAccess(
  db: Database,
  target: ModelConnectionTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  if (target.kind === "codex") return null;
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
