/**
 * Codex connect and disconnect on the shared subscription core (M3 PR 3b).
 *
 * Dormant like PR 1/2: API handlers reach this module only for the `core`
 * cutover disposition, and every write also rechecks the enabled cutover in
 * the database. Nothing here reads or writes a legacy Codex table.
 *
 * Authority (SUB-OWN-01/04, design 3.1):
 * - A new shared connection is created only by an organization
 *   administrator: on the organization route it is organization-scoped and
 *   organization-managed; on a shared workspace's route it serves and is
 *   managed by that workspace (the core shape of a legacy workspace account).
 * - A reconnect (same upstream account) replaces the credential of the
 *   existing connection. Organization administrators may reconnect any shared
 *   connection; a workspace administrator only one their workspace manages
 *   (the core update policy enforces it). An account already connected
 *   elsewhere in the organization is never widened or taken over.
 * - In a person's own Personal workspace, connect creates or reconnects that
 *   person's personal connection through the owner-scoped database writer.
 * - Only an organization administrator deletes a shared connection; a
 *   personal connection is deleted by its owner from their Personal
 *   workspace. Deletion waits for a redemption's share lock, and is refused
 *   while any workspace's redemption of the connection has an unresolved
 *   provider outcome or while a lease still names it.
 *
 * Every credential replacement takes the connection's refresh key
 * (`subscription-refresh:<id>`) before its row lock.
 */
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { withLosslessContentWriteVersion } from "./lossless-json";
import * as schema from "./schema";
import { resolveSubscriptionConnectionId } from "./subscription-core-repository";
import {
  listSubscriptionCoreCodexPersonalAccountsInTransaction,
  projectSubscriptionCoreCodexWorkspace,
  type SubscriptionCoreCodexWake,
} from "./subscription-core-codex-compat";

export type SubscriptionCoreCodexCredentialInput = {
  /** v1 envelope of JSON {access_token, refresh_token, id_token}. */
  credentialEncrypted: string;
  providerAccountId: string | null;
  /**
   * The signed-in person within the upstream account (the id_token's ChatGPT
   * user). Two people's logins of one ChatGPT workspace are distinct shared
   * connections; only the same person's login reconnects in place.
   */
  providerSubjectId: string | null;
  planType: string | null;
  isFedramp: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  accountEmail: string | null;
  label: string | null;
  /** Verified managed-browser human, never inferred from a grant's spelling. */
  connectedBySubjectId?: string | null;
};

export type SubscriptionCoreCodexConnectRefusal =
  /** Not an organization administrator, or not allowed to manage it here. */
  | "forbidden"
  /** The upstream account is already connected and managed elsewhere. */
  | "managed_elsewhere"
  /** A migrated login has no proven upstream person; never guess or merge it. */
  | "identity_unverified"
  /** Personal connections are turned off for this person here. */
  | "personal_connections_disabled"
  /** The Codex cutover is not enabled (or the caller is not exact). */
  | "unavailable";

export type SubscriptionCoreCodexConnectResult =
  | {
      kind: "connected";
      id: string;
      isNew: boolean;
      ownership: "shared" | "personal";
      wake: SubscriptionCoreCodexWake;
    }
  | { kind: "refused"; reason: SubscriptionCoreCodexConnectRefusal };

type ConnectScope = {
  accountId: string;
  /** null: the organization route. */
  workspaceId: string | null;
  subjectId: string;
};

function isRlsRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const causeCode = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === "42501" || causeCode === "42501";
}

function providerState(input: SubscriptionCoreCodexCredentialInput): Record<string, unknown> {
  return input.isFedramp ? { isFedramp: true } : {};
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

/**
 * Connect (or reconnect) one Codex account from a device-code sign-in. The
 * caller delivers `wake` after commit.
 */
export async function connectSubscriptionCoreCodexConnection(
  db: Database,
  input: ConnectScope & SubscriptionCoreCodexCredentialInput,
): Promise<SubscriptionCoreCodexConnectResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      if (
        input.workspaceId !== null &&
        (await workspaceKind(tx, input.accountId, input.workspaceId)) === "personal"
      ) {
        return await connectPersonal(tx, { ...input, workspaceId: input.workspaceId });
      }
      return await connectShared(tx, input);
    },
  );
}

async function connectPersonal(
  tx: Database,
  input: ConnectScope & { workspaceId: string } & SubscriptionCoreCodexCredentialInput,
): Promise<SubscriptionCoreCodexConnectResult> {
  if (!input.subjectId.startsWith("user:")) return { kind: "refused", reason: "forbidden" };
  const [row] = await rawRows<{ outcome: string; connection_id: string | null; is_new: boolean }>(
    tx,
    sql`select outcome, connection_id::text as connection_id, is_new
      from opengeni_private.connect_subscription_codex_personal(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId},
        ${input.credentialEncrypted}, ${input.providerAccountId}, ${input.planType},
        ${JSON.stringify(providerState(input))}::jsonb, ${iso(input.expiresAt)}::timestamptz,
        ${iso(input.lastRefreshAt)}::timestamptz, ${input.accountEmail}, ${input.label}
      )`,
  );
  if (row?.outcome === "connected" && row.connection_id) {
    return {
      kind: "connected",
      id: row.connection_id,
      isNew: row.is_new,
      ownership: "personal",
      wake: {
        accountId: input.accountId,
        reason: "core_codex_connected",
        workspaceIds: [input.workspaceId],
      },
    };
  }
  if (row?.outcome === "personal_connections_disabled") {
    return { kind: "refused", reason: "personal_connections_disabled" };
  }
  if (row?.outcome === "not_personal_workspace") return { kind: "refused", reason: "forbidden" };
  return { kind: "refused", reason: "unavailable" };
}

async function connectShared(
  tx: Database,
  input: ConnectScope & SubscriptionCoreCodexCredentialInput,
): Promise<SubscriptionCoreCodexConnectResult> {
  const [cutover] = await rawRows<{ enabled: boolean }>(
    tx,
    sql`select enabled from subscription_provider_cutovers
      where account_id = ${input.accountId}::uuid and provider = 'codex'`,
  );
  if (cutover?.enabled !== true) return { kind: "refused", reason: "unavailable" };
  if (input.providerAccountId !== null) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-connect:${input.accountId}:codex:shared:${input.providerAccountId}:${input.providerSubjectId ?? ""}`}, 0))`,
    );
  }
  const admin = await isOrganizationAdministrator(tx, input.accountId);
  if (input.providerAccountId !== null && input.providerSubjectId !== null) {
    const [unidentified] = await rawRows<{ id: string }>(
      tx,
      sql`select id from subscription_connections
      where account_id = ${input.accountId}::uuid and provider = 'codex'
        and kind = 'subscription' and ownership = 'shared'
        and provider_account_id = ${input.providerAccountId} and provider_subject_id is null limit 1`,
    );
    if (unidentified) return { kind: "refused", reason: "identity_unverified" };
  }
  const [existing] =
    input.providerAccountId === null
      ? []
      : await rawRows<{ id: string; managed_by_workspace_id: string | null }>(
          tx,
          sql`select id::text as id, managed_by_workspace_id::text as managed_by_workspace_id
            from subscription_connections
            where account_id = ${input.accountId}::uuid and provider = 'codex'
              and kind = 'subscription' and ownership = 'shared'
              and provider_account_id = ${input.providerAccountId}
              and provider_subject_id is not distinct from ${input.providerSubjectId}`,
        );
  // Only a managed human is recorded as the connecting person (legacy
  // parity): local administration and service principals own no reset credit.
  const connectedBySubjectId = input.connectedBySubjectId ?? null;
  const wake: SubscriptionCoreCodexWake =
    input.workspaceId === null
      ? { accountId: input.accountId, reason: "core_codex_connected" }
      : {
          accountId: input.accountId,
          reason: "core_codex_connected",
          workspaceIds: [input.workspaceId],
        };
  if (existing) {
    if (input.workspaceId !== null) {
      const pool = await projectSubscriptionCoreCodexWorkspace(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
      });
      if (!pool.accounts.some((account) => account.id === existing.id)) {
        return { kind: "refused", reason: "managed_elsewhere" };
      }
    }
    // Reconnect: the organization, or the workspace that manages it. Anyone
    // else would take over or widen an account managed elsewhere.
    if (!admin && existing.managed_by_workspace_id !== input.workspaceId) {
      return { kind: "refused", reason: "managed_elsewhere" };
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`subscription-refresh:${existing.id}`}, 0))`,
    );
    let replaced: { id: string }[];
    try {
      replaced = await tx.transaction(async (savepoint) => {
        await rawRows(
          savepoint as unknown as Database,
          sql`select id from subscription_connections
            where account_id = ${input.accountId}::uuid and id = ${existing.id}::uuid
            for update`,
        );
        return await rawRows<{ id: string }>(
          savepoint as unknown as Database,
          sql`update subscription_connections set
              credential_encrypted = ${input.credentialEncrypted}, credential_format = 'v1',
              expires_at = ${iso(input.expiresAt)}::timestamptz, last_refresh_at = ${iso(input.lastRefreshAt)}::timestamptz,
              refresh_generation = refresh_generation + 1, version = version + 1,
              status = 'active', last_error = null,
              plan_type = coalesce(${input.planType}, plan_type),
              provider_state = provider_state || ${JSON.stringify(providerState(input))}::jsonb,
              account_email = coalesce(${input.accountEmail}, account_email),
              label = coalesce(label, ${input.label}),
              connected_by_subject_id = ${connectedBySubjectId}, updated_at = clock_timestamp()
            where account_id = ${input.accountId}::uuid and id = ${existing.id}::uuid
            returning id::text as id`,
        );
      });
    } catch (error) {
      if (isRlsRefusal(error)) return { kind: "refused", reason: "forbidden" };
      throw error;
    }
    // The update policy hides a connection this subject may not manage.
    if (!replaced[0]) return { kind: "refused", reason: "forbidden" };
    return { kind: "connected", id: replaced[0].id, isNew: false, ownership: "shared", wake };
  }
  // A new shared connection is an organization decision (SUB-OWN-01/04).
  if (!admin) return { kind: "refused", reason: "forbidden" };
  const workspaceScoped = input.workspaceId !== null;
  const [created] = await rawRows<{ id: string }>(
    tx,
    sql`insert into subscription_connections (
        account_id, provider, kind, provider_account_id, account_email, label, plan_type,
        credential_encrypted, credential_format, expires_at, last_refresh_at, status,
        ownership, connected_by_subject_id, scope_kind, allow_personal_workspaces,
        managed_by_workspace_id, provider_state, provider_subject_id
      ) values (
        ${input.accountId}::uuid, 'codex', 'subscription', ${input.providerAccountId},
        ${input.accountEmail}, ${input.label}, ${input.planType}, ${input.credentialEncrypted},
        'v1', ${iso(input.expiresAt)}::timestamptz, ${iso(input.lastRefreshAt)}::timestamptz, 'active', 'shared', ${connectedBySubjectId},
        ${workspaceScoped ? "workspaces" : "organization"}, ${!workspaceScoped},
        ${input.workspaceId}::uuid, ${JSON.stringify(providerState(input))}::jsonb,
        ${input.providerSubjectId}
      ) returning id::text as id`,
  );
  if (!created) throw new Error("Codex connection insert returned no row");
  if (input.workspaceId !== null) {
    await tx.execute(sql`insert into subscription_connection_workspaces
        (account_id, connection_id, workspace_id)
      values (${input.accountId}::uuid, ${created.id}::uuid, ${input.workspaceId}::uuid)`);
    await tx.execute(sql`insert into subscription_connection_assignment_policies (
        account_id, connection_id, workspace_id, inference_pool, allocator_enabled,
        allowed_model_ids, excluded_models, managed_by_workspace_id
      ) values (
        ${input.accountId}::uuid, ${created.id}::uuid, ${input.workspaceId}::uuid, 'workspace',
        true, null, '{}'::text[], ${input.workspaceId}::uuid
      )`);
  }
  return { kind: "connected", id: created.id, isNew: true, ownership: "shared", wake };
}

export type SubscriptionCoreCodexDisconnectOutcome =
  | "removed"
  | "not_found"
  | "forbidden"
  | "unresolved_redemption"
  | "in_use";

export type SubscriptionCoreCodexDisconnectResult = {
  outcome: SubscriptionCoreCodexDisconnectOutcome;
  /** The canonical connection, when the route id resolved. */
  connectionId: string | null;
  /** Workspaces whose Apps designation the removal cleared (for audit). */
  clearedAppsWorkspaceIds: string[];
  wake: SubscriptionCoreCodexWake | null;
};

/** A route target: the organization's own accounts, or one workspace's. */
type DisconnectScope = ConnectScope;

async function disconnectInTransaction(
  tx: Database,
  input: DisconnectScope,
  connectionId: string,
): Promise<{ outcome: SubscriptionCoreCodexDisconnectOutcome; clearedAppsWorkspaceIds: string[] }> {
  const designations = await rawRows<{ workspace_id: string }>(
    tx,
    sql`select workspace_id::text as workspace_id from subscription_apps_designations
      where account_id = ${input.accountId}::uuid and connection_id = ${connectionId}::uuid`,
  );
  const [row] = await rawRows<{ outcome: string }>(
    tx,
    sql`select opengeni_private.disconnect_subscription_codex_connection(
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
            action: "codex_apps.cleared_on_disconnect",
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
 * a shared connection no workspace manages; on a workspace route a connection
 * of the workspace's projected account pool, or (in the person's own
 * Personal workspace) one of their personal connections. `organization`
 * marks an organization account named from a workspace route (legacy 409).
 */
async function disconnectTarget(
  tx: Database,
  input: DisconnectScope,
  rawId: string,
): Promise<{ id: string; organization: boolean } | null> {
  if (input.workspaceId === null) {
    const id = await resolveSubscriptionConnectionId(tx, {
      accountId: input.accountId,
      provider: "codex",
      connectionId: rawId,
    });
    if (!id) return null;
    const [row] = await rawRows<{ id: string }>(
      tx,
      sql`select id::text as id from subscription_connections
        where account_id = ${input.accountId}::uuid and id = ${id}::uuid and provider = 'codex'
          and kind = 'subscription' and ownership = 'shared' and managed_by_workspace_id is null`,
    );
    return row ? { id: row.id, organization: true } : null;
  }
  if ((await workspaceKind(tx, input.accountId, input.workspaceId)) === "personal") {
    // Resolve migrated aliases inside the owner-only routine. Ordinary app
    // RLS deliberately hides personal aliases, including from administrators.
    const [personal] = await rawRows<{ resolved: { id: string } | null }>(
      tx,
      sql`select opengeni_private.manage_subscription_codex_personal(
        ${input.accountId}::uuid, ${input.workspaceId}::uuid, ${input.subjectId}, ${rawId}::uuid,
        'resolve', null, null, null) as resolved`,
    );
    if (personal?.resolved) return { id: personal.resolved.id, organization: false };
  }
  const id = await resolveSubscriptionConnectionId(tx, {
    accountId: input.accountId,
    provider: "codex",
    connectionId: rawId,
  });
  if (!id) return null;
  const pool = await projectSubscriptionCoreCodexWorkspace(tx, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
  });
  const account = pool.accounts.find((candidate) => candidate.id === id);
  return account ? { id, organization: account.source === "organization" } : null;
}

export class SubscriptionCoreCodexOrganizationManagedError extends Error {
  constructor() {
    super("organization Codex subscriptions are managed in Organization settings");
  }
}

/** Disconnect one Codex account. The caller delivers `wake` after commit. */
export async function disconnectSubscriptionCoreCodexConnection(
  db: Database,
  input: DisconnectScope & { connectionId: string },
): Promise<SubscriptionCoreCodexDisconnectResult> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      const target = await disconnectTarget(tx, input, input.connectionId);
      if (!target) {
        return {
          outcome: "not_found",
          connectionId: null,
          clearedAppsWorkspaceIds: [],
          wake: null,
        };
      }
      if (input.workspaceId !== null && target.organization) {
        throw new SubscriptionCoreCodexOrganizationManagedError();
      }
      const result = await disconnectInTransaction(tx, input, target.id);
      return {
        ...result,
        connectionId: target.id,
        wake:
          result.outcome === "removed"
            ? { accountId: input.accountId, reason: "core_codex_disconnected" }
            : null,
      };
    },
  );
}

class DisconnectAllRefused extends Error {
  constructor(
    readonly outcome: Exclude<SubscriptionCoreCodexDisconnectOutcome, "removed" | "not_found">,
    readonly connectionIds: string[],
  ) {
    super("Codex disconnect-all refused");
  }
}

/**
 * The legacy workspace "disconnect all": every account this workspace manages
 * (or, in a person's own Personal workspace, their personal connections),
 * atomically. Any refusal leaves everything connected.
 */
export async function disconnectAllSubscriptionCoreCodexConnections(
  db: Database,
  input: ConnectScope & { workspaceId: string },
): Promise<{
  removed: number;
  refused: {
    outcome: Exclude<SubscriptionCoreCodexDisconnectOutcome, "removed" | "not_found">;
    connectionIds: string[];
  } | null;
  clearedAppsWorkspaceIds: string[];
  wake: SubscriptionCoreCodexWake | null;
}> {
  try {
    return await withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (tx) => {
        await setSubjectRlsContext(tx, input.subjectId);
        const personalWorkspace =
          (await workspaceKind(tx, input.accountId, input.workspaceId)) === "personal";
        const ids = personalWorkspace
          ? (await listSubscriptionCoreCodexPersonalAccountsInTransaction(tx, input)).map(
              (account) => account.id,
            )
          : [];
        const pool = await projectSubscriptionCoreCodexWorkspace(tx, input);
        for (const account of pool.accounts) {
          if (account.source === "workspace" && !ids.includes(account.id)) ids.push(account.id);
        }
        ids.sort();
        let removed = 0;
        const cleared = new Set<string>();
        for (const id of ids) {
          const result = await disconnectInTransaction(tx, input, id);
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
            removed > 0 ? { accountId: input.accountId, reason: "core_codex_disconnected" } : null,
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
