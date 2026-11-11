import { sql } from "drizzle-orm";
import { Permission } from "@opengeni/contracts";
import {
  ExternalIdentity,
  ExternalIdentityReference,
} from "@opengeni/contracts/external-identities";
import { rawRows, withAccountRls, withRlsContext, type Database } from "./database";
import {
  organizationApiKeyAllowsWorkspace,
  organizationApiKeyWorkspaceAllowedSql,
} from "./organization-api-key-access";
export * from "./external-membership-operations";

/** Pass an open transaction to retain the key lock through the protected write. */
export async function lockActiveExternalOrganizationKey(
  tx: Database,
  accountId: string,
  keyId: string,
  workspaceId?: string,
): Promise<Permission[] | null> {
  const key = await lockActiveExternalOrganizationKeyAuthority(tx, accountId, keyId, workspaceId);
  return key?.permissions ?? null;
}

/** Mode travels with the locked authority so explicit workspace:admin never
 * becomes a wildcard when callers evaluate a fresh policy. */
export async function lockActiveExternalOrganizationKeyAuthority(
  tx: Database,
  accountId: string,
  keyId: string,
  workspaceId?: string,
): Promise<{ permissions: Permission[]; permissionMode: "legacy" | "explicit" } | null> {
  return withAccountRls(tx, accountId, async (scoped) => {
    const [row] = await rawRows<{
      permissions: unknown;
      workspace_scope: "all" | "selected";
      permission_mode: "legacy" | "explicit";
    }>(
      scoped,
      sql`select permissions, workspace_scope, permission_mode from api_keys
      where account_id = ${accountId}::uuid and id = ${keyId}::uuid
        and workspace_id is null and credential_kind = 'organization'
        and revoked_at is null and (expires_at is null or expires_at > clock_timestamp()) for share`,
    );
    if (
      !row ||
      (workspaceId !== undefined &&
        !(await organizationApiKeyAllowsWorkspace(
          scoped,
          {
            id: keyId,
            accountId,
            workspaceScope: row.workspace_scope,
          },
          workspaceId,
        )))
    )
      return null;
    return {
      permissions: Permission.array().parse(row.permissions),
      permissionMode: row.permission_mode,
    };
  });
}

/**
 * Read-only twin of `lockActiveExternalOrganizationKeyAuthority` for a live
 * request fence: the same key predicates and workspace scope in one statement,
 * so the key row and its scope rows come from one snapshot. It takes no row
 * lock and writes nothing (no `last_used_at`); a revocation, expiry, narrowing
 * or scope change committed before the statement starts is always observed.
 */
export async function readActiveExternalOrganizationKeyAuthority(
  db: Database,
  accountId: string,
  keyId: string,
  workspaceId: string,
): Promise<{ permissions: Permission[]; permissionMode: "legacy" | "explicit" } | null> {
  return withRlsContext(db, { accountId, workspaceId }, async (scoped) => {
    const [row] = await rawRows<{
      permissions: unknown;
      permission_mode: "legacy" | "explicit";
    }>(
      scoped,
      sql`select k.permissions, k.permission_mode from api_keys k
      where k.account_id = ${accountId}::uuid and k.id = ${keyId}::uuid
        and k.workspace_id is null and k.credential_kind = 'organization'
        and k.revoked_at is null and (k.expires_at is null or k.expires_at > clock_timestamp())
        and ${organizationApiKeyWorkspaceAllowedSql(accountId, workspaceId, {
          id: sql`k.id`,
          workspaceScope: sql`k.workspace_scope`,
        })}`,
    );
    if (!row) return null;
    return {
      permissions: Permission.array().parse(row.permissions),
      permissionMode: row.permission_mode,
    };
  });
}

/** Transaction-local fence shared with organization member lifecycle writers.
 * Caller must pass an open transaction, not a pool-level database handle. */
export async function lockExternalWorkspaceMembershipLifecycle(
  tx: Database,
  accountId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
  );
}

/** The same fence in shared mode: ordered against every lifecycle writer
 * (they take it exclusively) but not against other readers, so concurrent
 * requests of one organization do not queue behind each other. Take it before
 * any other lock in the transaction, never after holding it shared and then
 * wanting it exclusively. Caller must pass an open transaction. */
export async function lockExternalWorkspaceMembershipLifecycleShared(
  tx: Database,
  accountId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock_shared(hashtextextended(${`organization-membership:${accountId}`}, 0))`,
  );
}

const EXTERNAL_IDENTITY_READ = "opengeni_private.read_external_identity_v1(uuid, text, text)";

/**
 * Whether the runtime may call the lock-free external identity read yet. 1172
 * creates it withheld: a release that does not know it rejects a runtime
 * EXECUTE grant on it, so a later migration grants it once this release is the
 * previous one. Until then authentication takes the fence exclusively, as
 * before. A separate statement: EXECUTE is checked when a statement starts.
 */
export async function externalIdentityReadGranted(db: Pick<Database, "execute">): Promise<boolean> {
  const [row] = await rawRows<{ granted: boolean | null }>(
    db,
    sql`select has_function_privilege(to_regprocedure(${EXTERNAL_IDENTITY_READ})::oid, 'EXECUTE')
      as granted`,
  );
  return row?.granted === true;
}

/** An existing external identity, read without locking or changing it, or
 * null when it does not exist yet (provision it with ensureExternalIdentity
 * under the exclusive fence). An inactive identity is refused with 42501, as
 * ensureExternalIdentity refuses it. Caller holds the membership fence, at
 * least shared, in the same transaction and the account's RLS scope, and has
 * checked externalIdentityReadGranted. */
export async function readExternalIdentity(
  tx: Database,
  input: {
    accountId: string;
    externalId: string;
    source?: string;
  },
): Promise<ExternalIdentity | null> {
  const reference = ExternalIdentityReference.parse({
    externalId: input.externalId,
    source: input.source,
  });
  const [row] = await rawRows<{ result: unknown }>(
    tx,
    sql`select opengeni_private.read_external_identity_v1(
    ${input.accountId}::uuid, ${reference.source}, ${reference.externalId}) as result`,
  );
  if (row?.result === null || row?.result === undefined) return null;
  const result = ExternalIdentity.parse(row.result);
  if (
    result.accountId !== input.accountId ||
    result.source !== reference.source ||
    result.externalId !== reference.externalId
  ) {
    throw new Error("External identity scope mismatch");
  }
  return result;
}

/** Internal lifecycle seam. Caller must authenticate an organization key and
 * establish its exact account before invoking; this does not admit HTTP users.
 * It never creates shared-workspace membership or reactivates removed users. */
export async function ensureExternalIdentity(
  db: Database,
  input: {
    accountId: string;
    externalId: string;
    source?: string;
  },
): Promise<ExternalIdentity> {
  const accountId = input.accountId;
  const reference = ExternalIdentityReference.parse({
    externalId: input.externalId,
    source: input.source,
  });
  return withAccountRls(db, accountId, async (tx) => {
    const [row] = await rawRows<{ result: unknown }>(
      tx,
      sql`select ensure_external_identity(
      ${accountId}::uuid, ${reference.source}, ${reference.externalId}) as result`,
    );
    const result = ExternalIdentity.parse(row?.result);
    if (
      result.accountId !== accountId ||
      result.source !== reference.source ||
      result.externalId !== reference.externalId
    ) {
      throw new Error("External identity scope mismatch");
    }
    return result;
  });
}
