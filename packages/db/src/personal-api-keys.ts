import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  normalizeOrganizationAccessPolicy,
  type OrganizationAccessPolicy,
  type OrganizationWorkspaceScope,
  type Permission,
} from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import {
  readOrganizationApiKeyWorkspaceScopes,
  replaceOrganizationApiKeyWorkspaceScope,
} from "./organization-api-key-access";
import * as schema from "./schema";

/* ----------------------------------------------------------------------------
   Personal API keys act as the person who created them. The row stores who
   that is and the most the key may do; every request reloads the person's live
   organization access and caps it by this setting. The legacy `permissions`
   column stays empty so no older reader can mistake the key for a grant.
   -------------------------------------------------------------------------- */

export type PersonalApiKeyRecord = {
  id: string;
  accountId: string;
  ownerSubjectId: string;
  name: string;
  description: string | null;
  prefix: string;
  access: OrganizationAccessPolicy;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export class PersonalApiKeyWorkspaceScopeError extends Error {
  constructor() {
    super("Every selected workspace must belong to this organization");
    this.name = "PersonalApiKeyWorkspaceScopeError";
  }
}

export class PersonalApiKeyLimitExceededError extends Error {
  constructor(readonly limit: number) {
    super(`You already have ${limit} active personal API keys here. Revoke one to create another.`);
    this.name = "PersonalApiKeyLimitExceededError";
  }
}

/** Active keys one person may hold in one organization. */
export const MAX_ACTIVE_PERSONAL_API_KEYS = 25;

export function personalApiKeyAccess(
  row: typeof schema.apiKeys.$inferSelect,
  workspaceIds: string[] = [],
): OrganizationAccessPolicy {
  const workspaceScope: OrganizationWorkspaceScope =
    row.workspaceScope === "selected" ? { kind: "selected", workspaceIds } : { kind: "all" };
  return normalizeOrganizationAccessPolicy({
    preset: "custom",
    permissions: (row.ownerPermissions ?? []) as Permission[],
    workspaceScope,
  });
}

function mapPersonalApiKey(
  row: typeof schema.apiKeys.$inferSelect,
  workspaceIds?: string[],
): PersonalApiKeyRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    ownerSubjectId: row.ownerSubjectId!,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    access: personalApiKeyAccess(row, workspaceIds),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

async function validatePersonalApiKeyWorkspaceScope(
  tx: Database,
  accountId: string,
  scope: OrganizationWorkspaceScope,
): Promise<void> {
  if (scope.kind === "all") return;
  if (scope.workspaceIds.length === 0) return;
  const rows = await tx
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.accountId, accountId),
        inArray(schema.workspaces.id, scope.workspaceIds),
      ),
    )
    .for("key share");
  if (rows.length !== scope.workspaceIds.length) throw new PersonalApiKeyWorkspaceScopeError();
}

export async function createPersonalApiKey(
  db: Database,
  input: {
    accountId: string;
    ownerSubjectId: string;
    name: string;
    description?: string | null;
    prefix: string;
    keyHash: string;
    access: OrganizationAccessPolicy;
    expiresAt?: Date | null;
    maxActiveKeys?: number;
  },
): Promise<PersonalApiKeyRecord> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
    const access = normalizeOrganizationAccessPolicy(input.access);
    await validatePersonalApiKeyWorkspaceScope(tx, input.accountId, access.workspaceScope);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`personal-api-key:${input.accountId}:${input.ownerSubjectId}`}, 0))`,
    );
    const limit = input.maxActiveKeys ?? MAX_ACTIVE_PERSONAL_API_KEYS;
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.accountId, input.accountId),
          eq(schema.apiKeys.credentialKind, "personal"),
          eq(schema.apiKeys.ownerSubjectId, input.ownerSubjectId),
          isNull(schema.apiKeys.revokedAt),
          or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, new Date())),
        ),
      );
    if (Number(count) >= limit) throw new PersonalApiKeyLimitExceededError(limit);
    const [row] = await tx
      .insert(schema.apiKeys)
      .values({
        accountId: input.accountId,
        workspaceId: null,
        credentialKind: "personal",
        ownerSubjectId: input.ownerSubjectId,
        ownerPermissions: access.permissions,
        permissions: [],
        permissionMode: "explicit",
        workspaceScope: access.workspaceScope.kind,
        name: input.name,
        description: input.description ?? null,
        prefix: input.prefix,
        keyHash: input.keyHash,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create personal API key");
    await replaceOrganizationApiKeyWorkspaceScope(
      tx,
      input.accountId,
      row.id,
      access.workspaceScope,
    );
    return mapPersonalApiKey(
      row,
      access.workspaceScope.kind === "selected" ? access.workspaceScope.workspaceIds : [],
    );
  });
}

/** One person's keys, or everyone's when `ownerSubjectId` is omitted (admins). */
export async function listPersonalApiKeys(
  db: Database,
  input: { accountId: string; ownerSubjectId?: string; apiKeyId?: string },
): Promise<PersonalApiKeyRecord[]> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.accountId, input.accountId),
          eq(schema.apiKeys.credentialKind, "personal"),
          isNull(schema.apiKeys.revokedAt),
          input.ownerSubjectId
            ? eq(schema.apiKeys.ownerSubjectId, input.ownerSubjectId)
            : sql`true`,
          input.apiKeyId ? eq(schema.apiKeys.id, input.apiKeyId) : sql`true`,
        ),
      )
      .orderBy(desc(schema.apiKeys.createdAt));
    const scopes = await readOrganizationApiKeyWorkspaceScopes(tx, rows);
    return rows.map((row) => mapPersonalApiKey(row, scopes.get(row.id)));
  });
}

export async function revokePersonalApiKey(
  db: Database,
  input: { accountId: string; apiKeyId: string },
): Promise<PersonalApiKeyRecord | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(schema.apiKeys)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.apiKeys.accountId, input.accountId),
          eq(schema.apiKeys.credentialKind, "personal"),
          eq(schema.apiKeys.id, input.apiKeyId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning();
    return row ? mapPersonalApiKey(row) : null;
  });
}

/**
 * A person who leaves an organization loses every key that acts as them
 * there, so rejoining later never revives an old key.
 */
export async function revokePersonalApiKeysForOwner(
  tx: Database,
  input: { accountId: string; ownerSubjectId: string },
): Promise<number> {
  return await withRlsContext(
    tx,
    { accountId: input.accountId, workspaceId: null },
    async (scoped) => {
      const now = new Date();
      const rows = await scoped
        .update(schema.apiKeys)
        .set({ revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.apiKeys.accountId, input.accountId),
            eq(schema.apiKeys.credentialKind, "personal"),
            eq(schema.apiKeys.ownerSubjectId, input.ownerSubjectId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .returning({ id: schema.apiKeys.id });
      return rows.length;
    },
  );
}
