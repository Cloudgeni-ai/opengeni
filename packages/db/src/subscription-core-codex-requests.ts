/**
 * Codex request custody on the shared core: the provider-neutral runtime
 * (`./subscription-core/requests`) bound to Codex under the names M3
 * shipped, plus Codex Apps custody (Apps-only), which uses the core's source
 * lock and native reservation with its explicit workspace designation.
 */
import { sql } from "drizzle-orm";
import { withRlsContext, type Database } from "./database";
import {
  subscriptionCoreRequests,
  type SubscriptionCoreRequestOutcome,
} from "./subscription-core/requests";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";

export {
  SubscriptionCoreCodexRequestOutcomeUnknownError,
  SubscriptionCoreCodexSourceDisconnectedError,
} from "./subscription-core-codex-errors";

export type SubscriptionCoreCodexRequestOutcome = SubscriptionCoreRequestOutcome;
type Request = { requestId: string; transportAttempt: number };

const core = subscriptionCoreRequests(SUBSCRIPTION_CORE_CODEX);

export const reserveSubscriptionCoreCodexRequest = core.reserveSubscriptionCoreRequest;
/** Read-only credential probes retain exact turn authority, not model custody. */
export const reserveSubscriptionCoreCodexTurnCredentialRequest =
  core.reserveSubscriptionCoreTurnCredentialRequest;
export const reserveSubscriptionCoreCodexOperationRequest =
  core.reserveSubscriptionCoreOperationRequest;
export const settleSubscriptionCoreCodexRequest = core.settleSubscriptionCoreRequest;
/** Same exact holder/attempt settlement, without misclassifying a read as a model call. */
export const settleSubscriptionCoreCodexTurnCredentialRequest = settleSubscriptionCoreCodexRequest;
export const settleSubscriptionCoreCodexOperationRequest =
  core.settleSubscriptionCoreOperationRequest;
export const isSubscriptionCoreCodexSourceDisconnected = core.isSubscriptionCoreSourceDisconnected;

/** Apps uses its explicit workspace designation, never a borrowed human/turn. */
export async function reserveSubscriptionCoreCodexAppsRequest(
  db: Database,
  target: { accountId: string; workspaceId: string; connectionId: string },
  request: Request,
): Promise<{ operationId: string }> {
  return withRlsContext(db, target, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`codex-apps-settings:${target.workspaceId}`}, 0))`);
    return core.reserveSubscriptionCoreDesignatedRequest(tx, target, {
      requestId: request.requestId,
      transportAttempt: request.transportAttempt,
      operationKind: "apps",
    });
  });
}

export async function settleSubscriptionCoreCodexAppsRequest(
  db: Database,
  target: { accountId: string; workspaceId: string; connectionId: string },
  request: {
    operationId: string;
    outcome: SubscriptionCoreCodexRequestOutcome;
  },
): Promise<void> {
  await withRlsContext(db, target, async (tx) => {
    await tx.execute(sql`update subscription_operation_leases set request_outcome = ${request.outcome}
      where account_id = ${target.accountId}::uuid and workspace_id = ${target.workspaceId}::uuid
        and connection_id = ${target.connectionId}::uuid and operation_id = ${request.operationId}::uuid
        and operation_kind = 'apps' and request_id is not null
        and request_outcome in ('reserved', 'unknown')`);
  });
}
