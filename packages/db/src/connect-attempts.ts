import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { ConnectAttempt, type ConnectAttempt as Attempt } from "@opengeni/contracts/connect";
import { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import { stableJson } from "@opengeni/contracts";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";

export type ConnectActorScope = { accountId: string; workspaceId: string; subjectId: string };
/** Live admission under the attempt transaction. Implementations must acquire
 * their key/membership/link fences in a consistent order and hold them through
 * commit. No network I/O. The attempt argument is an isolated copy. */
export type ConnectOperationAuthorization = (
  tx: Database,
  attempt: Attempt,
  origin: ExternalActorContinuation | null,
) => Promise<void>;
type Receipt = { digest: string; result: Attempt };
type Row = {
  id: string;
  account_id: string;
  workspace_id: string;
  subject_id: string;
  request_digest: string;
  return_url: string;
  projection: unknown;
  operation_id: string | null;
  operation_digest: string | null;
  receipts: Record<string, Receipt>;
  external_continuation: unknown;
};

export class ConnectAttemptConflictError extends Error {
  readonly code = "CONNECT_ATTEMPT_CONFLICT";
  constructor(message = "Connect attempt changed; reload its current state") {
    super(message);
  }
}
export class ConnectAttemptNotFoundError extends Error {
  readonly code = "CONNECT_ATTEMPT_NOT_FOUND";
  constructor() {
    super("Connect attempt not found");
  }
}

function projection(row: Row, scope: ConnectActorScope): Attempt {
  const value = ConnectAttempt.parse(row.projection);
  if (
    row.account_id !== scope.accountId ||
    row.workspace_id !== scope.workspaceId ||
    row.subject_id !== scope.subjectId ||
    value.id !== row.id ||
    value.workspaceId !== scope.workspaceId
  ) {
    throw new ConnectAttemptNotFoundError();
  }
  return value;
}
function scoped<T>(
  db: Database,
  scope: ConnectActorScope,
  run: (tx: Database) => Promise<T>,
): Promise<T> {
  return withWorkspaceSubjectRls(db, scope.workspaceId, scope.subjectId, run);
}
async function lockAttempt(
  tx: Database,
  scope: ConnectActorScope,
  id: string,
): Promise<Row & { expired: boolean }> {
  const [row] = await rawRows<Row & { expired: boolean }>(
    tx,
    sql`select *, expires_at <= clock_timestamp() as expired from connect_attempts
    where id = ${id}::uuid and account_id = ${scope.accountId}::uuid
      and workspace_id = ${scope.workspaceId}::uuid and subject_id = ${scope.subjectId}
    for update`,
  );
  if (!row) throw new ConnectAttemptNotFoundError();
  return row;
}

function receiptFor(
  row: Row,
  operationId: string,
  digest: string,
  scope: ConnectActorScope,
): Attempt | null {
  if (!Object.hasOwn(row.receipts, operationId)) return null;
  const receipt = row.receipts[operationId]!;
  if (receipt.digest !== digest)
    throw new ConnectAttemptConflictError("Connect operation ID was reused");
  return projection({ ...row, projection: receipt.result }, scope);
}
function validateOperation(id: string, digest: string): void {
  if (!id || new TextEncoder().encode(id).byteLength > 512 || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new ConnectAttemptConflictError("Invalid Connect operation identity");
  }
}

/** Caller must establish live workspace/actor authority before this storage
 * seam. RLS scope is a consistency boundary, not proof of authentication. */
export async function beginConnectAttempt(
  db: Database,
  scope: ConnectActorScope,
  input: {
    idempotencyKey: string;
    requestDigest: string;
    returnUrl: string;
    attempt: Attempt;
    externalContinuation?: ExternalActorContinuation;
  },
): Promise<Attempt> {
  const value = ConnectAttempt.parse(input.attempt);
  const origin = input.externalContinuation
    ? ExternalActorContinuation.parse(input.externalContinuation)
    : null;
  validateOperation(input.idempotencyKey, input.requestDigest);
  if (value.workspaceId !== scope.workspaceId || value.revision !== 1)
    throw new ConnectAttemptConflictError();
  const key = createHash("sha256").update(input.idempotencyKey).digest("hex");
  return scoped(db, scope, async (tx) => {
    // Serialize per-actor creation and quota, not the provider's remote request.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`connect:${scope.workspaceId}:${scope.subjectId}`}, 0))`);
    // Bounded actor-local cleanup; no Connection credentials are deleted.
    await tx.execute(sql`with expired as (
      select id from connect_attempts where workspace_id = ${scope.workspaceId}::uuid
        and account_id = ${scope.accountId}::uuid and subject_id = ${scope.subjectId}
        and expires_at < now() - interval '30 days'
      order by expires_at, id limit 100 for update skip locked
    ) delete from connect_attempts where id in (select id from expired)`);
    const [existing] = await rawRows<Row>(
      tx,
      sql`select * from connect_attempts
      where workspace_id = ${scope.workspaceId}::uuid and subject_id = ${scope.subjectId}
        and idempotency_key_hash = ${key} and account_id = ${scope.accountId}::uuid`,
    );
    if (existing) {
      if (
        existing.request_digest !== input.requestDigest ||
        existing.return_url !== input.returnUrl ||
        stableJson(existing.external_continuation ?? null) !== stableJson(origin)
      ) {
        throw new ConnectAttemptConflictError(
          "Connect idempotency key was reused with different input",
        );
      }
      return projection(existing, scope);
    }
    const [count] = await rawRows<{ count: number }>(
      tx,
      sql`select count(*)::int as count from connect_attempts
      where workspace_id = ${scope.workspaceId}::uuid and subject_id = ${scope.subjectId}
        and (expires_at > now() or operation_id is not null)
        and projection->>'state' not in ('complete','cancelled','expired')`,
    );
    if ((count?.count ?? 0) >= 32)
      throw new ConnectAttemptConflictError("Too many pending Connect attempts");
    const [row] = await rawRows<Row>(
      tx,
      sql`insert into connect_attempts
      (id, account_id, workspace_id, subject_id, idempotency_key_hash, request_digest, return_url, projection, expires_at, external_continuation)
      values (${value.id}::uuid, ${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${scope.subjectId},
        ${key}, ${input.requestDigest}, ${input.returnUrl}, ${JSON.stringify(value)}::jsonb, ${value.expiresAt}::timestamptz, ${origin ? JSON.stringify(origin) : null}::jsonb)
      returning *`,
    );
    if (!row) throw new Error("Connect attempt insert returned no result");
    return projection(row, scope);
  });
}

export async function getConnectAttempt(
  db: Database,
  scope: ConnectActorScope,
  id: string,
): Promise<{
  attempt: Attempt;
  returnUrl: string;
  operationInFlight: boolean;
}> {
  return scoped(db, scope, async (tx) => {
    const row = await lockAttempt(tx, scope, id);
    const current = projection(row, scope);
    if (row.expired && !["complete", "cancelled", "expired", "uncertain"].includes(current.state)) {
      const expired = ConnectAttempt.parse({
        ...current,
        revision: current.revision + 1,
        state: row.operation_id ? "uncertain" : "expired",
        nextAction: { type: "none" },
      });
      await tx.execute(sql`update connect_attempts set projection = ${JSON.stringify(expired)}::jsonb,
        updated_at = now() where id = ${row.id}::uuid`);
      row.projection = expired;
    }
    return {
      attempt: projection(row, scope),
      returnUrl: row.return_url,
      operationInFlight: row.operation_id !== null,
    };
  });
}

export async function listPendingConnectAttempts(
  db: Database,
  scope: ConnectActorScope,
): Promise<Attempt[]> {
  return scoped(db, scope, async (tx) => {
    const rows = await rawRows<Row>(
      tx,
      sql`select * from connect_attempts
      where workspace_id = ${scope.workspaceId}::uuid and account_id = ${scope.accountId}::uuid
        and subject_id = ${scope.subjectId} and (expires_at > now() or operation_id is not null)
        and projection->>'state' not in ('complete','cancelled','expired')
      order by created_at desc, id desc limit 32`,
    );
    return rows.map((row) => projection(row, scope));
  });
}

/** A claim is committed before remote effects. Never expire/reclaim it merely
 * because the caller timed out: the provider may have accepted the operation. */
export async function claimConnectOperation(
  db: Database,
  scope: ConnectActorScope,
  input: {
    attemptId: string;
    expectedRevision: number;
    operationId: string;
    inputDigest: string;
    authorize?: ConnectOperationAuthorization;
  },
): Promise<{ status: "claimed"; attempt: Attempt } | { status: "replayed"; attempt: Attempt }> {
  validateOperation(input.operationId, input.inputDigest);
  return scoped(db, scope, async (tx) => {
    const row = await lockAttempt(tx, scope, input.attemptId);
    const current = projection(row, scope);
    await input.authorize?.(
      tx,
      structuredClone(current),
      row.external_continuation ? ExternalActorContinuation.parse(row.external_continuation) : null,
    );
    const receipt = receiptFor(row, input.operationId, input.inputDigest, scope);
    if (receipt) {
      return { status: "replayed", attempt: receipt };
    }
    if (row.operation_id)
      throw new ConnectAttemptConflictError(
        "Connect operation is in flight or uncertain; reconcile before retrying",
      );
    if (
      Object.keys(row.receipts).length >= 64 ||
      current.revision !== input.expectedRevision ||
      row.expired ||
      ["complete", "cancelled", "expired"].includes(current.state)
    ) {
      throw new ConnectAttemptConflictError();
    }
    await tx.execute(sql`update connect_attempts set operation_id = ${input.operationId},
      operation_digest = ${input.inputDigest}, updated_at = now() where id = ${row.id}::uuid`);
    return { status: "claimed", attempt: current };
  });
}

/** Pass the same transaction to credential/installation persistence through
 * commit so its receipt and the public setup result become visible atomically.
 * Do not perform network effects inside commit. */
export async function finishConnectOperation(
  db: Database,
  scope: ConnectActorScope,
  input: {
    attemptId: string;
    operationId: string;
    inputDigest: string;
    commit: (tx: Database, current: Attempt) => Promise<Attempt>;
    authorize?: ConnectOperationAuthorization;
  },
): Promise<Attempt> {
  validateOperation(input.operationId, input.inputDigest);
  return scoped(db, scope, async (tx) => {
    const row = await lockAttempt(tx, scope, input.attemptId);
    const current = projection(row, scope);
    await input.authorize?.(
      tx,
      structuredClone(current),
      row.external_continuation ? ExternalActorContinuation.parse(row.external_continuation) : null,
    );
    const receipt = receiptFor(row, input.operationId, input.inputDigest, scope);
    if (receipt) {
      return receipt;
    }
    if (row.operation_id !== input.operationId || row.operation_digest !== input.inputDigest)
      throw new ConnectAttemptConflictError();
    const next = ConnectAttempt.parse(await input.commit(tx, structuredClone(current)));
    if (
      next.id !== current.id ||
      next.workspaceId !== current.workspaceId ||
      next.providerId !== current.providerId ||
      next.ownership !== current.ownership ||
      next.completionRequirement !== current.completionRequirement ||
      stableJson(next.installationTarget ?? null) !==
        stableJson(current.installationTarget ?? null) ||
      (current.source !== undefined && stableJson(next.source) !== stableJson(current.source)) ||
      next.expiresAt !== current.expiresAt ||
      next.revision !== current.revision + 1 ||
      (current.credentialsCommitted && !next.credentialsCommitted) ||
      (current.integrationInstalled && !next.integrationInstalled)
    )
      throw new ConnectAttemptConflictError();
    const receipts = {
      ...row.receipts,
      [input.operationId]: { digest: input.inputDigest, result: next },
    };
    await tx.execute(sql`update connect_attempts set projection = ${JSON.stringify(next)}::jsonb,
      receipts = ${JSON.stringify(receipts)}::jsonb, operation_id = null, operation_digest = null,
      updated_at = now() where id = ${row.id}::uuid`);
    return next;
  });
}
