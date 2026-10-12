import { and, eq, max, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import {
  countTurnServingPolicyChangesV1,
  readTurnExecutionPolicyV1,
  readTurnServingPolicyV1,
  readTurnPendingServingPolicyV1,
  TurnPendingServingPolicyV1,
  TURN_PENDING_SERVING_POLICY_METADATA_KEY,
  TURN_SERVING_POLICY_METADATA_KEY,
  TurnServingPolicyV1,
  type TurnServingPolicyReadV1,
} from "@opengeni/contracts";
import { isTransactionHandle, rawRows, withRlsContext, type Database } from "../database";
import {
  lockTurnAttemptWriteFenceTx,
  type TurnAttemptFenceRejectReason,
} from "../session-attempt-fence";
import { sessionHistoryItems, sessionTurns } from "../schema";

type TurnScope = { accountId: string; workspaceId: string; sessionId: string; turnId: string };
export const SUBSCRIPTION_CORE_SERVING_FAILOVER_LIMIT = 4;
type ServingWriteFence = Extract<
  Awaited<ReturnType<typeof lockTurnAttemptWriteFenceTx>>,
  { allowed: true }
>;
type ServingInput = TurnScope & {
  /** D-43. An omitted gate is OFF; C2 supplies the deployment setting. */
  crossProviderFailoverEnabled?: boolean | undefined;
  attemptId: string;
  executionGeneration: number;
  policy: TurnServingPolicyV1["policy"];
  connectionId: string;
  reason: TurnServingPolicyV1["reason"];
};
type ServingWriteResult =
  | { accepted: true; installed: boolean; revision: TurnServingPolicyV1; modelChangeCount: number }
  | {
      accepted: false;
      reason:
        | TurnAttemptFenceRejectReason
        | "disabled"
        | "accepted_policy_absent"
        | "credential_restricted"
        | "failover_bound_exceeded";
    };

/** Owns its transaction: call only AFTER placement commits, using a pool handle.
 * The fence takes the turn FOR UPDATE. Request reservation takes it FOR SHARE
 * then the binding FOR UPDATE. Writing here while placement holds a binding
 * would invert that order and deadlock. Any future switched event must be in
 * THIS fenced transaction, never in placement; C1 emits no event.
 *
 * The turn lock serializes append and dedupe. Exactly one receipt is allowed per
 * (turn, execution generation), including claim-time recording and retries.
 * Conflicting retries fail closed; neither the accepted policy nor old receipts
 * can be replaced. This is persistence, not placement or renewed authority.
 */
export async function recordSubscriptionCoreServingPolicyForTurnAttempt(
  db: Database,
  input: ServingInput,
): Promise<ServingWriteResult> {
  if (input.crossProviderFailoverEnabled !== true) return { accepted: false, reason: "disabled" };
  if (isTransactionHandle(db))
    throw new Error("Serving revisions must be recorded outside the placement transaction");
  return withRlsContext(db, input, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, input);
    if (!fence.allowed) return { accepted: false, reason: fence.reason };
    const accepted = readTurnExecutionPolicyV1(fence.turn.metadata);
    if (accepted.kind === "absent") return { accepted: false, reason: "accepted_policy_absent" };
    if (accepted.policy.credentialRestriction !== undefined)
      return { accepted: false, reason: "credential_restricted" };
    const stored = readTurnServingPolicyV1(fence.turn.metadata);
    const revisions = stored.kind === "valid" ? stored.revisions : [];
    const existing = revisions.find(
      (revision) => revision.executionGeneration === input.executionGeneration,
    );
    // Retry keeps the ORIGINAL history boundary even if history advanced since.
    const candidate = TurnServingPolicyV1.parse({
      schemaVersion: 1,
      policy: input.policy,
      executionGeneration: input.executionGeneration,
      connectionId: input.connectionId,
      reason: input.reason,
      historyPosition: existing?.historyPosition ?? 0,
    });
    if (existing) {
      if (!isDeepStrictEqual(existing, candidate))
        throw new Error("Conflicting serving revision for execution generation");
      return {
        accepted: true,
        installed: false,
        revision: existing,
        modelChangeCount: countTurnServingPolicyChangesV1(revisions),
      };
    }
    const pending = readTurnPendingServingPolicyV1(fence.turn.metadata);
    const previous = revisions.at(-1);
    if (pending) {
      if (
        pending.sourceExecutionGeneration >= input.executionGeneration ||
        previous?.executionGeneration !== pending.sourceExecutionGeneration ||
        !isDeepStrictEqual(pending.policy, candidate.policy) ||
        pending.connectionId !== candidate.connectionId ||
        pending.reason !== candidate.reason
      ) {
        throw new Error("Pending serving target does not match the newly claimed generation");
      }
    } else if (previous && !isDeepStrictEqual(previous.policy, candidate.policy)) {
      throw new Error("A changed serving policy requires a pending recovery target");
    }
    const modelChangeCount = countTurnServingPolicyChangesV1([...revisions, candidate]);
    if (
      modelChangeCount > countTurnServingPolicyChangesV1(revisions) &&
      modelChangeCount + (await servingRefusalsTx(tx, input)) >
        SUBSCRIPTION_CORE_SERVING_FAILOVER_LIMIT
    ) {
      return { accepted: false, reason: "failover_bound_exceeded" };
    }
    const [history] = await tx
      .select({ position: max(sessionHistoryItems.position) })
      .from(sessionHistoryItems)
      .where(
        and(
          eq(sessionHistoryItems.accountId, input.accountId),
          eq(sessionHistoryItems.workspaceId, input.workspaceId),
          eq(sessionHistoryItems.sessionId, input.sessionId),
        ),
      );
    const revision = TurnServingPolicyV1.parse({
      ...candidate,
      historyPosition: Number(history?.position ?? 0),
    });
    const next = [...revisions, revision];
    const metadata: Record<string, unknown> = {
      ...fence.turn.metadata,
      [TURN_SERVING_POLICY_METADATA_KEY]: next,
    };
    if (pending) delete metadata[TURN_PENDING_SERVING_POLICY_METADATA_KEY];
    readTurnServingPolicyV1(metadata);
    const [updated] = await tx
      .update(sessionTurns)
      .set({ metadata, updatedAt: new Date() })
      .where(
        and(
          eq(sessionTurns.accountId, input.accountId),
          eq(sessionTurns.workspaceId, input.workspaceId),
          eq(sessionTurns.sessionId, input.sessionId),
          eq(sessionTurns.id, input.turnId),
        ),
      )
      .returning({ id: sessionTurns.id });
    if (!updated) throw new Error("Serving revision owner changed while its turn was locked");
    return {
      accepted: true,
      installed: true,
      revision,
      modelChangeCount: countTurnServingPolicyChangesV1(next),
    };
  });
}

/** C2 recovery seam: the caller MUST already hold this exact allowed fence in
 * this same transaction, acquired before any binding locks. No transaction or
 * fence is opened here. C2 will call it inside recovery's atomic transition,
 * after placement commits. A plain placement transaction is not a write fence.
 */
export async function stageSubscriptionCorePendingServingPolicyTx(
  tx: Database,
  input: ServingInput,
  fence: ServingWriteFence,
): Promise<TurnPendingServingPolicyV1 | null> {
  if (input.crossProviderFailoverEnabled !== true) return null;
  if (
    !isTransactionHandle(tx) ||
    !fence.allowed ||
    fence.turn.accountId !== input.accountId ||
    fence.turn.workspaceId !== input.workspaceId ||
    fence.turn.sessionId !== input.sessionId ||
    fence.turn.id !== input.turnId ||
    fence.turn.executionGeneration !== input.executionGeneration ||
    fence.turn.activeAttemptId !== input.attemptId ||
    fence.attempt.id !== input.attemptId
  ) {
    throw new Error("Pending serving target requires the exact recovery transaction fence");
  }
  // Re-read under the caller's held lock so repeated calls in the SAME recovery
  // transaction cannot overwrite a prior proposal using an older fence snapshot.
  const [turn] = await tx
    .select({ metadata: sessionTurns.metadata })
    .from(sessionTurns)
    .where(
      and(
        eq(sessionTurns.accountId, input.accountId),
        eq(sessionTurns.workspaceId, input.workspaceId),
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.id, input.turnId),
        eq(sessionTurns.executionGeneration, input.executionGeneration),
        eq(sessionTurns.activeAttemptId, input.attemptId),
      ),
    )
    .limit(1);
  if (!turn) throw new Error("Pending serving target lost its turn fence");
  const accepted = readTurnExecutionPolicyV1(turn.metadata);
  if (accepted.kind !== "valid" || accepted.policy.credentialRestriction !== undefined)
    throw new Error("Pending serving target requires unrestricted accepted policy");
  const serving = readTurnServingPolicyV1(turn.metadata);
  if (
    serving.kind !== "valid" ||
    serving.revisions.at(-1)?.executionGeneration !== input.executionGeneration
  )
    throw new Error("Pending serving target requires this generation's serving baseline");
  const target = TurnPendingServingPolicyV1.parse({
    schemaVersion: 1,
    sourceExecutionGeneration: input.executionGeneration,
    sourceAttemptId: input.attemptId,
    policy: input.policy,
    connectionId: input.connectionId,
    reason: input.reason,
  });
  const existingTarget = readTurnPendingServingPolicyV1(turn.metadata);
  if (existingTarget) {
    if (!isDeepStrictEqual(existingTarget, target))
      throw new Error("Conflicting pending serving target");
    return existingTarget;
  }
  if (
    countTurnServingPolicyChangesV1(serving.revisions) + (await servingRefusalsTx(tx, input)) >=
    SUBSCRIPTION_CORE_SERVING_FAILOVER_LIMIT
  )
    throw new Error("Serving failover bound exceeded");
  const [updated] = await tx
    .update(sessionTurns)
    .set({
      metadata: { ...turn.metadata, [TURN_PENDING_SERVING_POLICY_METADATA_KEY]: target },
      updatedAt: new Date(),
    })
    .where(and(eq(sessionTurns.workspaceId, input.workspaceId), eq(sessionTurns.id, input.turnId)))
    .returning({ id: sessionTurns.id });
  if (!updated) throw new Error("Pending serving target lost its turn fence");
  return target;
}

/** The turn fence and scoped RLS are already held. Do not use per-provider
 * helpers: a provider hold must not erase its existing refusals from D-39.
 * B1's public all-provider counting read can share this aggregation later.
 */
async function servingRefusalsTx(tx: Database, input: TurnScope): Promise<number> {
  const [row] = await rawRows<{ refusals: number | string }>(
    tx,
    sql`
    select coalesce(sum(coalesce((recovery_evidence->>'refusals')::integer, 1)), 0) as refusals
    from subscription_turn_failures where account_id = ${input.accountId}::uuid
      and workspace_id = ${input.workspaceId}::uuid and session_id = ${input.sessionId}::uuid
      and turn_id = ${input.turnId}::uuid`,
  );
  const count = Number(row?.refusals);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid turn refusal count");
  return count;
}

/** null means not visible, not "no revisions". Retains caller session RLS. */
export async function readSubscriptionCoreServingPolicyForTurn(
  db: Database,
  input: TurnScope,
): Promise<TurnServingPolicyReadV1 | null> {
  return withRlsContext(db, input, async (tx) => {
    const [turn] = await tx
      .select({ metadata: sessionTurns.metadata })
      .from(sessionTurns)
      .where(
        and(
          eq(sessionTurns.accountId, input.accountId),
          eq(sessionTurns.workspaceId, input.workspaceId),
          eq(sessionTurns.sessionId, input.sessionId),
          eq(sessionTurns.id, input.turnId),
        ),
      )
      .limit(1);
    return turn ? readTurnServingPolicyV1(turn.metadata) : null;
  });
}

/** D-39 counting read; a hidden turn must never manufacture a zero count. */
export async function countSubscriptionCoreTurnServingPolicyChanges(
  db: Database,
  input: TurnScope,
): Promise<number | null> {
  const read = await readSubscriptionCoreServingPolicyForTurn(db, input);
  if (read === null) return null;
  return countTurnServingPolicyChangesV1(read.kind === "valid" ? read.revisions : []);
}
