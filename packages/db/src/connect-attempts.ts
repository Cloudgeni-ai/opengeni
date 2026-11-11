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

/**
 * Content-free state transition of one Connect attempt, reported only after
 * its transaction committed. `providerId` is caller-chosen; observers must
 * bound it against a reviewed catalog before using it as a label.
 */
export type ConnectAttemptTransition = {
  providerId: string;
  previousState: Attempt["state"] | null;
  state: Attempt["state"];
  errorCode: string | null;
};
type ConnectAttemptTransitionObserver = (transition: ConnectAttemptTransition) => void;
let connectAttemptTransitionObserver: ConnectAttemptTransitionObserver | null = null;

/** Install the process-wide observer (the API sets one at startup). */
export function setConnectAttemptTransitionObserver(
  observer: ConnectAttemptTransitionObserver | null,
): void {
  connectAttemptTransitionObserver = observer;
}

function reportConnectAttemptTransition(previous: Attempt | null, next: Attempt): void {
  if (previous && previous.state === next.state) return;
  try {
    connectAttemptTransitionObserver?.({
      providerId: next.providerId,
      previousState: previous?.state ?? null,
      state: next.state,
      errorCode: next.error?.code ?? null,
    });
  } catch {
    // Telemetry never changes the committed setup outcome.
  }
}

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
type ConnectBeginIdentity = {
  idempotencyKey: string;
  requestDigest: string;
  returnUrl: string;
  externalContinuation?: ExternalActorContinuation;
};

/** Recover only an exact saved begin request, under the caller's live actor
 * admission. This performs no provider work or acquisition. */
export async function getConnectBeginReplay(
  db: Database,
  scope: ConnectActorScope,
  input: ConnectBeginIdentity,
): Promise<Attempt | null> {
  validateOperation(input.idempotencyKey, input.requestDigest);
  const origin = input.externalContinuation
    ? ExternalActorContinuation.parse(input.externalContinuation)
    : null;
  const key = createHash("sha256").update(input.idempotencyKey).digest("hex");
  return scoped(db, scope, async (tx) => {
    const [existing] = await rawRows<Row>(
      tx,
      sql`select * from connect_attempts
      where workspace_id = ${scope.workspaceId}::uuid and subject_id = ${scope.subjectId}
        and idempotency_key_hash = ${key} and account_id = ${scope.accountId}::uuid`,
    );
    if (!existing) return null;
    if (
      existing.request_digest !== input.requestDigest ||
      existing.return_url !== input.returnUrl ||
      stableJson(existing.external_continuation ?? null) !== stableJson(origin)
    )
      throw new ConnectAttemptConflictError(
        "Connect idempotency key was reused with different input",
      );
    return projection(existing, scope);
  });
}

export async function beginConnectAttempt(
  db: Database,
  scope: ConnectActorScope,
  input: {
    idempotencyKey: string;
    requestDigest: string;
    returnUrl: string;
    attempt: Attempt;
    externalContinuation?: ExternalActorContinuation;
    authorizeAcquisition?: (tx: Database) => Promise<void>;
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
  let created = false;
  const result = await scoped(db, scope, async (tx) => {
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
    const existing = await getConnectBeginReplay(tx, scope, input);
    if (existing) return existing;
    await input.authorizeAcquisition?.(tx);
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
    created = true;
    return projection(row, scope);
  });
  if (created) reportConnectAttemptTransition(null, result);
  return result;
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
  let transition: [Attempt, Attempt] | null = null;
  const result = await scoped(db, scope, async (tx) => {
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
      transition = [current, expired];
    }
    return {
      attempt: projection(row, scope),
      returnUrl: row.return_url,
      operationInFlight: row.operation_id !== null,
    };
  });
  if (transition) reportConnectAttemptTransition(...(transition as [Attempt, Attempt]));
  return result;
}

export async function listPendingConnectAttempts(
  db: Database,
  scope: ConnectActorScope,
): Promise<Attempt[]> {
  return scoped(db, scope, async (tx) => {
    const rows = await rawRows<Row>(
      tx,
      sql`select * from connect_attempts attempt
      where attempt.workspace_id = ${scope.workspaceId}::uuid
        and attempt.account_id = ${scope.accountId}::uuid
        and attempt.subject_id = ${scope.subjectId}
        and (attempt.expires_at > now() or attempt.operation_id is not null)
        and attempt.projection->>'state' not in ('complete','cancelled','expired')
        and not exists (${connectedSince(sql`attempt`)})
      order by attempt.created_at desc, attempt.id desc limit 32`,
    );
    return rows.map((row) => projection(row, scope));
  });
}

/**
 * A later setup by the same person that connected the same service, with the
 * same owner and destination: an older unfinished setup has nothing left to
 * continue, so it is no longer offered. Custom connections (MCP servers,
 * OpenAPI and GraphQL sources) share one provider ID across different
 * services, so a later one never stands in for another.
 */
function connectedSince(attempt: ReturnType<typeof sql>) {
  return sql`select 1 from connect_attempts later
    where later.workspace_id = ${attempt}.workspace_id and later.account_id = ${attempt}.account_id
      and later.subject_id = ${attempt}.subject_id and later.id <> ${attempt}.id
      and later.created_at > ${attempt}.created_at
      and later.projection->>'state' = 'complete'
      and later.projection->>'providerId' = ${attempt}.projection->>'providerId'
      and later.projection->>'ownership' = ${attempt}.projection->>'ownership'
      and ${attempt}.projection->>'providerId' not like 'mcp-%'
      and ${attempt}.projection->>'providerId' not in ('openapi', 'graphql')
      and ${attempt}.projection->'mcpSetup' is null and later.projection->'mcpSetup' is null
      and coalesce(${attempt}.projection->'source'->>'kind', 'definition') = 'definition'
      and coalesce(later.projection->'installationTarget'->>'instanceKey', '')
        = coalesce(${attempt}.projection->'installationTarget'->>'instanceKey', '')`;
}

/** How long a saved account whose setup did not finish stays eligible to finish. */
export const UNFINISHED_CONNECT_SETUP_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * The actor's setups that saved an account but never installed its
 * integration (someone closed the app before the last step), newest first.
 * Unlike the pending list this includes attempts past their short expiry
 * (still open, or already marked expired): the saved account outlives the
 * attempt, and finishing needs no provider round trip.
 */
/**
 * A later setup by the same person of the same integration for the same saved
 * account. It took over: whatever the person did with that account since
 * (finished it, removed its tools) stands, so the older setup never finishes.
 */
function supersedingSetup(attempt: ReturnType<typeof sql>) {
  return sql`select 1 from connect_attempts later
    where later.workspace_id = ${attempt}.workspace_id and later.account_id = ${attempt}.account_id
      and later.subject_id = ${attempt}.subject_id and later.id <> ${attempt}.id
      and later.created_at > ${attempt}.created_at
      and later.projection->>'providerId' = ${attempt}.projection->>'providerId'
      and later.projection->'account'->>'id' = ${attempt}.projection->'account'->>'id'`;
}

export async function listUnfinishedConnectSetups(
  db: Database,
  scope: ConnectActorScope,
  limit = 16,
): Promise<Attempt[]> {
  return scoped(db, scope, async (tx) => {
    const rows = await rawRows<Row>(
      tx,
      sql`select * from connect_attempts attempt
      where attempt.workspace_id = ${scope.workspaceId}::uuid
        and attempt.account_id = ${scope.accountId}::uuid
        and attempt.subject_id = ${scope.subjectId} and attempt.operation_id is null
        and attempt.created_at > now() - make_interval(secs => ${UNFINISHED_CONNECT_SETUP_WINDOW_MS / 1000})
        and attempt.projection->>'state' in ('connected_but_incomplete','preview','expired')
        and attempt.projection->>'credentialsCommitted' = 'true'
        and coalesce(attempt.projection->>'integrationInstalled', 'false') <> 'true'
        and not exists (${supersedingSetup(sql`attempt`)})
      order by attempt.created_at desc, attempt.id desc limit ${limit}`,
    );
    return rows.map((row) => projection(row, scope));
  });
}

/**
 * Finish one unfinished setup (see listUnfinishedConnectSetups) in a single
 * transaction: `commit` installs under the attempt's row lock and returns the
 * completed attempt, or null to leave it as it is. Nothing happens when the
 * attempt moved on since `expectedRevision` or an operation is in flight
 * (the app is advancing it itself). Pass the same transaction to
 * installation persistence; do not perform network effects inside commit.
 */
export async function completeUnfinishedConnectSetup(
  db: Database,
  scope: ConnectActorScope,
  input: {
    attemptId: string;
    expectedRevision: number;
    commit: (
      tx: Database,
      current: Attempt,
      origin: ExternalActorContinuation | null,
    ) => Promise<Attempt | null>;
  },
): Promise<Attempt | null> {
  let transition: [Attempt, Attempt] | null = null;
  const result = await scoped(db, scope, async (tx) => {
    const row = await lockAttempt(tx, scope, input.attemptId);
    const current = projection(row, scope);
    if (
      row.operation_id !== null ||
      current.revision !== input.expectedRevision ||
      !["connected_but_incomplete", "preview", "expired"].includes(current.state) ||
      !current.credentialsCommitted ||
      current.integrationInstalled ||
      !current.account
    )
      return null;
    // One finish per saved account at a time (two tabs, a chat card and
    // Capabilities, or a server retry): the second sees the first's tools.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(
        ${`connect-finish:${scope.workspaceId}:${scope.subjectId}:${current.account.id}`}, 0))`,
    );
    const superseded = await rawRows<{ found: number }>(
      tx,
      sql`select 1 as found from connect_attempts attempt
        where attempt.id = ${row.id}::uuid and exists (${supersedingSetup(sql`attempt`)})`,
    );
    if (superseded.length > 0) return null;
    const committed = await input.commit(
      tx,
      structuredClone(current),
      row.external_continuation ? ExternalActorContinuation.parse(row.external_continuation) : null,
    );
    if (!committed) return null;
    const next = ConnectAttempt.parse(committed);
    if (
      next.id !== current.id ||
      next.workspaceId !== current.workspaceId ||
      next.providerId !== current.providerId ||
      next.ownership !== current.ownership ||
      next.completionRequirement !== current.completionRequirement ||
      stableJson(next.installationTarget ?? null) !==
        stableJson(current.installationTarget ?? null) ||
      next.expiresAt !== current.expiresAt ||
      next.revision !== current.revision + 1 ||
      next.state !== "complete" ||
      !next.credentialsCommitted ||
      !next.integrationInstalled
    )
      throw new ConnectAttemptConflictError();
    const persisted = await rawRows<{ id: string }>(
      tx,
      sql`update connect_attempts set projection = ${JSON.stringify(next)}::jsonb,
      updated_at = now() where id = ${row.id}::uuid returning id`,
    );
    if (persisted.length !== 1 || persisted[0]?.id !== row.id)
      throw new ConnectAttemptConflictError("Connect completion was not persisted");
    transition = [current, next];
    return next;
  });
  if (transition) reportConnectAttemptTransition(...(transition as [Attempt, Attempt]));
  return result;
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
    /** Additional acquisition admission, only after exact no-effect receipt replay. */
    authorizeAcquisition?: (tx: Database, attempt: Attempt) => Promise<void>;
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
    await input.authorizeAcquisition?.(tx, structuredClone(current));
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
    /** Additional acquisition admission, only after exact no-effect receipt replay. */
    authorizeAcquisition?: (tx: Database, attempt: Attempt) => Promise<void>;
  },
): Promise<Attempt> {
  validateOperation(input.operationId, input.inputDigest);
  let transition: [Attempt, Attempt] | null = null;
  const result = await scoped(db, scope, async (tx) => {
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
    await input.authorizeAcquisition?.(tx, structuredClone(current));
    if (row.operation_id !== input.operationId || row.operation_digest !== input.inputDigest)
      throw new ConnectAttemptConflictError();
    const next = ConnectAttempt.parse(await input.commit(tx, structuredClone(current)));
    if (
      next.id !== current.id ||
      next.workspaceId !== current.workspaceId ||
      next.providerId !== current.providerId ||
      next.ownership !== current.ownership ||
      next.completionRequirement !== current.completionRequirement ||
      stableJson(next.mcpSetup ?? null) !== stableJson(current.mcpSetup ?? null) ||
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
    const persisted = await rawRows<{ id: string }>(
      tx,
      sql`update connect_attempts set projection = ${JSON.stringify(next)}::jsonb,
      receipts = ${JSON.stringify(receipts)}::jsonb, operation_id = null, operation_digest = null,
      updated_at = now() where id = ${row.id}::uuid returning id`,
    );
    // A callback that loses the actor scope must roll back its writes, not
    // report success while RLS silently prevents the completion receipt.
    if (persisted.length !== 1 || persisted[0]?.id !== row.id)
      throw new ConnectAttemptConflictError("Connect completion receipt was not persisted");
    transition = [current, next];
    return next;
  });
  if (transition) reportConnectAttemptTransition(...(transition as [Attempt, Attempt]));
  return result;
}
