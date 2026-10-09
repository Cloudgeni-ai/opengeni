/**
 * Codex readiness for catalog, default-model and admission reads on the
 * shared subscription core (M3 PR 3 review fix).
 *
 * After the drained cutover (0680) the legacy Codex tables are frozen and
 * their ciphertext is blank, so "is Codex ready in this workspace, and which
 * models may its connections serve?" must be answered from the core for an
 * organization with an enabled Codex cutover row. Callers decide by
 * `readCodexCutoverDisposition` (or `readCodexCutoverDispositionForWorkspace`):
 * no row keeps the legacy readers unchanged, a disabled row reports Codex as
 * not ready (fail closed) without reading a legacy table, and an enabled row
 * reads only what is listed here.
 *
 * Connections that count, for one workspace and one acting subject:
 *
 * - shared organization- or workspace-scoped connections that can serve an
 *   operation here (`listSubscriptionCoreCodexOperationCandidates`: active,
 *   allocatable, in the effective inference pool, cutover enabled). This is
 *   the same rule as Codex Live readiness and transcription;
 * - the acting person's own personal connections, only in their own Personal
 *   workspace (the only place a new chat of theirs freezes personal
 *   authority), only while the effective settings allow personal connections
 *   and personal fallback (chat placement uses a personal connection only as
 *   fallback), and only when active and allocatable. They are read through
 *   the owner-only reader, so another person's personal connection is never
 *   seen. The person's own fallback opt-in is readable only inside an exact
 *   accepted turn and is not checked here; placement still enforces it.
 *
 * A connection's model policy is what placement intersects: the connection
 * allowlist and exclusions, and the workspace assignment policies of the
 * effective inference source. Nothing here returns credential material.
 */
import { inferenceSourceFor, providerSwitchesFor } from "@opengeni/subscriptions";
import { sql } from "drizzle-orm";
import { CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS } from "./codex-plan-entitlement";
import { rawRows, rlsContextForWorkspace, withRlsContext, type Database } from "./database";
import { namedSubjectPersonalWorkspaceId } from "./slack-routing-personal-workspace";
import {
  listSubscriptionCoreCodexPersonalAccountsInTransaction,
  readCodexCutoverDisposition,
  type CodexCutoverDisposition,
} from "./subscription-core-codex-compat";
import { listSubscriptionCoreCodexOperationCandidates } from "./subscription-core-codex-operations";
import {
  listSubscriptionConnectionAssignmentPolicies,
  readSubscriptionEffectiveSettings,
  readSubscriptionProviderCutoverState,
} from "./subscription-core-repository";

/** The service subject a subjectless workspace read acts as (shared capacity only). */
const CATALOG_SERVICE_SUBJECT = "service:subscription-core";

export type SubscriptionCoreCodexServingConnection = {
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

/** Placement's static model admission for one connection (allowlists and exclusions). */
export function subscriptionCoreCodexConnectionAllowsModel(
  connection: Pick<
    SubscriptionCoreCodexServingConnection,
    "allowedModelIds" | "excludedModelIds" | "assignments"
  >,
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
export function subscriptionCoreCodexConnectionAllowlist(
  connection: Pick<
    SubscriptionCoreCodexServingConnection,
    "allowedModelIds" | "excludedModelIds" | "assignments"
  >,
): string[] | null {
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
    : allowed.filter((modelId) => subscriptionCoreCodexConnectionAllowsModel(connection, modelId));
}

/**
 * The cutover disposition for a workspace whose organization the caller does
 * not hold. One extra workspace-to-organization lookup.
 */
export async function readCodexCutoverDispositionForWorkspace(
  db: Database,
  workspaceId: string,
  accountId?: string | null,
): Promise<{ accountId: string; disposition: CodexCutoverDisposition }> {
  const organizationId = accountId ?? (await rlsContextForWorkspace(db, workspaceId)).accountId;
  return {
    accountId: organizationId,
    disposition: await readCodexCutoverDisposition(db, organizationId, workspaceId),
  };
}

/**
 * The core Codex connections that can serve new work of `subjectId` in this
 * workspace (see the module comment). Empty without an enabled cutover. A
 * null or non-human subject sees shared capacity only.
 */
export async function listSubscriptionCoreCodexServingConnections(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
  now: Date = new Date(),
): Promise<SubscriptionCoreCodexServingConnection[]> {
  const shared = await listSubscriptionCoreCodexOperationCandidates(db, {
    kind: "workspace",
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId ?? CATALOG_SERVICE_SUBJECT,
  });
  const personalWorkspace =
    input.subjectId?.startsWith("user:") === true &&
    (await namedSubjectPersonalWorkspaceId(db, {
      accountId: input.accountId,
      subjectId: input.subjectId,
    })) === input.workspaceId;
  if (shared.length === 0 && !personalWorkspace) return [];
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (tx) => {
      const cutover = await readSubscriptionProviderCutoverState(tx, {
        accountId: input.accountId,
        provider: "codex",
      });
      if (cutover !== "enabled") return [];
      const effective = await readSubscriptionEffectiveSettings(
        tx,
        input.accountId,
        input.workspaceId,
      );
      const source = inferenceSourceFor(effective.values, "codex");
      const sharedIds = shared.map((candidate) => candidate.connectionId);
      const [policies, exclusions] = await Promise.all([
        sharedIds.length === 0
          ? Promise.resolve([])
          : listSubscriptionConnectionAssignmentPolicies(tx, {
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              provider: "codex",
            }),
        sharedIds.length === 0
          ? Promise.resolve([])
          : rawRows<{ id: string; excluded_models: string[] | null }>(
              tx,
              sql`select connection.id::text as id, connection.excluded_models
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
            policy.connectionId === candidate.connectionId &&
            (source === "automatic" || policy.inferencePool === source),
        );
        return {
          connectionId: candidate.connectionId,
          ownership: "shared" as const,
          planType: candidate.planType,
          allowedModelIds: candidate.allowedModelIds,
          excludedModelIds: excludedById.get(candidate.connectionId) ?? [],
          // Placement reads explicit rows; without one the connection keeps
          // its management classification and only its own allowlist applies.
          assignments: policies.some((policy) => policy.connectionId === candidate.connectionId)
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
        !providerSwitchesFor(effective.values, "codex").enabled ||
        !effective.values.personalConnectionsAllowed ||
        !effective.values.personalFallbackAllowed
      ) {
        return servingShared;
      }
      // The owner-only reader returns only this person's own connections.
      const personal = await listSubscriptionCoreCodexPersonalAccountsInTransaction(tx, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId!,
      });
      return [
        ...servingShared,
        ...personal
          .filter((account) => account.status === "active" && account.allocatorEnabled)
          .map((account) => ({
            connectionId: account.id,
            ownership: "personal" as const,
            planType: account.planType,
            allowedModelIds: account.allowedModelIds ?? null,
            excludedModelIds: [],
            assignments: null,
            cooledDownModelIds: (account.planEntitlementExclusion?.models ?? [])
              .filter(
                (model) =>
                  model.excludedAt.getTime() + CODEX_PLAN_ENTITLEMENT_EXCLUSION_TTL_MS >
                  now.getTime(),
              )
              .map((model) => model.modelId),
          })),
      ];
    },
  );
}

/**
 * Codex readiness on the core: at least one connection can serve new work of
 * this subject here. False without an enabled cutover.
 */
export async function subscriptionCoreCodexWorkspaceReady(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string | null },
): Promise<boolean> {
  return (await listSubscriptionCoreCodexServingConnections(db, input)).length > 0;
}
