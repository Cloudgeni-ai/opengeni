/**
 * Claude reads on the shared subscription core (design 5.3, Claude track
 * C2a): usage (EP-N24, EP-S13), catalog readiness (EP-T18, EP-S25, EP-N26)
 * and organization custom-model admission. Every entry point is reached only
 * after the caller read the organization's Claude provider route as `core`;
 * the Claude binding is looked up in the registry, which fails closed until
 * the Claude cutover (C3) registers it.
 *
 * Legacy model ids keep their meaning on the core: an
 * `organization-claude-subscription/` model is served by the organization
 * inference pool, a `workspace-claude-subscription/` model by the workspace
 * pool or the subject's own personal connection in their own Personal
 * workspace.
 */
import type { Settings } from "@opengeni/config";
import type { ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, setSubjectRlsContext, withRlsContext, type Database } from "./database";
import { listWorkspaceProviderCustomModelsByKind } from "./model-catalog";
import { namedSubjectPersonalWorkspaceId } from "./slack-routing-personal-workspace";
import { resolveSubscriptionConnectionId } from "./subscription-core-repository";
import {
  listSubscriptionCorePersonalConnectionRowsInTransaction,
  readSubscriptionCoreOrganizationPool,
  readSubscriptionCorePersonalConnectionVersionsInTransaction,
  readSubscriptionCoreWorkspacePool,
  type SubscriptionCoreConnectionRow,
} from "./subscription-core/administration";
import {
  listSubscriptionCoreServingConnections,
  subscriptionCoreConnectionAllowlist,
  subscriptionCoreConnectionAllowsModel,
  type SubscriptionCoreServingConnection,
} from "./subscription-core/catalog";
import {
  subscriptionCoreOperationConnections,
  type SubscriptionCoreConnectionProbeDeps,
} from "./subscription-core/operation-connections";
import { subscriptionCoreOperations } from "./subscription-core/operations";
import {
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./subscription-core/provider";
import { subscriptionCoreProvider } from "./subscription-core-providers";
import { SUBSCRIPTION_CORE_CLAUDE_PROVIDER } from "./subscription-core-claude-adapter";
import {
  projectSubscriptionCoreClaudeUsage,
  subscriptionCoreClaudeUsageVersion,
  type SubscriptionCoreClaudeUsageReading,
  type SubscriptionCoreClaudeUsageRefresh,
} from "./subscription-core-claude-usage";

// The legacy product model id prefixes (`SUBSCRIPTION_CORE_CLAUDE_MODEL_PREFIXES`).
const ORGANIZATION_PREFIX = "organization-claude-subscription";
const WORKSPACE_PREFIX = "workspace-claude-subscription";
/** The legacy refresh throttle: one live usage read per connection per 30 seconds. */
export const SUBSCRIPTION_CORE_CLAUDE_USAGE_REFRESH_INTERVAL_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The registered Claude binding; throws until the Claude cutover registers it. */
function claudeBinding(): SubscriptionCoreProvider {
  return subscriptionCoreProvider(SUBSCRIPTION_CORE_CLAUDE_PROVIDER);
}

/** A Claude connection one usage route may read, with the legacy authority scope it maps to. */
export type SubscriptionCoreClaudeUsageTarget = {
  connectionId: string;
  /**
   * `workspace` and `organization`: a shared connection of the workspace's
   * pool by its source; `user`: the caller's own personal connection.
   */
  scope: "workspace" | "organization" | "user";
  row: SubscriptionCoreConnectionRow;
};

/**
 * The Claude connection a workspace usage route names (a canonical id or a
 * cutover alias), when the caller may see it here: a shared connection of
 * the workspace's effective pool, or the caller's own personal connection
 * in their own Personal workspace (the owner-only reader). Null otherwise.
 * The row carries its row version (shared reads select it; a personal row
 * gets it from the owner-only version reader, and is not returned without
 * one).
 */
export async function readSubscriptionCoreClaudeWorkspaceUsageTarget(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; accountIdParam: string },
): Promise<SubscriptionCoreClaudeUsageTarget | null> {
  // Every connection id and alias is a UUID; anything else names nothing.
  if (!UUID.test(input.accountIdParam)) return null;
  const binding = claudeBinding();
  const connectionId = await subscriptionCoreOperations(
    binding,
  ).resolveSubscriptionCoreConnectionId(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    connectionId: input.accountIdParam,
  });
  const ownPersonalWorkspace =
    (await namedSubjectPersonalWorkspaceId(db, {
      accountId: input.accountId,
      subjectId: input.subjectId,
    })) === input.workspaceId;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const pool = await readSubscriptionCoreWorkspacePool(tx, binding, input);
      const shared =
        connectionId === null
          ? undefined
          : pool.connections.find((entry) => entry.row.id === connectionId);
      if (shared) return { connectionId: shared.row.id, scope: shared.source, row: shared.row };
      if (!ownPersonalWorkspace || pool.source.workspaceKind !== "personal") return null;
      // A personal connection and its aliases are invisible to the generic
      // resolver: the owner-only routine resolves them (exact owner
      // membership, in the owner's own Personal workspace).
      await setSubjectRlsContext(tx, input.subjectId);
      const [resolved] = await rawRows<{ resolved: { id?: unknown } | null }>(
        tx,
        sql`select opengeni_private.manage_subscription_core_personal(
          ${subscriptionCoreProviderId(binding)}, ${input.accountId}::uuid,
          ${input.workspaceId}::uuid, ${input.subjectId}, ${input.accountIdParam}::uuid,
          'resolve', null, null, null) as resolved`,
      );
      const personalId = resolved?.resolved?.id;
      if (typeof personalId !== "string") return null;
      const personal = await listSubscriptionCorePersonalConnectionRowsInTransaction(
        tx,
        binding,
        input,
      );
      const row = personal.find((candidate) => candidate.id === personalId);
      if (!row) return null;
      const version = (
        await readSubscriptionCorePersonalConnectionVersionsInTransaction(tx, binding, input)
      ).get(row.id);
      return version === undefined
        ? null
        : { connectionId: row.id, scope: "user" as const, row: { ...row, version } };
    },
  );
}

/**
 * The organization's own Claude connection an organization usage route
 * names, for an organization administrator (null for anyone else, and for
 * a connection outside the organization pool).
 */
export async function readSubscriptionCoreClaudeOrganizationUsageRow(
  db: Database,
  input: { organizationId: string; subjectId: string; accountIdParam: string },
): Promise<SubscriptionCoreConnectionRow | null> {
  if (!UUID.test(input.accountIdParam)) return null;
  const binding = claudeBinding();
  const pool = await readSubscriptionCoreOrganizationPool(db, binding, input);
  if (!pool) return null;
  // The canonical id, or a legacy id the drained migration kept as an alias,
  // under the administrator's organization scope.
  const connectionId = await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (tx) => {
      await setSubjectRlsContext(tx, input.subjectId);
      return await resolveSubscriptionConnectionId(tx, {
        accountId: input.organizationId,
        provider: SUBSCRIPTION_CORE_CLAUDE_PROVIDER,
        connectionId: input.accountIdParam,
      });
    },
  );
  return pool.rows.find((row) => row.id === connectionId) ?? null;
}

/**
 * Every Claude product model the workspace's catalog lists now (the
 * organization's Claude models and the workspace's own), passed to the
 * usage decoder so a model-family window cools each listed model.
 */
export async function listSubscriptionCoreClaudeCatalogModelIds(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<string[]> {
  const [organizationModels, workspaceModels] = await Promise.all([
    withRlsContext(
      db,
      input,
      async (tx) =>
        await rawRows<{ upstream_model_id: string }>(
          tx,
          sql`select model.upstream_model_id from organization_model_provider_custom_models model
            where model.account_id = ${input.accountId}::uuid
              and model.provider_kind = 'claude_subscription' and model.retired_at is null`,
        ),
    ),
    listWorkspaceProviderCustomModelsByKind(db, {
      ...input,
      providerKinds: ["claude_subscription"],
    }),
  ]);
  return [
    ...new Set([
      ...organizationModels.map((model) => `${ORGANIZATION_PREFIX}/${model.upstream_model_id}`),
      ...workspaceModels.claude_subscription.map(
        (model) => `${WORKSPACE_PREFIX}/${model.upstreamModelId}`,
      ),
    ]),
  ].sort();
}

type RefreshAttempt = { at: number; refresh: SubscriptionCoreClaudeUsageRefresh };
const MAX_REMEMBERED_ATTEMPTS = 1024;
/**
 * The last live read per workspace, connection and row version in this
 * process: the legacy throttle also holds back a read that failed (the core
 * stores readings, not failed attempts). Per replica: another API replica
 * may read once more within the interval. A reconnect moves the row
 * version, so a remembered outcome never outlives the credential it read.
 */
const lastAttempts = new Map<string, RefreshAttempt>();

function rememberAttempt(key: string, attempt: RefreshAttempt): void {
  lastAttempts.delete(key);
  lastAttempts.set(key, attempt);
  while (lastAttempts.size > MAX_REMEMBERED_ATTEMPTS) {
    const oldest = lastAttempts.keys().next().value;
    if (oldest === undefined) break;
    lastAttempts.delete(oldest);
  }
}

/** Forget remembered attempts (tests). */
export function resetSubscriptionCoreClaudeUsageThrottle(): void {
  lastAttempts.clear();
}

/**
 * A live usage refresh of one shared Claude connection of the workspace's
 * pool, through the core connection seam (workspace scope; a personal
 * connection is not readable there). Returns the connection's projected
 * usage after the read and whether the reading ended a stored exhaustion
 * (the caller wakes the Claude core waiters; a failed wake never fails the
 * committed read).
 *
 * Throttle (legacy: one read per 30 seconds): a stored usage-endpoint
 * reading younger than the interval answers first; else this replica's
 * remembered attempt, when it is younger than the interval and newer than
 * the stored reading. A reading the core did not apply (the generation
 * fence, or a failed write) is reported `unavailable`, never `available`.
 */
export async function refreshSubscriptionCoreClaudeWorkspaceUsage(
  db: Database,
  settings: Settings,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    target: SubscriptionCoreClaudeUsageTarget;
  },
  deps: Pick<SubscriptionCoreConnectionProbeDeps, "fetchImpl" | "requestFetch" | "resolver"> & {
    now?: () => number;
  } = {},
): Promise<{ usage: ClaudeSubscriptionUsage; recovered: boolean }> {
  const now = deps.now ?? Date.now;
  const { target } = input;
  const stored = projectSubscriptionCoreClaudeUsage(target.row);
  const key = [
    input.accountId,
    input.workspaceId,
    target.connectionId,
    subscriptionCoreClaudeUsageVersion(target.row),
  ].join(":");
  // The connection needs a new sign-in: no read until it reconnects.
  if (stored.refreshStatus === "reconnect") return { usage: stored, recovered: false };
  const storedAt =
    stored.refreshStatus === "available" && stored.refreshCheckedAt !== null
      ? Date.parse(stored.refreshCheckedAt)
      : null;
  if (storedAt !== null && now() - storedAt < SUBSCRIPTION_CORE_CLAUDE_USAGE_REFRESH_INTERVAL_MS)
    return { usage: stored, recovered: false };
  const last = lastAttempts.get(key);
  if (
    last &&
    now() - last.at < SUBSCRIPTION_CORE_CLAUDE_USAGE_REFRESH_INTERVAL_MS &&
    (storedAt === null || last.at > storedAt)
  )
    return {
      usage: projectSubscriptionCoreClaudeUsage(target.row, last.refresh),
      recovered: false,
    };
  const binding = claudeBinding();
  const scope = {
    kind: "workspace" as const,
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
  };
  const modelIds = await listSubscriptionCoreClaudeCatalogModelIds(db, input);
  const probe = await subscriptionCoreOperationConnections(
    binding,
  ).probeSubscriptionCoreConnectionUsage(db, settings, scope, target.connectionId, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.requestFetch ? { requestFetch: deps.requestFetch } : {}),
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    modelIds,
  });
  const checkedAt = new Date(now()).toISOString();
  const reading =
    probe.kind === "read" ? (probe.response as SubscriptionCoreClaudeUsageReading) : null;
  const refresh: SubscriptionCoreClaudeUsageRefresh =
    reading !== null && probe.kind === "read"
      ? {
          // An available reading the core did not record is not reported as read.
          status: reading.status === "available" && !probe.applied ? "unavailable" : reading.status,
          checkedAt: reading.checkedAt,
        }
      : probe.kind === "relogin"
        ? { status: "reconnect", checkedAt }
        : // Not readable here, unsupported, or a refresh or transport failure.
          { status: "unavailable", checkedAt };
  rememberAttempt(key, { at: now(), refresh });
  // The reading (or a relogin the refresh seam recorded) is read back as
  // committed. When the read-back fails (or the connection left the pool),
  // the row read before is answered, never as a fresh `available` reading.
  const after = await readSubscriptionCoreClaudeWorkspaceUsageTarget(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    accountIdParam: target.connectionId,
  }).catch(() => null);
  return {
    usage: after
      ? projectSubscriptionCoreClaudeUsage(after.row, refresh)
      : projectSubscriptionCoreClaudeUsage(
          target.row,
          refresh.status === "available" ? { status: "unavailable", checkedAt } : refresh,
        ),
    recovered: probe.kind === "read" && probe.recovered,
  };
}

/** Claude catalog readiness on the core, by the legacy model id prefixes. */
export type SubscriptionCoreClaudeCatalogReadiness = {
  /** `workspace-claude-subscription/` models: the workspace pool or an own personal connection. */
  workspace: boolean;
  /** `organization-claude-subscription/` models: the organization inference pool. */
  organization: boolean;
  /**
   * Each prefix's model restriction: the union of its serving allowlists,
   * each built from its own pool's assignment policies only (null: every
   * model).
   */
  restrictions: {
    readonly "organization-claude-subscription/": readonly string[] | null;
    readonly "workspace-claude-subscription/": readonly string[] | null;
  };
};

/** Whether a serving connection serves the organization inference pool here. */
function servesOrganizationPool(connection: SubscriptionCoreServingConnection): boolean {
  return connection.ownership === "shared" && connection.pools.includes("organization");
}

/** Whether a serving connection serves workspace-prefixed models here. */
function servesWorkspacePool(connection: SubscriptionCoreServingConnection): boolean {
  return connection.ownership === "personal" || connection.pools.includes("workspace");
}

/**
 * The connection's model policy as one pool sees it: a classified shared
 * connection keeps only that pool's assignment policies (a connection in
 * both pools never lets one pool's policy widen the other's prefix).
 */
function inPool(
  connection: SubscriptionCoreServingConnection,
  pool: "workspace" | "organization",
): SubscriptionCoreServingConnection {
  return connection.assignments === null
    ? connection
    : {
        ...connection,
        assignments: connection.assignments.filter((policy) => policy.inferencePool === pool),
      };
}

function allowlistUnion(
  connections: readonly SubscriptionCoreServingConnection[],
  pool: "workspace" | "organization",
) {
  const allowlists = connections.map((connection) =>
    subscriptionCoreConnectionAllowlist(inPool(connection, pool)),
  );
  return allowlists.some((allowed) => allowed === null)
    ? null
    : [...new Set(allowlists.flatMap((allowed) => allowed ?? []))].sort();
}

/** Not ready: what maintenance answers (deeply frozen; shared by every answer). */
export const SUBSCRIPTION_CORE_CLAUDE_NOT_READY: SubscriptionCoreClaudeCatalogReadiness =
  Object.freeze({
    workspace: false,
    organization: false,
    restrictions: Object.freeze({
      "organization-claude-subscription/": Object.freeze([] as string[]),
      "workspace-claude-subscription/": Object.freeze([] as string[]),
    }),
  });

/**
 * Claude readiness for new work of `subjectId` in this workspace on the core:
 * the core eligibility projection (shared pools; the subject's own personal
 * connections only in their own Personal workspace) split by the legacy
 * prefixes. Frozen v1 Claude snapshots are not read.
 */
export async function readSubscriptionCoreClaudeCatalogReadiness(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
): Promise<SubscriptionCoreClaudeCatalogReadiness> {
  const serving = await listSubscriptionCoreServingConnections(db, claudeBinding(), input);
  const organization = serving.filter(servesOrganizationPool);
  const workspace = serving.filter(servesWorkspacePool);
  return {
    workspace: workspace.length > 0,
    organization: organization.length > 0,
    restrictions: {
      "organization-claude-subscription/":
        organization.length > 0 ? allowlistUnion(organization, "organization") : [],
      "workspace-claude-subscription/":
        workspace.length > 0 ? allowlistUnion(workspace, "workspace") : [],
    },
  };
}

/**
 * Organization custom-model admission on the core: the workspace's
 * effective Claude source admits organization connections and an active,
 * allocatable organization-pool shared connection admits the model. Shared
 * capacity only: no person (and no session creator) is read or inferred.
 */
export async function subscriptionCoreClaudeOrganizationModelAdmitted(
  db: Database,
  input: { accountId: string; workspaceId: string; upstreamModelId: string },
): Promise<boolean> {
  const productModelId = `${ORGANIZATION_PREFIX}/${input.upstreamModelId}`;
  const serving = await listSubscriptionCoreServingConnections(db, claudeBinding(), {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: null,
  });
  return serving.some(
    (connection) =>
      servesOrganizationPool(connection) &&
      subscriptionCoreConnectionAllowsModel(inPool(connection, "organization"), productModelId),
  );
}

/**
 * The carrier whose accepted Claude authority an admission re-reads on the
 * core, when the work it admits was accepted before this request:
 *
 * - `session_initial`: a new session's initial authority (session creation);
 * - `session_turn`: an edit's source turn, whose authority the edit copies;
 * - `receiving_session`: agent-submitted work, which takes the receiving
 *   session's accepted source (its execution-context turn, else its latest
 *   turn, else its initial authority);
 * - `scheduled_task`: a scheduled-task update.
 *
 * A human's own new work and a service actor's work carry none: they
 * resolve the workspace's current source.
 */
export type SubscriptionCoreClaudeAdmissionCarrier =
  | { kind: "session_initial"; sessionId: string }
  | { kind: "session_turn"; turnId: string }
  | { kind: "receiving_session"; sessionId: string }
  | { kind: "scheduled_task"; scheduledTaskId: string };

/**
 * Whether a carrier's accepted Claude authority (0716's
 * `read_subscription_authority_compat`) lets the core admit an organization
 * model for it:
 *
 * - a compatibility record (a carrier accepted before the cutover) admits
 *   only when its shared pool is the organization's;
 * - a carrier accepted after the cutover (`v2` or `none`: it has no record)
 *   follows the same source rule as new work;
 * - anything else (not visible, `missing`, `v1`, an unknown answer, or a
 *   database without the reader) admits nothing.
 */
export function subscriptionCoreClaudeAcceptedAuthorityAdmitsOrganization(
  compat: unknown,
): boolean {
  if (compat === null || typeof compat !== "object" || Array.isArray(compat)) return false;
  const value = compat as { authority?: unknown; sharedPool?: unknown };
  if (value.authority === "record") return value.sharedPool === "organization";
  return value.authority === "v2" || value.authority === "none";
}

/**
 * The compatibility carrier of agent-submitted work: the receiving
 * session's accepted source, as the v1 receiver authority reads it (its
 * execution-context turn, else its latest accepted turn, else the session's
 * initial authority). Null when the session is not visible.
 */
async function receivingSessionCarrier(
  tx: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<{ kind: "session_turn" | "session_initial"; id: string } | null> {
  const [row] = await rawRows<{ kind: "session_turn" | "session_initial"; id: string }>(
    tx,
    sql`select case when coalesce(context_turn.id, latest_turn.id) is null
          then 'session_initial' else 'session_turn' end as kind,
        coalesce(context_turn.id, latest_turn.id, session.id)::text as id
      from sessions session
      left join session_turns context_turn
        on context_turn.workspace_id = session.workspace_id
        and context_turn.session_id = session.id
        and context_turn.id = session.execution_context_turn_id
      left join lateral (
        select turn.id from session_turns turn
        where turn.workspace_id = session.workspace_id and turn.session_id = session.id
        order by turn.created_at desc, turn.position desc, turn.id desc
        limit 1
      ) latest_turn on true
      where session.workspace_id = ${input.workspaceId}::uuid
        and session.id = ${input.sessionId}::uuid`,
  );
  return row ? { kind: row.kind, id: row.id } : null;
}

/** The carrier's effective Claude authority, or null (not visible, or no reader). */
async function readSubscriptionCoreClaudeAcceptedAuthority(
  tx: Database,
  input: { workspaceId: string; carrier: SubscriptionCoreClaudeAdmissionCarrier },
): Promise<unknown> {
  const [present] = await rawRows<{ present: boolean }>(
    tx,
    sql`select to_regprocedure(
        'opengeni_private.read_subscription_authority_compat(text,text,uuid,uuid,bigint)'
      ) is not null as present`,
  );
  if (present?.present !== true) return null;
  const { carrier } = input;
  const resolved =
    carrier.kind === "receiving_session"
      ? await receivingSessionCarrier(tx, {
          workspaceId: input.workspaceId,
          sessionId: carrier.sessionId,
        })
      : carrier.kind === "session_initial"
        ? { kind: carrier.kind, id: carrier.sessionId }
        : carrier.kind === "session_turn"
          ? { kind: carrier.kind, id: carrier.turnId }
          : { kind: carrier.kind, id: carrier.scheduledTaskId };
  if (resolved === null || !UUID.test(resolved.id)) return null;
  const [row] = await rawRows<{ authority: unknown }>(
    tx,
    sql`select opengeni_private.read_subscription_authority_compat(
        ${SUBSCRIPTION_CORE_CLAUDE_PROVIDER}, ${resolved.kind}, ${input.workspaceId}::uuid,
        ${resolved.id}::uuid, null
      ) as authority`,
  );
  return row?.authority ?? null;
}

/**
 * Claude organization custom-model admission on the core route (the
 * `claude_subscription` branch of
 * `lockActiveOrganizationModelProviderCustomModelForAdmission`), inside the
 * caller's workspace-scoped transaction:
 *
 * - the transaction's subject must be established by the admission caller
 *   (as on the legacy route); it is never replaced by a session creator and
 *   no person is inferred for a service actor;
 * - work accepted before this request (a carrier: a new session's initial
 *   authority, an edit's source turn, the receiving session of
 *   agent-submitted work, a scheduled task) first reads that accepted
 *   authority (`subscriptionCoreClaudeAcceptedAuthorityAdmitsOrganization`);
 *   without the reader nothing is admitted;
 * - then the workspace's effective Claude source must admit organization
 *   connections and a live organization-pool connection must admit the model.
 */
export async function subscriptionCoreClaudeCustomModelAdmitted(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    upstreamModelId: string;
    carrier: SubscriptionCoreClaudeAdmissionCarrier | null;
  },
): Promise<boolean> {
  const [scope] = await rawRows<{ subjectId: string | null }>(
    tx,
    sql`select nullif(current_setting('opengeni.subject_id', true), '') as "subjectId"`,
  );
  if (!scope?.subjectId) return false;
  if (
    input.carrier !== null &&
    !subscriptionCoreClaudeAcceptedAuthorityAdmitsOrganization(
      await readSubscriptionCoreClaudeAcceptedAuthority(tx, {
        workspaceId: input.workspaceId,
        carrier: input.carrier,
      }),
    )
  )
    return false;
  return await subscriptionCoreClaudeOrganizationModelAdmitted(tx, input);
}
