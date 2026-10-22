import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";
import { lockTurnAttemptWriteFenceTx } from "./session-attempt-fence";
import { lockSessionEventWriteRows } from "./session-control";
import { withSubscriptionCoreAcceptedTurn } from "./subscription-core-placement-world";
import type { SubscriptionCoreTurnIdentity } from "./subscription-core/turns";

export type SessionTitleOperationState =
  | "pending"
  | "dispatching"
  | "responded"
  | "completed"
  | "failed"
  | "unknown";

export type SessionTitleOperation = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  sourceTurnId: string;
  sourceAttemptId: string;
  sourceExecutionGeneration: number;
  provider: string;
  connectionId: string | null;
  requestEncrypted: string | null;
  responseEncrypted: string | null;
  state: SessionTitleOperationState;
  holderId: string | null;
  generation: number;
  leasedUntil: Date | null;
  requestOperationId: string | null;
};

type Tenant = { accountId: string; workspaceId: string };
type Claim = Tenant & { operationId: string; holderId: string; generation: number };

/** Called with the title row locked: release only this exact holder's owner lease. */
async function releaseTitleProviderLease(
  tx: Database,
  operation: SessionTitleOperation,
): Promise<void> {
  if (!operation.connectionId || !operation.holderId) return;
  await tx.execute(sql`delete from subscription_operation_leases
    where account_id = ${operation.accountId}::uuid and workspace_id = ${operation.workspaceId}::uuid
      and session_id = ${operation.sessionId}::uuid and turn_id = ${operation.sourceTurnId}::uuid
      and operation_id = ${operation.id}::uuid and operation_kind = 'session_title'
      and attempt_id = ${operation.sourceAttemptId}::uuid and provider = ${operation.provider}
      and connection_id = ${operation.connectionId}::uuid
      and holder_id = ${operation.holderId} and generation = ${operation.generation}
      and request_id is null`);
}

/** Settlement records an already admitted request, never grants new provider I/O.
 * The caller holds the exact title claim; revocation must not erase its evidence. */
async function settleTitleRequestEvidence(
  tx: Database,
  operation: SessionTitleOperation,
  outcome: "unknown" | "response_received",
): Promise<void> {
  if (!operation.connectionId || !operation.requestOperationId) return;
  await tx.execute(sql`update subscription_operation_leases set request_outcome = ${outcome},
    request_observed_at = clock_timestamp()
    where account_id = ${operation.accountId}::uuid and workspace_id = ${operation.workspaceId}::uuid
      and session_id = ${operation.sessionId}::uuid and turn_id = ${operation.sourceTurnId}::uuid
      and attempt_id = ${operation.sourceAttemptId}::uuid and provider = ${operation.provider}
      and connection_id = ${operation.connectionId}::uuid and operation_kind = 'session_title'
      and operation_id = ${operation.requestOperationId}::uuid and request_id is not null
      and request_outcome in ('reserved', 'unknown')`);
}

export async function claimSessionTitleWorkflows(
  db: Database,
  limit = 100,
): Promise<Array<Tenant & { operationId: string }>> {
  return rawRows(
    db,
    sql`select operation_id::text as "operationId", account_id::text as "accountId",
    workspace_id::text as "workspaceId" from opengeni_private.claim_session_title_workflows(${limit})`,
  );
}

const columns = sql`id::text, account_id::text as "accountId",
  workspace_id::text as "workspaceId", session_id::text as "sessionId",
  source_turn_id::text as "sourceTurnId", source_attempt_id::text as "sourceAttemptId",
  source_execution_generation::double precision as "sourceExecutionGeneration", provider,
  connection_id::text as "connectionId", request_encrypted as "requestEncrypted",
  response_encrypted as "responseEncrypted", state, holder_id as "holderId",
  generation::double precision, leased_until as "leasedUntil", request_operation_id::text as "requestOperationId"`;

/** Admission, not execution: the source attempt and selected chat lease are live. */
export async function admitSessionTitleOperation(
  db: Database,
  input: {
    identity: SubscriptionCoreTurnIdentity;
    attemptId: string;
    executionGeneration: number;
    provider: string;
    connectionId: string | null;
    requestEncrypted: string;
  },
): Promise<SessionTitleOperation | null> {
  const identity = input.identity;
  const access = await withSubscriptionCoreAcceptedTurn(db, identity, async (tx) => {
    const fence = await lockTurnAttemptWriteFenceTx(tx, {
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      attemptId: input.attemptId,
      executionGeneration: input.executionGeneration,
      sessionLock: "no_key_update",
    });
    if (!fence.allowed) return null;
    const [existing] = await rawRows<SessionTitleOperation>(
      tx,
      sql`
      select ${columns} from session_title_operations
      where workspace_id = ${identity.workspaceId}::uuid and session_id = ${identity.sessionId}::uuid
        and (state in ('pending', 'dispatching', 'responded') or source_turn_id = ${identity.turnId}::uuid)
      order by (state in ('pending', 'dispatching', 'responded')) desc limit 1`,
    );
    if (existing) return existing;
    const [row] = await rawRows<SessionTitleOperation>(
      tx,
      sql`
      insert into session_title_operations(account_id, workspace_id, session_id,
        source_turn_id, source_attempt_id, source_execution_generation, provider,
        connection_id, request_encrypted)
      values (${identity.accountId}::uuid, ${identity.workspaceId}::uuid, ${identity.sessionId}::uuid,
        ${identity.turnId}::uuid, ${input.attemptId}::uuid, ${input.executionGeneration},
        ${input.provider}, ${input.connectionId}::uuid, ${input.requestEncrypted})
      returning ${columns}`,
    );
    return row ?? null;
  });
  return access.status === "completed" ? access.value : null;
}

export async function getSessionTitleOperation(
  db: Database,
  input: Tenant & ({ operationId: string } | { sessionId: string }),
): Promise<SessionTitleOperation | null> {
  return withRlsContext(db, input, async (tx) => {
    const [row] = await rawRows<SessionTitleOperation>(
      tx,
      sql`
      select ${columns} from session_title_operations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and ${"operationId" in input ? sql`id = ${input.operationId}::uuid` : sql`session_id = ${input.sessionId}::uuid and state in ('pending', 'dispatching', 'responded')`}`,
    );
    return row ?? null;
  });
}

/** A new holder owns a new title generation, not a new conversation attempt. */
export async function claimSessionTitleOperation(
  db: Database,
  input: Tenant & { operationId: string; holderId: string; ttlMs: number },
): Promise<SessionTitleOperation | null> {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)
    throw new Error("Invalid title lease");
  return withRlsContext(db, input, async (tx) => {
    const [prior] = await rawRows<SessionTitleOperation>(
      tx,
      sql`select ${columns} from session_title_operations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and state in ('pending', 'dispatching', 'responded')
        and (leased_until is null or leased_until <= clock_timestamp()) for update`,
    );
    if (!prior) return null;
    // The expired metadata grant already fences the previous holder. Its
    // provider lease may have a later clock; do not leave it blocking drains.
    await releaseTitleProviderLease(tx, prior);
    const [row] = await rawRows<SessionTitleOperation>(
      tx,
      sql`
      update session_title_operations set holder_id = ${input.holderId}, generation = generation + 1,
        leased_until = clock_timestamp() + (${input.ttlMs} * interval '1 millisecond'), updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and state in ('pending', 'dispatching', 'responded')
        and (leased_until is null or leased_until <= clock_timestamp())
      returning ${columns}`,
    );
    return row ?? null;
  });
}

/** Release a known-unsent or response-retained claim; neither retries provider I/O. */
export async function retrySessionTitleOperation(db: Database, input: Claim): Promise<boolean> {
  return withRlsContext(db, input, async (tx) => {
    const [operation] = await rawRows<SessionTitleOperation>(
      tx,
      sql`select ${columns} from session_title_operations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and holder_id = ${input.holderId} and generation = ${input.generation}
        and leased_until > clock_timestamp()
        and ((state = 'pending' and request_operation_id is null) or state = 'responded') for update`,
    );
    if (!operation) return false;
    await releaseTitleProviderLease(tx, operation);
    await tx.execute(sql`update session_title_operations set holder_id = null, leased_until = null,
      updated_at = clock_timestamp() where id = ${operation.id}::uuid`);
    return true;
  });
}

/** Display purpose only; never used to select or authorize a provider account. */
export async function getSessionTitleTarget(db: Database, input: Tenant & { sessionId: string }) {
  return withRlsContext(db, input, async (tx) => {
    const [row] = await rawRows<{
      title: string | null;
      source: "agent" | "user" | null;
      archived: boolean;
    }>(
      tx,
      sql`select title, title_source as source, content_archive_state is not null as archived
        from sessions where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
          and id = ${input.sessionId}::uuid`,
    );
    return row ?? null;
  });
}

/** Exact reservation evidence distinguishes definite refusal from uncertainty. */
export async function getSessionTitleRequestOutcome(
  db: Database,
  operation: SessionTitleOperation,
) {
  if (!operation.connectionId || !operation.requestOperationId) return null;
  return withRlsContext(db, operation, async (tx) => {
    const [row] = await rawRows<{
      outcome: "reserved" | "refused" | "unknown" | "response_received";
    }>(
      tx,
      sql`select request_outcome as outcome from subscription_operation_leases
        where account_id = ${operation.accountId}::uuid and workspace_id = ${operation.workspaceId}::uuid
          and session_id = ${operation.sessionId}::uuid and turn_id = ${operation.sourceTurnId}::uuid
          and attempt_id = ${operation.sourceAttemptId}::uuid and provider = ${operation.provider}
          and connection_id = ${operation.connectionId}::uuid and operation_kind = 'session_title'
          and operation_id = ${operation.requestOperationId}::uuid and request_id is not null`,
    );
    return row?.outcome ?? null;
  });
}

/** Both the metadata holder and provider lease retain their own live clocks. */
export async function renewSessionTitleOperation(
  db: Database,
  input: Claim & { ttlMs: number },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0)
    throw new Error("Invalid title lease");
  return withRlsContext(db, input, async (tx) => {
    const rows = await rawRows(
      tx,
      sql`
      update session_title_operations
      set leased_until = clock_timestamp() + (${input.ttlMs} * interval '1 millisecond'), updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and holder_id = ${input.holderId} and generation = ${input.generation}
        and leased_until > clock_timestamp() and state in ('pending', 'dispatching', 'responded')
      returning id`,
    );
    return rows.length === 1;
  });
}

/** Usage, the title CAS and terminal state commit together, in session-prefix order. */
export async function completeSessionTitleOperation<T>(
  db: Database,
  input: Claim & { sessionId: string },
  settle: (tx: Database, operation: SessionTitleOperation) => Promise<T>,
): Promise<{ completed: true; value: T } | { completed: false }> {
  return withRlsContext(db, input, async (tx) => {
    const [identity] = await rawRows<SessionTitleOperation>(
      tx,
      sql`select ${columns} from session_title_operations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and id = ${input.operationId}::uuid`,
    );
    if (!identity) return { completed: false };
    await lockSessionEventWriteRows(tx, {
      workspaceId: input.workspaceId,
      sessionIds: [input.sessionId],
      controlLock: "none",
      turnIds: [identity.sourceTurnId],
      attemptIds: [identity.sourceAttemptId],
    });
    const [operation] = await rawRows<SessionTitleOperation>(
      tx,
      sql`
      select ${columns} from session_title_operations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and session_id = ${input.sessionId}::uuid and id = ${input.operationId}::uuid
        and holder_id = ${input.holderId} and generation = ${input.generation}
        and state = 'responded' and leased_until > clock_timestamp() for update`,
    );
    if (!operation) return { completed: false };
    const value = await settle(tx, operation);
    await settleTitleRequestEvidence(tx, operation, "response_received");
    await releaseTitleProviderLease(tx, operation);
    // The row lock excludes reclamation throughout settlement; no network work
    // belongs in the callback. Expiry after locking cannot undo committed usage.
    await tx.execute(sql`update session_title_operations set state = 'completed',
      request_encrypted = null, response_encrypted = null, holder_id = null,
      leased_until = null, updated_at = clock_timestamp() where id = ${operation.id}::uuid`);
    return { completed: true, value };
  });
}

/** API-key dispatch uses the same durable one-shot gate as subscription reservation. */
export async function reserveSessionTitleDispatch(db: Database, input: Claim): Promise<boolean> {
  return withRlsContext(db, input, async (tx) => {
    const rows = await rawRows(
      tx,
      sql`
      update session_title_operations set state = 'dispatching', request_operation_id = gen_random_uuid(),
        updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and holder_id = ${input.holderId} and generation = ${input.generation}
        and leased_until > clock_timestamp() and state = 'pending' and request_operation_id is null
      returning id`,
    );
    return rows.length === 1;
  });
}

/** Retain the finite response before any usage/title write that may need replay. */
export async function recordSessionTitleResponse(
  db: Database,
  input: Claim & { responseEncrypted: string },
): Promise<boolean> {
  return withRlsContext(db, input, async (tx) => {
    const rows = await rawRows(
      tx,
      sql`
      update session_title_operations set state = 'responded', response_encrypted = ${input.responseEncrypted},
        updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and holder_id = ${input.holderId} and generation = ${input.generation}
        and state = 'dispatching' and leased_until > clock_timestamp()
      returning id`,
    );
    return rows.length === 1;
  });
}

/** No uncertain provider request is sent again. Only database settlement retries. */
export async function finishSessionTitleOperation(
  db: Database,
  input: Claim & { state: "completed" | "failed" | "unknown" },
): Promise<boolean> {
  return withRlsContext(db, input, async (tx) => {
    const [operation] = await rawRows<SessionTitleOperation>(
      tx,
      sql`select ${columns} from session_title_operations
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and holder_id = ${input.holderId} and generation = ${input.generation}
        and leased_until > clock_timestamp() and state in ('pending', 'dispatching', 'responded') for update`,
    );
    if (!operation) return false;
    if (input.state === "completed" && operation.state !== "responded") return false;
    await settleTitleRequestEvidence(
      tx,
      operation,
      operation.state === "responded" ? "response_received" : "unknown",
    );
    await releaseTitleProviderLease(tx, operation);
    const rows = await rawRows(
      tx,
      sql`
      update session_title_operations set state = ${input.state}, request_encrypted = null,
        response_encrypted = null, holder_id = null, leased_until = null, updated_at = clock_timestamp()
      where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid
        and id = ${input.operationId}::uuid and holder_id = ${input.holderId} and generation = ${input.generation}
        and state in ('pending', 'dispatching', 'responded') and leased_until > clock_timestamp()
        and (${input.state} <> 'completed' or state = 'responded')
      returning id`,
    );
    return rows.length === 1;
  });
}
