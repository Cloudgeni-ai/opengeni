import {
  ManagedAuthLoginTransaction,
  ManagedAuthLogoutAllReceipt,
  ManagedAuthSessionSetProjection,
  type ManagedAuthLoginTransaction as ManagedAuthLoginTransactionType,
  type ManagedAuthLogoutAllReceipt as ManagedAuthLogoutAllReceiptType,
  type ManagedAuthSessionSetMode,
  type ManagedAuthSessionSetProjection as ManagedAuthSessionSetProjectionType,
} from "@opengeni/contracts/managed-auth-session-sets";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

const DatabaseProjection = ManagedAuthSessionSetProjection.omit({ csrfToken: true });
export type ManagedAuthDatabaseProjection = Omit<ManagedAuthSessionSetProjectionType, "csrfToken">;

export type ManagedAuthSelectedSession = {
  slotId: string;
  authSessionId: string;
  authUserId: string;
  token: string;
  email: string;
  name: string;
  emailVerified: boolean;
};

export type ManagedAuthInternalSlot = ManagedAuthSelectedSession;

export type ManagedAuthAdoptedSessionSnapshot = {
  authorityHash: string;
  actorEpoch: string;
  selected: ManagedAuthSelectedSession | null;
};

export class ManagedAuthSessionSetGenerationConflictError extends Error {
  readonly name = "ManagedAuthSessionSetGenerationConflictError";
  readonly code = "generation_conflict";
  constructor() {
    super("The browser session set changed in another request");
  }
}

export class ManagedAuthSessionSetOperationReuseError extends Error {
  readonly name = "ManagedAuthSessionSetOperationReuseError";
  constructor() {
    super("The browser session-set operation id was reused for different input");
  }
}

export class ManagedAuthSessionSetAuthorityError extends Error {
  readonly name = "ManagedAuthSessionSetAuthorityError";
}

export class ManagedAuthLoginSlotUnavailableError extends Error {
  readonly name = "ManagedAuthLoginSlotUnavailableError";
}

export class ManagedAuthLoginSlotLimitError extends Error {
  readonly name = "ManagedAuthLoginSlotLimitError";
}

export class ManagedAuthLoginSlotAlreadyExistsError extends Error {
  readonly name = "ManagedAuthLoginSlotAlreadyExistsError";
  readonly code = "slot_already_exists";
}

export class ManagedAuthActorMutationInFlightError extends Error {
  readonly name = "ManagedAuthActorMutationInFlightError";
  readonly code = "actor_mutation_in_flight";
}

function mapSqlError(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "40001") throw new ManagedAuthSessionSetGenerationConflictError();
  if (state === "23505") throw new ManagedAuthSessionSetOperationReuseError();
  if (state === "P0002") throw new ManagedAuthLoginSlotUnavailableError();
  if (state === "P0003") throw new ManagedAuthLoginSlotAlreadyExistsError();
  if (state === "54000") throw new ManagedAuthLoginSlotLimitError();
  if (state === "55P03") throw new ManagedAuthActorMutationInFlightError();
  if (state === "42501") {
    throw new ManagedAuthSessionSetAuthorityError(
      error instanceof Error ? error.message : "Browser session-set authority denied",
    );
  }
  throw error;
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function oneJson(db: Database, query: SQL): Promise<unknown> {
  const [row] = await rawRows<{ result: unknown }>(db, query);
  return row ? jsonValue(row.result) : null;
}

function projectionFromResult(value: unknown): ManagedAuthDatabaseProjection {
  const projection = (value as { projection?: unknown } | null)?.projection;
  return DatabaseProjection.parse(projection);
}

export async function getManagedAuthSessionSetAuthorityState(
  db: Database,
  authorityHash: string,
): Promise<"absent" | "active" | "retired"> {
  try {
    const [row] = await rawRows<{ state: string }>(
      db,
      sql`select managed_auth_session_set_authority_state(${authorityHash}) as state`,
    );
    const value = row?.state;
    if (value === "absent" || value === "active" || value === "retired") return value;
    throw new ManagedAuthSessionSetAuthorityError("Invalid browser session-set authority state");
  } catch (error) {
    mapSqlError(error);
  }
}

export async function getManagedAuthSessionSetSnapshot(
  db: Database,
  input: {
    authorityHash: string;
    mode: ManagedAuthSessionSetMode;
    includeInternal?: boolean;
    allowRecovery?: boolean;
    readOnly?: boolean;
  },
): Promise<{
  projection: ManagedAuthDatabaseProjection;
  selected: ManagedAuthSelectedSession | null;
  internalSlots: ManagedAuthInternalSlot[];
} | null> {
  try {
    const value = await oneJson(
      db,
      sql`select managed_auth_session_set_snapshot(
        ${input.authorityHash}, ${input.mode}, ${input.includeInternal ?? false},
        ${input.allowRecovery ?? false}, ${input.readOnly ?? false}
      ) as result`,
    );
    if (value === null) return null;
    const snapshot = value as {
      projection: unknown;
      selected?: ManagedAuthSelectedSession | null;
      internalSlots?: ManagedAuthInternalSlot[];
    };
    return {
      projection: DatabaseProjection.parse(snapshot.projection),
      selected: snapshot.selected ?? null,
      internalSlots: snapshot.internalSlots ?? [],
    };
  } catch (error) {
    mapSqlError(error);
  }
}

export async function bootstrapManagedAuthSessionSet(
  db: Database,
  input: {
    authorityHash: string;
    csrfHash: string;
    authSessionId: string | null;
    mode: ManagedAuthSessionSetMode;
    operationId: string;
    requestDigest: string;
    expectedGeneration: string;
    expectedActorEpoch: string;
  },
): Promise<ManagedAuthDatabaseProjection> {
  try {
    return projectionFromResult(
      await oneJson(
        db,
        sql`select managed_auth_session_set_bootstrap(
          ${input.authorityHash}, ${input.csrfHash}, ${input.authSessionId}, ${input.mode},
          ${input.operationId}::uuid, ${input.requestDigest},
          ${input.expectedGeneration}::bigint, ${input.expectedActorEpoch}::bigint
        ) as result`,
      ),
    );
  } catch (error) {
    mapSqlError(error);
  }
}

export async function beginManagedAuthLoginTransaction(
  db: Database,
  input: {
    authorityHash: string;
    csrfHash: string;
    operationId: string;
    requestDigest: string;
    expectedGeneration: string;
    expectedActorEpoch: string;
    transactionId: string;
    transactionSecretHash: string;
    kind: "add" | "reauth";
    targetSlotId: string | null;
    returnIntentId: string | null;
    returnPath: string | null;
    expiresAt: Date;
  },
): Promise<ManagedAuthLoginTransactionType> {
  try {
    const value = (await oneJson(
      db,
      sql`select managed_auth_session_set_begin_transaction(
          ${input.authorityHash}, ${input.csrfHash}, ${input.operationId}::uuid,
          ${input.requestDigest}, ${input.expectedGeneration}::bigint,
          ${input.transactionId}::uuid, ${input.expectedActorEpoch}::bigint,
          ${input.transactionSecretHash}, ${input.kind},
          ${input.targetSlotId}::uuid, ${input.returnIntentId}::uuid,
          ${input.returnPath}, ${input.expiresAt.toISOString()}::timestamptz
        ) as result`,
    )) as { expiresAt?: unknown } | null;
    return ManagedAuthLoginTransaction.parse({
      ...value,
      expiresAt:
        typeof value?.expiresAt === "string" || value?.expiresAt instanceof Date
          ? new Date(value.expiresAt).toISOString()
          : value?.expiresAt,
    });
  } catch (error) {
    mapSqlError(error);
  }
}

export async function completeManagedAuthLoginTransaction(
  db: Database,
  input: {
    authorityHash: string;
    csrfHash: string;
    operationId: string;
    requestDigest: string;
    expectedGeneration: string;
    expectedActorEpoch: string;
    transactionId: string;
    transactionSecretHash: string;
    authSessionId: string;
    mode: ManagedAuthSessionSetMode;
  },
): Promise<{ projection: ManagedAuthDatabaseProjection; returnIntent: string | null }> {
  try {
    const result = (await oneJson(
      db,
      sql`select managed_auth_session_set_complete_transaction(
        ${input.authorityHash}, ${input.csrfHash}, ${input.operationId}::uuid,
        ${input.requestDigest}, ${input.expectedGeneration}::bigint,
        ${input.expectedActorEpoch}::bigint,
        ${input.transactionId}::uuid, ${input.transactionSecretHash},
        ${input.authSessionId}, ${input.mode}
      ) as result`,
    )) as { projection: unknown; returnIntent?: string | null };
    return {
      projection: DatabaseProjection.parse(result.projection),
      returnIntent: result.returnIntent ?? null,
    };
  } catch (error) {
    mapSqlError(error);
  }
}

export async function mutateManagedAuthSessionSet(
  db: Database,
  input: {
    authorityHash: string;
    csrfHash: string;
    operationId: string;
    requestDigest: string;
    expectedGeneration: string;
    expectedActorEpoch: string;
    operationType: "cancel_transaction" | "select" | "logout_one" | "logout_all";
    targetSlotId?: string | null;
    replacementSlotId?: string | null;
    transactionId?: string | null;
    transactionSecretHash?: string | null;
    mode: ManagedAuthSessionSetMode;
  },
): Promise<ManagedAuthDatabaseProjection | ManagedAuthLogoutAllReceiptType> {
  try {
    const result = await oneJson(
      db,
      sql`select managed_auth_session_set_mutate(
        ${input.authorityHash}, ${input.csrfHash}, ${input.operationId}::uuid,
        ${input.requestDigest}, ${input.expectedGeneration}::bigint,
        ${input.expectedActorEpoch}::bigint, ${input.operationType},
        ${input.targetSlotId ?? null}::uuid, ${input.replacementSlotId ?? null}::uuid,
        ${input.transactionId ?? null}::uuid, ${input.transactionSecretHash ?? null}, ${input.mode}
      ) as result`,
    );
    if (input.operationType === "logout_all") return ManagedAuthLogoutAllReceipt.parse(result);
    return projectionFromResult(result);
  } catch (error) {
    mapSqlError(error);
  }
}

export async function getManagedAuthSessionSetOperationReceipt(
  db: Database,
  input: { authorityHash: string; operationId: string; requestDigest: string },
): Promise<{ projection: ManagedAuthDatabaseProjection; returnIntent: string | null } | null> {
  const result = (await oneJson(
    db,
    sql`select managed_auth_session_set_operation_receipt(
      ${input.authorityHash}, ${input.operationId}::uuid, ${input.requestDigest}, 'complete'
    ) as result`,
  )) as { projection?: unknown; returnIntent?: string | null } | null;
  if (!result?.projection) return null;
  return {
    projection: DatabaseProjection.parse(result.projection),
    returnIntent: result.returnIntent ?? null,
  };
}

export async function acquireManagedAuthActorMutationLease(
  db: Database,
  input: {
    authorityHash: string;
    actorEpoch: string;
    requestId: string;
    leaseSeconds: number;
  },
): Promise<Date> {
  try {
    const [row] = await rawRows<{ expiresAt: Date | string }>(
      db,
      sql`select managed_auth_actor_mutation_lease_acquire(
        ${input.authorityHash}, ${input.actorEpoch}::bigint,
        ${input.requestId}::uuid, ${input.leaseSeconds}::integer
      ) as "expiresAt"`,
    );
    if (!row) throw new ManagedAuthSessionSetAuthorityError("Mutation lease was not acquired");
    return row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
  } catch (error) {
    mapSqlError(error);
  }
}

export async function releaseManagedAuthActorMutationLease(
  db: Database,
  input: { authorityHash: string; requestId: string },
): Promise<boolean> {
  try {
    const [row] = await rawRows<{ released: boolean }>(
      db,
      sql`select managed_auth_actor_mutation_lease_release(
        ${input.authorityHash}, ${input.requestId}::uuid
      ) as released`,
    );
    return row?.released === true;
  } catch (error) {
    mapSqlError(error);
  }
}

/** Classify a legacy ambient session once it has entered session-set authority. */
export async function getManagedAuthAdoptedSessionSnapshot(
  db: Database,
  authSessionId: string,
): Promise<ManagedAuthAdoptedSessionSnapshot | null> {
  try {
    const value = (await oneJson(
      db,
      sql`select managed_auth_adopted_session_snapshot(${authSessionId}) as result`,
    )) as ManagedAuthAdoptedSessionSnapshot | null;
    if (value === null) return null;
    if (!/^[0-9a-f]{64}$/.test(value.authorityHash) || !/^[1-9][0-9]*$/.test(value.actorEpoch)) {
      throw new ManagedAuthSessionSetAuthorityError("Invalid adopted-session snapshot");
    }
    return value;
  } catch (error) {
    mapSqlError(error);
  }
}

/** Exact post-handler proof that the request-owned actor lease is still live. */
export async function validateManagedAuthActorMutationLease(
  db: Database,
  input: { authorityHash: string; actorEpoch: string; requestId: string },
): Promise<boolean> {
  try {
    const [row] = await rawRows<{ valid: boolean }>(
      db,
      sql`select managed_auth_actor_mutation_lease_validate(
        ${input.authorityHash}, ${input.actorEpoch}::bigint, ${input.requestId}::uuid
      ) as valid`,
    );
    return row?.valid === true;
  } catch (error) {
    mapSqlError(error);
  }
}

/** Bounded cleanup for provider sessions left by a process death before adoption. */
export async function reapManagedAuthIsolatedSessions(db: Database, limit = 100): Promise<number> {
  try {
    const [row] = await rawRows<{ reaped: number }>(
      db,
      sql`select managed_auth_isolated_session_reap(${limit}::integer) as reaped`,
    );
    return row?.reaped ?? 0;
  } catch (error) {
    mapSqlError(error);
  }
}

/** Bounded, lease-aware retirement of expired installation/session-set authority. */
export async function reapExpiredManagedAuthSessionSets(
  db: Database,
  limit = 100,
): Promise<number> {
  try {
    const [row] = await rawRows<{ retired: number }>(
      db,
      sql`select managed_auth_expired_session_set_reap(${limit}::integer) as retired`,
    );
    return row?.retired ?? 0;
  } catch (error) {
    mapSqlError(error);
  }
}
