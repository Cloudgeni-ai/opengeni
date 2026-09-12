import { sql } from "drizzle-orm";
import { Permission } from "@opengeni/contracts";
import {
  ExternalIdentity,
  ExternalIdentityReference,
} from "@opengeni/contracts/external-identities";
import { rawRows, withAccountRls, type Database } from "./database";
export * from "./external-membership-operations";

/** Pass an open transaction to retain the key lock through the protected write. */
export async function lockActiveExternalOrganizationKey(
  tx: Database,
  accountId: string,
  keyId: string,
): Promise<Permission[] | null> {
  return withAccountRls(tx, accountId, async (scoped) => {
    const [row] = await rawRows<{ permissions: unknown }>(
      scoped,
      sql`select permissions from api_keys
      where account_id = ${accountId}::uuid and id = ${keyId}::uuid
        and workspace_id is null and credential_kind = 'organization'
        and revoked_at is null and (expires_at is null or expires_at > clock_timestamp()) for share`,
    );
    return row ? Permission.array().parse(row.permissions) : null;
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
