/** One-shot physical request admission and nonsecret outcome custody.
 * A reservation is not a dispatch receipt. Neither expiry nor `unknown` means
 * that a remote request failed, and neither permits replay of that request.
 */
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "./database";
import {
  authorizeSubscriptionCoreFrozenPersonalCodex,
  SubscriptionCoreCodexAccessLostError,
  SubscriptionCoreCodexLeaseLostError,
  type SubscriptionCoreCodexLeaseRef,
  type SubscriptionCoreTurnIdentity,
} from "./subscription-core-codex";
import type {
  SubscriptionCoreCodexOperationLeaseRef,
  SubscriptionCoreCodexOperationScope,
} from "./subscription-core-codex-operations";
import { withSubscriptionCoreAcceptedTurn } from "./subscription-core-placement-world";

export class SubscriptionCoreCodexSourceDisconnectedError extends Error {
  readonly code = "subscription_core_source_disconnected";
  constructor() {
    super("The Codex subscription source was disconnected before this request was admitted");
    this.name = "SubscriptionCoreCodexSourceDisconnectedError";
  }
}

/** A crashed/replaced attempt has no durable response or definitive refusal.
 * This is not a retryable transport error or a new placement request.
 */
export class SubscriptionCoreCodexRequestOutcomeUnknownError extends Error {
  readonly code = "subscription_core_request_outcome_unknown";
  constructor() {
    super("An earlier Codex request has an unresolved outcome; automatic replay is not safe");
    this.name = "SubscriptionCoreCodexRequestOutcomeUnknownError";
  }
}

export type SubscriptionCoreCodexRequestOutcome = "response_received" | "refused" | "unknown";
type Request = { requestId: string; transportAttempt: number };
type TurnRequest = Request & { attemptId: string; executionGeneration: number };
type AppsScope = { kind: "apps"; accountId: string; workspaceId: string };

async function inScope<T>(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  operation: (tx: Database) => Promise<T>,
): Promise<T> {
  if (scope.kind === "turn") {
    const result = await withSubscriptionCoreAcceptedTurn(db, scope.identity, async (tx) => {
      await authorizeSubscriptionCoreFrozenPersonalCodex(tx, scope.identity);
      return operation(tx);
    });
    if (result.status !== "completed") throw new SubscriptionCoreCodexAccessLostError();
    return result.value;
  }
  const actor =
    scope.kind === "session"
      ? {
          subjectId: "service:subscription-core",
          initiatingHumanSubjectId: scope.sessionOwnerSubjectId,
        }
      : {
          subjectId: scope.subjectId,
          initiatingHumanSubjectId: scope.subjectId,
        };
  return withSessionRlsActorContext(actor, () => withRlsContext(db, scope, operation));
}

function tenant(scope: SubscriptionCoreCodexOperationScope | AppsScope) {
  return scope.kind === "turn" ? scope.identity : scope;
}

async function lockSource(tx: Database, accountId: string, connectionId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`subscription-refresh:${connectionId}`}, 0))`);
  const [source] = await rawRows<{
    status: string;
    disconnected_at: Date | null;
    enabled: boolean;
  }>(
    tx,
    sql`select status, disconnected_at, exists (select 1 from subscription_provider_cutovers
        where account_id = ${accountId}::uuid and provider = 'codex' and enabled) as enabled
      from subscription_connections
      where account_id = ${accountId}::uuid and id = ${connectionId}::uuid and provider = 'codex'`,
  );
  if (!source || source.disconnected_at !== null)
    throw new SubscriptionCoreCodexSourceDisconnectedError();
  if (source.status !== "active" || !source.enabled)
    throw new SubscriptionCoreCodexAccessLostError();
}

async function insertRequest(
  tx: Database,
  scope: SubscriptionCoreCodexOperationScope | AppsScope,
  connectionId: string,
  input: Request & {
    attemptId: string;
    holderId: string;
    generation: number;
    operationKind: string;
  },
) {
  if (
    !input.requestId ||
    input.requestId.length > 512 ||
    !Number.isSafeInteger(input.transportAttempt) ||
    input.transportAttempt < 1
  ) {
    throw new Error("Invalid physical request identity");
  }
  const { accountId, workspaceId } = tenant(scope);
  const operationId = crypto.randomUUID();
  const sessionId =
    scope.kind === "turn"
      ? scope.identity.sessionId
      : scope.kind === "session"
        ? scope.sessionId
        : null;
  const turnId = scope.kind === "turn" ? scope.identity.turnId : null;
  // No ON CONFLICT: an old reservation never issues a second dispatch permit.
  // Request records live in the native operation seam, not a parallel ledger.
  await tx.execute(sql`insert into subscription_operation_leases (
      account_id, workspace_id, operation_id, attempt_id, operation_kind,
      session_id, turn_id, provider, connection_id, holder_id, generation, leased_until,
      request_id, transport_attempt, request_reserved_at, request_outcome
    ) values (${accountId}::uuid, ${workspaceId}::uuid, ${operationId}::uuid,
      ${input.attemptId}::uuid, ${input.operationKind}, ${sessionId}::uuid, ${turnId}::uuid,
      'codex', ${connectionId}::uuid, ${input.holderId}, ${input.generation},
      clock_timestamp() + interval '5 minutes', ${input.requestId}, ${input.transportAttempt},
      clock_timestamp(), 'reserved')`);
  return { operationId };
}

export async function reserveSubscriptionCoreCodexRequest(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  ref: SubscriptionCoreCodexLeaseRef,
  request: TurnRequest,
): Promise<{ operationId: string }> {
  return reserveTurnRequest(db, identity, ref, request, "model");
}

/** Read-only credential probes retain exact turn authority, not model custody. */
export async function reserveSubscriptionCoreCodexTurnCredentialRequest(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  ref: SubscriptionCoreCodexLeaseRef,
  request: TurnRequest,
): Promise<{ operationId: string }> {
  return reserveTurnRequest(db, identity, ref, request, "credential_request");
}

async function reserveTurnRequest(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  ref: SubscriptionCoreCodexLeaseRef,
  request: TurnRequest,
  operationKind: "model" | "credential_request",
): Promise<{ operationId: string }> {
  const scope = { kind: "turn" as const, identity };
  return inScope(db, scope, async (tx) => {
    // Serialize admission with attempt replacement. A newer worker may neither
    // borrow this admission nor turn an old lease's expiry into replay proof.
    const locked = await rawRows(
      tx,
      sql`select id from session_turns
      where account_id = ${identity.accountId}::uuid and workspace_id = ${identity.workspaceId}::uuid
        and session_id = ${identity.sessionId}::uuid and id = ${identity.turnId}::uuid
        and active_attempt_id = ${request.attemptId}::uuid and execution_generation = ${request.executionGeneration}
        and status = 'running' for share`,
    );
    if (!locked.length) throw new SubscriptionCoreCodexLeaseLostError();
    // The fence blocks replay of an ambiguous request: a resumed generation
    // (approval or capacity) or an attempt without a closed record never
    // treats an earlier unresolved request as settled. An earlier-generation
    // attempt that closed as failed (rerun only through an explicit Retry) or
    // as recoverable (worker shutdown, worker loss, lost lease) can no longer
    // write, so its response is never consumed and does not block the new
    // generation. The request rows keep their outcome.
    const [prior] = await rawRows<{ unresolved: boolean }>(
      tx,
      sql`select exists (
      select 1 from subscription_operation_leases request
      where request.account_id = ${identity.accountId}::uuid
        and request.workspace_id = ${identity.workspaceId}::uuid
        and request.session_id = ${identity.sessionId}::uuid
        and request.turn_id = ${identity.turnId}::uuid and request.provider = 'codex'
        and request.operation_kind = 'model' and request.request_id is not null
        and (request.request_outcome = 'unknown'
          or (request.request_outcome = 'reserved' and request.attempt_id <> ${request.attemptId}::uuid))
        and not exists (
          select 1 from session_turn_attempts attempt
          where attempt.account_id = request.account_id
            and attempt.workspace_id = request.workspace_id
            and attempt.session_id = request.session_id and attempt.turn_id = request.turn_id
            and attempt.id = request.attempt_id
            and attempt.execution_generation < ${request.executionGeneration}
            and attempt.state = 'closed'
            and attempt.outcome in ('failed', 'interrupted_recoverable', 'lease_lost_recoverable'))
    ) as unresolved`,
    );
    if (operationKind === "model" && prior?.unresolved)
      throw new SubscriptionCoreCodexRequestOutcomeUnknownError();
    await lockSource(tx, identity.accountId, ref.connectionId);
    const [lease] = await rawRows<{ current: boolean }>(
      tx,
      sql`select exists (
      select 1 from subscription_leases lease join session_turns turn
        on turn.account_id = lease.account_id and turn.workspace_id = lease.workspace_id
        and turn.session_id = lease.session_id and turn.id = lease.turn_id
      join sessions session on session.account_id = turn.account_id
        and session.workspace_id = turn.workspace_id and session.id = turn.session_id
      where lease.account_id = ${identity.accountId}::uuid
        and lease.workspace_id = ${identity.workspaceId}::uuid
        and lease.session_id = ${identity.sessionId}::uuid and lease.turn_id = ${identity.turnId}::uuid
        and lease.provider = 'codex' and lease.connection_id = ${ref.connectionId}::uuid
        and lease.holder_id = ${ref.holderId} and lease.generation = ${ref.generation}
        and lease.leased_until > clock_timestamp() and turn.status = 'running'
        and session.status = 'running' and session.active_turn_id = turn.id
        and turn.active_attempt_id = ${request.attemptId}::uuid
        and turn.execution_generation = ${request.executionGeneration}
    ) as current`,
    );
    if (!lease?.current) throw new SubscriptionCoreCodexLeaseLostError();
    return insertRequest(tx, scope, ref.connectionId, {
      ...request,
      holderId: ref.holderId,
      generation: request.executionGeneration,
      operationKind,
    });
  });
}

export async function reserveSubscriptionCoreCodexOperationRequest(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  ref: SubscriptionCoreCodexOperationLeaseRef | null,
  connectionId: string,
  request: Request,
): Promise<{ operationId: string }> {
  return inScope(db, scope, async (tx) => {
    const { accountId, workspaceId } = tenant(scope);
    await lockSource(tx, accountId, connectionId);
    const [authorized] = await rawRows<{ status: string }>(
      tx,
      sql`select status
      from opengeni_private.read_subscription_codex_connection_credential(
        ${accountId}::uuid, ${workspaceId}::uuid, ${connectionId}::uuid,
        ${ref?.operationId ?? null}::uuid, ${ref?.attemptId ?? null}::uuid,
        ${ref?.holderId ?? null}, ${ref?.generation ?? null}::bigint)`,
    );
    if (authorized?.status !== "active") throw new SubscriptionCoreCodexAccessLostError();
    if (scope.kind === "turn" && !ref) throw new SubscriptionCoreCodexAccessLostError();
    return insertRequest(tx, scope, connectionId, {
      ...request,
      attemptId: ref?.attemptId ?? crypto.randomUUID(),
      holderId: ref?.holderId ?? `request:${crypto.randomUUID()}`,
      generation: ref?.generation ?? 1,
      operationKind:
        ref?.operationKind ?? (scope.kind === "session" ? "realtime" : "credential_request"),
    });
  });
}

/** Apps uses its explicit workspace designation, never a borrowed human/turn. */
export async function reserveSubscriptionCoreCodexAppsRequest(
  db: Database,
  target: { accountId: string; workspaceId: string; connectionId: string },
  request: Request,
): Promise<{ operationId: string }> {
  return withRlsContext(db, target, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`codex-apps-settings:${target.workspaceId}`}, 0))`);
    await lockSource(tx, target.accountId, target.connectionId);
    // The native operation-reference + disconnect guards recheck designation,
    // scope, cutover and active connection without minting personal authority.
    return insertRequest(tx, { ...target, kind: "apps" }, target.connectionId, {
      ...request,
      operationKind: "apps",
      attemptId: crypto.randomUUID(),
      holderId: `apps-request:${crypto.randomUUID()}`,
      generation: 1,
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

export async function settleSubscriptionCoreCodexRequest(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  ref: SubscriptionCoreCodexLeaseRef,
  request: {
    operationId: string;
    attemptId: string;
    executionGeneration: number;
    outcome: SubscriptionCoreCodexRequestOutcome;
  },
): Promise<void> {
  await inScope(db, { kind: "turn", identity }, async (tx) => {
    await tx.execute(sql`update subscription_operation_leases set request_outcome = ${request.outcome}
      where account_id = ${identity.accountId}::uuid and workspace_id = ${identity.workspaceId}::uuid
        and session_id = ${identity.sessionId}::uuid and turn_id = ${identity.turnId}::uuid
        and operation_id = ${request.operationId}::uuid and attempt_id = ${request.attemptId}::uuid
        and connection_id = ${ref.connectionId}::uuid and holder_id = ${ref.holderId}
        and generation = ${request.executionGeneration} and request_id is not null
        and request_outcome in ('reserved', 'unknown')`);
  });
}

/** Same exact holder/attempt settlement, without misclassifying a read as a model call. */
export const settleSubscriptionCoreCodexTurnCredentialRequest = settleSubscriptionCoreCodexRequest;

export async function settleSubscriptionCoreCodexOperationRequest(
  db: Database,
  scope: SubscriptionCoreCodexOperationScope,
  request: {
    operationId: string;
    outcome: SubscriptionCoreCodexRequestOutcome;
  },
): Promise<void> {
  await inScope(db, scope, async (tx) => {
    const { accountId, workspaceId } = tenant(scope);
    const sessionId =
      scope.kind === "turn"
        ? scope.identity.sessionId
        : scope.kind === "session"
          ? scope.sessionId
          : null;
    const turnId = scope.kind === "turn" ? scope.identity.turnId : null;
    await tx.execute(sql`update subscription_operation_leases set request_outcome = ${request.outcome}
      where account_id = ${accountId}::uuid and workspace_id = ${workspaceId}::uuid
        and session_id is not distinct from ${sessionId}::uuid
        and turn_id is not distinct from ${turnId}::uuid
        and operation_id = ${request.operationId}::uuid and request_id is not null
        and request_outcome in ('reserved', 'unknown')`);
  });
}

export async function isSubscriptionCoreCodexSourceDisconnected(
  db: Database,
  identity: SubscriptionCoreTurnIdentity,
  connectionId: string,
): Promise<boolean> {
  return inScope(db, { kind: "turn", identity }, async (tx) => {
    const [source] = await rawRows<{ disconnected: boolean }>(
      tx,
      sql`select disconnected_at is not null as disconnected
      from subscription_connections where account_id = ${identity.accountId}::uuid
        and id = ${connectionId}::uuid and provider = 'codex'`,
    );
    return !source || source.disconnected;
  });
}
