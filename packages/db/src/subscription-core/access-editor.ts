import { sql } from "drizzle-orm";
import type { ProviderId } from "@opengeni/subscriptions";
import {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceSubjectRls,
  type Database,
} from "../database";
import { resolveSubscriptionConnectionId } from "../subscription-core-repository";
import { subscriptionCoreProvider } from "../subscription-core-providers";

/** What a connection serves, in the access routes' shape. */
export type ModelConnectionAccess = {
  allowedModels: string[] | null;
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  version: number;
};

/**
 * The connection an access route edits, for the subject editing it: one the
 * organization manages when `workspaceId` is null, otherwise one that
 * workspace manages. The provider is a separate argument.
 */
export type SubscriptionCoreAccessTarget = {
  accountId: string;
  workspaceId: string | null;
  subjectId: string;
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

/**
 * Runs an access route's reads and writes: under the subject's workspace RLS
 * for a workspace's connection, otherwise in the organization scope once the
 * subject's organization administration overview is readable.
 */
export async function withModelConnectionAccessScope<T>(
  db: Database,
  target: SubscriptionCoreAccessTarget,
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

type CoreAccessRow = {
  id: string;
  allowed_model_ids: string[] | null;
  scope_kind: "organization" | "workspaces" | "people";
  allow_personal_workspaces: boolean;
  allocator_enabled: boolean;
  access_version: number | string;
};

/**
 * The provider's shared connection the route may edit on the subscription
 * core: organization-managed or this workspace's.
 */
async function coreAccessConnection(
  tx: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
  lock: boolean,
): Promise<CoreAccessRow | null> {
  const connectionId = await resolveSubscriptionConnectionId(tx, {
    accountId: target.accountId,
    provider,
    connectionId: target.connectionId,
  });
  if (!connectionId) return null;
  const [row] = await rawRows<CoreAccessRow>(
    tx,
    sql`select connection.id::text as id, connection.allowed_model_ids, connection.scope_kind,
        connection.allow_personal_workspaces, connection.allocator_enabled, connection.access_version
      from subscription_connections connection
      where connection.account_id = ${target.accountId}::uuid
        and connection.id = ${connectionId}::uuid
        and connection.provider = ${provider} and connection.kind = 'subscription'
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

async function coreAccessPolicy(
  tx: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
  connection: CoreAccessRow,
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
    sql`select opengeni_private.subscription_core_reach(
      ${provider}, ${target.accountId}::uuid, ${connection.id}::uuid) as reach`,
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
 * A shared connection's access policy on the shared subscription core, for
 * any registered provider, in the legacy shape. The organization route reads
 * an organization-managed connection, the workspace route one that workspace
 * manages. `allowedWorkspaces` is null when every shared workspace, including
 * ones created later, may use it.
 */
export async function getSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
): Promise<ModelConnectionAccess | null> {
  subscriptionCoreProvider(provider);
  return await withModelConnectionAccessScope(db, target, async (tx) => {
    const connection = await coreAccessConnection(tx, provider, target, false);
    return connection ? await coreAccessPolicy(tx, provider, target, connection) : null;
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
 * Save what a shared connection of any registered provider serves on the
 * core. Null when the connection is gone or its access changed since
 * `policy.version` was read.
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
export async function updateSubscriptionCoreModelConnectionAccess(
  db: Database,
  provider: ProviderId,
  target: SubscriptionCoreAccessTarget,
  policy: ModelConnectionAccess,
): Promise<ModelConnectionAccess | null> {
  subscriptionCoreProvider(provider);
  if (target.workspaceId !== null && policy.allowedWorkspaces !== null)
    throw new Error("Workspace connections cannot assign other workspaces");
  return await withModelConnectionAccessScope(db, target, async (tx) => {
    const current = await coreAccessConnection(tx, provider, target, true);
    if (!current) {
      // Locking needs the write policy: a readable row it hides is a refusal.
      if (await coreAccessConnection(tx, provider, target, false))
        throw new ModelConnectionAccessForbiddenError();
      return null;
    }
    if (Number(current.access_version) !== policy.version) return null;
    const id = current.id;
    const models = textArray(policy.allowedModels);
    if (target.workspaceId !== null) {
      const [updated] = await rawRows<CoreAccessRow>(
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
      return await coreAccessPolicy(tx, provider, target, updated);
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
    const [updated] = await rawRows<CoreAccessRow>(
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
    await tx.execute(sql`select opengeni_private.set_subscription_core_reach(
      ${provider}, ${target.accountId}::uuid, ${id}::uuid,
      ${!organizationScope && policy.allowedWorkspaces === null}::boolean,
      ${!organizationScope && policy.allowPersonalWorkspaces}::boolean)`);
    return await coreAccessPolicy(tx, provider, target, updated);
  });
}
