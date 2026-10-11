/**
 * Provider readiness for catalog, default-model and admission reads on the
 * shared subscription core, for any provider.
 *
 * Callers decide by the provider's cutover disposition first: a disabled
 * row reports the provider as not ready (fail closed), and an enabled row
 * reads only what is listed here.
 *
 * Connections that count, for one workspace and one acting subject:
 *
 * - active, allocatable shared connections in chat placement's effective
 *   inference pools. Automatic includes both workspace and organization
 *   candidates;
 * - the acting person's own personal connections, only in their own Personal
 *   workspace (generic workspace readers never represent a private session's
 *   exact accepted context), only while the effective settings allow
 *   personal connections and only when active and allocatable. They are read
 *   through the owner-only reader, so another person's personal connection
 *   is never seen. Fallback consent applies to private work outside the
 *   owner's Personal workspace, which this catalog reader does not represent.
 *
 * A connection's model policy is what placement intersects: the connection
 * allowlist and exclusions, and the workspace assignment policies of the
 * effective inference source. Nothing here returns credential material.
 */
import { inferenceSourceFor, providerSwitchesFor } from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";
import { rawRows, rlsContextForWorkspace, withRlsContext, type Database } from "../database";
import { namedSubjectPersonalWorkspaceId } from "../slack-routing-personal-workspace";
import {
  decodeSubscriptionQuota,
  listSubscriptionConnectionsForPlacement,
  listSubscriptionConnectionAssignmentPolicies,
  readSubscriptionEffectiveSettings,
  readSubscriptionProviderCutoverState,
} from "../subscription-core-repository";
import {
  listSubscriptionCorePersonalConnectionRowsInTransaction,
  readSubscriptionCoreCutoverDisposition,
  type SubscriptionCoreCutoverDisposition,
} from "./administration";
import {
  subscriptionCoreConnectionKind,
  subscriptionCoreProviderId,
  type SubscriptionCoreProvider,
} from "./provider";

export type SubscriptionCoreServingConnection = {
  connectionId: string;
  ownership: "shared" | "personal";
  planType: string | null;
  /** The connection's own model allowlist (null: every model). */
  allowedModelIds: string[] | null;
  /** Models the connection excludes. */
  excludedModelIds: string[];
  /**
   * The workspace assignment policies of the effective inference source; null
   * when none apply (personal, or a shared connection classified by
   * management). Placement requires one of them to admit the model.
   */
  assignments: Array<{ allowedModelIds: string[] | null; excludedModelIds: string[] }> | null;
  /**
   * Product models with a live per-model cooldown on this connection (a
   * proven plan refusal). Read for personal connections, whose live model
   * list cannot be read outside an exact accepted turn.
   */
  cooledDownModelIds: string[];
};

type ModelPolicy = Pick<
  SubscriptionCoreServingConnection,
  "allowedModelIds" | "excludedModelIds" | "assignments"
>;

/** Placement's static model admission for one connection (allowlists and exclusions). */
export function subscriptionCoreConnectionAllowsModel(
  connection: ModelPolicy,
  modelId: string,
): boolean {
  if (connection.excludedModelIds.includes(modelId)) return false;
  if (connection.allowedModelIds !== null && !connection.allowedModelIds.includes(modelId))
    return false;
  return (
    connection.assignments === null ||
    connection.assignments.some(
      (policy) =>
        (policy.allowedModelIds === null || policy.allowedModelIds.includes(modelId)) &&
        !policy.excludedModelIds.includes(modelId),
    )
  );
}

/**
 * The connection's admitted models as one allowlist (null: every model), for
 * the catalog's per-provider restriction union. Exclusions without an
 * allowlist cannot be listed; placement still refuses those models.
 */
export function subscriptionCoreConnectionAllowlist(connection: ModelPolicy): string[] | null {
  let allowed = connection.allowedModelIds;
  if (connection.assignments !== null) {
    const assignmentUnion = connection.assignments.some((policy) => policy.allowedModelIds === null)
      ? null
      : [...new Set(connection.assignments.flatMap((policy) => policy.allowedModelIds ?? []))];
    allowed =
      allowed === null
        ? assignmentUnion
        : assignmentUnion === null
          ? allowed
          : allowed.filter((modelId) => assignmentUnion.includes(modelId));
  }
  return allowed === null
    ? null
    : allowed.filter((modelId) => subscriptionCoreConnectionAllowsModel(connection, modelId));
}

/**
 * The provider's cutover disposition for a workspace whose organization the
 * caller does not hold. One extra workspace-to-organization lookup.
 */
export async function readSubscriptionCoreCutoverDispositionForWorkspace(
  db: Database,
  provider: SubscriptionCoreProvider,
  workspaceId: string,
  accountId?: string | null,
): Promise<{ accountId: string; disposition: SubscriptionCoreCutoverDisposition }> {
  const organizationId = accountId ?? (await rlsContextForWorkspace(db, workspaceId)).accountId;
  return {
    accountId: organizationId,
    disposition: await readSubscriptionCoreCutoverDisposition(
      db,
      provider,
      organizationId,
      workspaceId,
    ),
  };
}

/**
 * Live per-model cooldowns of one connection, sorted by model id. A cooldown
 * ends at its stored time as a Date holds it (whole milliseconds).
 */
function liveModelCooldowns(quota: ReturnType<typeof decodeSubscriptionQuota>, now: Date) {
  return Object.entries(quota?.modelCooldowns ?? {})
    .filter(([, until]) => Number.isFinite(until) && new Date(until).getTime() > now.getTime())
    .map(([modelId]) => modelId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The core connections of this provider that can serve new work of
 * `subjectId` in this workspace (see the module comment). Empty without an
 * enabled cutover. A null or non-human subject sees shared capacity only.
 */
export async function listSubscriptionCoreServingConnections(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
  now: Date = new Date(),
): Promise<SubscriptionCoreServingConnection[]> {
  const providerId = subscriptionCoreProviderId(provider);
  const personalWorkspace =
    input.subjectId?.startsWith("user:") === true &&
    (await namedSubjectPersonalWorkspaceId(db, {
      accountId: input.accountId,
      subjectId: input.subjectId,
    })) === input.workspaceId;
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const cutover = await readSubscriptionProviderCutoverState(tx, {
        accountId: input.accountId,
        provider: providerId,
      });
      if (cutover !== "enabled") return [];
      const effective = await readSubscriptionEffectiveSettings(
        tx,
        input.accountId,
        input.workspaceId,
      );
      const source = inferenceSourceFor(effective.values, providerId);
      if (!providerSwitchesFor(effective.values, providerId).enabled) return [];
      const [workspace] = await rawRows<{ kind: string }>(
        tx,
        sql`select get_workspace_kind(${input.accountId}::uuid, ${input.workspaceId}::uuid) as kind`,
      );
      const world = await listSubscriptionConnectionsForPlacement(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        provider: providerId,
        kind: subscriptionCoreConnectionKind(provider),
      });
      const shared = world.filter((connection) => {
        if (
          connection.ownership.kind !== "shared" ||
          connection.health !== "healthy" ||
          !connection.allocatorEnabled
        )
          return false;
        const scope = connection.ownership.scope;
        if (
          scope.kind !== "organization" &&
          !(
            scope.kind === "workspaces" &&
            (scope.workspaceIds.includes(input.workspaceId) ||
              (workspace?.kind === "personal" && scope.allowPersonalWorkspaces))
          )
        )
          return false;
        if (connection.assignmentPolicies)
          return connection.assignmentPolicies.some(
            (policy) =>
              policy.allocatorEnabled &&
              (source === "automatic" || policy.inferencePool === source),
          );
        return (
          source === "automatic" ||
          source ===
            (connection.ownership.managedByWorkspaceId === input.workspaceId
              ? "workspace"
              : "organization")
        );
      });
      const sharedIds = shared.map((candidate) => candidate.id);
      const [policies, exclusions] = await Promise.all([
        sharedIds.length === 0
          ? Promise.resolve([])
          : listSubscriptionConnectionAssignmentPolicies(tx, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              provider: providerId,
            }),
        sharedIds.length === 0
          ? Promise.resolve([])
          : rawRows<{ id: string; excluded_models: string[] | null; plan_type: string | null }>(
              tx,
              sql`select connection.id::text as id, connection.excluded_models, connection.plan_type
                from subscription_connections connection
                where connection.account_id = ${input.accountId}::uuid
                  and connection.id in (${sql.join(
                    sharedIds.map((id) => sql`${id}::uuid`),
                    sql`, `,
                  )})`,
            ),
      ]);
      const excludedById = new Map(exclusions.map((row) => [row.id, row.excluded_models ?? []]));
      const servingShared = shared.map((candidate) => {
        const applicable = policies.filter(
          (policy) =>
            policy.connectionId === candidate.id &&
            policy.allocatorEnabled &&
            (source === "automatic" || policy.inferencePool === source),
        );
        return {
          connectionId: candidate.id,
          ownership: "shared" as const,
          planType: exclusions.find((row) => row.id === candidate.id)?.plan_type ?? null,
          allowedModelIds:
            candidate.allowedModelIds === null ? null : [...candidate.allowedModelIds],
          excludedModelIds: excludedById.get(candidate.id) ?? [],
          // Placement reads explicit rows; without one the connection keeps
          // its management classification and only its own allowlist applies.
          assignments: policies.some((policy) => policy.connectionId === candidate.id)
            ? applicable.map((policy) => ({
                allowedModelIds: policy.allowedModelIds,
                excludedModelIds: policy.excludedModels,
              }))
            : null,
          cooledDownModelIds: [],
        };
      });
      if (
        !personalWorkspace ||
        !providerSwitchesFor(effective.values, providerId).enabled ||
        !effective.values.personalConnectionsAllowed
      ) {
        return servingShared;
      }
      // The owner-only reader returns only this person's own connections.
      const personal = await listSubscriptionCorePersonalConnectionRowsInTransaction(tx, provider, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId!,
      });
      return [
        ...servingShared,
        ...personal
          .filter((row) => row.status === "active" && row.allocator_enabled)
          .map((row) => ({
            connectionId: row.id,
            ownership: "personal" as const,
            planType: row.plan_type,
            allowedModelIds: row.allowed_model_ids ?? null,
            excludedModelIds: [],
            assignments: null,
            cooledDownModelIds: liveModelCooldowns(decodeSubscriptionQuota(row), now),
          })),
      ];
    },
  );
}

/**
 * The provider's readiness on the core: at least one connection can serve
 * new work of this subject here. False without an enabled cutover.
 */
export async function subscriptionCoreWorkspaceReady(
  db: Database,
  provider: SubscriptionCoreProvider,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
): Promise<boolean> {
  return (await listSubscriptionCoreServingConnections(db, provider, input)).length > 0;
}
