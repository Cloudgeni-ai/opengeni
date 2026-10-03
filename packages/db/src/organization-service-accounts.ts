import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  Permission,
  serviceAccountAllowsPermission,
  type OrganizationServiceAccount,
  type OrganizationServiceAccountRole,
} from "@opengeni/contracts";
import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

/* ----------------------------------------------------------------------------
   Service accounts: an organization identity with no person behind it. Every
   organization API key belongs to one, and the service account's role caps
   what its keys can be given: a member's keys never hold administrator
   permissions. The cap lives in the stored key permissions themselves, so
   every check that reads a key (in TypeScript or SQL) sees it.
   -------------------------------------------------------------------------- */

export class OrganizationServiceAccountNotFoundError extends Error {
  constructor() {
    super("Service account not found");
    this.name = "OrganizationServiceAccountNotFoundError";
  }
}

export class OrganizationServiceAccountRoleError extends Error {
  constructor(readonly permissions: Permission[]) {
    super(
      `A member service account's keys can't hold ${permissions.join(", ")}. Make the service account an admin first.`,
    );
    this.name = "OrganizationServiceAccountRoleError";
  }
}

type ServiceAccountRow = typeof schema.organizationServiceAccounts.$inferSelect;
type KeyRow = typeof schema.apiKeys.$inferSelect;

/** Never implied by a legacy key's workspace:admin wildcard; held only literally. */
const LITERAL_ONLY_PERMISSIONS = new Set<Permission>([
  "account:read",
  "account:admin",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "members:manage",
  "secrets:read",
]);

function permissionAllowedByStoredKey(
  permissions: readonly string[],
  mode: KeyRow["permissionMode"],
  permission: Permission,
): boolean {
  if (permissions.includes(permission)) return true;
  // Legacy keys: workspace:admin implies workspace work, never organization
  // authority, member management or secret values. Converting never widens.
  return (
    mode !== "explicit" &&
    permissions.includes("workspace:admin") &&
    !LITERAL_ONLY_PERMISSIONS.has(permission)
  );
}

/** Everything a stored key can do, as an explicit list. */
export function effectiveKeyPermissions(
  key: Pick<KeyRow, "permissions" | "permissionMode">,
): Permission[] {
  return Permission.options.filter((permission) =>
    permissionAllowedByStoredKey(key.permissions, key.permissionMode, permission),
  );
}

/** The permissions a service account's role leaves out of `permissions`. */
export function permissionsBeyondServiceAccountRole(
  role: OrganizationServiceAccountRole,
  permissions: readonly Permission[],
): Permission[] {
  return permissions.filter((permission) => !serviceAccountAllowsPermission(role, permission));
}

function mapServiceAccount(
  row: ServiceAccountRow,
  activeKeyCount: number,
): OrganizationServiceAccount {
  return {
    id: row.id,
    organizationId: row.accountId,
    name: row.name,
    description: row.description,
    role: row.role,
    activeKeyCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function activeKeyCounts(tx: Database, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      serviceAccountId: schema.apiKeys.serviceAccountId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.apiKeys)
    .where(and(inArray(schema.apiKeys.serviceAccountId, ids), isNull(schema.apiKeys.revokedAt)))
    .groupBy(schema.apiKeys.serviceAccountId);
  return new Map(rows.map((row) => [row.serviceAccountId!, Number(row.count)]));
}

export async function listOrganizationServiceAccounts(
  db: Database,
  accountId: string,
): Promise<OrganizationServiceAccount[]> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.organizationServiceAccounts)
      .where(
        and(
          eq(schema.organizationServiceAccounts.accountId, accountId),
          isNull(schema.organizationServiceAccounts.deletedAt),
        ),
      )
      .orderBy(desc(schema.organizationServiceAccounts.createdAt));
    const counts = await activeKeyCounts(
      tx,
      rows.map((row) => row.id),
    );
    return rows.map((row) => mapServiceAccount(row, counts.get(row.id) ?? 0));
  });
}

/** A live service account, locked for the rest of the transaction. */
export async function lockOrganizationServiceAccount(
  tx: Database,
  accountId: string,
  serviceAccountId: string,
): Promise<ServiceAccountRow> {
  const [row] = await tx
    .select()
    .from(schema.organizationServiceAccounts)
    .where(
      and(
        eq(schema.organizationServiceAccounts.accountId, accountId),
        eq(schema.organizationServiceAccounts.id, serviceAccountId),
        isNull(schema.organizationServiceAccounts.deletedAt),
      ),
    )
    .for("update");
  if (!row) throw new OrganizationServiceAccountNotFoundError();
  return row;
}

export async function getOrganizationServiceAccount(
  db: Database,
  accountId: string,
  serviceAccountId: string,
): Promise<OrganizationServiceAccount | null> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.organizationServiceAccounts)
      .where(
        and(
          eq(schema.organizationServiceAccounts.accountId, accountId),
          eq(schema.organizationServiceAccounts.id, serviceAccountId),
          isNull(schema.organizationServiceAccounts.deletedAt),
        ),
      );
    if (!row) return null;
    const counts = await activeKeyCounts(tx, [row.id]);
    return mapServiceAccount(row, counts.get(row.id) ?? 0);
  });
}

/** Insert inside an existing organization-scoped transaction. */
export async function insertOrganizationServiceAccount(
  tx: Database,
  input: {
    accountId: string;
    name: string;
    description?: string | null;
    role: OrganizationServiceAccountRole;
    createdBySubjectId?: string | null;
  },
): Promise<ServiceAccountRow> {
  const [row] = await tx
    .insert(schema.organizationServiceAccounts)
    .values({
      accountId: input.accountId,
      name: input.name.trim().slice(0, 200) || "Organization API key",
      description: input.description ?? null,
      role: input.role,
      createdBySubjectId: input.createdBySubjectId ?? null,
    })
    .returning();
  if (!row) throw new Error("Failed to create service account");
  return row;
}

export async function createOrganizationServiceAccount(
  db: Database,
  input: {
    accountId: string;
    name: string;
    description?: string | null;
    role: OrganizationServiceAccountRole;
    createdBySubjectId: string;
  },
): Promise<OrganizationServiceAccount> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) =>
    mapServiceAccount(await insertOrganizationServiceAccount(tx, input), 0),
  );
}

/**
 * Rename, describe or change the role. Making it a member narrows its live
 * keys in the same transaction: each becomes an explicit key without
 * administrator permissions, so no key keeps more than its holder may have.
 */
export async function updateOrganizationServiceAccount(
  db: Database,
  accountId: string,
  serviceAccountId: string,
  input: {
    name?: string | undefined;
    description?: string | null | undefined;
    role?: OrganizationServiceAccountRole | undefined;
  },
): Promise<OrganizationServiceAccount> {
  return await withRlsContext(db, { accountId, workspaceId: null }, async (tx) => {
    const prior = await lockOrganizationServiceAccount(tx, accountId, serviceAccountId);
    const now = new Date();
    const [row] = await tx
      .update(schema.organizationServiceAccounts)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.role !== undefined ? { role: input.role } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.organizationServiceAccounts.accountId, accountId),
          eq(schema.organizationServiceAccounts.id, serviceAccountId),
        ),
      )
      .returning();
    if (!row) throw new OrganizationServiceAccountNotFoundError();
    if (input.role === "member" && prior.role !== "member") {
      const keys = await tx
        .select()
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.accountId, accountId),
            eq(schema.apiKeys.serviceAccountId, serviceAccountId),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .for("update");
      for (const key of keys) {
        const effective = effectiveKeyPermissions(key);
        if (permissionsBeyondServiceAccountRole("member", effective).length === 0) continue;
        await tx
          .update(schema.apiKeys)
          .set({
            permissions: effective.filter((permission) =>
              serviceAccountAllowsPermission("member", permission),
            ),
            permissionMode: "explicit",
            updatedAt: now,
          })
          .where(and(eq(schema.apiKeys.accountId, accountId), eq(schema.apiKeys.id, key.id)));
      }
    }
    const counts = await activeKeyCounts(tx, [row.id]);
    return mapServiceAccount(row, counts.get(row.id) ?? 0);
  });
}

/** Delete a service account and revoke every key it holds, at once. */
export async function deleteOrganizationServiceAccount(
  db: Database,
  accountId: string,
  serviceAccountId: string,
): Promise<void> {
  await withRlsContext(db, { accountId, workspaceId: null }, async (tx) => {
    await lockOrganizationServiceAccount(tx, accountId, serviceAccountId);
    const now = new Date();
    await tx
      .update(schema.apiKeys)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.apiKeys.accountId, accountId),
          eq(schema.apiKeys.serviceAccountId, serviceAccountId),
          isNull(schema.apiKeys.revokedAt),
        ),
      );
    await tx
      .update(schema.organizationServiceAccounts)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.organizationServiceAccounts.accountId, accountId),
          eq(schema.organizationServiceAccounts.id, serviceAccountId),
        ),
      );
  });
}

/** The holder of each key, for key listings. */
export async function serviceAccountsForKeys(
  tx: Database,
  keys: ReadonlyArray<Pick<KeyRow, "serviceAccountId">>,
): Promise<Map<string, { id: string; name: string; role: OrganizationServiceAccountRole }>> {
  const ids = [...new Set(keys.map((key) => key.serviceAccountId).filter(Boolean))] as string[];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: schema.organizationServiceAccounts.id,
      name: schema.organizationServiceAccounts.name,
      role: schema.organizationServiceAccounts.role,
    })
    .from(schema.organizationServiceAccounts)
    .where(inArray(schema.organizationServiceAccounts.id, ids));
  return new Map(rows.map((row) => [row.id, row]));
}
