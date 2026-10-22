/**
 * What a shared subscription connection serves, for any provider on the
 * shared core: its models and, at organization scope, its reach (the whole
 * organization, chosen workspaces with the Personal-workspace switch, or
 * chosen people). Design 5.4 and the 0702 access editor.
 *
 * Every shared connection has one owner (D-50, SUB-OWN-04): the
 * organization, or one shared workspace whose own connection reaches only
 * that workspace. The organization route reads all of them; it changes a
 * workspace's own connection only by giving it more reach, which makes it the
 * organization's. The workspace route reads and edits only the models of the
 * workspace's own connection. The organization route also lets an exact
 * personal owner who is an organization administrator explicitly share that
 * named connection. It never inventories personal connections.
 *
 * Every query runs under the caller's own row-level-security context, so the
 * core tables' policies and the scope guard decide authority. Personal
 * sharing additionally uses an owner-fenced, versioned database capability.
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
  /** The shared workspaces it reaches; null for every shared workspace, including new ones. */
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  /** The chosen people (organization membership ids), or null when not limited to people. */
  allowedPeople?: string[] | null | undefined;
  sharePersonal?: true | undefined;
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
  /** The workspace whose own connection this is, as a list (organization route only). */
  localWorkspaceIds: string[];
  /** The workspace whose own connection this is, if any (organization route only). */
  managedByWorkspaceId: string | null;
  /**
   * Whether the connection may be limited to chosen people (organization
   * route, an organization connection).
   */
  peopleSupported: boolean;
  personalSharingSupported?: boolean;
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
      // Administration overview share-locks membership rows. Membership
      // lifecycle takes this advisory fence first, so access/sharing must
      // take it before the overview too (not only inside the sharing routine).
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(
        ${`organization-membership:${target.accountId}`}, 0))`);
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
  const owner = connection.managed_by_workspace_id;
  const allowedModels = connection.allowed_model_ids;
  const base = {
    localWorkspaceIds: owner !== null && shared.has(owner) ? [owner] : [],
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
    // them); the policy shape names only shared workspaces.
    const listed = await rawRows<{ workspace_id: string }>(
      tx,
      sql`select assignment.workspace_id::text as workspace_id
        from subscription_connection_workspaces assignment
        where assignment.account_id = ${target.accountId}::uuid
          and assignment.connection_id = ${connection.id}::uuid
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
    if (connection) return await projection(tx, provider, target, connection);
    if (target.workspaceId !== null) return null;
    const personal = await personalSharing(tx, provider, target);
    return personal
      ? {
          policy: {
            allowedModels: personal.allowedModels,
            allowedWorkspaces: [],
            allowPersonalWorkspaces: false,
            allowedPeople: null,
            version: personal.version,
          },
          localWorkspaceIds: [],
          managedByWorkspaceId: null,
          peopleSupported: false,
          personalSharingSupported: true,
        }
      : null;
  });
}

/** Owner + organization-admin intersection; never an inventory of other people's accounts. */
async function personalSharing(
  tx: Database,
  provider: SubscriptionCoreProvider,
  target: SubscriptionCoreAccessTarget,
  expectedVersion?: number,
): Promise<{ id: string; allowedModels: string[] | null; version: number } | null> {
  const [row] = await rawRows<{
    value: { id: string; allowedModels: string[] | null; version: number } | null;
  }>(
    tx,
    sql`select opengeni_private.subscription_core_personal_sharing(
      ${subscriptionCoreProviderId(provider)}, ${target.accountId}::uuid,
      ${target.subjectId}, ${target.connectionId}::uuid, ${expectedVersion ?? null}::integer) as value`,
  );
  return row?.value ?? null;
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
 * Save what a shared connection serves. Null when the connection is gone or
 * its access changed since `policy.version` was read (or a form that cannot
 * show the current people choice saved over it).
 *
 * At organization scope the connection's scope, its workspace and people
 * assignments and the reach for workspaces created later change together, in
 * one transaction:
 * - chosen people: `people` scope over them, with no reach for later
 *   workspaces;
 * - every shared and Personal workspace: `organization` scope;
 * - otherwise `workspaces` scope over the chosen shared workspaces (all of
 *   today's when the choice is "all, including new ones") plus every Personal
 *   workspace when they are allowed, with the reach kept for later ones.
 * A workspace's own connection stays its own while it reaches only that
 * workspace; any other reach makes it the organization's (D-50). In a
 * workspace, only the models of the workspace's own connection change.
 */
export async function updateSubscriptionCoreConnectionAccess(
  db: Database,
  provider: SubscriptionCoreProvider,
  target: SubscriptionCoreAccessTarget,
  policy: SubscriptionCoreAccessPolicy,
): Promise<SubscriptionCoreAccess | null> {
  const people = policy.allowedPeople ?? null;
  if (
    policy.sharePersonal &&
    (target.workspaceId !== null ||
      people !== null ||
      (policy.allowedWorkspaces?.length === 0 && !policy.allowPersonalWorkspaces))
  )
    throw new SubscriptionCoreAccessInvalidError(
      "Choose workspaces before sharing this personal account",
    );
  if (target.workspaceId !== null && (policy.allowedWorkspaces !== null || people !== null))
    throw new SubscriptionCoreAccessInvalidError(
      "Workspace connections cannot assign other workspaces",
    );
  if (people !== null && (policy.allowedWorkspaces?.length !== 0 || policy.allowPersonalWorkspaces))
    throw new SubscriptionCoreAccessInvalidError(
      "An account limited to people cannot also be given to workspaces",
    );
  return await withSubscriptionCoreAccessScope(db, target, async (tx) => {
    if (policy.sharePersonal) {
      try {
        if (!(await personalSharing(tx, provider, target, policy.version))) return null;
      } catch (error) {
        if (nestedPostgresSqlState(error) === "22023")
          throw new SubscriptionCoreAccessInvalidError(
            "This account cannot be shared. Sign in again, or use its existing shared connection.",
          );
        throw error;
      }
    }
    const current = await accessConnection(tx, provider, target, true);
    if (!current) {
      if (policy.sharePersonal) throw new SubscriptionCoreAccessForbiddenError();
      // Locking needs the write policy: a readable row it hides is a refusal.
      if (await accessConnection(tx, provider, target, false))
        throw new SubscriptionCoreAccessForbiddenError();
      return null;
    }
    if (Number(current.access_version) !== policy.version) {
      if (policy.sharePersonal) throw new SubscriptionCoreAccessForbiddenError();
      return null;
    }
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
      return await projection(tx, provider, target, updated);
    }

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
    // A workspace's own connection stays its own while it reaches exactly
    // that workspace; anything else makes it the organization's.
    const owner = current.managed_by_workspace_id;
    const keepOwner =
      owner !== null &&
      people === null &&
      !policy.allowPersonalWorkspaces &&
      policy.allowedWorkspaces !== null &&
      policy.allowedWorkspaces.length === 1 &&
      policy.allowedWorkspaces[0] === owner;
    const organizationScope =
      people === null && policy.allowedWorkspaces === null && policy.allowPersonalWorkspaces;
    const reach =
      people === null && !organizationScope
        ? {
            sharedWorkspaces: policy.allowedWorkspaces === null,
            personalWorkspaces: policy.allowPersonalWorkspaces,
          }
        : { sharedWorkspaces: false, personalWorkspaces: false };
    const desired = new Set(
      people !== null || organizationScope
        ? []
        : [
            ...(policy.allowedWorkspaces ?? shared),
            ...(policy.allowPersonalWorkspaces ? personal : []),
          ],
    );
    // The owner changes first, so the reach written next is checked against
    // the connection's new owner.
    const [updated] = await rawRows<AccessRow>(
      tx,
      sql`update subscription_connections connection set allowed_model_ids = ${models},
          scope_kind = ${people !== null ? "people" : organizationScope ? "organization" : "workspaces"},
          allow_personal_workspaces = ${people === null && policy.allowPersonalWorkspaces},
          managed_by_workspace_id = ${keepOwner ? owner : null}::uuid,
          access_version = access_version + 1, updated_at = clock_timestamp()
        where connection.account_id = ${target.accountId}::uuid and connection.id = ${id}::uuid
        returning ${ACCESS_COLUMNS}`,
    );
    if (!updated) return null;
    const assigned = uuidArray(desired);
    await tx.execute(sql`delete from subscription_connection_workspaces assignment
      where assignment.account_id = ${target.accountId}::uuid
        and assignment.connection_id = ${id}::uuid
        and assignment.workspace_id <> all(${assigned})`);
    await tx.execute(sql`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
      select ${target.accountId}::uuid, ${id}::uuid, workspace_id
      from unnest(${assigned}) as workspace_id
      on conflict do nothing`);
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
    return await projection(tx, provider, target, updated);
  });
}
