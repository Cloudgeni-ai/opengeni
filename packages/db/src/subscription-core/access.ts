/**
 * What a shared subscription connection serves, for any provider on the
 * shared core: its models and, at organization scope, its reach (the whole
 * organization, chosen workspaces with the Personal-workspace switch, or
 * chosen people). Design 5.4 and the 0702 access editor.
 *
 * Every shared connection is an organization account, including one a
 * workspace manages (its delegated manager, SUB-OWN-04): the organization
 * route reads and edits all of them. A workspace's own copy (its
 * `workspace`-pool assignment policy) keeps its assignment and row whatever is
 * chosen for workspaces. The workspace route reads and edits only the models
 * of a connection that workspace manages. Personal connections are never
 * read or written here.
 *
 * Every query runs under the caller's own row-level-security context, so the
 * core tables' policies and the scope guard decide authority.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  rawRows,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceSubjectRls,
} from "../database";
import type { Database } from "../database";
import { nestedPostgresSqlState } from "../persistence-errors";
import { resolveSubscriptionConnectionId } from "../subscription-core-repository";
import {
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";

export type SubscriptionCoreAccessPolicy = {
  allowedModels: string[] | null;
  /** Organization-pool grants; null for every shared workspace, including new ones. */
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  /** The chosen people (organization membership ids), or null when not limited to people. */
  allowedPeople?: string[] | null | undefined;
  version: number;
};

export type SubscriptionCoreAccessTarget = {
  accountId: string;
  /** null: the organization route. */
  workspaceId: string | null;
  subjectId: string;
  connectionId: string;
};

export type SubscriptionCoreAccess = {
  policy: SubscriptionCoreAccessPolicy & { allowedPeople: string[] | null };
  /** Shared workspaces that use the connection as their own (organization route only). */
  localWorkspaceIds: string[];
  /** The workspace that also manages the connection, if any (organization route only). */
  managedByWorkspaceId: string | null;
  /**
   * Whether the connection may be limited to chosen people (organization
   * route, no managing workspace: people scope would hide it from its
   * delegated managers, design 5.4 decision 5).
   */
  peopleSupported: boolean;
};

/** A requested access policy names a workspace outside the organization's shared workspaces. */
export class SubscriptionCoreAccessWorkspaceNotInOrganizationError extends Error {
  constructor() {
    super("A selected workspace is not in this organization");
    this.name = "SubscriptionCoreAccessWorkspaceNotInOrganizationError";
  }
}

/** A requested access policy names someone who is not an active person of the organization. */
export class SubscriptionCoreAccessPersonNotInOrganizationError extends Error {
  constructor() {
    super("A selected person is not an active member of this organization");
    this.name = "SubscriptionCoreAccessPersonNotInOrganizationError";
  }
}

/** People can't be added: the organization has more members than can be listed. */
export class SubscriptionCoreAccessPeopleUnlistableError extends Error {
  constructor() {
    super("This organization has too many members to choose people for an account");
    this.name = "SubscriptionCoreAccessPeopleUnlistableError";
  }
}

/** The requested combination cannot be saved (for example people together with workspaces). */
export class SubscriptionCoreAccessInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionCoreAccessInvalidError";
  }
}

/** The viewer can read a connection's access but may not change it. */
export class SubscriptionCoreAccessForbiddenError extends Error {
  constructor() {
    super("You can't change what this account serves");
    this.name = "SubscriptionCoreAccessForbiddenError";
  }
}

type AccessRow = {
  id: string;
  allowed_model_ids: string[] | null;
  scope_kind: "organization" | "workspaces" | "people";
  allow_personal_workspaces: boolean;
  allocator_enabled: boolean;
  access_version: number | string;
  managed_by_workspace_id: string | null;
};

const ACCESS_COLUMNS = sql`connection.id::text as id, connection.allowed_model_ids,
  connection.scope_kind, connection.allow_personal_workspaces, connection.allocator_enabled,
  connection.access_version, connection.managed_by_workspace_id::text as managed_by_workspace_id`;

/**
 * Runs an access route's reads and writes: under the subject's workspace RLS
 * for a workspace's connection, otherwise in the organization scope once the
 * subject's organization administration overview is readable.
 */
export async function withSubscriptionCoreAccessScope<T>(
  db: Database,
  target: SubscriptionCoreAccessTarget,
  use: (tx: Database) => Promise<T>,
): Promise<T> {
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

/**
 * A shared connection the organization administers: one no workspace manages,
 * or one a shared workspace manages (its delegated manager, design 5.4). A
 * shared connection managed by a Personal workspace cannot be produced by any
 * writer; if one existed it is not an organization account (fail closed).
 * Organization context only (the shared-workspace inventory refuses a
 * workspace context). `alias` names the `subscription_connections` row, or
 * none for unqualified columns.
 */
export function organizationAdministeredConnection(alias?: string): SQL {
  const column = (name: string) =>
    alias ? sql`${sql.identifier(alias)}.${sql.identifier(name)}` : sql.identifier(name);
  return sql`(${column("managed_by_workspace_id")} is null
    or ${column("managed_by_workspace_id")} in (
      select inventory.workspace_id
      from list_organization_workspace_ids(${column("account_id")}) inventory))`;
}

/**
 * The shared connection the route may edit: on the organization route any
 * shared connection of this provider (one a workspace manages too, unless that
 * workspace is a Personal workspace, which no writer produces: fail closed),
 * on a workspace route only one that workspace manages.
 */
async function accessConnection(
  tx: Database,
  provider: SubscriptionCoreProvider,
  target: SubscriptionCoreAccessTarget,
  lock: boolean,
): Promise<AccessRow | null> {
  const providerId = subscriptionCoreProviderId(provider);
  const connectionId = await resolveSubscriptionConnectionId(tx, {
    accountId: target.accountId,
    provider: providerId,
    connectionId: target.connectionId,
  });
  if (!connectionId) return null;
  const [row] = await rawRows<AccessRow>(
    tx,
    sql`select ${ACCESS_COLUMNS}
      from subscription_connections connection
      where connection.account_id = ${target.accountId}::uuid
        and connection.id = ${connectionId}::uuid
        and connection.provider = ${providerId}
        and connection.kind = ${subscriptionCoreConnectionKind(provider)}
        and connection.ownership = 'shared' and connection.disconnected_at is null
        and ${
          target.workspaceId === null
            ? organizationAdministeredConnection("connection")
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

/**
 * Workspaces using the connection as their own copy: a `workspace`-pool
 * policy row, or (a world without policy rows for it) the managing workspace's
 * plain assignment, which placement classifies the same way.
 */
async function localWorkspaceIds(
  tx: Database,
  accountId: string,
  connection: AccessRow,
): Promise<string[]> {
  const rows = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select policy.workspace_id::text as workspace_id
      from subscription_connection_assignment_policies policy
      where policy.account_id = ${accountId}::uuid and policy.connection_id = ${connection.id}::uuid
        and policy.inference_pool = 'workspace'
      union
      select assignment.workspace_id::text
      from subscription_connection_workspaces assignment
      where assignment.account_id = ${accountId}::uuid
        and assignment.connection_id = ${connection.id}::uuid
        and assignment.workspace_id = ${connection.managed_by_workspace_id}::uuid
        and not exists (select 1 from subscription_connection_assignment_policies policy
          where policy.account_id = assignment.account_id
            and policy.connection_id = assignment.connection_id
            and policy.workspace_id = assignment.workspace_id)
      order by 1`,
  );
  return rows.map((row) => row.workspace_id);
}

async function projection(
  tx: Database,
  provider: SubscriptionCoreProvider,
  target: SubscriptionCoreAccessTarget,
  connection: AccessRow,
): Promise<SubscriptionCoreAccess> {
  const version = Number(connection.access_version);
  // A workspace's own account is never offered to other workspaces from there.
  if (target.workspaceId !== null)
    return {
      policy: {
        allowedModels: connection.allowed_model_ids,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: false,
        allowedPeople: null,
        version,
      },
      localWorkspaceIds: [],
      managedByWorkspaceId: null,
      peopleSupported: false,
    };
  const shared = await organizationSharedWorkspaceIds(tx, target.accountId);
  const local = (await localWorkspaceIds(tx, target.accountId, connection)).filter((id) =>
    shared.has(id),
  );
  // The organization's list, which its workspaces are held to.
  const allowedModels = await organizationModels(tx, provider, target.accountId, connection);
  const base = {
    localWorkspaceIds: local,
    managedByWorkspaceId: connection.managed_by_workspace_id,
    peopleSupported: connection.managed_by_workspace_id === null,
  };
  if (connection.scope_kind === "organization")
    return {
      ...base,
      policy: {
        allowedModels,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        allowedPeople: null,
        version,
      },
    };
  if (connection.scope_kind === "people") {
    const people = await rawRows<{ membership_id: string }>(
      tx,
      sql`select organization_membership_id::text as membership_id
        from subscription_connection_people
        where account_id = ${target.accountId}::uuid and connection_id = ${connection.id}::uuid
        order by organization_membership_id`,
    );
    return {
      ...base,
      policy: {
        allowedModels,
        allowedWorkspaces: [],
        allowPersonalWorkspaces: false,
        allowedPeople: people.map((row) => row.membership_id),
        version,
      },
    };
  }
  // The reach kept for workspaces created later (0689 auto-assignments, the
  // provider-keyed helpers of PR 0c), or null when there is none.
  const [reachRow] = await rawRows<{
    reach: { sharedWorkspaces: boolean; personalWorkspaces: boolean } | null;
  }>(
    tx,
    sql`select opengeni_private.subscription_core_reach(
      ${subscriptionCoreProviderId(provider)}, ${target.accountId}::uuid,
      ${connection.id}::uuid) as reach`,
  );
  const reach = reachRow?.reach ?? null;
  let allowedWorkspaces: string[] | null = null;
  if (!reach?.sharedWorkspaces) {
    // Personal workspaces are listed too (their assignment is what admits
    // them); the policy shape names only shared workspaces. A workspace's own
    // copy is not an organization-pool choice: an organization-pool row is,
    // and so is a plain assignment without any policy row unless it is the
    // managing workspace's (placement classifies that one as its own copy).
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
            or (not exists (select 1 from subscription_connection_assignment_policies policy
                where policy.account_id = assignment.account_id
                  and policy.connection_id = assignment.connection_id
                  and policy.workspace_id = assignment.workspace_id)
              and assignment.workspace_id is distinct from ${connection.managed_by_workspace_id}::uuid))
        order by assignment.workspace_id`,
    );
    allowedWorkspaces = listed.map((row) => row.workspace_id).filter((id) => shared.has(id));
  }
  return {
    ...base,
    policy: {
      allowedModels,
      allowedWorkspaces,
      allowPersonalWorkspaces: connection.allow_personal_workspaces,
      allowedPeople: null,
      version,
    },
  };
}

/**
 * A shared connection's access. The organization route reads any shared
 * connection of the provider, the workspace route one that workspace manages.
 */
export async function readSubscriptionCoreConnectionAccess(
  db: Database,
  provider: SubscriptionCoreProvider,
  target: SubscriptionCoreAccessTarget,
): Promise<SubscriptionCoreAccess | null> {
  return await withSubscriptionCoreAccessScope(db, target, async (tx) => {
    const connection = await accessConnection(tx, provider, target, false);
    return connection ? await projection(tx, provider, target, connection) : null;
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
 * Active people of the organization among `ids`: memberships of humans,
 * read through the organization administrators' member list (the runtime role
 * cannot read memberships directly). Null when the organization has more
 * memberships than that list projects (SQLSTATE 54000); the read runs in a
 * savepoint so the save's transaction survives the refusal.
 */
async function activePeople(
  tx: Database,
  target: SubscriptionCoreAccessTarget,
  ids: readonly string[],
): Promise<Set<string> | null> {
  const wanted = new Set(ids);
  let rows: { id: string }[];
  try {
    rows = await tx.transaction(
      async (savepoint) =>
        await rawRows<{ id: string }>(
          savepoint as unknown as Database,
          sql`select member->>'id' as id
            from jsonb_array_elements(coalesce(list_organization_administration_members(
              ${target.accountId}::uuid, ${target.subjectId})::jsonb, '[]'::jsonb)) member
            where member->>'status' = 'active' and member->>'revokedAt' is null
              and member->>'subjectId' like 'user:%'`,
        ),
    );
  } catch (error) {
    if (nestedPostgresSqlState(error) === "54000") return null;
    throw error;
  }
  return new Set(rows.map((row) => row.id).filter((id) => wanted.has(id)));
}

async function chosenPeople(tx: Database, accountId: string, connectionId: string) {
  const rows = await rawRows<{ membership_id: string }>(
    tx,
    sql`select organization_membership_id::text as membership_id
      from subscription_connection_people
      where account_id = ${accountId}::uuid and connection_id = ${connectionId}::uuid`,
  );
  return new Set(rows.map((row) => row.membership_id));
}

/**
 * The organization's own copies of a connection: its organization-pool rows
 * (in workspace order) and the reach row for workspaces created later, each
 * with its rotation switch and model list. Only organization administrators
 * write them (the organization route and editor write them together); a
 * workspace-managed connection's delegated manager writes the connection's
 * switch and list and its own copy, never these. Organization administrators
 * only (the reach reader refuses anyone else).
 */
async function organizationCopies(
  tx: Database,
  provider: SubscriptionCoreProvider,
  accountId: string,
  connectionId: string,
): Promise<{
  rows: { allocator: boolean; models: string[] | null }[];
  reach: { allocator: boolean; models: string[] | null } | null;
}> {
  const rows = await rawRows<{ allocator_enabled: boolean; allowed_model_ids: string[] | null }>(
    tx,
    sql`select policy.allocator_enabled, policy.allowed_model_ids
      from subscription_connection_assignment_policies policy
      where policy.account_id = ${accountId}::uuid and policy.connection_id = ${connectionId}::uuid
        and policy.inference_pool = 'organization' and policy.managed_by_workspace_id is null
      order by policy.workspace_id`,
  );
  const [reachRow] = await rawRows<{
    reach: { allocatorEnabled?: unknown; allowedModelIds?: unknown } | null;
  }>(
    tx,
    sql`select opengeni_private.subscription_core_reach(
      ${subscriptionCoreProviderId(provider)}, ${accountId}::uuid, ${connectionId}::uuid) as reach`,
  );
  const reach = reachRow?.reach;
  return {
    rows: rows.map((row) => ({ allocator: row.allocator_enabled, models: row.allowed_model_ids })),
    // 0714's reader reports the reach row's switch and list.
    reach:
      reach && typeof reach.allocatorEnabled === "boolean"
        ? {
            allocator: reach.allocatorEnabled,
            models: Array.isArray(reach.allowedModelIds) ? reach.allowedModelIds.map(String) : null,
          }
        : null,
  };
}

/** The switches of the organization's own copies (`organizationCopies`). */
export async function organizationAllocatorCopies(
  tx: Database,
  provider: SubscriptionCoreProvider,
  accountId: string,
  connectionId: string,
): Promise<boolean[]> {
  const copies = await organizationCopies(tx, provider, accountId, connectionId);
  return [...copies.rows, ...(copies.reach ? [copies.reach] : [])].map((copy) => copy.allocator);
}

/**
 * The organization's own rotation switch for the workspaces it shares a
 * connection with: its copies' switch (uniform), or the connection's while it
 * has none (an account not shared yet), so new rows and the reach for
 * workspaces created later take this value, not the connection's.
 */
export async function organizationAllocator(
  tx: Database,
  provider: SubscriptionCoreProvider,
  accountId: string,
  connectionId: string,
  connectionAllocator: boolean,
): Promise<boolean> {
  const copies = await organizationAllocatorCopies(tx, provider, accountId, connectionId);
  return copies.length > 0 ? copies.every(Boolean) : connectionAllocator;
}

/**
 * The organization's model list: for a connection no workspace manages, the
 * connection's; otherwise its organization-pool rows' list, the reach row's
 * when it has no rows, or the connection's while it has neither (an account
 * not shared yet).
 */
export async function organizationModels(
  tx: Database,
  provider: SubscriptionCoreProvider,
  accountId: string,
  connection: Pick<AccessRow, "id" | "managed_by_workspace_id" | "allowed_model_ids">,
): Promise<string[] | null> {
  if (connection.managed_by_workspace_id === null) return connection.allowed_model_ids;
  const copies = await organizationCopies(tx, provider, accountId, connection.id);
  const first = copies.rows[0] ?? copies.reach;
  return first ? first.models : connection.allowed_model_ids;
}

/**
 * Save what a shared connection serves. Null when the connection is gone or
 * its access changed since `policy.version` was read (or a form that cannot
 * show the current people choice saved over it).
 *
 * At organization scope the connection's scope, its workspace and people
 * assignments, the organization-pool policy rows and the reach for workspaces
 * created later change together, in one transaction:
 * - chosen people: `people` scope over them; no organization-pool rows and no
 *   reach for later workspaces;
 * - every shared and Personal workspace: `organization` scope;
 * - otherwise `workspaces` scope over the chosen shared workspaces (all of
 *   today's when the choice is "all, including new ones") plus every Personal
 *   workspace when they are allowed, with the reach kept for later ones.
 * A workspace's own copy (its workspace-pool row and assignment) is never
 * removed. In a workspace, only the models of the account that workspace
 * manages change.
 */
export async function updateSubscriptionCoreConnectionAccess(
  db: Database,
  provider: SubscriptionCoreProvider,
  target: SubscriptionCoreAccessTarget,
  policy: SubscriptionCoreAccessPolicy,
): Promise<SubscriptionCoreAccess | null> {
  const people = policy.allowedPeople ?? null;
  if (target.workspaceId !== null && (policy.allowedWorkspaces !== null || people !== null))
    throw new SubscriptionCoreAccessInvalidError(
      "Workspace connections cannot assign other workspaces",
    );
  if (people !== null && (policy.allowedWorkspaces?.length !== 0 || policy.allowPersonalWorkspaces))
    throw new SubscriptionCoreAccessInvalidError(
      "An account limited to people cannot also be given to workspaces",
    );
  return await withSubscriptionCoreAccessScope(db, target, async (tx) => {
    const current = await accessConnection(tx, provider, target, true);
    if (!current) {
      // Locking needs the write policy: a readable row it hides is a refusal.
      if (await accessConnection(tx, provider, target, false))
        throw new SubscriptionCoreAccessForbiddenError();
      return null;
    }
    if (Number(current.access_version) !== policy.version) return null;
    // A form that never saw people (an older client) must not replace them.
    if (
      target.workspaceId === null &&
      current.scope_kind === "people" &&
      policy.allowedPeople === undefined
    )
      return null;
    const id = current.id;
    const models = textArray(policy.allowedModels);
    if (target.workspaceId !== null) {
      const [updated] = await rawRows<AccessRow>(
        tx,
        sql`update subscription_connections connection set allowed_model_ids = ${models},
            access_version = access_version + 1, updated_at = clock_timestamp()
          where connection.account_id = ${target.accountId}::uuid and connection.id = ${id}::uuid
          returning ${ACCESS_COLUMNS}`,
      );
      if (!updated) return null;
      await tx.execute(sql`update subscription_connection_assignment_policies
        set allowed_model_ids = ${models}, updated_at = clock_timestamp()
        where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
          and workspace_id = ${target.workspaceId}::uuid and inference_pool = 'workspace'`);
      return await projection(tx, provider, target, updated);
    }

    // People scope hides a connection from its delegated managers (they see
    // it only through a workspace assignment), so it is refused while a
    // workspace manages it; that would take an ability away (decision 5).
    if (people !== null && current.managed_by_workspace_id !== null)
      throw new SubscriptionCoreAccessInvalidError(
        "An account a workspace manages cannot be limited to people",
      );
    const shared = await organizationSharedWorkspaceIds(tx, target.accountId);
    if (policy.allowedWorkspaces?.some((workspaceId) => !shared.has(workspaceId)))
      throw new SubscriptionCoreAccessWorkspaceNotInOrganizationError();
    if (people !== null) {
      // A person already chosen who has since left may stay listed (people
      // scope admits only active memberships); anyone added must be active.
      // Without a member list (too many members) people already chosen can be
      // kept or removed, so models stay editable, but no one can be added.
      const chosen = await chosenPeople(tx, target.accountId, current.id);
      const added = people.filter((membershipId) => !chosen.has(membershipId));
      if (added.length > 0) {
        const active = await activePeople(tx, target, added);
        if (active === null) throw new SubscriptionCoreAccessPeopleUnlistableError();
        if (added.some((membershipId) => !active.has(membershipId)))
          throw new SubscriptionCoreAccessPersonNotInOrganizationError();
      }
    }
    const accountWorkspaces = await rawRows<{ id: string }>(
      tx,
      sql`select id::text as id from workspaces where account_id = ${target.accountId}::uuid`,
    );
    const personal = accountWorkspaces
      .map((row) => row.id)
      .filter((workspaceId) => !shared.has(workspaceId));
    // A workspace-managed connection is never stored with organization scope:
    // its delegated manager writes the connection's own switch and model list,
    // so "everyone" is every workspace's organization-pool row plus the reach
    // for workspaces created later, which only organization administrators
    // write, and the manager can narrow other workspaces but never widen them.
    const organizationScope =
      current.managed_by_workspace_id === null &&
      people === null &&
      policy.allowedWorkspaces === null &&
      policy.allowPersonalWorkspaces;
    // An account no workspace manages is the organization's alone: its switch
    // is the connection's, as its page and route show (0689 may have left its
    // organization copies paused while the connection is on).
    const organizationSwitch =
      current.managed_by_workspace_id === null
        ? current.allocator_enabled
        : await organizationAllocator(
            tx,
            provider,
            target.accountId,
            id,
            current.allocator_enabled,
          );
    const reach =
      people === null && !organizationScope
        ? {
            sharedWorkspaces: policy.allowedWorkspaces === null,
            personalWorkspaces: policy.allowPersonalWorkspaces,
          }
        : { sharedWorkspaces: false, personalWorkspaces: false };
    // A workspace with its own copy stays assigned whatever the organization
    // chooses, so that copy keeps its row (and serves again when the reach
    // includes workspaces). That includes the managing workspace's plain
    // assignment without policy rows, which placement also reads as its own.
    const local = await localWorkspaceIds(tx, target.accountId, current);
    const withPolicy = new Set(
      (
        await rawRows<{ workspace_id: string }>(
          tx,
          sql`select workspace_id::text as workspace_id
          from subscription_connection_assignment_policies
          where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
            and inference_pool = 'workspace'`,
        )
      ).map((row) => row.workspace_id),
    );
    // An organization-pool policy row on a plain own copy would make placement
    // read the whole assignment as the organization's, so that copy gets none.
    const plainLocal = new Set(local.filter((workspaceId) => !withPolicy.has(workspaceId)));
    // Organization scope admits every workspace; only a workspace that also
    // has its own copy needs explicit rows for both pools. People scope has no
    // organization-pool rows.
    const desired = new Set(
      (people !== null
        ? []
        : organizationScope
          ? local
          : [
              ...(policy.allowedWorkspaces ?? shared),
              ...(policy.allowPersonalWorkspaces ? personal : []),
            ]
      ).filter((workspaceId) => !plainLocal.has(workspaceId)),
    );
    const [updated] = await rawRows<AccessRow>(
      tx,
      sql`update subscription_connections connection set allowed_model_ids = ${models},
          scope_kind = ${people !== null ? "people" : organizationScope ? "organization" : "workspaces"},
          allow_personal_workspaces = ${people === null && policy.allowPersonalWorkspaces},
          access_version = access_version + 1, updated_at = clock_timestamp()
        where connection.account_id = ${target.accountId}::uuid and connection.id = ${id}::uuid
        returning ${ACCESS_COLUMNS}`,
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
        ${organizationSwitch}, ${models}, '{}'::text[], null
      from unnest(${keep}) as workspace_id
      on conflict do nothing`);
    await tx.execute(sql`update subscription_connection_assignment_policies
      set allowed_model_ids = ${models}, updated_at = clock_timestamp()
      where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
        and inference_pool = 'organization'`);
    const chosen = uuidArray(new Set(people ?? []));
    await tx.execute(sql`delete from subscription_connection_people
      where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
        and organization_membership_id <> all(${chosen})`);
    await tx.execute(sql`insert into subscription_connection_people
        (account_id, connection_id, organization_membership_id)
      select ${target.accountId}::uuid, ${id}::uuid, membership_id
      from unnest(${chosen}) as membership_id
      on conflict do nothing`);
    // Both reaches false removes the row (people scope, the whole
    // organization, or chosen workspaces only).
    await tx.execute(sql`select opengeni_private.set_subscription_core_reach(
      ${subscriptionCoreProviderId(provider)}, ${target.accountId}::uuid, ${id}::uuid,
      ${reach.sharedWorkspaces}::boolean, ${reach.personalWorkspaces}::boolean)`);
    // The setter copies the connection's switch; the reach keeps the
    // organization's.
    await tx.execute(sql`select opengeni_private.set_subscription_core_reach_allocator(
      ${subscriptionCoreProviderId(provider)}, ${target.accountId}::uuid, ${id}::uuid,
      ${organizationSwitch}::boolean)`);
    // The organization's list also becomes the managing workspace's own
    // copy's, which that workspace may change again afterwards.
    if (current.managed_by_workspace_id !== null)
      await tx.execute(sql`update subscription_connection_assignment_policies
        set allowed_model_ids = ${models}, updated_at = clock_timestamp()
        where account_id = ${target.accountId}::uuid and connection_id = ${id}::uuid
          and workspace_id = ${current.managed_by_workspace_id}::uuid
          and inference_pool = 'workspace'
          and managed_by_workspace_id = ${current.managed_by_workspace_id}::uuid`);
    return await projection(tx, provider, target, updated);
  });
}
