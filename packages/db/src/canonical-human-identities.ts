import { createHash } from "node:crypto";
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

export type CanonicalHumanExactLoginBinding = {
  id: string;
  identityId: string;
  revision: number;
  status: "active" | "recovery_pending" | "stale" | "disputed" | "revoked";
};

export async function getCanonicalHumanExactLoginBindingForAuthUser(
  db: Database,
  input: { authUserId: string; providerId: string },
): Promise<CanonicalHumanExactLoginBinding> {
  const [row] = await rawRows<{
    result:
      | (Omit<CanonicalHumanExactLoginBinding, "revision"> & { revision: number | string })
      | null;
  }>(
    db,
    sql`
      select get_canonical_human_exact_login_binding(
        ${input.authUserId}, ${input.providerId}
      ) as result
    `,
  );
  if (!row?.result) {
    throw new CanonicalHumanIdentityAuthorityError(
      "Authentication did not prove exactly one canonical login binding",
    );
  }
  return { ...row.result, revision: Number(row.result.revision) };
}

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

export class CanonicalHumanIdentityMutationInFlightError extends Error {
  readonly name = "CanonicalHumanIdentityMutationInFlightError";
  readonly code = "CANONICAL_HUMAN_IDENTITY_MUTATION_IN_FLIGHT";

  constructor() {
    super("Another request is still using this browser actor");
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

function deterministicOperationId(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function projectionValue(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function mapSqlError(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "40001") throw new CanonicalHumanIdentityConflictError();
  if (state === "23505") throw new CanonicalHumanIdentityOperationReuseError();
  if (state === "55P03") throw new CanonicalHumanIdentityMutationInFlightError();
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
  try {
    const existing = await getCanonicalHumanIdentityProjection(db, authUserId);
    return {
      identityId: existing.activeIdentity.id,
      identityRevision: existing.activeIdentity.identityRevision,
      authRevision: existing.activeIdentity.authRevision,
      identityStatus: existing.activeIdentity.status,
    };
  } catch (error) {
    if (!(error instanceof CanonicalHumanIdentityNotFoundError)) throw error;
  }
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

export async function synchronizeCanonicalHumanLoginBindings(
  db: Database,
  authUserId: string,
): Promise<CanonicalHumanSessionAuthority> {
  let authority = await ensureCanonicalHumanIdentityForAuthUser(db, authUserId);
  const accounts = await rawRows<{
    id: string;
    providerId: string;
    providerAccountId: string;
  }>(
    db,
    sql`
      select
        id,
        lower(provider_id) as "providerId",
        account_id as "providerAccountId"
      from auth_identities
      where user_id = ${authUserId}
      order by created_at, id
    `,
  );

  for (const account of accounts) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const projection = await getCanonicalHumanIdentityProjection(db, authUserId);
      if (projection.activeIdentity.status !== "active") {
        return {
          identityId: projection.activeIdentity.id,
          identityRevision: projection.activeIdentity.identityRevision,
          authRevision: projection.activeIdentity.authRevision,
          identityStatus: projection.activeIdentity.status,
        };
      }
      const existing = projection.loginBindings.find(
        (binding) =>
          binding.providerId === account.providerId &&
          binding.providerAccountId === account.providerAccountId,
      );
      if (existing?.status === "active") {
        authority = {
          identityId: projection.activeIdentity.id,
          identityRevision: projection.activeIdentity.identityRevision,
          authRevision: projection.activeIdentity.authRevision,
          identityStatus: projection.activeIdentity.status,
        };
        break;
      }
      try {
        const result = await applyCanonicalHumanIdentityOperation(db, {
          operationId: deterministicOperationId(
            `canonical-human-account-link\n${account.id}\n${projection.activeIdentity.identityRevision}`,
          ),
          authUserId,
          expectedIdentityRevision: projection.activeIdentity.identityRevision,
          operationType: "link",
          providerId: account.providerId,
          providerAccountId: account.providerAccountId,
          reason: "Synchronize verified authentication account",
        });
        authority = {
          identityId: result.identity.activeIdentity.id,
          identityRevision: result.identity.activeIdentity.identityRevision,
          authRevision: result.identity.activeIdentity.authRevision,
          identityStatus: result.identity.activeIdentity.status,
        };
        break;
      } catch (error) {
        if (error instanceof CanonicalHumanIdentityConflictError && attempt < 3) continue;
        if (error instanceof CanonicalHumanIdentityAuthorityError) {
          const currentProjection = await getCanonicalHumanIdentityProjection(db, authUserId);
          if (currentProjection.activeIdentity.status !== "active") {
            return {
              identityId: currentProjection.activeIdentity.id,
              identityRevision: currentProjection.activeIdentity.identityRevision,
              authRevision: currentProjection.activeIdentity.authRevision,
              identityStatus: currentProjection.activeIdentity.status,
            };
          }
        }
        throw error;
      }
    }
  }
  return authority;
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
  actorFence?: {
    authorityHash: string;
    actorEpoch: string;
    requestId: string;
  };
};

export async function applyCanonicalHumanIdentityOperation(
  db: Database,
  input: ApplyCanonicalHumanIdentityOperationInput,
): Promise<CanonicalHumanIdentityMutationResponseType> {
  try {
    if (input.actorFence) {
      return await db.transaction(async (tx) => {
        const txDb = tx as unknown as Database;
        await rawRows(
          txDb,
          sql`select managed_auth_actor_mutation_fence(
            ${input.actorFence!.authorityHash}, ${input.actorFence!.actorEpoch}::bigint,
            ${input.actorFence!.requestId}::uuid
          )`,
        );
        return await applyCanonicalHumanIdentityOperationInner(txDb, input);
      });
    }
    return await applyCanonicalHumanIdentityOperationInner(db, input);
  } catch (error) {
    if (
      error instanceof CanonicalHumanIdentityConflictError ||
      error instanceof CanonicalHumanIdentityOperationReuseError ||
      error instanceof CanonicalHumanIdentityMutationInFlightError ||
      error instanceof CanonicalHumanIdentityNotFoundError ||
      error instanceof CanonicalHumanIdentityAuthorityError
    ) {
      throw error;
    }
    mapSqlError(error);
  }
}

async function applyCanonicalHumanIdentityOperationInner(
  db: Database,
  input: ApplyCanonicalHumanIdentityOperationInput,
): Promise<CanonicalHumanIdentityMutationResponseType> {
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
}
