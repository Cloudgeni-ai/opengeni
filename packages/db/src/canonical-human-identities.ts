import {
  CanonicalHumanIdentityMutationResponse,
  CanonicalHumanIdentityProjection,
  type CanonicalHumanIdentityMutationOutcome,
  type CanonicalHumanIdentityMutationResponse as CanonicalHumanIdentityMutationResponseType,
  type CanonicalHumanIdentityProjection as CanonicalHumanIdentityProjectionType,
} from "@opengeni/contracts/canonical-human-identities";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export type CanonicalHumanSessionAuthority = {
  identityId: string;
  identityRevision: number;
  authRevision: number;
  identityStatus: "active" | "recovery_required" | "disputed" | "disabled";
};

export class CanonicalHumanIdentityConflictError extends Error {
  readonly name = "CanonicalHumanIdentityConflictError";
  readonly code = "CANONICAL_HUMAN_IDENTITY_CONFLICT";

  constructor() {
    super("The canonical human identity changed in another request");
  }
}

export class CanonicalHumanIdentityOperationReuseError extends Error {
  readonly name = "CanonicalHumanIdentityOperationReuseError";
  readonly code = "CANONICAL_HUMAN_IDENTITY_OPERATION_REUSED";

  constructor() {
    super("The canonical human identity operation id was already used for another request");
  }
}

export class CanonicalHumanIdentityNotFoundError extends Error {
  readonly name = "CanonicalHumanIdentityNotFoundError";

  constructor(message = "Canonical human identity was not found") {
    super(message);
  }
}

export class CanonicalHumanIdentityAuthorityError extends Error {
  readonly name = "CanonicalHumanIdentityAuthorityError";
}

function projectionValue(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function mapSqlError(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "40001") throw new CanonicalHumanIdentityConflictError();
  if (state === "23505") throw new CanonicalHumanIdentityOperationReuseError();
  if (state === "P0002") throw new CanonicalHumanIdentityNotFoundError();
  if (state === "42501") {
    throw new CanonicalHumanIdentityAuthorityError(
      error instanceof Error ? error.message : "Canonical human identity authority denied",
    );
  }
  throw error;
}

export async function ensureCanonicalHumanIdentity(
  db: Database,
  input: { authUserId: string; displayName: string },
): Promise<CanonicalHumanSessionAuthority> {
  try {
    const [row] = await rawRows<{
      identityId: string;
      identityRevision: number | string;
      authRevision: number | string;
      identityStatus: CanonicalHumanSessionAuthority["identityStatus"];
    }>(
      db,
      sql`
        select
          identity_id as "identityId",
          identity_revision as "identityRevision",
          auth_revision as "authRevision",
          identity_status as "identityStatus"
        from ensure_canonical_human_identity(${input.authUserId}, ${input.displayName})
      `,
    );
    if (!row) throw new CanonicalHumanIdentityNotFoundError();
    return {
      identityId: row.identityId,
      identityRevision: Number(row.identityRevision),
      authRevision: Number(row.authRevision),
      identityStatus: row.identityStatus,
    };
  } catch (error) {
    mapSqlError(error);
  }
}

export async function ensureCanonicalHumanIdentityForAuthUser(
  db: Database,
  authUserId: string,
): Promise<CanonicalHumanSessionAuthority> {
  const [user] = await rawRows<{ displayName: string }>(
    db,
    sql`
      select coalesce(nullif(btrim(name), ''), email) as "displayName"
      from auth_users
      where id = ${authUserId}
      limit 1
    `,
  );
  if (!user) throw new CanonicalHumanIdentityNotFoundError("Authentication user was not found");
  return await ensureCanonicalHumanIdentity(db, {
    authUserId,
    displayName: user.displayName,
  });
}

export async function validateCanonicalHumanSession(
  db: Database,
  input: { authSessionId: string; authUserId: string; allowRecovery?: boolean },
): Promise<boolean> {
  try {
    const [row] = await rawRows<{ valid: boolean }>(
      db,
      sql`
        select validate_canonical_human_session(
          ${input.authSessionId},
          ${input.authUserId},
          ${input.allowRecovery ?? false}
        ) as valid
      `,
    );
    return row?.valid === true;
  } catch (error) {
    mapSqlError(error);
  }
}

export async function getCanonicalHumanIdentityProjection(
  db: Database,
  authUserId: string,
): Promise<CanonicalHumanIdentityProjectionType> {
  try {
    const [row] = await rawRows<{ projection: unknown }>(
      db,
      sql`
        select get_canonical_human_identity_projection(${authUserId}) as projection
      `,
    );
    if (row?.projection === null || row?.projection === undefined) {
      throw new CanonicalHumanIdentityNotFoundError();
    }
    return CanonicalHumanIdentityProjection.parse(projectionValue(row.projection));
  } catch (error) {
    if (error instanceof CanonicalHumanIdentityNotFoundError) throw error;
    mapSqlError(error);
  }
}

export type ApplyCanonicalHumanIdentityOperationInput = {
  operationId: string;
  authUserId: string;
  expectedIdentityRevision: number;
  operationType: "link" | "unlink" | "begin_recovery" | "recover";
  bindingId?: string | null;
  providerId?: string | null;
  providerAccountId?: string | null;
  reason: string;
};

export async function applyCanonicalHumanIdentityOperation(
  db: Database,
  input: ApplyCanonicalHumanIdentityOperationInput,
): Promise<CanonicalHumanIdentityMutationResponseType> {
  try {
    const [row] = await rawRows<{
      outcome: CanonicalHumanIdentityMutationOutcome;
      identityId: string;
      identityRevision: number | string;
      authRevision: number | string;
    }>(
      db,
      sql`
        select
          outcome,
          identity_id as "identityId",
          identity_revision as "identityRevision",
          auth_revision as "authRevision"
        from apply_canonical_human_identity_operation(
          ${input.operationId},
          ${input.authUserId},
          ${input.expectedIdentityRevision},
          ${input.operationType},
          ${input.bindingId ?? null},
          ${input.providerId ?? null},
          ${input.providerAccountId ?? null},
          ${input.reason}
        )
      `,
    );
    if (!row) throw new CanonicalHumanIdentityNotFoundError();
    const identity = await getCanonicalHumanIdentityProjection(db, input.authUserId);
    return CanonicalHumanIdentityMutationResponse.parse({
      outcome: row.outcome,
      operationId: input.operationId,
      identity,
    });
  } catch (error) {
    if (
      error instanceof CanonicalHumanIdentityConflictError ||
      error instanceof CanonicalHumanIdentityOperationReuseError ||
      error instanceof CanonicalHumanIdentityNotFoundError ||
      error instanceof CanonicalHumanIdentityAuthorityError
    ) {
      throw error;
    }
    mapSqlError(error);
  }
}
