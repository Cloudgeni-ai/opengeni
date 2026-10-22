/**
 * Connect and disconnect on the shared subscription core, for any provider.
 *
 * API handlers reach this module only for the provider's `core` cutover
 * disposition, and every write also rechecks the enabled cutover in the
 * database.
 *
 * Authority (SUB-OWN-01/04, design 3.1):
 * - On the organization route an organization administrator creates an
 *   organization-scoped, organization-managed connection. On a shared
 *   workspace's route an organization administrator or an administrator of
 *   that workspace (SUB-OWN-09) creates the workspace's own account: it
 *   serves and is managed by that workspace alone, and the organization
 *   still owns it. The 0642/0777 insert policies enforce who may create it.
 * - A reconnect (same upstream account and person) replaces the credential
 *   of the existing connection. Organization administrators may reconnect
 *   any shared connection; a workspace administrator only one their
 *   workspace manages (the core update policy enforces it). An account
 *   already connected elsewhere in the organization is never widened or
 *   taken over, including one the caller cannot see.
 * - In a person's own Personal workspace, connect creates or reconnects that
 *   person's personal connection through the owner-scoped database writer.
 * - An organization administrator deletes any shared connection; the
 *   managing workspace's administrator only the workspace's own account
 *   (migration 0777). A personal connection is deleted by its owner from
 *   their Personal workspace. Deletion waits for a redemption's share lock,
 *   and is refused while any workspace's redemption of the connection has an
 *   unresolved provider outcome or while a lease still names it.
 *
 * Every credential replacement takes the connection's refresh key
 * (`subscription-refresh:<id>`) before its row lock. The provider is data:
 * its id selects rows, lock keys and wake reasons; its adapter's `apps`
 * capability decides whether a removal audits cleared Apps designations.
 */
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "../database";
import { withLosslessContentWriteVersion } from "../lossless-json";
import * as schema from "../schema";
import { resolveSubscriptionConnectionId } from "../subscription-core-repository";
import {
  isSubscriptionCoreRlsRefusal,
  listSubscriptionCorePersonalConnectionRowsInTransaction,
  readSubscriptionCorePersonalConnectionVersionsInTransaction,
  readSubscriptionCoreWorkspacePool,
  subscriptionCoreWakeReason,
  type SubscriptionCoreWake,
} from "./administration";
import { organizationAdministeredConnection } from "./access";
import {
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";

export type SubscriptionCoreCredentialInput = {
  /** v1 envelope of the adapter's encoded credential. */
  credentialEncrypted: string;
  /**
   * The stored format of that credential (`adapter.credential.format`);
   * `v1`, the 0707 writers' format, when omitted.
   */
  credentialFormat?: string;
  providerAccountId: string | null;
  /**
   * The signed-in person within the upstream account. Two people's logins of
   * one upstream account are distinct shared connections; only the same
   * person's login reconnects in place.
   */
  providerSubjectId: string | null;
  planType: string | null;
  /** Adapter-owned provider state merged into the connection's. */
  providerState: Record<string, unknown>;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  accountEmail: string | null;
  label: string | null;
  /** Verified managed-browser human, never inferred from a grant's spelling. */
  connectedBySubjectId?: string | null;
};

export type SubscriptionCoreConnectRefusal =
  /** Not an organization administrator, or not allowed to manage it here. */
  | "forbidden"
  /** The upstream account is already connected and managed elsewhere. */
  | "managed_elsewhere"
  /** A migrated login has no proven upstream person; never guess or merge it. */
  | "identity_unverified"
  /** Personal connections are turned off for this person here. */
  | "personal_connections_disabled"
  /** The provider's cutover is not enabled (or the caller is not exact). */
  | "unavailable"
  /** A fenced reconnect's connection is gone, changed, or not the one this sign-in reaches. */
  | "changed";

export type SubscriptionCoreConnectResult =
  | {
      kind: "connected";
      id: string;
      isNew: boolean;
      ownership: "shared" | "personal";
      wake: SubscriptionCoreWake;
      /**
       * The connection's row version after the write: always for a shared
       * connection; for a personal one only when asked (`returnVersion` or
       * `reconnect`), which costs one owner read.
       */
      version?: number;
    }
  | { kind: "refused"; reason: SubscriptionCoreConnectRefusal };

/**
 * A reconnect of one exact connection (a route that names the account it
 * replaces): the sign-in must land on that connection at that version, or
 * nothing is written (`changed`). Never creates a connection.
 */
export type SubscriptionCoreReconnectTarget = {
  connectionId: string;
  /** The connection's row version the caller read (`SubscriptionCoreConnectionRow.version`). */
  expectedVersion: number;
};

export type SubscriptionCoreConnectScope = {
  accountId: string;
  /** null: the organization route. */
  workspaceId: string | null;
  subjectId: string;
  /**
   * The caller asked for the person's own connection (a legacy `user`
   * scope): only a personal connection in their Personal workspace, else
   * refused (`forbidden`), never a shared one.
   */
  personal?: boolean;
  /** Replace exactly this connection at this version (see the type). */
  reconnect?: SubscriptionCoreReconnectTarget;
  /** Report a personal connection's row version too (one owner read). */
  returnVersion?: boolean;
};

/** Rolls back a fenced reconnect that reached another (or a new) connection. */
class SubscriptionCoreReconnectChanged extends Error {
  constructor() {
    super("subscription core reconnect target changed");
    this.name = "SubscriptionCoreReconnectChanged";
  }
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

async function workspaceKind(
  tx: Database,
  accountId: string,
  workspaceId: string,
): Promise<"personal" | "shared"> {
  const [row] = await rawRows<{ workspace_kind: string | null }>(
    tx,
    sql`select get_workspace_kind(${accountId}::uuid, ${workspaceId}::uuid) as workspace_kind`,
  );
  return row?.workspace_kind === "personal" ? "personal" : "shared";
}

async function isOrganizationAdministrator(tx: Database, accountId: string): Promise<boolean> {
  const [row] = await rawRows<{ admin: boolean }>(
    tx,
    sql`select opengeni_private.subscription_organization_admin(${accountId}::uuid) as admin`,
  );
  return row?.admin === true;
}

/** A stored `credential_format` name, as 0728's personal writer checks it. */
const SUBSCRIPTION_CORE_CREDENTIAL_FORMAT = /^[a-z][a-z0-9_]{0,63}$/u;

/** One upstream account is one shared connection per organization (SUB-OWN-08). */
function isProviderAccountUniqueViolation(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current && typeof current === "object" && depth < 4;
    current = (current as { cause?: unknown }).cause, depth += 1
  ) {
    const { code, constraint_name: constraintName } = current as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === "23505") {
      return constraintName === "subscription_connections_provider_owner_account_uq";
    }
  }
  return false;
}

/**
 * Connect (or reconnect) one account of this provider from a completed
 * sign-in. The caller delivers `wake` after commit.
 */
export async function connectSubscriptionCoreConnection(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope & SubscriptionCoreCredentialInput,
): Promise<SubscriptionCoreConnectResult> {
  // The format is the adapter's stored-format name (`credential.format`),
  // never free text. A malformed one is a caller defect, reported as such on
  // every path rather than as a refusal or a maintenance pause.
  if (
    input.credentialFormat !== undefined &&
    !SUBSCRIPTION_CORE_CREDENTIAL_FORMAT.test(input.credentialFormat)
  ) {
    throw new Error("subscription core credential format is malformed");
  }
  try {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (tx) => {
        await setSubjectRlsContext(tx, input.subjectId);
        if (
          input.workspaceId !== null &&
          (input.personal === true ||
            (await workspaceKind(tx, input.accountId, input.workspaceId)) === "personal")
        ) {
          // The personal writer refuses a workspace that is not the person's own.
          return await connectPersonal(tx, provider, { ...input, workspaceId: input.workspaceId });
        }
        if (input.personal === true) return { kind: "refused", reason: "forbidden" };
        return await connectShared(tx, provider, input);
      },
    );
  } catch (error) {
    if (error instanceof SubscriptionCoreReconnectChanged) {
      return { kind: "refused", reason: "changed" };
    }
    throw error;
  }
}

async function connectPersonal(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope & { workspaceId: string } & SubscriptionCoreCredentialInput,
): Promise<SubscriptionCoreConnectResult> {
  if (!input.subjectId.startsWith("user:")) return { kind: "refused", reason: "forbidden" };
  const [row] = await rawRows<{ outcome: string; connection_id: string | null; is_new: boolean }>(
    tx,
    // The `v1` format keeps the 0707 writer (the format it stores); any
    // other format takes the 0728 overload.
    input.credentialFormat === undefined || input.credentialFormat === "v1"
      ? sql`select outcome, connection_id::text as connection_id, is_new
      from opengeni_private.connect_subscription_core_personal(${subscriptionCoreProviderId(provider)},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId},
        ${input.credentialEncrypted}, ${input.providerAccountId}, ${input.providerSubjectId}, ${input.planType},
        ${JSON.stringify(input.providerState)}::jsonb, ${iso(input.expiresAt)}::timestamptz,
        ${iso(input.lastRefreshAt)}::timestamptz, ${input.accountEmail}, ${input.label},
        ${input.connectedBySubjectId ?? null}
      )`
      : sql`select outcome, connection_id::text as connection_id, is_new
      from opengeni_private.connect_subscription_core_personal(${subscriptionCoreProviderId(provider)},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId},
        ${input.credentialEncrypted}, ${input.providerAccountId}, ${input.providerSubjectId}, ${input.planType},
        ${JSON.stringify(input.providerState)}::jsonb, ${iso(input.expiresAt)}::timestamptz,
        ${iso(input.lastRefreshAt)}::timestamptz, ${input.accountEmail}, ${input.label},
        ${input.connectedBySubjectId ?? null}, ${input.credentialFormat}
      )`,
  );
  if (row?.outcome === "connected" && row.connection_id) {
    let version: number | undefined;
    if (input.reconnect || input.returnVersion) {
      version = (
        await readSubscriptionCorePersonalConnectionVersionsInTransaction(tx, provider, input)
      ).get(row.connection_id);
    }
    // The writer holds the row lock until commit and moves the version by
    // exactly one, so this compares the version the caller read. Anything
    // else rolls the whole write back (the caller sees `changed`).
    if (
      input.reconnect &&
      (row.is_new ||
        row.connection_id !== input.reconnect.connectionId ||
        version !== input.reconnect.expectedVersion + 1)
    ) {
      throw new SubscriptionCoreReconnectChanged();
    }
    return {
      kind: "connected",
      id: row.connection_id,
      isNew: row.is_new,
      ownership: "personal",
      wake: {
        accountId: input.accountId,
        reason: subscriptionCoreWakeReason(provider, "connected"),
        workspaceIds: [input.workspaceId],
      },
      ...(version === undefined ? {} : { version }),
    };
  }
  if (row?.outcome === "personal_connections_disabled") {
    return { kind: "refused", reason: "personal_connections_disabled" };
  }
  if (row?.outcome === "identity_unverified") {
    return { kind: "refused", reason: "identity_unverified" };
  }
  if (row?.outcome === "not_personal_workspace") return { kind: "refused", reason: "forbidden" };
  return { kind: "refused", reason: "unavailable" };
}

async function connectShared(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope & SubscriptionCoreCredentialInput,
): Promise<SubscriptionCoreConnectResult> {
  const providerId = subscriptionCoreProviderId(provider);
  const connectionKind = subscriptionCoreConnectionKind(provider);
  const [cutover] = await rawRows<{ enabled: boolean }>(
    tx,
    sql`select enabled from subscription_provider_cutovers
      where account_id = ${input.accountId}::uuid and provider = ${providerId}`,
  );
  if (cutover?.enabled !== true) return { kind: "refused", reason: "unavailable" };
  if (
    !input.providerAccountId ||
    !input.providerSubjectId ||
    input.providerSubjectId.startsWith("legacy:")
  ) {
    return { kind: "refused", reason: "identity_unverified" };
  }
  if (input.providerAccountId !== null) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-connect:${input.accountId}:${providerId}:shared:${input.providerAccountId}`}, 0))`,
    );
  }
  const admin = await isOrganizationAdministrator(tx, input.accountId);
  if (input.providerAccountId !== null && input.providerSubjectId !== null) {
    const [unidentified] = await rawRows<{ id: string }>(
      tx,
      sql`select id from subscription_connections
      where account_id = ${input.accountId}::uuid and provider = ${providerId}
        and kind = ${connectionKind} and ownership = 'shared'
        and provider_account_id = ${input.providerAccountId}
        and (provider_subject_id is null or provider_subject_id like 'legacy:%') limit 1`,
    );
    if (unidentified) return { kind: "refused", reason: "identity_unverified" };
  }
  let [existing] =
    input.providerAccountId === null
      ? []
      : await rawRows<{ id: string; managed_by_workspace_id: string | null; version: number }>(
          tx,
          sql`select id::text as id, managed_by_workspace_id::text as managed_by_workspace_id,
              version
            from subscription_connections
            where account_id = ${input.accountId}::uuid and provider = ${providerId}
              and kind = ${connectionKind} and ownership = 'shared'
              and provider_account_id = ${input.providerAccountId}
              and provider_subject_id is not distinct from ${input.providerSubjectId}`,
        );
  if (existing) {
    // Preserve the existing non-takeover refusal before an UPDATE policy can
    // hide a source managed elsewhere from the row-lock query.
    if (!admin && existing.managed_by_workspace_id !== input.workspaceId) {
      return { kind: "refused", reason: "managed_elsewhere" };
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-refresh:${existing.id}`}, 0))`,
    );
    // Disconnect may have scrubbed the identity while this caller waited.
    // The connect key still serializes replacement creation; never reactivate
    // the old tombstone or reuse its assignment/management authority.
    [existing] = await rawRows<{
      id: string;
      managed_by_workspace_id: string | null;
      version: number;
    }>(
      tx,
      sql`select id::text as id, managed_by_workspace_id::text as managed_by_workspace_id,
          version
        from subscription_connections where account_id = ${input.accountId}::uuid
          and id = ${existing.id}::uuid and disconnected_at is null
          and provider_account_id = ${input.providerAccountId}
          and provider_subject_id is not distinct from ${input.providerSubjectId}
        for update`,
    );
  }
  // A fenced reconnect writes only the connection it names, at the version
  // the caller read (the row is locked above), and never creates one.
  if (
    input.reconnect &&
    (existing?.id !== input.reconnect.connectionId ||
      Number(existing.version) !== input.reconnect.expectedVersion)
  ) {
    return { kind: "refused", reason: "changed" };
  }
  // Only a managed human is recorded as the connecting person (legacy
  // parity): local administration and service principals own no reset credit.
  const connectedBySubjectId = input.connectedBySubjectId ?? null;
  const reason = subscriptionCoreWakeReason(provider, "connected");
  const wake: SubscriptionCoreWake =
    input.workspaceId === null
      ? { accountId: input.accountId, reason }
      : { accountId: input.accountId, reason, workspaceIds: [input.workspaceId] };
  const providerState = JSON.stringify(input.providerState);
  const credentialFormat = input.credentialFormat ?? "v1";
  if (existing) {
    if (input.workspaceId !== null) {
      const pool = await readSubscriptionCoreWorkspacePool(tx, provider, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
      });
      if (!pool.connections.some((entry) => entry.row.id === existing.id)) {
        return { kind: "refused", reason: "managed_elsewhere" };
      }
    }
    // Reconnect: the organization, or the workspace that manages it. Anyone
    // else would take over or widen an account managed elsewhere.
    if (!admin && existing.managed_by_workspace_id !== input.workspaceId) {
      return { kind: "refused", reason: "managed_elsewhere" };
    }
    let replaced: { id: string; version: number }[];
    try {
      replaced = await tx.transaction(async (savepoint) => {
        await rawRows(
          savepoint as unknown as Database,
          sql`select id from subscription_connections
            where account_id = ${input.accountId}::uuid and id = ${existing.id}::uuid
            for update`,
        );
        return await rawRows<{ id: string; version: number }>(
          savepoint as unknown as Database,
          sql`update subscription_connections set
              credential_encrypted = ${input.credentialEncrypted}, credential_format = ${credentialFormat},
              expires_at = ${iso(input.expiresAt)}::timestamptz, last_refresh_at = ${iso(input.lastRefreshAt)}::timestamptz,
              refresh_generation = refresh_generation + 1, version = version + 1,
              status = 'active', last_error = null,
              plan_type = coalesce(${input.planType}, plan_type),
              provider_state = provider_state || ${providerState}::jsonb,
              account_email = coalesce(${input.accountEmail}, account_email),
              label = coalesce(label, ${input.label}),
              connected_by_subject_id = ${connectedBySubjectId}, updated_at = clock_timestamp()
            where account_id = ${input.accountId}::uuid and id = ${existing.id}::uuid
            returning id::text as id, version`,
        );
      });
    } catch (error) {
      if (isSubscriptionCoreRlsRefusal(error)) return { kind: "refused", reason: "forbidden" };
      throw error;
    }
    // The update policy hides a connection this subject may not manage.
    if (!replaced[0]) return { kind: "refused", reason: "forbidden" };
    return {
      kind: "connected",
      id: replaced[0].id,
      isNew: false,
      ownership: "shared",
      wake,
      version: Number(replaced[0].version),
    };
  }
  // A new organization account is an organization decision (SUB-OWN-01);
  // a workspace's own account may also be its administrator's (SUB-OWN-09).
  // The insert policies decide who may create which; anyone else is refused.
  if (!admin && input.workspaceId === null) return { kind: "refused", reason: "forbidden" };
  const workspaceScoped = input.workspaceId !== null;
  // The id is chosen here, not returned: a workspace administrator sees a
  // workspace-scoped connection only once its workspace link exists.
  const createdId = crypto.randomUUID();
  try {
    await tx.transaction(async (savepoint) => {
      const write = savepoint as unknown as Database;
      await write.execute(sql`insert into subscription_connections (
        id, account_id, provider, kind, provider_account_id, account_email, label, plan_type,
        credential_encrypted, credential_format, expires_at, last_refresh_at, status,
        ownership, connected_by_subject_id, scope_kind, allow_personal_workspaces,
        managed_by_workspace_id, provider_state, provider_subject_id
      ) values (
        ${createdId}::uuid, ${input.accountId}::uuid, ${providerId}, ${connectionKind}, ${input.providerAccountId},
        ${input.accountEmail}, ${input.label}, ${input.planType}, ${input.credentialEncrypted},
        ${credentialFormat}, ${iso(input.expiresAt)}::timestamptz, ${iso(input.lastRefreshAt)}::timestamptz, 'active', 'shared', ${connectedBySubjectId},
        ${workspaceScoped ? "workspaces" : "organization"}, ${!workspaceScoped},
        ${input.workspaceId}::uuid, ${providerState}::jsonb,
        ${input.providerSubjectId}
      )`);
      if (input.workspaceId === null) return;
      await write.execute(sql`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
      values (${input.accountId}::uuid, ${createdId}::uuid, ${input.workspaceId}::uuid)`);
      await write.execute(sql`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
        allowed_model_ids, excluded_models, managed_by_workspace_id
      ) values (
        ${input.accountId}::uuid, ${createdId}::uuid, ${input.workspaceId}::uuid, 'workspace',
        true, null, '{}'::text[], ${input.workspaceId}::uuid
      )`);
    });
  } catch (error) {
    if (isSubscriptionCoreRlsRefusal(error)) return { kind: "refused", reason: "forbidden" };
    // The upstream account is already a shared connection the caller cannot
    // see (another workspace's own account): never widen or take it over.
    if (isProviderAccountUniqueViolation(error)) {
      return { kind: "refused", reason: "managed_elsewhere" };
    }
    throw error;
  }
  const [created] = await rawRows<{ id: string; version: number }>(
    tx,
    sql`select id::text as id, version from subscription_connections
      where account_id = ${input.accountId}::uuid and id = ${createdId}::uuid`,
  );
  if (!created) {
    throw new Error(`${provider.adapter.displayName} connection insert is not readable`);
  }
  return {
    kind: "connected",
    id: created.id,
    isNew: true,
    ownership: "shared",
    wake,
    version: Number(created.version),
  };
}

export type SubscriptionCoreDisconnectOutcome =
  | "removed"
  | "not_found"
  | "forbidden"
  | "unresolved_redemption"
  | "in_use";

export type SubscriptionCoreDisconnectResult = {
  outcome: SubscriptionCoreDisconnectOutcome;
  /** The canonical connection, when the route id resolved. */
  connectionId: string | null;
  /** Workspaces whose Apps designation the removal cleared (for audit). */
  clearedAppsWorkspaceIds: string[];
  wake: SubscriptionCoreWake | null;
};

async function disconnectInTransaction(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope,
  connectionId: string,
): Promise<{ outcome: SubscriptionCoreDisconnectOutcome; clearedAppsWorkspaceIds: string[] }> {
  const providerId = subscriptionCoreProviderId(provider);
  // Only a provider with Apps designations has any to clear.
  const designations = provider.adapter.capabilities.apps
    ? await rawRows<{ workspace_id: string }>(
        tx,
        sql`select workspace_id::text as workspace_id from subscription_apps_designations
          where account_id = ${input.accountId}::uuid and connection_id = ${connectionId}::uuid`,
      )
    : [];
  const [row] = await rawRows<{ outcome: string }>(
    tx,
    sql`select opengeni_private.disconnect_subscription_core_connection(${providerId},
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId},
        ${connectionId}::uuid
      ) as outcome`,
  );
  const outcome = row?.outcome;
  if (outcome === "removed" && input.workspaceId !== null) {
    // Legacy parity: the workspace's Apps designation of a removed account is
    // cleared (by the cascade) and audited in that workspace.
    const accountId = input.accountId;
    for (const designation of designations) {
      if (designation.workspace_id !== input.workspaceId) continue;
      await tx.insert(schema.auditEvents).values(
        withLosslessContentWriteVersion(
          {
            accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
            action: `${providerId}_apps.cleared_on_disconnect`,
            targetType: "subscription_connection",
            targetId: connectionId,
            metadata: {},
          },
          "metadata",
          "metadataCodecVersion",
        ),
      );
    }
  }
  if (
    outcome === "removed" ||
    outcome === "forbidden" ||
    outcome === "unresolved_redemption" ||
    outcome === "in_use"
  ) {
    return {
      outcome,
      clearedAppsWorkspaceIds:
        outcome === "removed" ? designations.map((entry) => entry.workspace_id) : [],
    };
  }
  return { outcome: "not_found", clearedAppsWorkspaceIds: [] };
}

/**
 * The canonical connection a route may disconnect: on the organization route
 * any organization account (`organizationAdministeredConnection`); on a workspace route a connection
 * of the workspace's projected pool, or (in the person's own Personal
 * workspace) one of their personal connections. `organization` marks an
 * organization account named from a workspace route (legacy 409).
 */
async function disconnectTarget(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope,
  rawId: string,
): Promise<{ id: string; organization: boolean } | null> {
  const providerId = subscriptionCoreProviderId(provider);
  const connectionKind = subscriptionCoreConnectionKind(provider);
  if (input.workspaceId === null) {
    const id = await resolveRouteConnectionIdInTransaction(tx, provider, input, rawId);
    if (!id) return null;
    const [row] = await rawRows<{ id: string }>(
      tx,
      sql`select id::text as id from subscription_connections
        where account_id = ${input.accountId}::uuid and id = ${id}::uuid and provider = ${providerId}
          and kind = ${connectionKind} and ownership = 'shared'
          and ${organizationAdministeredConnection()}`,
    );
    return row ? { id: row.id, organization: true } : null;
  }
  const personal = await resolvePersonalConnectionIdInTransaction(tx, provider, input, rawId);
  if (personal) return { id: personal, organization: false };
  const id = await resolveSubscriptionConnectionId(tx, {
    accountId: input.accountId,
    provider: providerId,
    connectionId: rawId,
  });
  if (!id) return null;
  const pool = await readSubscriptionCoreWorkspacePool(tx, provider, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  });
  const entry = pool.connections.find((candidate) => candidate.row.id === id);
  return entry ? { id, organization: entry.source === "organization" } : null;
}

/**
 * The caller's own personal connection a route id names (canonical, or a
 * legacy id the drained cutover kept as its alias), only in their own
 * Personal workspace. Resolved inside the owner-only routine: ordinary app
 * RLS deliberately hides personal aliases, including from administrators.
 */
async function resolvePersonalConnectionIdInTransaction(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope,
  rawId: string,
): Promise<string | null> {
  if (input.workspaceId === null) return null;
  if ((await workspaceKind(tx, input.accountId, input.workspaceId)) !== "personal") return null;
  const [personal] = await rawRows<{ resolved: { id: string } | null }>(
    tx,
    sql`select opengeni_private.manage_subscription_core_personal(${subscriptionCoreProviderId(provider)},
      ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId}, ${rawId}::uuid,
      'resolve', null, null, null) as resolved`,
  );
  return personal?.resolved?.id ?? null;
}

async function resolveRouteConnectionIdInTransaction(
  tx: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope,
  rawId: string,
): Promise<string | null> {
  const personal = await resolvePersonalConnectionIdInTransaction(tx, provider, input, rawId);
  if (personal) return personal;
  return await resolveSubscriptionConnectionId(tx, {
    accountId: input.accountId,
    provider: subscriptionCoreProviderId(provider),
    connectionId: rawId,
  });
}

/**
 * A route's account id (canonical, or a legacy id the drained cutover kept
 * as an alias) as the canonical connection id, resolved as the caller: an
 * organization administrator sees every alias of the organization (the
 * organization route, `workspaceId: null`, or any workspace route); anyone
 * else the aliases of connections the workspace reaches; a personal
 * connection's only its owner, in their own Personal workspace. Null when
 * nothing resolves; the caller's projection still decides whether the
 * connection is theirs to name.
 */
export async function resolveSubscriptionCoreRouteConnectionId(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope & { connectionId: string },
): Promise<string | null> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      return await resolveRouteConnectionIdInTransaction(tx, provider, input, input.connectionId);
    },
  );
}

/**
 * Disconnect one account of this provider. Throws the provider's
 * organization-managed error for an organization account named from a
 * workspace route. The caller delivers `wake` after commit.
 */
export async function disconnectSubscriptionCoreConnection(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope & { connectionId: string },
): Promise<SubscriptionCoreDisconnectResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      const target = await disconnectTarget(tx, provider, input, input.connectionId);
      if (!target) {
        return {
          outcome: "not_found",
          connectionId: null,
          clearedAppsWorkspaceIds: [],
          wake: null,
        };
      }
      if (input.workspaceId !== null && target.organization) {
        throw provider.errors.organizationManaged();
      }
      const result = await disconnectInTransaction(tx, provider, input, target.id);
      return {
        ...result,
        connectionId: target.id,
        wake:
          result.outcome === "removed"
            ? {
                accountId: input.accountId,
                reason: subscriptionCoreWakeReason(provider, "disconnected"),
              }
            : null,
      };
    },
  );
}

class DisconnectAllRefused extends Error {
  constructor(
    readonly outcome: Exclude<SubscriptionCoreDisconnectOutcome, "removed" | "not_found">,
    readonly connectionIds: string[],
  ) {
    super("subscription disconnect-all refused");
  }
}

export type SubscriptionCoreDisconnectAllResult = {
  removed: number;
  refused: {
    outcome: Exclude<SubscriptionCoreDisconnectOutcome, "removed" | "not_found">;
    connectionIds: string[];
  } | null;
  clearedAppsWorkspaceIds: string[];
  wake: SubscriptionCoreWake | null;
};

/**
 * The workspace "disconnect all": every account of this provider the
 * workspace manages (or, in a person's own Personal workspace, their
 * personal connections), atomically. Any refusal leaves everything
 * connected.
 */
export async function disconnectAllSubscriptionCoreConnections(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: SubscriptionCoreConnectScope & { workspaceId: string },
): Promise<SubscriptionCoreDisconnectAllResult> {
  try {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (tx) => {
        await setSubjectRlsContext(tx, input.subjectId);
        const personalWorkspace =
          (await workspaceKind(tx, input.accountId, input.workspaceId)) === "personal";
        const ids = personalWorkspace
          ? (
              await listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, input)
            ).map((row) => row.id)
          : [];
        const pool = await readSubscriptionCoreWorkspacePool(tx, provider, input);
        for (const entry of pool.connections) {
          if (entry.source === "workspace" && !ids.includes(entry.row.id)) ids.push(entry.row.id);
        }
        ids.sort();
        let removed = 0;
        const cleared = new Set<string>();
        for (const id of ids) {
          const result = await disconnectInTransaction(tx, provider, input, id);
          if (result.outcome === "removed") {
            removed += 1;
            for (const workspaceId of result.clearedAppsWorkspaceIds) cleared.add(workspaceId);
          } else if (result.outcome !== "not_found") {
            throw new DisconnectAllRefused(result.outcome, [id]);
          }
        }
        return {
          removed,
          refused: null,
          clearedAppsWorkspaceIds: [...cleared],
          wake:
            removed > 0
              ? {
                  accountId: input.accountId,
                  reason: subscriptionCoreWakeReason(provider, "disconnected"),
                }
              : null,
        };
      },
    );
  } catch (error) {
    if (error instanceof DisconnectAllRefused) {
      return {
        removed: 0,
        refused: { outcome: error.outcome, connectionIds: error.connectionIds },
        clearedAppsWorkspaceIds: [],
        wake: null,
      };
    }
    throw error;
  }
}
