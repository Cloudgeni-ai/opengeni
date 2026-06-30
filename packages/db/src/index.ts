import type {
  AccessContext,
  AccessGrant,
  ApiKey,
  BillingBalance,
  CapabilityCatalogItem,
  CapabilityInstallation,
  CapabilityInstallationStatus,
  CapabilityKind,
  CapabilityPack,
  CapabilitySource,
  FileAsset,
  FileStatus,
  FileUploadStatus,
  ManagedAccount,
  Permission,
  PackInstallation,
  PackInstallationStatus,
  ResourceRef,
  SandboxBackend,
  SandboxOs,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  ScheduledTaskOverlapPolicy,
  ScheduledTaskRun,
  ScheduledTaskRunMode,
  ScheduledTaskRunStatus,
  ScheduledTaskScheduleSpec,
  ScheduledTaskStatus,
  ScheduledTaskTriggerType,
  Session,
  SessionEvent,
  SessionEventType,
  SessionGoal,
  SessionGoalCreatedBy,
  SessionGoalStatus,
  SessionStatus,
  SessionTurn,
  SessionTurnSource,
  SessionTurnStatus,
  SocialConnection,
  SocialConnectionStatus,
  SocialPost,
  SocialProvider,
  ToolRef,
  ReasoningEffort,
  UsageEvent,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceEnvironmentVariableMetadata,
  WorkspaceMember,
  WorkspaceRegisteredPack,
} from "@opengeni/contracts";
import { reasoningEffortForMetadata, CLEARED_RUN_STATE_BLOB } from "@opengeni/contracts";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { and, asc, desc, eq, gt, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { decryptEnvironmentValue } from "./environment-crypto";
import { sanitizeEventPayload } from "./event-payload-sanitizer";
import * as schema from "./schema";

export { sql as dbSql } from "drizzle-orm";
export { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";
export { sanitizeEventPayload, sanitizeEventString } from "./event-payload-sanitizer";

export type Database = PostgresJsDatabase<typeof schema>;

export type DbClient = {
  db: Database;
  close: () => Promise<void>;
};

export type RlsContext = {
  accountId: string;
  workspaceId?: string | null;
};

export function createDb(databaseUrl: string): DbClient {
  const client = postgres(databaseUrl, { max: 10 });
  return {
    db: drizzle(client, { schema }),
    close: async () => {
      await client.end();
    },
  };
}

export async function setRlsContext(db: Database, context: RlsContext): Promise<void> {
  await db.execute(sql`select set_config('opengeni.account_id', ${context.accountId}, true)`);
  await db.execute(sql`select set_config('opengeni.workspace_id', ${context.workspaceId ?? ""}, true)`);
}

export async function withRlsContext<T>(
  db: Database,
  context: RlsContext,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    await setRlsContext(tx as unknown as Database, context);
    return await fn(tx as unknown as Database);
  });
}

export async function rlsContextForWorkspace(db: Database, workspaceId: string): Promise<RlsContext> {
  const [row] = await db.select({ accountId: schema.workspaces.accountId })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return { accountId: row.accountId, workspaceId };
}

export async function withWorkspaceRls<T>(
  db: Database,
  workspaceId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, await rlsContextForWorkspace(db, workspaceId), fn);
}

export async function withWorkspaceUsageLock<T>(
  db: Database,
  workspaceId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  const context = await rlsContextForWorkspace(db, workspaceId);
  return await withRlsContext(db, context, async (scopedDb) => {
    await scopedDb.execute(sql`select pg_advisory_xact_lock(hashtext(${`usage:${workspaceId}`}))`);
    return await fn(scopedDb);
  });
}

export async function withAccountRls<T>(
  db: Database,
  accountId: string,
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, { accountId, workspaceId: null }, fn);
}

export const allWorkspacePermissions: Permission[] = [
  "workspace:read",
  "workspace:admin",
  "members:manage",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "documents:manage",
  "documents:search",
  "scheduled_tasks:manage",
  "scheduled_tasks:run",
  "github:manage",
  "github:use",
  "api_keys:manage",
  "environments:manage",
  "environments:use",
  "goals:manage",
  "enrollments:read",
  "enrollments:manage",
];

export const allAccountPermissions: Permission[] = [
  "account:read",
  "account:admin",
  "members:manage",
  "workspace:create",
  "billing:read",
  "billing:manage",
  "api_keys:manage",
];

export type BootstrapWorkspaceInput = {
  accountExternalSource: string;
  accountExternalId: string;
  accountName: string;
  workspaceExternalSource: string;
  workspaceExternalId: string;
  workspaceName: string;
  subjectId: string;
  subjectLabel?: string;
  accountPermissions?: Permission[];
  workspacePermissions?: Permission[];
};

export async function bootstrapWorkspace(db: Database, input: BootstrapWorkspaceInput): Promise<AccessContext> {
  return await db.transaction(async (tx) => {
    const [account] = await tx.insert(schema.managedAccounts).values({
      name: input.accountName,
      externalSource: input.accountExternalSource,
      externalId: input.accountExternalId,
    }).onConflictDoUpdate({
      target: [schema.managedAccounts.externalSource, schema.managedAccounts.externalId],
      set: {
        name: input.accountName,
        updatedAt: new Date(),
      },
    }).returning();
    if (!account) {
      throw new Error("Failed to bootstrap account");
    }
    const [workspace] = await tx.insert(schema.workspaces).values({
      accountId: account.id,
      name: input.workspaceName,
      externalSource: input.workspaceExternalSource,
      externalId: input.workspaceExternalId,
    }).onConflictDoUpdate({
      target: [schema.workspaces.externalSource, schema.workspaces.externalId],
      set: {
        name: input.workspaceName,
        updatedAt: new Date(),
      },
    }).returning();
    if (!workspace) {
      throw new Error("Failed to bootstrap workspace");
    }
    const workspacePermissions = input.workspacePermissions ?? allWorkspacePermissions;
    await tx.insert(schema.workspaceMemberships).values({
      accountId: account.id,
      workspaceId: workspace.id,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel ?? null,
      role: "owner",
      permissions: workspacePermissions,
    }).onConflictDoUpdate({
      target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
      set: {
        subjectLabel: input.subjectLabel ?? null,
        role: "owner",
        permissions: workspacePermissions,
        updatedAt: new Date(),
      },
    });
    return {
      mode: input.accountExternalSource === "opengeni:local" ? "local" : "configured",
      subjectId: input.subjectId,
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
      accountGrants: [{
        accountId: account.id,
        subjectId: input.subjectId,
        ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        role: "owner",
        permissions: input.accountPermissions ?? allAccountPermissions,
      }],
      workspaceGrants: [{
        workspaceId: workspace.id,
        accountId: account.id,
        subjectId: input.subjectId,
        ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
        permissions: workspacePermissions,
      }],
      defaultAccountId: account.id,
      defaultWorkspaceId: workspace.id,
    };
  });
}

export async function ensureManagedAccessForUser(db: Database, input: {
  userId: string;
  email: string;
  name: string;
}): Promise<AccessContext> {
  const subjectId = `user:${input.userId}`;
  const subjectLabel = input.email || input.name;
  return await db.transaction(async (tx) => {
    const [account] = await tx.insert(schema.managedAccounts).values({
      name: input.name || input.email,
      externalSource: "better-auth:user",
      externalId: input.userId,
    }).onConflictDoUpdate({
      target: [schema.managedAccounts.externalSource, schema.managedAccounts.externalId],
      set: {
        name: input.name || input.email,
        updatedAt: new Date(),
      },
    }).returning();
    if (!account) {
      throw new Error("Failed to ensure managed account");
    }
    const [defaultWorkspace] = await tx.insert(schema.workspaces).values({
      accountId: account.id,
      name: "Default workspace",
      slug: "default",
      externalSource: "better-auth:user",
      externalId: `${input.userId}:default`,
    }).onConflictDoUpdate({
      target: [schema.workspaces.externalSource, schema.workspaces.externalId],
      set: {
        name: "Default workspace",
        updatedAt: new Date(),
      },
    }).returning();
    if (!defaultWorkspace) {
      throw new Error("Failed to ensure default workspace");
    }
    await tx.insert(schema.workspaceMemberships).values({
      accountId: account.id,
      workspaceId: defaultWorkspace.id,
      subjectId,
      subjectLabel,
      role: "owner",
      permissions: allWorkspacePermissions,
    }).onConflictDoUpdate({
      target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
      set: {
        subjectLabel,
        role: "owner",
        permissions: allWorkspacePermissions,
        updatedAt: new Date(),
      },
    });
    const memberships = await tx.select({
      membership: schema.workspaceMemberships,
      workspace: schema.workspaces,
    }).from(schema.workspaceMemberships)
      .innerJoin(schema.workspaces, eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id))
      .where(eq(schema.workspaceMemberships.subjectId, subjectId))
      .orderBy(desc(schema.workspaces.createdAt));
    return {
      mode: "managed",
      subjectId,
      subjectLabel,
      accountGrants: [{
        accountId: account.id,
        subjectId,
        subjectLabel,
        role: "owner",
        permissions: allAccountPermissions,
      }],
      workspaceGrants: memberships.map((row) => ({
        workspaceId: row.workspace.id,
        accountId: row.workspace.accountId,
        subjectId,
        subjectLabel,
        permissions: row.membership.permissions as Permission[],
      })),
      defaultAccountId: account.id,
      defaultWorkspaceId: defaultWorkspace.id,
    };
  });
}

export async function getWorkspace(db: Database, workspaceId: string): Promise<Workspace | null> {
  const [row] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  return row ? mapWorkspace(row) : null;
}

export async function getManagedAccount(db: Database, accountId: string): Promise<ManagedAccount | null> {
  const [row] = await db.select().from(schema.managedAccounts).where(eq(schema.managedAccounts.id, accountId)).limit(1);
  return row ? mapAccount(row) : null;
}

export async function requireWorkspace(db: Database, workspaceId: string): Promise<Workspace> {
  const workspace = await getWorkspace(db, workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return workspace;
}

export async function listWorkspacesForSubject(db: Database, subjectId: string, limit = 100): Promise<Workspace[]> {
  const rows = await db.select({ workspace: schema.workspaces }).from(schema.workspaceMemberships)
    .innerJoin(schema.workspaces, eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id))
    .where(eq(schema.workspaceMemberships.subjectId, subjectId))
    .orderBy(desc(schema.workspaces.createdAt))
    .limit(limit);
  return rows.map((row) => mapWorkspace(row.workspace));
}

export async function countWorkspacesForAccount(db: Database, accountId: string): Promise<number> {
  const [{ count } = { count: 0 }] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(schema.workspaces).where(eq(schema.workspaces.accountId, accountId));
  return Number(count);
}

export async function createWorkspace(db: Database, input: {
  accountId: string;
  name: string;
  slug?: string | null;
  externalSource?: string | null;
  externalId?: string | null;
  agentInstructions?: string | null;
}): Promise<Workspace> {
  const [row] = await db.insert(schema.workspaces).values({
    accountId: input.accountId,
    name: input.name,
    slug: input.slug ?? null,
    externalSource: input.externalSource ?? null,
    externalId: input.externalId ?? null,
    agentInstructions: input.agentInstructions ?? null,
  }).returning();
  if (!row) {
    throw new Error("Failed to create workspace");
  }
  return mapWorkspace(row);
}

export async function grantWorkspaceAccess(db: Database, input: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  subjectLabel?: string;
  role?: string;
  permissions: Permission[];
}): Promise<void> {
  await db.insert(schema.workspaceMemberships).values({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    subjectLabel: input.subjectLabel ?? null,
    role: input.role ?? "member",
    permissions: input.permissions,
  }).onConflictDoUpdate({
    target: [schema.workspaceMemberships.subjectId, schema.workspaceMemberships.workspaceId],
    set: {
      subjectLabel: input.subjectLabel ?? null,
      role: input.role ?? "member",
      permissions: input.permissions,
      updatedAt: new Date(),
    },
  });
}

export async function updateWorkspace(db: Database, workspaceId: string, input: {
  name?: string;
  slug?: string | null;
  agentInstructions?: string | null;
}): Promise<Workspace> {
  const [row] = await db.update(schema.workspaces).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.agentInstructions !== undefined ? { agentInstructions: input.agentInstructions } : {}),
    updatedAt: new Date(),
  }).where(eq(schema.workspaces.id, workspaceId)).returning();
  if (!row) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  return mapWorkspace(row);
}

export async function getWorkspaceGrant(db: Database, subjectId: string, workspaceId: string): Promise<AccessGrant | null> {
  const [row] = await db.select({
    membership: schema.workspaceMemberships,
    workspace: schema.workspaces,
  }).from(schema.workspaceMemberships)
    .innerJoin(schema.workspaces, eq(schema.workspaceMemberships.workspaceId, schema.workspaces.id))
    .where(and(eq(schema.workspaceMemberships.subjectId, subjectId), eq(schema.workspaceMemberships.workspaceId, workspaceId)))
    .limit(1);
  return row ? {
    workspaceId: row.workspace.id,
    accountId: row.workspace.accountId,
    subjectId: row.membership.subjectId,
    ...(row.membership.subjectLabel ? { subjectLabel: row.membership.subjectLabel } : {}),
    permissions: row.membership.permissions as Permission[],
  } : null;
}

export async function listWorkspaceMembers(db: Database, workspaceId: string): Promise<WorkspaceMember[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.workspaceMemberships)
      .where(eq(schema.workspaceMemberships.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceMemberships.createdAt));
    return rows.map(mapWorkspaceMember);
  });
}

export async function removeWorkspaceMember(db: Database, workspaceId: string, subjectId: string): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.delete(schema.workspaceMemberships)
      .where(and(eq(schema.workspaceMemberships.workspaceId, workspaceId), eq(schema.workspaceMemberships.subjectId, subjectId)))
      .returning({ id: schema.workspaceMemberships.id });
    return rows.length > 0;
  });
}

/**
 * Resolve a Better Auth user email to its user id. The `auth_users` table is
 * owned by Better Auth and is NOT in the Drizzle schema, so this runs a raw
 * parameterized select. Returns the id (or null when no such user exists),
 * matching emails case-insensitively. Used to add an already-registered user
 * to a workspace; email invites for unknown users are deferred.
 */
export async function getManagedUserByEmail(db: Database, email: string): Promise<string | null> {
  const rows = await db.execute(sql<{ id: string }>`
    select id from auth_users where lower(email) = lower(${email}) limit 1
  `);
  return (rows[0]?.id as string | undefined) ?? null;
}

export async function deleteWorkspace(db: Database, workspaceId: string): Promise<void> {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
}

export async function createApiKey(db: Database, input: {
  accountId: string;
  workspaceId?: string | null;
  name: string;
  prefix: string;
  keyHash: string;
  permissions: Permission[];
  expiresAt?: Date | null;
}): Promise<ApiKey> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId ?? null }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.apiKeys).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? null,
      name: input.name,
      prefix: input.prefix,
      keyHash: input.keyHash,
      permissions: input.permissions,
      expiresAt: input.expiresAt ?? null,
    }).returning();
    if (!row) {
      throw new Error("Failed to create API key");
    }
    return mapApiKey(row);
  });
}

export async function listApiKeys(db: Database, workspaceId: string): Promise<ApiKey[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.apiKeys)
      .where(eq(schema.apiKeys.workspaceId, workspaceId))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows.map(mapApiKey);
  });
}

export async function countActiveApiKeysForWorkspace(db: Database, workspaceId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb.select({
      count: sql<number>`count(*)::int`,
    }).from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.workspaceId, workspaceId), sql`${schema.apiKeys.revokedAt} is null`, sql`(${schema.apiKeys.expiresAt} is null or ${schema.apiKeys.expiresAt} > now())`));
    return Number(count);
  });
}

export async function revokeApiKey(db: Database, workspaceId: string, apiKeyId: string): Promise<ApiKey> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.apiKeys).set({
      revokedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(schema.apiKeys.workspaceId, workspaceId), eq(schema.apiKeys.id, apiKeyId))).returning();
    if (!row) {
      throw new Error(`API key not found: ${apiKeyId}`);
    }
    return mapApiKey(row);
  });
}

export async function findActiveApiKeyByHash(db: Database, keyHash: string): Promise<ApiKey | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.api_key_hash', ${keyHash}, true)`);
    const [row] = await tx.select().from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, keyHash), sql`${schema.apiKeys.revokedAt} is null`, sql`(${schema.apiKeys.expiresAt} is null or ${schema.apiKeys.expiresAt} > now())`))
      .limit(1);
    if (!row) {
      return null;
    }
    const now = new Date();
    await tx.update(schema.apiKeys).set({ lastUsedAt: now, updatedAt: now }).where(eq(schema.apiKeys.id, row.id));
    return mapApiKey({ ...row, lastUsedAt: now });
  });
}

export type GitHubInstallation = {
  id: string;
  accountId: string;
  workspaceId: string;
  installationId: number;
  accountLogin: string | null;
  accountType: string | null;
  createdAt: string;
  updatedAt: string;
};

export async function upsertGitHubInstallation(db: Database, input: {
  accountId: string;
  workspaceId: string;
  installationId: number;
  accountLogin?: string | null;
  accountType?: string | null;
}): Promise<GitHubInstallation> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.githubInstallations).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      accountLogin: input.accountLogin ?? null,
      accountType: input.accountType ?? null,
    }).onConflictDoUpdate({
      target: [schema.githubInstallations.workspaceId, schema.githubInstallations.installationId],
      set: {
        accountId: input.accountId,
        accountLogin: input.accountLogin ?? null,
        accountType: input.accountType ?? null,
        updatedAt: new Date(),
      },
    }).returning();
    if (!row) {
      throw new Error("Failed to upsert GitHub installation");
    }
    return mapGitHubInstallation(row);
  });
}

export async function listGitHubInstallationsForWorkspace(db: Database, workspaceId: string): Promise<GitHubInstallation[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.githubInstallations.updatedAt));
    return rows.map(mapGitHubInstallation);
  });
}

export async function listGitHubInstallationIdsForWorkspace(db: Database, workspaceId: string): Promise<number[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select({ installationId: schema.githubInstallations.installationId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.githubInstallations.updatedAt));
    return rows.map((row) => row.installationId);
  });
}

export async function recordUsageEvent(db: Database, input: {
  accountId: string;
  workspaceId: string;
  subjectId?: string | null;
  eventType: string;
  quantity: number;
  unit: string;
  sourceResourceType?: string | null;
  sourceResourceId?: string | null;
  idempotencyKey: string;
  occurredAt?: Date;
}): Promise<UsageEvent> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.usageEvents).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId ?? null,
      eventType: input.eventType,
      quantity: input.quantity,
      unit: input.unit,
      sourceResourceType: input.sourceResourceType ?? null,
      sourceResourceId: input.sourceResourceId ?? null,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt ?? new Date(),
    }).onConflictDoNothing({ target: schema.usageEvents.idempotencyKey }).returning();
    if (row) {
      return mapUsageEvent(row);
    }
    const [existing] = await scopedDb.select().from(schema.usageEvents).where(eq(schema.usageEvents.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!existing) {
      throw new Error("Failed to record usage event");
    }
    return mapUsageEvent(existing);
  });
}

export async function listUsageEvents(db: Database, input: {
  accountId: string;
  workspaceId?: string;
  limit?: number;
}): Promise<UsageEvent[]> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId ?? null }, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.usageEvents)
      .where(input.workspaceId
        ? and(eq(schema.usageEvents.accountId, input.accountId), eq(schema.usageEvents.workspaceId, input.workspaceId))
        : eq(schema.usageEvents.accountId, input.accountId))
      .orderBy(desc(schema.usageEvents.occurredAt), desc(schema.usageEvents.recordedAt))
      .limit(input.limit ?? 100);
    return rows.map(mapUsageEvent);
  });
}

export async function sumUsageQuantity(db: Database, input: {
  accountId?: string;
  workspaceId?: string;
  eventType: string;
  since?: Date;
}): Promise<number> {
  const context = input.workspaceId
    ? await rlsContextForWorkspace(db, input.workspaceId)
    : input.accountId
      ? { accountId: input.accountId, workspaceId: null }
      : null;
  if (!context) {
    throw new Error("Usage quantity queries require accountId or workspaceId");
  }
  return await withRlsContext(db, context, async (scopedDb) => {
    const clauses = [
      eq(schema.usageEvents.eventType, input.eventType),
      ...(input.accountId ? [eq(schema.usageEvents.accountId, input.accountId)] : []),
      ...(input.workspaceId ? [eq(schema.usageEvents.workspaceId, input.workspaceId)] : []),
      ...(input.since ? [gt(schema.usageEvents.occurredAt, input.since)] : []),
    ];
    const [{ total } = { total: 0 }] = await scopedDb.select({
      total: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
    }).from(schema.usageEvents).where(and(...clauses));
    return Number(total);
  });
}

export async function applyCreditLedgerEntry(db: Database, input: {
  accountId: string;
  workspaceId?: string | null;
  type: string;
  amountMicros: number;
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<BillingBalance> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId ?? null }, async (scopedDb) => {
    await scopedDb.insert(schema.creditLedgerEntries).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? null,
      type: input.type,
      amountMicros: input.amountMicros,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    }).onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey });
    return await getBillingBalance(scopedDb, input.accountId);
  });
}

export async function applyCreditDebitUpToBalance(db: Database, input: {
  accountId: string;
  workspaceId?: string | null;
  type: string;
  requestedAmountMicros: number;
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<{ balance: BillingBalance; debitedMicros: number }> {
  if (input.requestedAmountMicros <= 0) {
    return { balance: await getBillingBalance(db, input.accountId), debitedMicros: 0 };
  }
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId ?? null }, async (scopedDb) => {
    await scopedDb.execute(sql`select pg_advisory_xact_lock(hashtext(${input.accountId}))`);
    const before = await getBillingBalance(scopedDb, input.accountId);
    const debitedMicros = Math.min(input.requestedAmountMicros, Math.max(0, before.balanceMicros));
    if (debitedMicros > 0) {
      await scopedDb.insert(schema.creditLedgerEntries).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId ?? null,
        type: input.type,
        amountMicros: -debitedMicros,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        metadata: {
          ...input.metadata,
          requestedAmountMicros: input.requestedAmountMicros,
          debitedMicros,
        },
        occurredAt: input.occurredAt ?? new Date(),
      }).onConflictDoNothing({ target: schema.creditLedgerEntries.idempotencyKey });
    }
    return { balance: await getBillingBalance(scopedDb, input.accountId), debitedMicros };
  });
}

export async function hasCreditLedgerEntry(db: Database, accountId: string, idempotencyKey: string): Promise<boolean> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [row] = await scopedDb.select({ id: schema.creditLedgerEntries.id })
      .from(schema.creditLedgerEntries)
      .where(and(eq(schema.creditLedgerEntries.accountId, accountId), eq(schema.creditLedgerEntries.idempotencyKey, idempotencyKey)))
      .limit(1);
    return Boolean(row);
  });
}

export async function getBillingCustomer(db: Database, accountId: string, provider = "stripe"): Promise<{
  accountId: string;
  provider: string;
  providerCustomerId: string;
  email: string | null;
} | null> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.billingCustomers)
      .where(and(eq(schema.billingCustomers.accountId, accountId), eq(schema.billingCustomers.provider, provider)))
      .limit(1);
    return row ? {
      accountId: row.accountId,
      provider: row.provider,
      providerCustomerId: row.providerCustomerId,
      email: row.email,
    } : null;
  });
}

export async function upsertBillingCustomer(db: Database, input: {
  accountId: string;
  provider?: string;
  providerCustomerId: string;
  email?: string | null;
}): Promise<void> {
  await withAccountRls(db, input.accountId, async (scopedDb) => {
    await scopedDb.insert(schema.billingCustomers).values({
      accountId: input.accountId,
      provider: input.provider ?? "stripe",
      providerCustomerId: input.providerCustomerId,
      email: input.email ?? null,
    }).onConflictDoUpdate({
      target: [schema.billingCustomers.accountId, schema.billingCustomers.provider],
      set: {
        providerCustomerId: input.providerCustomerId,
        email: input.email ?? null,
        updatedAt: new Date(),
      },
    });
  });
}

export async function recordStripeWebhookEvent(db: Database, input: {
  id: string;
  type: string;
  livemode: boolean;
  payload: unknown;
}): Promise<boolean> {
  const [row] = await db.insert(schema.stripeWebhookEvents).values({
    id: input.id,
    type: input.type,
    livemode: String(input.livemode),
    payload: input.payload,
  }).onConflictDoNothing({ target: schema.stripeWebhookEvents.id }).returning({ id: schema.stripeWebhookEvents.id });
  return Boolean(row);
}

export async function isStripeWebhookProcessed(db: Database, id: string): Promise<boolean> {
  const [row] = await db.select({ processedAt: schema.stripeWebhookEvents.processedAt })
    .from(schema.stripeWebhookEvents)
    .where(eq(schema.stripeWebhookEvents.id, id))
    .limit(1);
  return Boolean(row?.processedAt);
}

export async function markStripeWebhookProcessed(db: Database, id: string): Promise<void> {
  await db.update(schema.stripeWebhookEvents).set({ processedAt: new Date() }).where(eq(schema.stripeWebhookEvents.id, id));
}

export async function getBillingBalance(db: Database, accountId: string): Promise<BillingBalance> {
  return await withAccountRls(db, accountId, async (scopedDb) => {
    const [{ balance } = { balance: 0 }] = await scopedDb.select({
      balance: sql<number>`coalesce(sum(${schema.creditLedgerEntries.amountMicros}), 0)`,
    }).from(schema.creditLedgerEntries).where(eq(schema.creditLedgerEntries.accountId, accountId));
    return {
      accountId,
      balanceMicros: Number(balance),
      currency: "usd",
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function countScheduledTasksForWorkspace(db: Database, workspaceId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb.select({
      count: sql<number>`count(*)::int`,
    }).from(schema.scheduledTasks).where(eq(schema.scheduledTasks.workspaceId, workspaceId));
    return Number(count);
  });
}

export type AppendEventInput = {
  type: SessionEventType;
  payload?: unknown;
  clientEventId?: string;
  turnId?: string | null;
  producerId?: string;
  producerSeq?: number;
  occurredAt?: Date;
};

export type CreateScheduledTaskInput = {
  id?: string;
  accountId: string;
  workspaceId: string;
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  temporalScheduleId: string;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  environmentId?: string | null;
  metadata: Record<string, unknown>;
};

export type UpdateScheduledTaskInput = Partial<{
  name: string;
  status: ScheduledTaskStatus;
  schedule: ScheduledTaskScheduleSpec;
  runMode: ScheduledTaskRunMode;
  overlapPolicy: ScheduledTaskOverlapPolicy;
  agentConfig: ScheduledTaskAgentConfig;
  reusableSessionId: string | null;
  environmentId: string | null;
  metadata: Record<string, unknown>;
}>;

export type CreatePackInstallationInput = {
  accountId: string;
  workspaceId: string;
  packId: string;
  metadata?: Record<string, unknown>;
};

export type RegisterWorkspacePackInput = {
  accountId: string;
  workspaceId: string;
  pack: CapabilityPack;
};

export type CreateSocialConnectionInput = {
  accountId: string;
  workspaceId: string;
  provider: SocialProvider;
  accountHandle: string;
  accountName?: string | null;
  externalAccountId?: string | null;
  status: SocialConnectionStatus;
  scopes?: string[];
  credentialRef?: string | null;
  tokenMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type CreateSocialPostInput = {
  accountId: string;
  workspaceId: string;
  connectionId: string;
  externalPostId?: string | null;
  url?: string | null;
  authorHandle?: string | null;
  text: string;
  publishedAt: Date;
  metrics?: Record<string, number>;
  raw?: Record<string, unknown>;
};

export type CreateCapabilityCatalogItemInput = {
  accountId: string;
  workspaceId: string;
  id: string;
  kind: Exclude<CapabilityKind, "pack">;
  source: CapabilitySource;
  name: string;
  description?: string | null;
  category?: string;
  tags?: string[];
  homepageUrl?: string | null;
  endpointUrl?: string | null;
  installUrl?: string | null;
  authModel?: string | null;
  metadata?: Record<string, unknown>;
};

export type EnableCapabilityInstallationInput = {
  accountId: string;
  workspaceId: string;
  capabilityId: string;
  kind: CapabilityKind;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type EnabledMcpCapabilityServer = {
  capabilityId: string;
  id: string;
  name: string;
  url: string;
  allowedTools?: string[];
  timeoutMs?: number;
  cacheToolsList?: boolean;
  /**
   * Credential request headers stored encrypted at enable time
   * (AES-256-GCM under the workspace-environments key). Decrypted only at
   * the runtime boundary that builds the MCP client; never exposed by the
   * capability API surface.
   */
  headersEncrypted?: Record<string, string>;
};

export type EnqueueSessionTurnInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
  source: SessionTurnSource;
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  metadata: Record<string, unknown>;
};

export type UpdateQueuedSessionTurnInput = Partial<{
  prompt: string;
  resources: ResourceRef[];
  tools: ToolRef[];
  model: string;
  reasoningEffort: ReasoningEffort;
  sandboxBackend: SandboxBackend;
  metadata: Record<string, unknown>;
}>;

export async function createFileUpload(db: Database, input: {
  accountId: string;
  workspaceId: string;
  fileId: string;
  filename: string;
  safeFilename: string;
  contentType: string;
  sizeBytes: number;
  sha256?: string | null;
  bucket: string;
  objectKey: string;
  expiresAt: Date;
}): Promise<{ file: FileAsset; uploadId: string; expiresAt: string }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [fileRow] = await tx.insert(schema.files).values({
      id: input.fileId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      filename: input.filename,
      safeFilename: input.safeFilename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256 ?? null,
      bucket: input.bucket,
      objectKey: input.objectKey,
      status: "pending_upload",
    }).returning();
    if (!fileRow) {
      throw new Error("Failed to create file");
    }
    const [uploadRow] = await tx.insert(schema.fileUploads).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      fileId: fileRow.id,
      status: "pending",
      expiresAt: input.expiresAt,
    }).returning({ id: schema.fileUploads.id, expiresAt: schema.fileUploads.expiresAt });
    if (!uploadRow) {
      throw new Error("Failed to create file upload");
    }
    return {
      file: mapFile(fileRow),
      uploadId: uploadRow.id,
      expiresAt: uploadRow.expiresAt.toISOString(),
    };
  }));
}

export async function getFile(db: Database, workspaceId: string, fileId: string): Promise<FileAsset | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.files).where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, fileId))).limit(1);
    return row ? mapFile(row) : null;
  });
}

export async function requireFile(db: Database, workspaceId: string, fileId: string): Promise<FileAsset> {
  const file = await getFile(db, workspaceId, fileId);
  if (!file) {
    throw new Error(`File not found: ${fileId}`);
  }
  return file;
}

export async function getFileUpload(db: Database, workspaceId: string, uploadId: string): Promise<{ id: string; status: FileUploadStatus; expiresAt: Date; file: FileAsset } | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      id: schema.fileUploads.id,
      status: schema.fileUploads.status,
      expiresAt: schema.fileUploads.expiresAt,
      file: schema.files,
    }).from(schema.fileUploads)
      .innerJoin(schema.files, eq(schema.fileUploads.fileId, schema.files.id))
      .where(and(eq(schema.fileUploads.workspaceId, workspaceId), eq(schema.fileUploads.id, uploadId)))
      .limit(1);
    return row ? {
      id: row.id,
      status: row.status as FileUploadStatus,
      expiresAt: row.expiresAt,
      file: mapFile(row.file),
    } : null;
  });
}

export async function completeFileUpload(db: Database, workspaceId: string, uploadId: string): Promise<FileAsset> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [uploadRow] = await tx.select().from(schema.fileUploads).where(and(eq(schema.fileUploads.workspaceId, workspaceId), eq(schema.fileUploads.id, uploadId))).for("update").limit(1);
    if (!uploadRow) {
      throw new Error(`File upload not found: ${uploadId}`);
    }
    const [fileRow] = await tx.select().from(schema.files).where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, uploadRow.fileId))).for("update").limit(1);
    if (!fileRow) {
      throw new Error(`File not found for upload: ${uploadId}`);
    }
    const now = new Date();
    const [updatedFile] = await tx.update(schema.files).set({
      status: "ready",
      updatedAt: now,
    }).where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, fileRow.id))).returning();
    await tx.update(schema.fileUploads).set({
      status: "completed",
      completedAt: now,
      updatedAt: now,
    }).where(and(eq(schema.fileUploads.workspaceId, workspaceId), eq(schema.fileUploads.id, uploadId)));
    if (!updatedFile) {
      throw new Error("Failed to complete file upload");
    }
    return mapFile(updatedFile);
  }));
}

export async function markFileUploadFailed(db: Database, workspaceId: string, uploadId: string, fileId: string): Promise<void> {
  const now = new Date();
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    await tx.update(schema.fileUploads).set({ status: "failed", updatedAt: now }).where(and(eq(schema.fileUploads.workspaceId, workspaceId), eq(schema.fileUploads.id, uploadId)));
    await tx.update(schema.files).set({ status: "failed", updatedAt: now }).where(and(eq(schema.files.workspaceId, workspaceId), eq(schema.files.id, fileId)));
  }));
}

export async function enablePackInstallation(db: Database, input: CreatePackInstallationInput): Promise<PackInstallation> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const now = new Date();
    const existing = await getPackInstallation(scopedDb, input.workspaceId, input.packId);
    if (existing) {
      const [row] = await scopedDb.update(schema.packInstallations).set({
        status: "active",
        metadata: input.metadata ?? existing.metadata,
        enabledAt: now,
        updatedAt: now,
      }).where(and(eq(schema.packInstallations.workspaceId, input.workspaceId), eq(schema.packInstallations.packId, input.packId))).returning();
      if (!row) {
        throw new Error(`Pack installation not found: ${input.packId}`);
      }
      return mapPackInstallation(row);
    }
    const [row] = await scopedDb.insert(schema.packInstallations).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      packId: input.packId,
      status: "active",
      metadata: input.metadata ?? {},
    }).returning();
    if (!row) {
      throw new Error("Failed to enable pack installation");
    }
    return mapPackInstallation(row);
  });
}

export async function listPackInstallations(db: Database, workspaceId: string): Promise<PackInstallation[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.packInstallations)
      .where(eq(schema.packInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.packInstallations.updatedAt));
    return rows.map(mapPackInstallation);
  });
}

export async function getPackInstallation(db: Database, workspaceId: string, packId: string): Promise<PackInstallation | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.packInstallations)
      .where(and(eq(schema.packInstallations.workspaceId, workspaceId), eq(schema.packInstallations.packId, packId)))
      .limit(1);
    return row ? mapPackInstallation(row) : null;
  });
}

export async function updatePackInstallationStatus(db: Database, workspaceId: string, packId: string, status: PackInstallationStatus): Promise<PackInstallation> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.packInstallations).set({
      status,
      updatedAt: new Date(),
    }).where(and(eq(schema.packInstallations.workspaceId, workspaceId), eq(schema.packInstallations.packId, packId))).returning();
    if (!row) {
      throw new Error(`Pack installation not found: ${packId}`);
    }
    return mapPackInstallation(row);
  });
}

export async function registerWorkspacePack(db: Database, input: RegisterWorkspacePackInput): Promise<{ pack: WorkspaceRegisteredPack; created: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const now = new Date();
    const [row] = await scopedDb.insert(schema.workspacePacks).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      packId: input.pack.id,
      manifest: input.pack as unknown as Record<string, unknown>,
    })
      .onConflictDoUpdate({
        target: [schema.workspacePacks.workspaceId, schema.workspacePacks.packId],
        set: {
          manifest: input.pack as unknown as Record<string, unknown>,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) {
      throw new Error("Failed to register workspace pack");
    }
    return { pack: mapWorkspacePack(row), created: row.createdAt.getTime() === row.updatedAt.getTime() };
  });
}

export async function listWorkspacePacks(db: Database, workspaceId: string): Promise<WorkspaceRegisteredPack[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.workspacePacks)
      .where(eq(schema.workspacePacks.workspaceId, workspaceId))
      .orderBy(asc(schema.workspacePacks.packId));
    return rows.map(mapWorkspacePack);
  });
}

export async function getWorkspacePack(db: Database, workspaceId: string, packId: string): Promise<WorkspaceRegisteredPack | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.workspacePacks)
      .where(and(eq(schema.workspacePacks.workspaceId, workspaceId), eq(schema.workspacePacks.packId, packId)))
      .limit(1);
    return row ? mapWorkspacePack(row) : null;
  });
}

export async function deleteWorkspacePack(db: Database, workspaceId: string, packId: string): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.delete(schema.workspacePacks)
      .where(and(eq(schema.workspacePacks.workspaceId, workspaceId), eq(schema.workspacePacks.packId, packId)))
      .returning({ id: schema.workspacePacks.id });
    return rows.length > 0;
  });
}

export async function upsertCapabilityCatalogItem(db: Database, input: CreateCapabilityCatalogItemInput): Promise<CapabilityCatalogItem> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const now = new Date();
    const values = {
      id: input.id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      source: input.source,
      name: input.name,
      description: input.description ?? null,
      category: input.category ?? "custom",
      tags: input.tags ?? [],
      homepageUrl: input.homepageUrl ?? null,
      endpointUrl: input.endpointUrl ?? null,
      installUrl: input.installUrl ?? null,
      authModel: input.authModel ?? null,
      metadata: input.metadata ?? {},
      updatedAt: now,
    };
    const updateValues = {
      kind: values.kind,
      source: values.source,
      name: values.name,
      description: values.description,
      category: values.category,
      tags: values.tags,
      homepageUrl: values.homepageUrl,
      endpointUrl: values.endpointUrl,
      installUrl: values.installUrl,
      authModel: values.authModel,
      metadata: values.metadata,
      updatedAt: values.updatedAt,
    };
    const [row] = await scopedDb.insert(schema.capabilityCatalogItems).values(values)
      .onConflictDoUpdate({
        target: [schema.capabilityCatalogItems.workspaceId, schema.capabilityCatalogItems.id],
        set: updateValues,
      })
      .returning();
    if (!row) {
      throw new Error("Failed to upsert capability catalog item");
    }
    return mapCapabilityCatalogItem(row);
  });
}

export async function listCapabilityCatalogItems(db: Database, workspaceId: string): Promise<CapabilityCatalogItem[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.capabilityCatalogItems)
      .where(eq(schema.capabilityCatalogItems.workspaceId, workspaceId))
      .orderBy(asc(schema.capabilityCatalogItems.kind), asc(schema.capabilityCatalogItems.name));
    return rows.map(mapCapabilityCatalogItem);
  });
}

export async function getCapabilityCatalogItem(db: Database, workspaceId: string, capabilityId: string): Promise<CapabilityCatalogItem | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.capabilityCatalogItems)
      .where(and(eq(schema.capabilityCatalogItems.workspaceId, workspaceId), eq(schema.capabilityCatalogItems.id, capabilityId)))
      .limit(1);
    return row ? mapCapabilityCatalogItem(row) : null;
  });
}

export async function enableCapabilityInstallation(db: Database, input: EnableCapabilityInstallationInput): Promise<CapabilityInstallation> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const now = new Date();
    // Read the raw row (not the redacted mapping) so an omitted config
    // preserves stored credential-header ciphertext instead of the redaction.
    const [existing] = await scopedDb.select().from(schema.capabilityInstallations)
      .where(and(eq(schema.capabilityInstallations.workspaceId, input.workspaceId), eq(schema.capabilityInstallations.capabilityId, input.capabilityId)))
      .limit(1);
    if (existing) {
      const [row] = await scopedDb.update(schema.capabilityInstallations).set({
        kind: input.kind,
        status: "active",
        config: input.config ?? existing.config,
        metadata: input.metadata ?? existing.metadata,
        enabledAt: now,
        updatedAt: now,
      }).where(and(eq(schema.capabilityInstallations.workspaceId, input.workspaceId), eq(schema.capabilityInstallations.capabilityId, input.capabilityId))).returning();
      if (!row) {
        throw new Error(`Capability installation not found: ${input.capabilityId}`);
      }
      return mapCapabilityInstallation(row);
    }
    const [row] = await scopedDb.insert(schema.capabilityInstallations).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      capabilityId: input.capabilityId,
      kind: input.kind,
      status: "active",
      config: input.config ?? {},
      metadata: input.metadata ?? {},
    }).returning();
    if (!row) {
      throw new Error("Failed to enable capability installation");
    }
    return mapCapabilityInstallation(row);
  });
}

export async function disableCapabilityInstallation(db: Database, workspaceId: string, capabilityId: string): Promise<CapabilityInstallation> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.capabilityInstallations).set({
      status: "disabled",
      updatedAt: new Date(),
    }).where(and(eq(schema.capabilityInstallations.workspaceId, workspaceId), eq(schema.capabilityInstallations.capabilityId, capabilityId))).returning();
    if (!row) {
      throw new Error(`Capability installation not found: ${capabilityId}`);
    }
    return mapCapabilityInstallation(row);
  });
}

export async function listCapabilityInstallations(db: Database, workspaceId: string): Promise<CapabilityInstallation[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.capabilityInstallations)
      .where(eq(schema.capabilityInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.capabilityInstallations.updatedAt));
    return rows.map(mapCapabilityInstallation);
  });
}

export async function getCapabilityInstallation(db: Database, workspaceId: string, capabilityId: string): Promise<CapabilityInstallation | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.capabilityInstallations)
      .where(and(eq(schema.capabilityInstallations.workspaceId, workspaceId), eq(schema.capabilityInstallations.capabilityId, capabilityId)))
      .limit(1);
    return row ? mapCapabilityInstallation(row) : null;
  });
}

export async function listEnabledMcpCapabilityServers(db: Database, workspaceId: string): Promise<EnabledMcpCapabilityServer[]> {
  const rows = await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.select({
    item: schema.capabilityCatalogItems,
    installation: schema.capabilityInstallations,
  }).from(schema.capabilityInstallations)
    .innerJoin(schema.capabilityCatalogItems, and(
      eq(schema.capabilityInstallations.workspaceId, schema.capabilityCatalogItems.workspaceId),
      eq(schema.capabilityInstallations.capabilityId, schema.capabilityCatalogItems.id),
    ))
    .where(and(
      eq(schema.capabilityInstallations.workspaceId, workspaceId),
      eq(schema.capabilityInstallations.kind, "mcp"),
      eq(schema.capabilityInstallations.status, "active"),
    ))
    .orderBy(asc(schema.capabilityCatalogItems.name)));

  return rows.flatMap(({ item, installation }) => {
    if (!item.endpointUrl || !mcpConnectivityOk(installation.metadata)) {
      return [];
    }
    const headersEncrypted = encryptedHeadersConfig(installation.config.headersEncrypted);
    if (item.authModel && !headersEncrypted) {
      // Credential-gated MCPs are runnable only when credential headers were
      // stored at enable time.
      return [];
    }
    const metadata = item.metadata;
    const config = installation.config;
    const allowedTools = stringArrayConfig(config.allowedTools ?? metadata.allowedTools);
    const timeoutMs = positiveIntegerConfig(config.timeoutMs ?? metadata.timeoutMs);
    const cacheToolsList = booleanConfig(config.cacheToolsList ?? metadata.cacheToolsList);
    return [{
      capabilityId: item.id,
      id: mcpServerIdForCapability(item.id, metadata),
      name: item.name,
      url: item.endpointUrl,
      ...(allowedTools ? { allowedTools } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(cacheToolsList !== undefined ? { cacheToolsList } : {}),
      ...(headersEncrypted ? { headersEncrypted } : {}),
    }];
  });
}

/**
 * Decrypts an enabled capability MCP's stored credential headers. Returns
 * null when the server has none, and "unavailable" when headers exist but
 * cannot be recovered (missing key or failed decryption) — in which case the
 * server must be skipped rather than connected without credentials.
 */
export function decryptedCapabilityHeaders(
  server: EnabledMcpCapabilityServer,
  encryptionKey: Uint8Array | null,
): Record<string, string> | null | "unavailable" {
  if (!server.headersEncrypted || Object.keys(server.headersEncrypted).length === 0) {
    return null;
  }
  if (!encryptionKey) {
    return "unavailable";
  }
  try {
    return Object.fromEntries(Object.entries(server.headersEncrypted).map(([name, value]) => [name, decryptEnvironmentValue(encryptionKey, value)]));
  } catch {
    return "unavailable";
  }
}

/**
 * Returns the encrypted credential-header map stored on a capability
 * installation, or null when none is stored. This is the only read path for
 * the ciphertext besides listEnabledMcpCapabilityServers; the generic
 * installation mapping redacts it to header names.
 */
export async function getStoredCapabilityHeaderCiphertext(db: Database, workspaceId: string, capabilityId: string): Promise<Record<string, string> | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({ config: schema.capabilityInstallations.config }).from(schema.capabilityInstallations)
      .where(and(eq(schema.capabilityInstallations.workspaceId, workspaceId), eq(schema.capabilityInstallations.capabilityId, capabilityId)))
      .limit(1);
    return row ? encryptedHeadersConfig(row.config.headersEncrypted) ?? null : null;
  });
}

export function mcpServerIdForCapability(capabilityId: string, metadata: Record<string, unknown> = {}): string {
  const explicit = typeof metadata.mcpServerId === "string" ? metadata.mcpServerId.trim() : "";
  if (/^[A-Za-z0-9_-]+$/.test(explicit)) {
    return explicit;
  }
  const body = capabilityId
    .replace(/^[^:]+:/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 44) || "mcp";
  return `cap-${body}-${shortHash(capabilityId)}`;
}

export async function createSocialConnection(db: Database, input: CreateSocialConnectionInput): Promise<SocialConnection> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.socialConnections).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      accountHandle: input.accountHandle,
      accountName: input.accountName ?? null,
      externalAccountId: input.externalAccountId ?? null,
      status: input.status,
      scopes: input.scopes ?? [],
      credentialRef: input.credentialRef ?? null,
      tokenMetadata: input.tokenMetadata ?? {},
      metadata: input.metadata ?? {},
    }).returning();
    if (!row) {
      throw new Error("Failed to create social connection");
    }
    return mapSocialConnection(row);
  });
}

export async function listSocialConnections(db: Database, workspaceId: string, limit = 100): Promise<SocialConnection[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.socialConnections)
      .where(eq(schema.socialConnections.workspaceId, workspaceId))
      .orderBy(desc(schema.socialConnections.createdAt))
      .limit(limit);
    return rows.map(mapSocialConnection);
  });
}

export async function getSocialConnection(db: Database, workspaceId: string, connectionId: string): Promise<SocialConnection | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.socialConnections)
      .where(and(eq(schema.socialConnections.workspaceId, workspaceId), eq(schema.socialConnections.id, connectionId)))
      .limit(1);
    return row ? mapSocialConnection(row) : null;
  });
}

export async function requireSocialConnection(db: Database, workspaceId: string, connectionId: string): Promise<SocialConnection> {
  const connection = await getSocialConnection(db, workspaceId, connectionId);
  if (!connection) {
    throw new Error(`Social connection not found: ${connectionId}`);
  }
  return connection;
}

export async function createSocialPost(db: Database, input: CreateSocialPostInput): Promise<SocialPost> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const connection = await requireSocialConnection(scopedDb, input.workspaceId, input.connectionId);
    const [row] = await scopedDb.insert(schema.socialPosts).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      provider: connection.provider,
      externalPostId: input.externalPostId ?? null,
      url: input.url ?? null,
      authorHandle: input.authorHandle ?? connection.accountHandle,
      text: input.text,
      publishedAt: input.publishedAt,
      metrics: input.metrics ?? {},
      raw: input.raw ?? {},
    }).returning();
    if (!row) {
      throw new Error("Failed to create social post");
    }
    return mapSocialPost(row);
  });
}

export async function listSocialPosts(db: Database, options: {
  workspaceId: string;
  connectionIds?: string[];
  since?: Date;
  limit?: number;
}): Promise<SocialPost[]> {
  const conditions: SQL[] = [eq(schema.socialPosts.workspaceId, options.workspaceId)];
  if (options.connectionIds?.length) {
    conditions.push(inArray(schema.socialPosts.connectionId, options.connectionIds));
  }
  if (options.since) {
    conditions.push(gte(schema.socialPosts.publishedAt, options.since));
  }
  const limit = options.limit ?? 100;
  return await withWorkspaceRls(db, options.workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.socialPosts)
      .where(and(...conditions))
      .orderBy(desc(schema.socialPosts.publishedAt))
      .limit(limit);
    return rows.map(mapSocialPost);
  });
}

export async function createScheduledTask(db: Database, input: CreateScheduledTaskInput): Promise<ScheduledTask> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.scheduledTasks).values(input).returning();
    if (!row) {
      throw new Error("Failed to create scheduled task");
    }
    return mapScheduledTask(row);
  });
}

export async function updateScheduledTask(db: Database, workspaceId: string, taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.scheduledTasks).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
      ...(input.runMode !== undefined ? { runMode: input.runMode } : {}),
      ...(input.overlapPolicy !== undefined ? { overlapPolicy: input.overlapPolicy } : {}),
      ...(input.agentConfig !== undefined ? { agentConfig: input.agentConfig } : {}),
      ...(input.reusableSessionId !== undefined ? { reusableSessionId: input.reusableSessionId } : {}),
      ...(input.environmentId !== undefined ? { environmentId: input.environmentId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: new Date(),
    }).where(and(eq(schema.scheduledTasks.workspaceId, workspaceId), eq(schema.scheduledTasks.id, taskId))).returning();
    if (!row) {
      throw new Error(`Scheduled task not found: ${taskId}`);
    }
    return mapScheduledTask(row);
  });
}

export async function getScheduledTask(db: Database, workspaceId: string, taskId: string): Promise<ScheduledTask | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.workspaceId, workspaceId), eq(schema.scheduledTasks.id, taskId))).limit(1);
    return row ? mapScheduledTask(row) : null;
  });
}

export async function requireScheduledTask(db: Database, workspaceId: string, taskId: string): Promise<ScheduledTask> {
  const task = await getScheduledTask(db, workspaceId, taskId);
  if (!task) {
    throw new Error(`Scheduled task not found: ${taskId}`);
  }
  return task;
}

export async function listScheduledTasks(db: Database, workspaceId: string, limit = 100): Promise<ScheduledTask[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.scheduledTasks)
      .where(eq(schema.scheduledTasks.workspaceId, workspaceId))
      .orderBy(desc(schema.scheduledTasks.createdAt))
      .limit(limit);
    return rows.map(mapScheduledTask);
  });
}

export async function deleteScheduledTask(db: Database, workspaceId: string, taskId: string): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.delete(schema.scheduledTasks).where(and(eq(schema.scheduledTasks.workspaceId, workspaceId), eq(schema.scheduledTasks.id, taskId)));
  });
}

export async function createScheduledTaskRun(db: Database, input: {
  workspaceId: string;
  taskId: string;
  triggerType: ScheduledTaskTriggerType;
  scheduledAt?: Date | null;
  firedAt?: Date;
}): Promise<ScheduledTaskRun> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [taskRow] = await scopedDb.select().from(schema.scheduledTasks)
      .where(and(eq(schema.scheduledTasks.workspaceId, input.workspaceId), eq(schema.scheduledTasks.id, input.taskId)))
      .limit(1);
    if (!taskRow) {
      throw new Error(`Scheduled task not found: ${input.taskId}`);
    }
    const [row] = await scopedDb.insert(schema.scheduledTaskRuns).values({
      accountId: taskRow.accountId,
      workspaceId: taskRow.workspaceId,
      taskId: input.taskId,
      triggerType: input.triggerType,
      scheduledAt: input.scheduledAt ?? null,
      firedAt: input.firedAt ?? new Date(),
      status: "queued",
    }).returning();
    if (!row) {
      throw new Error("Failed to create scheduled task run");
    }
    return mapScheduledTaskRun(row);
  });
}

export async function updateScheduledTaskRun(db: Database, workspaceId: string, runId: string, input: Partial<{
  status: ScheduledTaskRunStatus;
  sessionId: string | null;
  triggerEventId: string | null;
  error: string | null;
}>): Promise<ScheduledTaskRun> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.scheduledTaskRuns).set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.triggerEventId !== undefined ? { triggerEventId: input.triggerEventId } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      updatedAt: new Date(),
    }).where(and(eq(schema.scheduledTaskRuns.workspaceId, workspaceId), eq(schema.scheduledTaskRuns.id, runId))).returning();
    if (!row) {
      throw new Error(`Scheduled task run not found: ${runId}`);
    }
    return mapScheduledTaskRun(row);
  });
}

export async function listScheduledTaskRuns(db: Database, workspaceId: string, taskId: string, limit = 100): Promise<ScheduledTaskRun[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.scheduledTaskRuns)
      .where(and(eq(schema.scheduledTaskRuns.workspaceId, workspaceId), eq(schema.scheduledTaskRuns.taskId, taskId)))
      .orderBy(desc(schema.scheduledTaskRuns.createdAt))
      .limit(limit);
    return rows.map(mapScheduledTaskRun);
  });
}

export async function createWorkspaceEnvironment(db: Database, input: {
  accountId: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  variables?: Array<{ name: string; valueEncrypted: string }>;
}): Promise<WorkspaceEnvironment> {
  // withRlsContext wraps the callback in one transaction, so the environment
  // row and all initial variables commit or roll back together.
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.workspaceEnvironments).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
    }).returning();
    if (!row) {
      throw new Error("Failed to create workspace environment");
    }
    const variables = input.variables ?? [];
    if (variables.length === 0) {
      return mapWorkspaceEnvironment(row, []);
    }
    const inserted = await scopedDb.insert(schema.workspaceEnvironmentVariables).values(variables.map((variable) => ({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      environmentId: row.id,
      name: variable.name,
      valueEncrypted: variable.valueEncrypted,
    }))).returning({
      name: schema.workspaceEnvironmentVariables.name,
      version: schema.workspaceEnvironmentVariables.version,
      createdAt: schema.workspaceEnvironmentVariables.createdAt,
      updatedAt: schema.workspaceEnvironmentVariables.updatedAt,
    });
    return mapWorkspaceEnvironment(row, inserted
      .map(mapWorkspaceEnvironmentVariableMetadata)
      .sort((a, b) => a.name.localeCompare(b.name)));
  });
}

export async function listWorkspaceEnvironments(db: Database, workspaceId: string): Promise<WorkspaceEnvironment[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.workspaceEnvironments)
      .where(eq(schema.workspaceEnvironments.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceEnvironments.createdAt));
    const variableRows = await scopedDb.select({
      environmentId: schema.workspaceEnvironmentVariables.environmentId,
      name: schema.workspaceEnvironmentVariables.name,
      version: schema.workspaceEnvironmentVariables.version,
      createdAt: schema.workspaceEnvironmentVariables.createdAt,
      updatedAt: schema.workspaceEnvironmentVariables.updatedAt,
    }).from(schema.workspaceEnvironmentVariables)
      .where(eq(schema.workspaceEnvironmentVariables.workspaceId, workspaceId))
      .orderBy(asc(schema.workspaceEnvironmentVariables.name));
    const grouped = new Map<string, WorkspaceEnvironmentVariableMetadata[]>();
    for (const variable of variableRows) {
      const list = grouped.get(variable.environmentId) ?? [];
      list.push(mapWorkspaceEnvironmentVariableMetadata(variable));
      grouped.set(variable.environmentId, list);
    }
    return rows.map((row) => mapWorkspaceEnvironment(row, grouped.get(row.id) ?? []));
  });
}

export async function getWorkspaceEnvironment(db: Database, workspaceId: string, environmentId: string): Promise<WorkspaceEnvironment | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.workspaceEnvironments)
      .where(and(eq(schema.workspaceEnvironments.workspaceId, workspaceId), eq(schema.workspaceEnvironments.id, environmentId)))
      .limit(1);
    if (!row) {
      return null;
    }
    return mapWorkspaceEnvironment(row, await listEnvironmentVariableMetadata(scopedDb, workspaceId, environmentId));
  });
}

export async function getWorkspaceEnvironmentByName(db: Database, workspaceId: string, name: string): Promise<WorkspaceEnvironment | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.workspaceEnvironments)
      .where(and(eq(schema.workspaceEnvironments.workspaceId, workspaceId), eq(schema.workspaceEnvironments.name, name)))
      .limit(1);
    if (!row) {
      return null;
    }
    return mapWorkspaceEnvironment(row, await listEnvironmentVariableMetadata(scopedDb, workspaceId, row.id));
  });
}

export async function updateWorkspaceEnvironment(db: Database, workspaceId: string, environmentId: string, input: {
  name?: string;
  description?: string | null;
}): Promise<WorkspaceEnvironment> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.workspaceEnvironments).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedAt: new Date(),
    }).where(and(eq(schema.workspaceEnvironments.workspaceId, workspaceId), eq(schema.workspaceEnvironments.id, environmentId))).returning();
    if (!row) {
      throw new Error(`Workspace environment not found: ${environmentId}`);
    }
    return mapWorkspaceEnvironment(row, await listEnvironmentVariableMetadata(scopedDb, workspaceId, environmentId));
  });
}

export async function deleteWorkspaceEnvironment(db: Database, workspaceId: string, environmentId: string): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.delete(schema.workspaceEnvironments)
      .where(and(eq(schema.workspaceEnvironments.workspaceId, workspaceId), eq(schema.workspaceEnvironments.id, environmentId)))
      .returning({ id: schema.workspaceEnvironments.id });
    return rows.length > 0;
  });
}

export async function countWorkspaceEnvironments(db: Database, workspaceId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb.select({
      count: sql<number>`count(*)::int`,
    }).from(schema.workspaceEnvironments).where(eq(schema.workspaceEnvironments.workspaceId, workspaceId));
    return Number(count);
  });
}

export async function countScheduledTasksUsingEnvironment(db: Database, workspaceId: string, environmentId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb.select({
      count: sql<number>`count(*)::int`,
    }).from(schema.scheduledTasks)
      .where(and(eq(schema.scheduledTasks.workspaceId, workspaceId), eq(schema.scheduledTasks.environmentId, environmentId)));
    return Number(count);
  });
}

export async function countActiveSessionsUsingEnvironment(db: Database, workspaceId: string, environmentId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb.select({
      count: sql<number>`count(*)::int`,
    }).from(schema.sessions)
      .where(and(
        eq(schema.sessions.workspaceId, workspaceId),
        eq(schema.sessions.environmentId, environmentId),
        inArray(schema.sessions.status, ["queued", "running", "requires_action"]),
      ));
    return Number(count);
  });
}

export async function setWorkspaceEnvironmentVariable(db: Database, input: {
  accountId: string;
  workspaceId: string;
  environmentId: string;
  name: string;
  valueEncrypted: string;
}): Promise<WorkspaceEnvironmentVariableMetadata> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const now = new Date();
    const [row] = await scopedDb.insert(schema.workspaceEnvironmentVariables).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      environmentId: input.environmentId,
      name: input.name,
      valueEncrypted: input.valueEncrypted,
    }).onConflictDoUpdate({
      target: [
        schema.workspaceEnvironmentVariables.workspaceId,
        schema.workspaceEnvironmentVariables.environmentId,
        schema.workspaceEnvironmentVariables.name,
      ],
      set: {
        valueEncrypted: input.valueEncrypted,
        version: sql`${schema.workspaceEnvironmentVariables.version} + 1`,
        updatedAt: now,
      },
    }).returning({
      name: schema.workspaceEnvironmentVariables.name,
      version: schema.workspaceEnvironmentVariables.version,
      createdAt: schema.workspaceEnvironmentVariables.createdAt,
      updatedAt: schema.workspaceEnvironmentVariables.updatedAt,
    });
    if (!row) {
      throw new Error("Failed to set workspace environment variable");
    }
    await scopedDb.update(schema.workspaceEnvironments).set({ updatedAt: now })
      .where(and(eq(schema.workspaceEnvironments.workspaceId, input.workspaceId), eq(schema.workspaceEnvironments.id, input.environmentId)));
    return mapWorkspaceEnvironmentVariableMetadata(row);
  });
}

export async function deleteWorkspaceEnvironmentVariable(db: Database, workspaceId: string, environmentId: string, name: string): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.delete(schema.workspaceEnvironmentVariables)
      .where(and(
        eq(schema.workspaceEnvironmentVariables.workspaceId, workspaceId),
        eq(schema.workspaceEnvironmentVariables.environmentId, environmentId),
        eq(schema.workspaceEnvironmentVariables.name, name),
      ))
      .returning({ id: schema.workspaceEnvironmentVariables.id });
    if (rows.length > 0) {
      await scopedDb.update(schema.workspaceEnvironments).set({ updatedAt: new Date() })
        .where(and(eq(schema.workspaceEnvironments.workspaceId, workspaceId), eq(schema.workspaceEnvironments.id, environmentId)));
    }
    return rows.length > 0;
  });
}

/**
 * The ONLY helper that selects value_encrypted. Used exclusively by the worker
 * activity that materializes a sandbox for a run whose session carries an
 * environment attachment. Do not call from API routes: values are write-only.
 */
export async function getWorkspaceEnvironmentValuesForRun(db: Database, workspaceId: string, environmentId: string): Promise<{
  environment: { id: string; name: string; description: string | null };
  values: Record<string, string>;
} | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [environment] = await scopedDb.select({
      id: schema.workspaceEnvironments.id,
      name: schema.workspaceEnvironments.name,
      description: schema.workspaceEnvironments.description,
    }).from(schema.workspaceEnvironments)
      .where(and(eq(schema.workspaceEnvironments.workspaceId, workspaceId), eq(schema.workspaceEnvironments.id, environmentId)))
      .limit(1);
    if (!environment) {
      return null;
    }
    const rows = await scopedDb.select({
      name: schema.workspaceEnvironmentVariables.name,
      valueEncrypted: schema.workspaceEnvironmentVariables.valueEncrypted,
    }).from(schema.workspaceEnvironmentVariables)
      .where(and(
        eq(schema.workspaceEnvironmentVariables.workspaceId, workspaceId),
        eq(schema.workspaceEnvironmentVariables.environmentId, environmentId),
      ));
    return {
      environment: { id: environment.id, name: environment.name, description: environment.description },
      values: Object.fromEntries(rows.map((row) => [row.name, row.valueEncrypted])),
    };
  });
}

export type WorkspaceEnvironmentForRun = {
  id: string;
  name: string;
  description: string | null;
  values: Record<string, string>;
};

/**
 * Load and decrypt the workspace environment attached to a run's session. SHARED
 * by the worker TURN path (apps/worker agent-turn) AND the API-direct ATTACH paths
 * (viewer / Channel-A / desktop / terminal) so a box first warmed by an attach is
 * created with the SAME decrypted workspace-environment values the turn declares —
 * the box-manifest env must match the agent-manifest env or the SDK's
 * `validateNoEnvironmentDelta` throws when the agent injects its manifest into the
 * resumed non-owned box.
 *
 * `environmentId === null` is the unattached path: zero DB work and behavior
 * byte-identical to deployments without this feature. Attached runs fail closed: a
 * missing key or a deleted environment throws (names/ids only in messages) instead
 * of silently running without the secrets the run expects.
 */
export async function loadWorkspaceEnvironmentForRun(
  db: Database,
  settings: Settings,
  workspaceId: string,
  environmentId: string | null,
): Promise<WorkspaceEnvironmentForRun | null> {
  if (!environmentId) {
    return null;
  }
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error("workspace environment attached but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
  }
  const stored = await getWorkspaceEnvironmentValuesForRun(db, workspaceId, environmentId);
  if (!stored) {
    throw new Error(`workspace environment not found: ${environmentId}`);
  }
  const values: Record<string, string> = {};
  for (const [name, encrypted] of Object.entries(stored.values)) {
    try {
      values[name] = decryptEnvironmentValue(key, encrypted);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to decrypt workspace environment variable ${name}: ${reason}`);
    }
  }
  return {
    id: stored.environment.id,
    name: stored.environment.name,
    description: stored.environment.description,
    values,
  };
}

// ---------------------------------------------------------------------------
// Codex (ChatGPT) subscription credentials
//
// One row per workspace. Secret tokens live inside `credential_encrypted` (v1
// AES-256-GCM, same envelope as workspace env vars). The caller pre-encrypts the
// JSON bundle {access_token, refresh_token, id_token} — the db layer never sees
// plaintext token JSON on the write path. `loadCodexCredentialForRun` is the
// ONLY decrypt-read accessor and must never be called from an API route;
// `getCodexCredentialStatus` returns metadata only (never the secret column).
// ---------------------------------------------------------------------------

export type CodexCredentialTokens = { accessToken: string; refreshToken: string; idToken: string };

export type CodexCredentialForRun = {
  workspaceId: string;
  tokens: CodexCredentialTokens;          // decrypted — never logged, never returned by a route
  chatgptAccountId: string | null;
  scopes: string | null;
  planType: string | null;
  isFedramp: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  status: string;
  lastError: string | null;
};

/** Login / rotation write. Caller passes the PRE-encrypted credential blob. */
export async function upsertCodexSubscriptionCredential(db: Database, input: {
  accountId: string;
  workspaceId: string;
  credentialEncrypted: string;            // v1 envelope of JSON {access_token, refresh_token, id_token}
  chatgptAccountId: string | null;
  scopes: string | null;
  planType: string | null;
  isFedramp: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const now = new Date();
    await scopedDb.insert(schema.codexSubscriptionCredentials).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      credentialEncrypted: input.credentialEncrypted,
      chatgptAccountId: input.chatgptAccountId,
      scopes: input.scopes,
      planType: input.planType,
      isFedramp: input.isFedramp,
      expiresAt: input.expiresAt,
      lastRefreshAt: input.lastRefreshAt,
      status: "active",
      lastError: null,
    }).onConflictDoUpdate({
      target: [schema.codexSubscriptionCredentials.workspaceId],
      set: {
        credentialEncrypted: input.credentialEncrypted,
        chatgptAccountId: input.chatgptAccountId,
        scopes: input.scopes,
        planType: input.planType,
        isFedramp: input.isFedramp,
        expiresAt: input.expiresAt,
        lastRefreshAt: input.lastRefreshAt,
        status: "active",
        lastError: null,
        version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
        updatedAt: now,
      },
    });
  });
}

/** The ONLY decrypt-read accessor. Fails closed. Never call from an API route that returns the result. */
export async function loadCodexCredentialForRun(
  db: Database,
  settings: Settings,
  workspaceId: string,
): Promise<CodexCredentialForRun | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) {
    throw new Error("codex credential present but OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is not configured");
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId)).limit(1);
    if (!row) {
      return null;
    }
    let tokens: CodexCredentialTokens;
    try {
      // The stored blob uses OpenAI's snake_case token field names; map to the
      // camelCase internal shape. Callers (route + worker) write snake_case.
      const parsed = JSON.parse(decryptEnvironmentValue(key, row.credentialEncrypted)) as {
        access_token: string;
        refresh_token: string;
        id_token: string;
      };
      tokens = { accessToken: parsed.access_token, refreshToken: parsed.refresh_token, idToken: parsed.id_token };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to decrypt codex credential for workspace ${workspaceId}: ${reason}`);
    }
    return {
      workspaceId,
      tokens,
      chatgptAccountId: row.chatgptAccountId,
      scopes: row.scopes,
      planType: row.planType,
      isFedramp: row.isFedramp,
      expiresAt: row.expiresAt,
      lastRefreshAt: row.lastRefreshAt,
      status: row.status,
      lastError: row.lastError,
    };
  });
}

/** Persist rotated tokens after a successful refresh. Caller pre-encrypts. */
export async function recordCodexTokenRefresh(db: Database, input: {
  workspaceId: string;
  credentialEncrypted: string;
  expiresAt: Date | null;
  lastRefreshAt: Date;
}): Promise<void> {
  await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.codexSubscriptionCredentials).set({
      credentialEncrypted: input.credentialEncrypted,
      expiresAt: input.expiresAt,
      lastRefreshAt: input.lastRefreshAt,
      status: "active",
      lastError: null,
      version: sql`${schema.codexSubscriptionCredentials.version} + 1`,
      updatedAt: new Date(),
    }).where(eq(schema.codexSubscriptionCredentials.workspaceId, input.workspaceId));
  });
}

/** Surface a permanent or transient failure on the credential row. */
export async function setCodexCredentialStatus(
  db: Database,
  workspaceId: string,
  status: "active" | "needs_relogin" | "error",
  lastError: string | null,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.codexSubscriptionCredentials)
      .set({ status, lastError, updatedAt: new Date() })
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId));
  });
}

/** Metadata-only read for API routes. NEVER selects credential_encrypted. */
export async function getCodexCredentialStatus(db: Database, workspaceId: string): Promise<{
  connected: boolean;
  chatgptAccountId: string | null;
  scopes: string | null;
  planType: string | null;
  status: string;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  lastError: string | null;
} | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      chatgptAccountId: schema.codexSubscriptionCredentials.chatgptAccountId,
      scopes: schema.codexSubscriptionCredentials.scopes,
      planType: schema.codexSubscriptionCredentials.planType,
      status: schema.codexSubscriptionCredentials.status,
      expiresAt: schema.codexSubscriptionCredentials.expiresAt,
      lastRefreshAt: schema.codexSubscriptionCredentials.lastRefreshAt,
      lastError: schema.codexSubscriptionCredentials.lastError,
    }).from(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId)).limit(1);
    if (!row) {
      return null;
    }
    return { connected: row.status === "active", ...row };
  });
}

/** Disconnect: delete the workspace's codex credential. Returns true if a row was removed. */
export async function deleteCodexSubscriptionCredential(db: Database, workspaceId: string): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.delete(schema.codexSubscriptionCredentials)
      .where(eq(schema.codexSubscriptionCredentials.workspaceId, workspaceId))
      .returning({ id: schema.codexSubscriptionCredentials.id });
    return rows.length > 0;
  });
}

export async function recordAuditEvent(db: Database, input: {
  accountId: string;
  workspaceId?: string | null;
  subjectId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  // audit_events has a FORCED RLS policy keyed on the account/workspace GUCs,
  // so the insert must run inside an RLS context.
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId ?? null }, async (scopedDb) => {
    await scopedDb.insert(schema.auditEvents).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? null,
      subjectId: input.subjectId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? {},
    });
  });
}

async function listEnvironmentVariableMetadata(db: Database, workspaceId: string, environmentId: string): Promise<WorkspaceEnvironmentVariableMetadata[]> {
  const rows = await db.select({
    name: schema.workspaceEnvironmentVariables.name,
    version: schema.workspaceEnvironmentVariables.version,
    createdAt: schema.workspaceEnvironmentVariables.createdAt,
    updatedAt: schema.workspaceEnvironmentVariables.updatedAt,
  }).from(schema.workspaceEnvironmentVariables)
    .where(and(
      eq(schema.workspaceEnvironmentVariables.workspaceId, workspaceId),
      eq(schema.workspaceEnvironmentVariables.environmentId, environmentId),
    ))
    .orderBy(asc(schema.workspaceEnvironmentVariables.name));
  return rows.map(mapWorkspaceEnvironmentVariableMetadata);
}

function mapWorkspaceEnvironment(row: typeof schema.workspaceEnvironments.$inferSelect, variables: WorkspaceEnvironmentVariableMetadata[]): WorkspaceEnvironment {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    variables,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWorkspaceEnvironmentVariableMetadata(row: {
  name: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceEnvironmentVariableMetadata {
  return {
    name: row.name,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createSession(db: Database, input: {
  accountId: string;
  workspaceId: string;
  initialMessage: string;
  resources: ResourceRef[];
  tools?: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: SandboxBackend;
  environmentId?: string | null;
  firstPartyMcpPermissions?: Permission[] | null;
  parentSessionId?: string | null;
  createIdempotencyKey?: string | null;
  // The shared-sandbox group to join. Omit (or null) for a singleton group:
  // the new row's own id is used (group === session), today's 1:1 behavior. A
  // shared spawn passes the parent's sandboxGroupId so both run in ONE box.
  sandboxGroupId?: string | null;
  sandboxOs?: SandboxOs;
}): Promise<Session> {
  // Generate the id up front so the same uuid can seed sandbox_group_id for a
  // singleton group (sandbox_group_id cannot SQL-default to id).
  const id = crypto.randomUUID();
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.sessions).values({
      id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      initialMessage: input.initialMessage,
      resources: input.resources,
      tools: input.tools ?? [],
      metadata: input.metadata,
      model: input.model,
      sandboxBackend: input.sandboxBackend,
      sandboxOs: input.sandboxOs ?? "linux",
      sandboxGroupId: input.sandboxGroupId ?? id,
      environmentId: input.environmentId ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      parentSessionId: input.parentSessionId ?? null,
      createIdempotencyKey: input.createIdempotencyKey ?? null,
      status: "queued",
    }).returning();
    if (!row) {
      throw new Error("Failed to create session");
    }
    return mapSession(row);
  });
}

/**
 * Inserts a session under a workspace-scoped CREATE idempotency key, collapsing
 * a concurrent race on the same key to a single row. On the unique-violation
 * the conflicting insert does nothing (`onConflictDoNothing` on the partial
 * unique index) and the now-existing winning row is fetched and returned, so
 * two near-simultaneous creates with the same key yield ONE session and both
 * callers see the same id. `created` distinguishes the winner (true: this call
 * inserted and must run the rest of the start flow) from the loser/dup (false:
 * the row already existed and must be returned as-is).
 */
export async function createSessionWithIdempotencyKey(db: Database, input: {
  accountId: string;
  workspaceId: string;
  initialMessage: string;
  resources: ResourceRef[];
  tools?: ToolRef[];
  metadata: Record<string, unknown>;
  model: string;
  sandboxBackend: SandboxBackend;
  environmentId?: string | null;
  firstPartyMcpPermissions?: Permission[] | null;
  parentSessionId?: string | null;
  createIdempotencyKey: string;
  // The shared-sandbox group to join. Omit (or null) for a singleton group
  // (group === the new row's own id); a shared spawn passes the parent's group.
  sandboxGroupId?: string | null;
  sandboxOs?: SandboxOs;
}): Promise<{ session: Session; created: boolean }> {
  // Generate the id up front so the same uuid can seed sandbox_group_id for a
  // singleton group (sandbox_group_id cannot SQL-default to id).
  const id = crypto.randomUUID();
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [inserted] = await scopedDb.insert(schema.sessions).values({
      id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      initialMessage: input.initialMessage,
      resources: input.resources,
      tools: input.tools ?? [],
      metadata: input.metadata,
      model: input.model,
      sandboxBackend: input.sandboxBackend,
      sandboxOs: input.sandboxOs ?? "linux",
      sandboxGroupId: input.sandboxGroupId ?? id,
      environmentId: input.environmentId ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      parentSessionId: input.parentSessionId ?? null,
      createIdempotencyKey: input.createIdempotencyKey,
      status: "queued",
    }).onConflictDoNothing({
      target: [schema.sessions.workspaceId, schema.sessions.createIdempotencyKey],
      where: sql`${schema.sessions.createIdempotencyKey} is not null`,
    }).returning();
    if (inserted) {
      return { session: mapSession(inserted), created: true };
    }
    const [existing] = await scopedDb.select().from(schema.sessions).where(and(
      eq(schema.sessions.workspaceId, input.workspaceId),
      eq(schema.sessions.createIdempotencyKey, input.createIdempotencyKey),
    )).limit(1);
    if (!existing) {
      // No row inserted and none found: the conflict target did not actually
      // collide (should never happen for a present key) — surface it rather
      // than silently returning a phantom.
      throw new Error("Failed to create session under idempotency key");
    }
    return { session: mapSession(existing), created: false };
  });
}

export async function getSessionByCreateIdempotencyKey(db: Database, workspaceId: string, createIdempotencyKey: string): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessions).where(and(
      eq(schema.sessions.workspaceId, workspaceId),
      eq(schema.sessions.createIdempotencyKey, createIdempotencyKey),
    )).limit(1);
    return row ? mapSession(row) : null;
  });
}

export async function getSession(db: Database, workspaceId: string, sessionId: string): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessions).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId))).limit(1);
    return row ? mapSession(row) : null;
  });
}

/**
 * Resolve ANY session that belongs to a shared-sandbox group (addendum 05 §D.3,
 * stress (e)). Used by the create-session `sandbox:{groupId}` join path to (1)
 * prove the group exists and (2) inherit its box's (backend, os).
 *
 * `workspaceId` is a MANDATORY access boundary, NOT optional: the group uuid is
 * caller-supplied, so the workspace filter (inside RLS) is what forbids a
 * cross-workspace join — a foreign group returns null → the caller 404s. The
 * group uuid itself is never an authorization boundary. Returns the first member
 * session (any one suffices to read the shared box's backend/os); null when the
 * group has no session in this workspace.
 */
export async function getAnySessionInGroup(db: Database, workspaceId: string, sandboxGroupId: string): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.sandboxGroupId, sandboxGroupId)))
      .limit(1);
    return row ? mapSession(row) : null;
  });
}

export async function listSessions(db: Database, workspaceId: string, limit = 50): Promise<Session[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.sessions)
      .where(eq(schema.sessions.workspaceId, workspaceId))
      .orderBy(desc(schema.sessions.createdAt), desc(schema.sessions.id))
      .limit(limit);
    return rows.map(mapSession);
  });
}

/**
 * Count sessions still attached to a live Temporal workflow: queued, running,
 * or awaiting an approval (requires_action). idle has no running execution and
 * failed/cancelled are terminal, so neither blocks a workspace delete. The
 * delete path uses this to refuse (409) while a session could still be running
 * in Temporal, since there is no clean session-terminate to call first.
 */
export async function countActiveSessionsForWorkspace(db: Database, workspaceId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [{ count } = { count: 0 }] = await scopedDb.select({
      count: sql<number>`count(*)::int`,
    }).from(schema.sessions)
      .where(and(
        eq(schema.sessions.workspaceId, workspaceId),
        inArray(schema.sessions.status, ["queued", "running", "requires_action"]),
      ));
    return Number(count);
  });
}

export async function requireSession(db: Database, workspaceId: string, sessionId: string): Promise<Session> {
  const session = await getSession(db, workspaceId, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return session;
}

export async function listSessionEvents(db: Database, workspaceId: string, sessionId: string, after = 0, limit = 500): Promise<SessionEvent[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.sessionEvents)
      .where(and(eq(schema.sessionEvents.workspaceId, workspaceId), eq(schema.sessionEvents.sessionId, sessionId), gt(schema.sessionEvents.sequence, after)))
      .orderBy(asc(schema.sessionEvents.sequence))
      .limit(limit);
    return rows.map(mapEvent);
  });
}

export async function getSessionEvent(db: Database, workspaceId: string, eventId: string): Promise<SessionEvent | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessionEvents).where(and(eq(schema.sessionEvents.workspaceId, workspaceId), eq(schema.sessionEvents.id, eventId))).limit(1);
    return row ? mapEvent(row) : null;
  });
}

export async function getLatestRunState(db: Database, workspaceId: string, sessionId: string): Promise<{
  id: string;
  serializedRunState: string;
  pendingApprovals: unknown[];
} | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.agentRunStates)
      .where(and(eq(schema.agentRunStates.workspaceId, workspaceId), eq(schema.agentRunStates.sessionId, sessionId)))
      .orderBy(desc(schema.agentRunStates.createdAt))
      .limit(1);
    return row ? {
      id: row.id,
      serializedRunState: row.serializedRunState,
      pendingApprovals: row.pendingApprovals,
    } : null;
  });
}

/**
 * Append conversation items (verbatim SDK AgentInputItems) to the session's
 * history. Idempotent on (workspace, session, position): concurrent or
 * repeated writers (streaming writes + turn-end reconciliation) converge
 * instead of duplicating.
 */
export async function appendSessionHistoryItems(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string | null;
  items: Array<{ position: number; item: Record<string, unknown> }>;
}): Promise<void> {
  if (input.items.length === 0) {
    return;
  }
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    await scopedDb.insert(schema.sessionHistoryItems).values(input.items.map((entry) => ({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      position: entry.position,
      item: sanitizeEventPayload(entry.item),
    }))).onConflictDoNothing({
      target: [schema.sessionHistoryItems.workspaceId, schema.sessionHistoryItems.sessionId, schema.sessionHistoryItems.position],
    });
  });
}

export async function getSessionHistoryItems(db: Database, workspaceId: string, sessionId: string): Promise<Array<{ position: number; item: Record<string, unknown> }>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select({
      position: schema.sessionHistoryItems.position,
      item: schema.sessionHistoryItems.item,
    }).from(schema.sessionHistoryItems)
      .where(and(eq(schema.sessionHistoryItems.workspaceId, workspaceId), eq(schema.sessionHistoryItems.sessionId, sessionId)))
      .orderBy(schema.sessionHistoryItems.position);
    return rows;
  });
}

/**
 * The LIVE conversation-truth read path: only active rows, position-ordered.
 * After a client-side context compaction this returns [active summary,
 * ...active recent tail]; with no compaction yet it equals
 * getSessionHistoryItems. The model-facing read path uses this so superseded
 * (summarized-away) prefix rows are excluded while the full transcript stays in
 * the table as an audit trail.
 */
export async function getActiveSessionHistoryItems(db: Database, workspaceId: string, sessionId: string): Promise<Array<{ position: number; item: Record<string, unknown> }>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select({
      position: schema.sessionHistoryItems.position,
      item: schema.sessionHistoryItems.item,
    }).from(schema.sessionHistoryItems)
      .where(and(
        eq(schema.sessionHistoryItems.workspaceId, workspaceId),
        eq(schema.sessionHistoryItems.sessionId, sessionId),
        eq(schema.sessionHistoryItems.active, true),
      ))
      .orderBy(schema.sessionHistoryItems.position);
    return rows;
  });
}

/**
 * Count of ACTIVE (live, model-facing) history rows for a session. This is the
 * length of the history the next turn is seeded from — the dual-write slice
 * index — which after a compaction is far smaller than the total persisted-row
 * count (countSessionHistoryItems still includes the superseded prefix).
 */
export async function countActiveSessionHistoryItems(db: Database, workspaceId: string, sessionId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      count: sql<number>`count(*)`,
    }).from(schema.sessionHistoryItems)
      .where(and(
        eq(schema.sessionHistoryItems.workspaceId, workspaceId),
        eq(schema.sessionHistoryItems.sessionId, sessionId),
        eq(schema.sessionHistoryItems.active, true),
      ));
    return Number(row?.count ?? 0);
  });
}

/**
 * Result-item types and the CALL type that settles each. Kept byte-for-byte in
 * sync with the runtime sanitizer's RESULT_TYPE_BY_CALL_TYPE and the repair
 * migration (0014). The repair, the read-path sanitizer, and this spec all share
 * one definition of a tool-call pair.
 */
const REPAIR_CALL_TYPE_BY_RESULT_TYPE: Record<string, string> = {
  function_call_result: "function_call",
  computer_call_result: "computer_call",
  shell_call_output: "shell_call",
  apply_patch_call_output: "apply_patch_call",
};

function repairCallIdOf(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const record = item as { callId?: unknown; call_id?: unknown };
  if (typeof record.callId === "string") {
    return record.callId;
  }
  if (typeof record.call_id === "string") {
    return record.call_id;
  }
  return undefined;
}

function repairItemType(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Pure TypeScript SPEC for the one-time orphan repair (migration 0014),
 * mirroring its SQL WHERE clause so the deletion rule is unit-testable without a
 * database. Given the ACTIVE history rows of a single session in position order,
 * returns the indices of the orphaned tool-call RESULT rows the repair deletes.
 *
 * An orphan is a result-type row (function_call_result / computer_call_result /
 * shell_call_output / apply_patch_call_output) with no matching CALL of the
 * paired type, same correlation id (camelCase `callId` OR snake_case `call_id`),
 * at a STRICTLY EARLIER position in the same session. This is exactly the
 * session-bricking row the Responses API 400s on ("No tool call found for
 * function call output").
 *
 * DANGLING CALLS (a call with no result yet) are intentionally NOT returned: a
 * call awaiting a not-yet-settled result is valid, not corruption. Only unpaired
 * results are removed.
 *
 * EXISTENCE, not consumption: like the migration's `NOT EXISTS (... earlier
 * call ...)`, a result is kept whenever ANY earlier matching call exists. A
 * second result that re-uses a call_id already settled earlier is therefore NOT
 * flagged here (a matching call still exists before it) — this conservative
 * choice matches the SQL exactly and never deletes a row whose call is present;
 * the read-path sanitizer (which consumes calls one-for-one) still drops such a
 * rare duplicate in-memory, so the model request stays valid regardless.
 *
 * Callers pass rows already ordered by position. The earlier-position test is
 * by array order (the SQL orders by the numeric position column, which the read
 * path also orders by), so identical inputs yield identical decisions.
 */
export function orphanedResultRowIndicesForRepair(
  activeRowsInPositionOrder: ReadonlyArray<{ item: Record<string, unknown> }>,
): number[] {
  // call_ids of CALLs seen so far, per matching result type. A result is an
  // orphan unless a call of its paired type with the same id appeared earlier.
  const seenCallIdsByResultType = new Map<string, Set<string>>();
  // Pre-index every call type to the result type(s) it can settle.
  const resultTypeByCallType: Record<string, string> = {};
  for (const [resultType, callType] of Object.entries(REPAIR_CALL_TYPE_BY_RESULT_TYPE)) {
    resultTypeByCallType[callType] = resultType;
  }
  const orphanIndices: number[] = [];
  activeRowsInPositionOrder.forEach((row, index) => {
    const type = repairItemType(row.item);
    const callId = repairCallIdOf(row.item);
    if (!type || !callId) {
      return;
    }
    const settlesResultType = resultTypeByCallType[type];
    if (settlesResultType) {
      // This row is a CALL: record its id so a later matching result is paired.
      const seen = seenCallIdsByResultType.get(settlesResultType) ?? new Set<string>();
      seen.add(callId);
      seenCallIdsByResultType.set(settlesResultType, seen);
      return;
    }
    if (REPAIR_CALL_TYPE_BY_RESULT_TYPE[type]) {
      // This row is a RESULT: orphan unless an earlier matching call was seen.
      const seen = seenCallIdsByResultType.get(type);
      if (!seen || !seen.has(callId)) {
        orphanIndices.push(index);
      }
    }
  });
  return orphanIndices;
}

/**
 * Apply a client-side context compaction as an atomic, audit-preserving write:
 *
 *  - supersede (set active=false) every active row whose position lies in
 *    [0, boundaryPosition) — i.e. the summarized prefix — EXCLUDING the tail.
 *    Rows are never deleted.
 *  - insert ONE active synthetic summary row at `summaryPosition` (a FRACTIONAL
 *    position — boundaryPosition - 0.5 — that sorts immediately before the kept
 *    tail and collides with NO existing row, so no real prefix row is ever
 *    overwritten). Idempotent on position: a retry that finds the summary row
 *    already there does not duplicate it (it only re-activates the existing
 *    summary row at that fractional position) and — crucially — never mutates
 *    the real row at boundaryPosition - 1.
 *
 * The caller computes the boundary from the orphan-safe planner so no tool-call
 * pair straddles the cut. `summaryPosition` must be < boundaryPosition (between
 * the last superseded prefix row and the kept tail), guaranteeing it sorts
 * before the tail. Because positions are whole numbers and summaries are
 * half-steps, the summary's fractional position can never equal a real row.
 */
export async function applyContextCompaction(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string | null;
  /** Active prefix rows with position < boundaryPosition get superseded. */
  boundaryPosition: number;
  /** Fractional position for the new summary row (must be < boundaryPosition). */
  summaryPosition: number;
  summaryItem: Record<string, unknown>;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    await scopedDb.transaction(async (tx) => {
      await tx.update(schema.sessionHistoryItems)
        .set({ active: false })
        .where(and(
          eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
          eq(schema.sessionHistoryItems.sessionId, input.sessionId),
          eq(schema.sessionHistoryItems.active, true),
          lt(schema.sessionHistoryItems.position, input.boundaryPosition),
        ));
      // Insert the summary at its FRACTIONAL position. The supersede step above
      // also sets active=false for any rows with position < boundaryPosition —
      // which on a RETRY includes the summary itself (it sits below the
      // boundary). The conflict target here is that fractional position, which
      // can ONLY ever collide with a prior summary row (real rows are whole
      // numbers), so onConflictDoUpdate set:{active:true} is safe: it merely
      // re-activates the existing summary, keeping the retry idempotent WITHOUT
      // mutating its item/turnId and — crucially — WITHOUT ever touching the
      // real row at boundaryPosition - 1 (the old integer placement overwrote
      // it). The summary carries the current turnId so per-turn counts stay
      // correct.
      await tx.insert(schema.sessionHistoryItems).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: input.turnId ?? null,
        position: input.summaryPosition,
        item: sanitizeEventPayload(input.summaryItem),
        active: true,
      }).onConflictDoUpdate({
        target: [schema.sessionHistoryItems.workspaceId, schema.sessionHistoryItems.sessionId, schema.sessionHistoryItems.position],
        set: { active: true },
      });
    });
  });
}

/**
 * The next free WHOLE-NUMBER history position for a session: one past the
 * largest existing position (active or superseded), floored so the synthetic
 * summary's fractional half-step never shifts the count. The dual-write
 * watermark uses this to append new rows at fresh absolute positions, decoupled
 * from the in-memory history length (which, after a compaction, is far shorter
 * than the total persisted-row count and so cannot serve as the next position).
 */
export async function nextSessionHistoryPosition(db: Database, workspaceId: string, sessionId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      maxPosition: sql<number | null>`max(${schema.sessionHistoryItems.position})`,
    }).from(schema.sessionHistoryItems)
      .where(and(eq(schema.sessionHistoryItems.workspaceId, workspaceId), eq(schema.sessionHistoryItems.sessionId, sessionId)));
    const max = row?.maxPosition;
    return max === null || max === undefined ? 0 : Math.floor(Number(max)) + 1;
  });
}

/**
 * Record the actual input-token count of the most recent turn's final model
 * call, for the next turn's pre-read compaction trigger.
 */
export async function setSessionLastInputTokens(db: Database, workspaceId: string, sessionId: string, lastInputTokens: number): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.sessions)
      .set({ lastInputTokens, updatedAt: new Date() })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

/**
 * The neutral marker written by clearSessionContext as the sole active history
 * row. It keeps getActiveSessionHistoryItems().length > 0 so the items read
 * path (run-input.ts messageInput) stays selected and never falls through to
 * the getLatestRunState blob — that fallback is the resurrection vector a clear
 * must defeat. A plain user message is a valid, sanitizer-clean item.
 */
export function clearedContextMarkerItem(): Record<string, unknown> {
  return { type: "message", role: "user", content: "[context cleared]" };
}

/**
 * The sentinel serializedRunState written by clearSessionContext, re-exported
 * from @opengeni/contracts so the writer (here) and the readers (run-input /
 * runtime) share one definition. It is audit-honest (carries no prior
 * conversation) and is NOT a real Agents-SDK run state — it has no
 * `$schemaVersion`/history, so `RunState.fromString` throws on it.
 *
 * Both run-state read paths therefore guard against it explicitly via
 * {@link isClearedRunStateBlob}:
 *  - the message path (run-input messageInput) honors it in BOTH items and
 *    run_state history modes — in items mode the boundary marker keeps the
 *    active read non-empty so the blob is never reached, and in run_state mode
 *    the sentinel is recognized and treated as a fresh empty start;
 *  - the approval path is additionally refused by the API for mid-turn /
 *    requires_action sessions, so it never sees the sentinel.
 * Stored so getLatestRunState (the run_state-source read path) reflects the
 * clear instead of resurrecting the pre-clear blob.
 */
export const CLEARED_RUN_STATE = CLEARED_RUN_STATE_BLOB;

export type ClearSessionContextResult = {
  /** Active history rows superseded (active=true -> false). */
  supersededItems: number;
  /** Position of the inserted neutral boundary marker. */
  markerPosition: number;
  /** stateVersion of the fresh cleared run-state row. */
  runStateVersion: number;
};

/**
 * Clear a session's conversation context in ONE transaction, audit-preserving
 * and idempotent. Defeats the RunState-fallback resurrection on BOTH model read
 * paths:
 *
 *  (a) supersede every active session_history_items row (active=true -> false).
 *      Nothing is deleted — the full transcript stays as an audit trail, same
 *      pattern as applyContextCompaction.
 *  (b) insert ONE active neutral boundary marker at max(position)+1 so the
 *      active read path returns length 1 (not 0) and run-input.ts stays on the
 *      items route, away from the getLatestRunState blob (the bug).
 *  (c) insert a fresh agent_run_states row (stateVersion = max+1) with an empty
 *      cleared blob and pendingApprovals:[], so getLatestRunState (approval /
 *      run_state-source read path) also reflects the clear.
 *
 * Also resets last_input_tokens to 0 so the next turn's compaction trigger
 * starts fresh against the now-short context.
 *
 * Idempotent: a re-run supersedes the (now sole, already-marker) active row,
 * inserts another marker at the next position, and another cleared run-state.
 * The post-conditions (one active marker row, latest run-state cleared) hold.
 */
export async function clearSessionContext(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
}): Promise<ClearSessionContextResult> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    return await scopedDb.transaction(async (tx) => {
      const supersededRows = await tx.update(schema.sessionHistoryItems)
        .set({ active: false })
        .where(and(
          eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
          eq(schema.sessionHistoryItems.sessionId, input.sessionId),
          eq(schema.sessionHistoryItems.active, true),
        ))
        .returning({ id: schema.sessionHistoryItems.id });

      const [{ maxPosition } = { maxPosition: -1 }] = await tx.select({
        maxPosition: sql<number>`coalesce(max(${schema.sessionHistoryItems.position}), -1)`,
      }).from(schema.sessionHistoryItems)
        .where(and(
          eq(schema.sessionHistoryItems.workspaceId, input.workspaceId),
          eq(schema.sessionHistoryItems.sessionId, input.sessionId),
        ));
      const markerPosition = Number(maxPosition) + 1;
      await tx.insert(schema.sessionHistoryItems).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: null,
        position: markerPosition,
        item: sanitizeEventPayload(clearedContextMarkerItem()),
        active: true,
      }).onConflictDoNothing({
        target: [schema.sessionHistoryItems.workspaceId, schema.sessionHistoryItems.sessionId, schema.sessionHistoryItems.position],
      });

      const [{ maxVersion } = { maxVersion: 0 }] = await tx.select({
        maxVersion: sql<number>`coalesce(max(${schema.agentRunStates.stateVersion}), 0)`,
      }).from(schema.agentRunStates)
        .where(and(
          eq(schema.agentRunStates.workspaceId, input.workspaceId),
          eq(schema.agentRunStates.sessionId, input.sessionId),
        ));
      const runStateVersion = Number(maxVersion) + 1;
      await tx.insert(schema.agentRunStates).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        turnId: null,
        stateVersion: runStateVersion,
        serializedRunState: CLEARED_RUN_STATE,
        pendingApprovals: [],
      });

      await tx.update(schema.sessions)
        .set({ lastInputTokens: 0, updatedAt: new Date() })
        .where(and(eq(schema.sessions.workspaceId, input.workspaceId), eq(schema.sessions.id, input.sessionId)));

      return { supersededItems: supersededRows.length, markerPosition, runStateVersion };
    });
  });
}

export async function countSessionHistoryItems(db: Database, workspaceId: string, sessionId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      count: sql<number>`count(*)`,
    }).from(schema.sessionHistoryItems)
      .where(and(eq(schema.sessionHistoryItems.workspaceId, workspaceId), eq(schema.sessionHistoryItems.sessionId, sessionId)));
    return Number(row?.count ?? 0);
  });
}

/**
 * Set the operator /compact request flag. The worker honors it before the next
 * turn (forced client-side compaction) and clears it. Idempotent: repeated
 * requests collapse to one pending compaction.
 */
export async function requestSessionCompaction(db: Database, workspaceId: string, sessionId: string): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.sessions)
      .set({ compactRequested: true, updatedAt: new Date() })
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

/**
 * Atomically consume the /compact request flag: clear it and report whether it
 * was set. The worker calls this pre-turn; only the call that observed `true`
 * runs the forced compaction, so concurrent turns can't double-compact.
 */
export async function consumeSessionCompactionRequest(db: Database, workspaceId: string, sessionId: string): Promise<boolean> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const cleared = await scopedDb.update(schema.sessions)
      .set({ compactRequested: false, updatedAt: new Date() })
      .where(and(
        eq(schema.sessions.workspaceId, workspaceId),
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.compactRequested, true),
      ))
      .returning({ id: schema.sessions.id });
    return cleared.length > 0;
  });
}

/**
 * Number of conversation-truth items a specific turn persisted. The
 * worker-death requeue path uses this to decide whether the re-dispatched
 * turn must enter through a resume notice (its partial progress is already
 * part of conversation truth, so replaying the original trigger would hand
 * the model duplicate input) or can replay its original trigger cleanly.
 */
export async function countTurnSessionHistoryItems(db: Database, workspaceId: string, turnId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      count: sql<number>`count(*)`,
    }).from(schema.sessionHistoryItems)
      .where(and(eq(schema.sessionHistoryItems.workspaceId, workspaceId), eq(schema.sessionHistoryItems.turnId, turnId)));
    return Number(row?.count ?? 0);
  });
}

/**
 * Persist the session's sandbox recovery descriptor (the small versioned
 * envelope used to reattach / snapshot-restore / rebuild the sandbox),
 * decoupled from the RunState blob.
 */
export async function upsertSandboxSessionEnvelope(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  envelope: Record<string, unknown>;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    await scopedDb.insert(schema.sandboxSessionEnvelopes).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      envelope: input.envelope,
    }).onConflictDoUpdate({
      target: [schema.sandboxSessionEnvelopes.workspaceId, schema.sandboxSessionEnvelopes.sessionId],
      set: { envelope: input.envelope, updatedAt: new Date() },
    });
  });
}

export async function getSandboxSessionEnvelope(db: Database, workspaceId: string, sessionId: string): Promise<Record<string, unknown> | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({ envelope: schema.sandboxSessionEnvelopes.envelope })
      .from(schema.sandboxSessionEnvelopes)
      .where(and(eq(schema.sandboxSessionEnvelopes.workspaceId, workspaceId), eq(schema.sandboxSessionEnvelopes.sessionId, sessionId)))
      .limit(1);
    return row?.envelope ?? null;
  });
}

// ============================================================================
// Session recordings — the durable index for the "agent films itself proving
// the fix" loop (P4.3). One row per recording; insert at start, update at
// finalize (available with the storage_key) or failure. Read-side feeds the
// list route + the signed-URL replay route (storage_key is the source of truth).
// ============================================================================

export type SessionRecordingState = (typeof schema.sessionRecordingStateValues)[number];
export type SessionRecordingMode = (typeof schema.sessionRecordingModeValues)[number];
export type SessionRecordingCodec = (typeof schema.sessionRecordingCodecValues)[number];

export type SessionRecordingRow = {
  id: string;
  workspaceId: string;
  sessionId: string;
  turnId: string | null;
  state: SessionRecordingState;
  mode: SessionRecordingMode;
  codec: SessionRecordingCodec;
  storageKey: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number;
  height: number;
  reason: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
};

function mapRecording(row: typeof schema.sessionRecordings.$inferSelect): SessionRecordingRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    state: row.state,
    mode: row.mode,
    codec: row.codec,
    storageKey: row.storageKey,
    sizeBytes: row.sizeBytes === null || row.sizeBytes === undefined ? null : Number(row.sizeBytes),
    durationSeconds: row.durationSeconds === null || row.durationSeconds === undefined ? null : Number(row.durationSeconds),
    width: row.width,
    height: row.height,
    reason: row.reason,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
  };
}

export async function insertRecording(db: Database, input: {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string | null;
  mode: SessionRecordingMode;
  codec: SessionRecordingCodec;
  width: number;
  height: number;
  reason?: string | null;
}): Promise<SessionRecordingRow> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.sessionRecordings).values({
      id: input.id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      state: "recording",
      mode: input.mode,
      codec: input.codec,
      width: input.width,
      height: input.height,
      reason: input.reason ?? null,
    }).returning();
    return mapRecording(row!);
  });
}

export async function updateRecording(db: Database, input: {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  state: SessionRecordingState;
  storageKey?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  reason?: string | null;
  finalized?: boolean;
}): Promise<SessionRecordingRow | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const set: Partial<typeof schema.sessionRecordings.$inferInsert> = { state: input.state };
    if (input.storageKey !== undefined) set.storageKey = input.storageKey;
    if (input.sizeBytes !== undefined) set.sizeBytes = input.sizeBytes;
    if (input.durationSeconds !== undefined) set.durationSeconds = input.durationSeconds;
    if (input.reason !== undefined) set.reason = input.reason;
    if (input.finalized || input.state === "available" || input.state === "failed") {
      set.finalizedAt = new Date();
    }
    const [row] = await scopedDb.update(schema.sessionRecordings)
      .set(set)
      .where(and(
        eq(schema.sessionRecordings.workspaceId, input.workspaceId),
        eq(schema.sessionRecordings.id, input.recordingId),
      ))
      .returning();
    return row ? mapRecording(row) : null;
  });
}

/**
 * Hard-delete a recording row. Used to DISCARD an on-turn recording that captured
 * NO computer-use activity (a plain text turn): the row was inserted at
 * `beginRecording` (state "recording") but the turn never drove the desktop, so it
 * is removed entirely rather than surfaced as a phantom recording or a failure. No
 * other table FK-references session_recordings, so the delete is self-contained.
 */
export async function deleteRecording(db: Database, input: {
  accountId: string;
  workspaceId: string;
  recordingId: string;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    await scopedDb.delete(schema.sessionRecordings)
      .where(and(
        eq(schema.sessionRecordings.workspaceId, input.workspaceId),
        eq(schema.sessionRecordings.id, input.recordingId),
      ));
  });
}

export async function getRecording(db: Database, workspaceId: string, recordingId: string): Promise<SessionRecordingRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessionRecordings)
      .where(and(
        eq(schema.sessionRecordings.workspaceId, workspaceId),
        eq(schema.sessionRecordings.id, recordingId),
      ))
      .limit(1);
    return row ? mapRecording(row) : null;
  });
}

export async function listRecordings(db: Database, workspaceId: string, sessionId: string): Promise<SessionRecordingRow[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.sessionRecordings)
      .where(and(
        eq(schema.sessionRecordings.workspaceId, workspaceId),
        eq(schema.sessionRecordings.sessionId, sessionId),
      ))
      .orderBy(desc(schema.sessionRecordings.createdAt));
    return rows.map(mapRecording);
  });
}

// ============================================================================
// Channel-A interactive PTY sessions (P4.4) — the ptyId <-> exec-session-id map.
// The ONLY new persistent state Channel A needs; FS/Git reads persist nothing.
// ============================================================================

export type SandboxPtySessionRow = {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  execSessionId: number | null;
  leaseEpoch: number;
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
  status: "open" | "closed";
  openedBy: string;
  lastInputAt: string;
  createdAt: string;
  closedAt: string | null;
};

function mapPtySession(row: typeof schema.sandboxPtySessions.$inferSelect): SandboxPtySessionRow {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    execSessionId: row.execSessionId ?? null,
    leaseEpoch: row.leaseEpoch,
    cols: row.cols,
    rows: row.rows,
    shell: row.shell,
    cwd: row.cwd,
    status: row.status as "open" | "closed",
    openedBy: row.openedBy,
    lastInputAt: row.lastInputAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

export async function insertPtySession(db: Database, input: {
  id: string;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  execSessionId?: number | null;
  leaseEpoch: number;
  cols: number;
  rows: number;
  shell: string;
  cwd: string;
  openedBy: string;
}): Promise<SandboxPtySessionRow> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.sandboxPtySessions).values({
      id: input.id,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      execSessionId: input.execSessionId ?? null,
      leaseEpoch: input.leaseEpoch,
      cols: input.cols,
      rows: input.rows,
      shell: input.shell,
      cwd: input.cwd,
      status: "open",
      openedBy: input.openedBy,
    }).returning();
    return mapPtySession(row!);
  });
}

/** Read an OPEN PTY row by ptyId. Returns null when absent or already closed. */
export async function getOpenPtySession(db: Database, workspaceId: string, ptyId: string): Promise<SandboxPtySessionRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sandboxPtySessions)
      .where(and(
        eq(schema.sandboxPtySessions.workspaceId, workspaceId),
        eq(schema.sandboxPtySessions.id, ptyId),
        eq(schema.sandboxPtySessions.status, "open"),
      ))
      .limit(1);
    return row ? mapPtySession(row) : null;
  });
}

/** Stamp the SDK exec-session id (known only after the open exec yields a still-
 *  running process) + refresh the input-activity TTL. */
export async function updatePtySessionActivity(db: Database, input: {
  accountId: string;
  workspaceId: string;
  ptyId: string;
  execSessionId?: number | null;
  cols?: number;
  rows?: number;
}): Promise<SandboxPtySessionRow | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const set: Partial<typeof schema.sandboxPtySessions.$inferInsert> = { lastInputAt: new Date() };
    if (input.execSessionId !== undefined) set.execSessionId = input.execSessionId;
    if (input.cols !== undefined) set.cols = input.cols;
    if (input.rows !== undefined) set.rows = input.rows;
    const [row] = await scopedDb.update(schema.sandboxPtySessions)
      .set(set)
      .where(and(
        eq(schema.sandboxPtySessions.workspaceId, input.workspaceId),
        eq(schema.sandboxPtySessions.id, input.ptyId),
        eq(schema.sandboxPtySessions.status, "open"),
      ))
      .returning();
    return row ? mapPtySession(row) : null;
  });
}

/** Mark a PTY closed (idempotent — a double close on a closed row is a no-op). */
export async function closePtySession(db: Database, input: {
  accountId: string;
  workspaceId: string;
  ptyId: string;
}): Promise<SandboxPtySessionRow | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.sandboxPtySessions)
      .set({ status: "closed", closedAt: new Date() })
      .where(and(
        eq(schema.sandboxPtySessions.workspaceId, input.workspaceId),
        eq(schema.sandboxPtySessions.id, input.ptyId),
      ))
      .returning();
    return row ? mapPtySession(row) : null;
  });
}

/** List a session's OPEN PTYs (reattach + reap). */
export async function listOpenPtySessions(db: Database, workspaceId: string, sessionId: string): Promise<SandboxPtySessionRow[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.sandboxPtySessions)
      .where(and(
        eq(schema.sandboxPtySessions.workspaceId, workspaceId),
        eq(schema.sandboxPtySessions.sessionId, sessionId),
        eq(schema.sandboxPtySessions.status, "open"),
      ))
      .orderBy(desc(schema.sandboxPtySessions.createdAt));
    return rows.map(mapPtySession);
  });
}

// ============================================================================
// Sandbox singleton lease — the SOLE enforcer of one-box-per-group (P1.1).
//
// Group-keyed (workspace_id, sandbox_group_id) from the start. The sole
// double-spawn guard is the UNIQUE (workspace_id, sandbox_group_id) index +
// plain SELECT … FOR UPDATE (block, NOT skip-locked) + the cold->warming CAS
// inside that row lock. lease_epoch is integer (returns a JS number) but every
// read is Number()-coerced defensively. Mirrors the claimNextQueuedTurn
// withWorkspaceRls/withRlsContext -> scopedDb.transaction -> tx.execute(sql<T>``)
// pattern (the row type goes on the sql tag, not on .execute).
// ============================================================================

export type SandboxLeaseLiveness = "cold" | "warming" | "warm" | "draining";
export type LeaseHolderKind = "turn" | "viewer";

// The snake_case raw shape returned by the raw sql`` lease queries. lease_epoch
// comes back as a number for an integer column, but we type it number|string
// and Number()-coerce so the same code is correct regardless of column type.
// Typed with an index signature so it satisfies db.execute<TRow extends
// Record<string, unknown>>.
type LeaseRow = {
  id: string;
  account_id: string;
  workspace_id: string;
  sandbox_group_id: string;
  liveness: SandboxLeaseLiveness;
  refcount: number;
  turn_holders: number;
  viewer_holders: number;
  instance_id: string | null;
  backend: string;
  os: string;
  data_plane_url: string | null;
  terminal_data_plane_url: string | null;
  lease_epoch: number | string;
  resume_backend_id: string | null;
  resume_state: Record<string, unknown> | null;
  last_meter_at: Date | string | null;
  last_meter_tick: number;
  expires_at: Date | string;
} & Record<string, unknown>;

export interface LeaseSnapshot {
  id: string;
  sandboxGroupId: string;
  liveness: SandboxLeaseLiveness;
  refcount: number;
  turnHolders: number;
  viewerHolders: number;
  instanceId: string | null;
  backend: string;
  os: string;
  dataPlaneUrl: string | null;
  // The cached ttyd pty-ws tunnel URL (7681), separate from dataPlaneUrl (the
  // 6080 desktop tunnel). Null until mintTerminalStream resolves + records it.
  terminalDataPlaneUrl: string | null;
  leaseEpoch: number;
  resumeBackendId: string | null;
  resumeState: Record<string, unknown> | null;
  expiresAt: Date;
}

export interface AcquireLeaseInput {
  accountId: string;
  workspaceId: string;
  // The group's identity (sessions.sandbox_group_id; == session id for a
  // singleton group). The lease is per-group, not per-session.
  sandboxGroupId: string;
  kind: LeaseHolderKind;
  holderId: string;            // session_turns.id (turn) | viewer connection id (viewer)
  subjectId?: string | null;   // the attributing session within the group
  backend: string;             // sessions.sandbox_backend
  os?: string;                 // default 'linux'
  leaseTtlMs: number;          // refresh window for expires_at (turn-heartbeat cadence)
  // Optional epoch fence for a re-establishing turn holder: when set, the
  // turn-arrival increment is gated on lease_epoch == expectedEpoch (split-brain).
  expectedEpoch?: number;
}

export type AcquireLeaseResult =
  // Caller WON the cold->warming CAS: it is the spawner (any pool worker). Must
  // resume-by-id from resume_state, expose the stream port, then call
  // commitWarmingToWarm. No owner process is started.
  | { role: "spawner"; lease: LeaseSnapshot }
  // Box live or being built by someone else: attach (and, for warming, wait).
  | { role: "attached"; lease: LeaseSnapshot }
  // Re-armed a draining lease back to warm (box never torn down).
  | { role: "rearmed"; lease: LeaseSnapshot }
  // Epoch fence rejected the turn-arrival increment: a newer epoch exists (a
  // later turn re-established the box). Caller must back off and re-read; NEVER
  // create().
  | { role: "fenced"; lease: LeaseSnapshot };

// Thrown by callers that treat a fenced/superseded epoch as an error path.
export class SandboxLeaseSupersededError extends Error {
  constructor(public readonly sandboxGroupId: string, public readonly leaseEpoch: number) {
    super(`Sandbox lease superseded for group ${sandboxGroupId} (epoch ${leaseEpoch})`);
    this.name = "SandboxLeaseSupersededError";
  }
}

function mapLeaseRow(row: LeaseRow): LeaseSnapshot {
  return {
    id: row.id,
    sandboxGroupId: row.sandbox_group_id,
    liveness: row.liveness,
    refcount: Number(row.refcount),
    turnHolders: Number(row.turn_holders),
    viewerHolders: Number(row.viewer_holders),
    instanceId: row.instance_id,
    backend: row.backend,
    os: row.os,
    dataPlaneUrl: row.data_plane_url,
    terminalDataPlaneUrl: row.terminal_data_plane_url ?? null,
    // Defensive coercion: integer returns a number, but coerce regardless so the
    // fence comparison stays exact even if the column type ever drifts to int8.
    leaseEpoch: Number(row.lease_epoch),
    resumeBackendId: row.resume_backend_id,
    resumeState: row.resume_state,
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

// Recompute refcount/split-counts from the holder rows (holders are the source
// of truth), refresh expires_at, optionally set liveness. Returns the updated row.
async function recomputeAndStampLease(
  tx: Database,
  leaseId: string,
  leaseTtlMs: number,
  setLiveness: SandboxLeaseLiveness | null,
): Promise<LeaseRow> {
  const counts = await tx.execute<{ total: number; turns: number; viewers: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where kind = 'turn')::int   as turns,
           count(*) filter (where kind = 'viewer')::int as viewers
    from sandbox_lease_holders where lease_id = ${leaseId}
  `);
  const c = counts[0]!;
  const updated = await tx.execute<LeaseRow>(sql`
    update sandbox_leases set
      refcount       = ${c.total},
      turn_holders   = ${c.turns},
      viewer_holders = ${c.viewers},
      expires_at     = now() + (${String(leaseTtlMs)} || ' milliseconds')::interval,
      ${setLiveness ? sql`liveness = ${setLiveness},` : sql``}
      updated_at     = now()
    where id = ${leaseId}
    returning *
  `);
  return updated[0]!;
}

// Idempotent acquire: the unique (lease, kind, holder) index makes a retried or
// duplicate acquire a no-op heartbeat refresh, never a double-count.
async function upsertLeaseHolder(
  tx: Database, leaseId: string, accountId: string, workspaceId: string,
  kind: LeaseHolderKind, holderId: string, subjectId: string | null,
): Promise<void> {
  await tx.execute(sql`
    insert into sandbox_lease_holders
      (account_id, workspace_id, lease_id, kind, holder_id, subject_id, last_heartbeat_at)
    values (${accountId}, ${workspaceId}, ${leaseId}, ${kind}, ${holderId}, ${subjectId}, now())
    on conflict (lease_id, kind, holder_id)
      do update set last_heartbeat_at = now()
  `);
}

// §4.1 — the get-or-create critical section. ONE transaction:
// insert-or-nothing -> SELECT … FOR UPDATE (block, not skip) -> branch -> bump.
// The single most load-bearing function: the sole double-spawn guard.
export async function acquireLease(db: Database, input: AcquireLeaseInput): Promise<AcquireLeaseResult> {
  const { accountId, workspaceId, sandboxGroupId, kind, holderId, backend } = input;
  const os = input.os ?? "linux";
  const subjectId = input.subjectId ?? null;
  return await withRlsContext(db, { accountId, workspaceId }, async (scopedDb) =>
    await scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      // (1) Materialize the singleton row if absent. ON CONFLICT DO NOTHING + the
      // unique index = idempotent under a race; concurrent inserts collapse to
      // one row. expires_at seeded so a never-warmed cold row has a valid TTL.
      await tx.execute(sql`
        insert into sandbox_leases
          (account_id, workspace_id, sandbox_group_id, liveness, backend, os, expires_at)
        values
          (${accountId}, ${workspaceId}, ${sandboxGroupId}, 'cold', ${backend}, ${os},
           now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval)
        on conflict (workspace_id, sandbox_group_id) do nothing
      `);

      // (2) Serialize ALL concurrent arrivals on this group's row. Plain FOR
      // UPDATE (block, do NOT skip) — unlike claimNextQueuedTurn's SKIP LOCKED,
      // because we WANT the loser to block then attach, not skip and lose.
      const rows = await tx.execute<LeaseRow>(sql`
        select * from sandbox_leases
        where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}
        for update
      `);
      const row = rows[0];
      if (!row) throw new Error(`Lease row vanished post-insert: ${sandboxGroupId}`);

      const liveness = row.liveness;

      // -- draining: late arrival re-arms (D1). Box still alive (grace open).
      if (liveness === "draining") {
        await upsertLeaseHolder(tx, row.id, accountId, workspaceId, kind, holderId, subjectId);
        const updated = await recomputeAndStampLease(tx, row.id, input.leaseTtlMs, "warm");
        return { role: "rearmed" as const, lease: mapLeaseRow(updated) };
      }

      // -- cold: WIN the cold->warming CAS (C1). Exactly one winner under the
      // held row lock; concurrent arrivals serialize behind us and see warming.
      if (liveness === "cold") {
        const casRows = await tx.execute<{ id: string }>(sql`
          update sandbox_leases set liveness = 'warming', updated_at = now()
          where id = ${row.id} and liveness = 'cold'
          returning id
        `);
        await upsertLeaseHolder(tx, row.id, accountId, workspaceId, kind, holderId, subjectId);
        const updated = await recomputeAndStampLease(tx, row.id, input.leaseTtlMs, null);
        // casRows.length === 0 cannot happen under the held row lock (defensive):
        // a lost CAS means a sibling flipped it first, so we attach.
        const role = casRows.length === 0 ? "attached" as const : "spawner" as const;
        return { role, lease: mapLeaseRow(updated) };
      }

      // -- warm: epoch fence for re-establishing turn holders (split-brain). A
      // turn arriving with expectedEpoch must match the live row epoch; a stale
      // re-dispatched turn is fenced out -> back off, NEVER create(). Number()-
      // coerced so an int8 drift cannot make the compare always-true.
      if (liveness === "warm" && kind === "turn" && input.expectedEpoch !== undefined
          && Number(row.lease_epoch) !== input.expectedEpoch) {
        return { role: "fenced" as const, lease: mapLeaseRow(row) };
      }

      // -- warm / warming: attach (A2 / A1). refcount++ ONLY; never touch
      // liveness. The spawner exclusively owns warming->warm.
      await upsertLeaseHolder(tx, row.id, accountId, workspaceId, kind, holderId, subjectId);
      const updated = await recomputeAndStampLease(tx, row.id, input.leaseTtlMs, null);
      return { role: "attached" as const, lease: mapLeaseRow(updated) };
    }),
  );
}

// §4.2 — the ONLY lease_epoch++ site. CAS on (warming AND lease_epoch=expected).
// Folds the group box-envelope (resume_backend_id/resume_state) onto the lease.
export async function commitWarmingToWarm(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string;
  expectedEpoch: number;          // the epoch the spawner observed at cold->warming
  instanceId: string;
  dataPlaneUrl?: string | null;   // event-driven resolveExposedPort result, any worker
  resumeBackendId?: string | null;
  resumeState?: Record<string, unknown> | null;
  leaseTtlMs: number;
}): Promise<{ committed: boolean; lease: LeaseSnapshot | null }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // resume_state is jsonb: the raw postgres driver does NOT auto-stringify a
      // plain object bound for a jsonb column, so serialize to a JSON string and
      // cast ::jsonb (null stays a real SQL null). Binding the object directly
      // throws "string argument must be of type string" on the wire.
      const resumeStateJson = input.resumeState == null ? null : JSON.stringify(input.resumeState);
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          liveness          = 'warm',
          instance_id       = ${input.instanceId},
          data_plane_url    = ${input.dataPlaneUrl ?? null},
          -- A box re-key (epoch++) invalidates the prior epoch's ttyd tunnel; the
          -- terminal URL is re-resolved + re-recorded lazily by mintTerminalStream
          -- on the next attach. Clear it here so a stale URL never survives a roll.
          terminal_data_plane_url = null,
          resume_backend_id = ${input.resumeBackendId ?? null},
          resume_state      = ${resumeStateJson}::jsonb,
          lease_epoch       = lease_epoch + 1,
          expires_at        = now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval,
          updated_at        = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
        returning *
      `);
      // CAS miss = a reaper already reset this warming row to cold (the spawner
      // was too slow), or another spawner re-established and bumped the epoch.
      // The spawner MUST drop its in-memory handle and re-acquire — NEVER force
      // warm, NEVER provider-delete the box (it rides the provider idle-timeout).
      if (rows.length === 0) return { committed: false, lease: null };
      return { committed: true, lease: mapLeaseRow(rows[0]!) };
    });
}

// §4.3 — caught spawn failure: warming -> cold (W3). Holders are intentionally
// left intact — the arrival that triggered the spawn still wants a box, so the
// next acquireLease re-CAS cold->warming.
//
// ARCHIVE PRESERVATION (sandbox-file-persistence): when the cold lease that was
// selected for re-warm carried a persisted /workspace archive on its resume_state
// (an archive-only envelope `{ backendId, sessionState: { workspaceArchive } }`
// placed there by a prior drain), the spawn failed BEFORE commitWarmingToWarm,
// so the LIVE box envelope was never folded onto resume_state. The warming row
// still holds the ORIGINAL archive-only envelope. Nulling resume_state here would
// destroy the snapshot the NEXT re-warm must replay — the same file-persistence
// bug confirmDrainCold guards against. So we PRESERVE a minimal archive-only
// envelope across this failure rollback (same shape confirmDrainCold keeps) and
// retain resume_backend_id. No archive on the warming row (a never-persisted cold
// start) -> resume_state is nulled as before.
export async function failWarmingToCold(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string; expectedEpoch: number;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      await scopedDb.execute(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          data_plane_url = null, terminal_data_plane_url = null, updated_at = now(),
          resume_state = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then jsonb_build_object(
                'backendId', coalesce(resume_state ->> 'backendId', to_jsonb(resume_backend_id) #>> '{}'),
                'sessionState', jsonb_build_object(
                  'workspaceArchive', resume_state #> '{sessionState,workspaceArchive}'))
            else null
          end,
          resume_backend_id = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then resume_backend_id
            else null
          end
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'warming' and lease_epoch = ${input.expectedEpoch}
      `);
    });
}

// §4.4 — idempotent delete-my-row (+ opportunistic warm->draining guarded
// refcount=0 AND turn_holders=0, so a paying turn is never drained).
export async function releaseLeaseHolder(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string;
  kind: LeaseHolderKind; holderId: string; idleGraceMs: number;
}): Promise<{ liveness: SandboxLeaseLiveness; refcount: number } | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const rows = await tx.execute<LeaseRow>(sql`
        select * from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
        for update
      `);
      const row = rows[0];
      if (!row) return null;  // already cold-and-reaped; release is an idempotent no-op

      // Idempotent: deleting an already-gone holder affects 0 rows, fine.
      await tx.execute(sql`
        delete from sandbox_lease_holders
        where lease_id = ${row.id} and kind = ${input.kind} and holder_id = ${input.holderId}
      `);

      const counts = await tx.execute<{ total: number; turns: number; viewers: number }>(sql`
        select count(*)::int as total,
               count(*) filter (where kind = 'turn')::int   as turns,
               count(*) filter (where kind = 'viewer')::int as viewers
        from sandbox_lease_holders where lease_id = ${row.id}
      `);
      const c = counts[0]!;

      // warm + dropped to 0 (AND no turn holders) -> draining, stamp grace deadline.
      // Release during warming decrements only, NEVER touches liveness (the
      // spawner owns warming->warm and re-checks refcount after committing).
      const enterDraining = row.liveness === "warm" && c.total === 0 && c.turns === 0;
      const updated = await tx.execute<LeaseRow>(sql`
        update sandbox_leases set
          refcount = ${c.total}, turn_holders = ${c.turns}, viewer_holders = ${c.viewers},
          ${enterDraining
            ? sql`liveness = 'draining', expires_at = now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval,`
            : sql``}
          updated_at = now()
        where id = ${row.id}
        returning *
      `);
      return { liveness: updated[0]!.liveness, refcount: Number(c.total) };
    }));
}

// §4.5 — heartbeat. EPOCH-FENCED (the C1b fix — the real split-brain bug, on the
// HEARTBEAT path): a stale (superseded) owner's lease refresh is rejected so it
// self-evicts. Also liveness-guarded to warm/warming (C2) so a heartbeat can't
// wedge a draining lease forever by pushing its grace deadline.
export async function heartbeatLeaseHolder(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string;
  kind: LeaseHolderKind; holderId: string; leaseTtlMs: number; expectedEpoch: number;
}): Promise<boolean> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const updated = await tx.execute<{ id: string }>(sql`
        update sandbox_lease_holders set last_heartbeat_at = now()
        where lease_id = (select id from sandbox_leases
                          where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId})
          and kind = ${input.kind} and holder_id = ${input.holderId}
        returning id
      `);
      if (updated.length === 0) return false;   // holder was reaped — caller re-acquires
      // Epoch-fenced, liveness-guarded lease TTL refresh: only a live-epoch
      // warm/warming lease is refreshed. A stale-epoch (split-brain) or draining
      // lease returns 0 rows -> false -> the stale holder drops its handle.
      const leaseRows = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          expires_at = now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval,
          updated_at = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and lease_epoch = ${input.expectedEpoch}
          and liveness in ('warm','warming')
        returning id
      `);
      return leaseRows.length > 0;
    }));
}

// §4.6 — the reaper. DB-SIDE ONLY (no provider call — the provider stop() is
// P1.3's runtime concern). Three actions in one pass: TTL-reap stale viewer
// holders, recompute refcounts + warm->draining, reset warming-death to cold;
// returns the drainable (workspaceId, sandboxGroupId) rows the caller terminates.
//
// This is the PER-WORKSPACE entry point (RLS-scoped). The cross-workspace global
// sweep is the SECURITY-DEFINER opengeni_private.reap_sandbox_leases() fn —
// reapStaleLeaseHoldersGlobal below.
export interface ReapDrainable {
  workspaceId: string;
  sandboxGroupId: string;
  instanceId: string | null;
  leaseEpoch: number;
}

export async function reapStaleLeaseHolders(db: Database, input: {
  workspaceId: string;
  viewerHolderTtlMs: number;   // delete viewer rows older than this
  idleGraceMs: number;         // drain-grace horizon (matches releaseLeaseHolder)
}): Promise<{ reapedViewers: number; warmingReset: number; drained: ReapDrainable[] }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) =>
    await scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      // (a) Reap stale VIEWER holders (turn holders are TTL-exempt — never reaped).
      const reaped = await tx.execute<{ lease_id: string }>(sql`
        delete from sandbox_lease_holders
        where workspace_id = ${input.workspaceId} and kind = 'viewer'
          and last_heartbeat_at < now() - (${String(input.viewerHolderTtlMs)} || ' milliseconds')::interval
        returning lease_id
      `);

      // (b) Recompute refcounts for every lease in the workspace; warm leases
      // that hit 0 (AND turn_holders=0) enter draining with a fresh grace
      // deadline (idleGraceMs — the SAME horizon releaseLeaseHolder stamps).
      await tx.execute(sql`
        update sandbox_leases L set
          refcount       = c.total,
          turn_holders   = c.turns,
          viewer_holders = c.viewers,
          liveness = case when L.liveness = 'warm' and c.total = 0 and c.turns = 0
                          then 'draining' else L.liveness end,
          expires_at = case when L.liveness = 'warm' and c.total = 0 and c.turns = 0
                          then now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval
                          else L.expires_at end,
          updated_at = now()
        from (
          select L2.id,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id)::int                       as total,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id and h.kind = 'turn')::int   as turns,
                 (select count(*) from sandbox_lease_holders h where h.lease_id = L2.id and h.kind = 'viewer')::int as viewers
          from sandbox_leases L2 where L2.workspace_id = ${input.workspaceId}
        ) c
        where L.id = c.id and L.workspace_id = ${input.workspaceId}
      `);

      // (c) WARMING-death: a 'warming' row whose LEASE TTL lapsed = an uncaught
      // spawner death. Reset to cold so a queued turn can re-acquire and re-spawn.
      const warmingReset = await tx.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          resume_backend_id = null, resume_state = null,
          data_plane_url = null, terminal_data_plane_url = null, updated_at = now()
        where workspace_id = ${input.workspaceId}
          and liveness = 'warming' and expires_at < now()
        returning id
      `);

      // (d) DRAINING-grace elapsed: surface leases whose grace is up AND still
      // idle, with instance_id + epoch, so the caller can issue the provider
      // stop() then confirmDrainCold. DB-only: no provider call here.
      const drainable = await tx.execute<{ sandbox_group_id: string; instance_id: string | null; lease_epoch: number | string }>(sql`
        select sandbox_group_id, instance_id, lease_epoch from sandbox_leases
        where workspace_id = ${input.workspaceId}
          and liveness = 'draining' and expires_at < now() and refcount = 0
      `);

      return {
        reapedViewers: reaped.length,
        warmingReset: warmingReset.length,
        drained: drainable.map((r) => ({
          workspaceId: input.workspaceId,
          sandboxGroupId: r.sandbox_group_id,
          instanceId: r.instance_id,
          leaseEpoch: Number(r.lease_epoch),
        })),
      };
    }));
}

// §4.6 (global) — the cross-workspace reaper sweep (OD-3). Calls the
// SECURITY-DEFINER opengeni_private.reap_sandbox_leases() fn so the global
// reaper Temporal Schedule (P1.3) sees stale rows across ALL workspaces in ONE
// pass, bypassing per-workspace FORCE RLS. DB-only — returns the drainable rows;
// the provider stop() is the caller's concern. No RLS GUC is set (the DEFINER fn
// is the sanctioned cross-workspace read).
export async function reapStaleLeaseHoldersGlobal(db: Database, input: {
  viewerHolderTtlMs: number;
  idleGraceMs: number;
}): Promise<ReapDrainable[]> {
  const rows = await db.execute<{ workspace_id: string; sandbox_group_id: string; instance_id: string | null; lease_epoch: number | string }>(sql`
    select workspace_id, sandbox_group_id, instance_id, lease_epoch
    from opengeni_private.reap_sandbox_leases(${input.viewerHolderTtlMs}, ${input.idleGraceMs})
  `);
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    sandboxGroupId: r.sandbox_group_id,
    instanceId: r.instance_id,
    leaseEpoch: Number(r.lease_epoch),
  }));
}

// §2.2 (global) — the warm-meter read for the REAPER tick (P2.1). Returns one row
// per WARM viewer-only group (turn-held boxes are metered by the turn heartbeat,
// so they are EXCLUDED here — no double-meter). Cross-workspace via the
// SECURITY-DEFINER list fn (FORCE RLS would hide other workspaces from the scoped
// connection). DB-only read; the worker accrues per row via accrueWarmSeconds.
export interface MeterableWarmLease {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  leaseEpoch: number;
  backend: string;
}

export async function listMeterableWarmLeases(db: Database): Promise<MeterableWarmLease[]> {
  const rows = await db.execute<{ account_id: string; workspace_id: string; sandbox_group_id: string; lease_epoch: number | string; backend: string }>(sql`
    select account_id, workspace_id, sandbox_group_id, lease_epoch, backend
    from opengeni_private.list_meterable_warm_leases()
  `);
  return rows.map((r) => ({
    accountId: r.account_id,
    workspaceId: r.workspace_id,
    sandboxGroupId: r.sandbox_group_id,
    leaseEpoch: Number(r.lease_epoch),
    backend: r.backend,
  }));
}

// §4.7 — explicit re-arm seam (D1). acquireLease already re-arms a draining
// lease inline; this is the standalone version for callers that learn a holder
// is wanted during the grace window without going through acquireLease first.
export async function reArmDrainingLease(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string; leaseTtlMs: number;
}): Promise<{ rearmed: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'warm',
          expires_at = now() + (${String(input.leaseTtlMs)} || ' milliseconds')::interval,
          updated_at = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining'
        returning id
      `);
      return { rearmed: rows.length > 0 };
    });
}

// §4.8 — the reaper's final teardown commit (D3). Called AFTER the caller issued
// the provider stop() on instance_id. CAS-guarded (draining AND refcount=0 AND
// lease_epoch=expected) so a late re-arm (D1) or a newer epoch that snuck in
// during teardown wins — wentCold:false means the box is still wanted and must
// NOT have been stopped (the caller checks this CAS before stop(), or re-reads).
export async function confirmDrainCold(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string; expectedEpoch: number;
}): Promise<{ wentCold: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // draining->cold: the box is terminated, so EVERY live-box field is cleared
      // (instance_id / data-plane URLs). resume_state, however, is NOT blindly
      // nulled — if the reaper PERSISTED a /workspace snapshot onto it
      // (persistDrainSnapshot folds the archive at resume_state.sessionState.
      // workspaceArchive BEFORE this CAS, in the SAME sweep), nulling it here would
      // immediately destroy the snapshot the next cold-restore must replay — the
      // file-persistence bug. So we PRESERVE a MINIMAL archive-only envelope
      // `{ backendId, sessionState: { workspaceArchive } }` (dropping the dead box's
      // providerState/sandboxId — the box is gone, resume-by-id would only fail) and
      // KEEP resume_backend_id so cold-restore knows which client to hydrate with.
      // No archive (a non-persisted drain, or a 'none'/tar config that stored none)
      // -> resume_state is nulled as before. The archive then rides the COLD lease's
      // resume_state until the next spawner reads + hydrates it; it is re-superseded
      // (GC'd) on the next drain and finally cleared on workspace teardown.
      const rows = await scopedDb.execute<{ id: string }>(sql`
        update sandbox_leases set
          liveness = 'cold', instance_id = null,
          data_plane_url = null, terminal_data_plane_url = null, updated_at = now(),
          resume_state = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then jsonb_build_object(
                'backendId', coalesce(resume_state ->> 'backendId', to_jsonb(resume_backend_id) #>> '{}'),
                'sessionState', jsonb_build_object(
                  'workspaceArchive', resume_state #> '{sessionState,workspaceArchive}'))
            else null
          end,
          resume_backend_id = case
            when (resume_state #>> '{sessionState,workspaceArchive}') is not null
              then resume_backend_id
            else null
          end
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining' and refcount = 0 and lease_epoch = ${input.expectedEpoch}
        returning id
      `);
      return { wentCold: rows.length > 0 };
    });
}

// §4.8b — persist the /workspace snapshot archive onto the lease BEFORE the
// reaper terminates a drained box (sandbox-file-persistence). The reaper, after
// resuming the live box and capturing `session.persistWorkspace()` (a base64
// snapshot-ref / tar archive), CAS-folds it onto the lease's resume_state under
// the SAME epoch fence confirmDrainCold uses (draining AND refcount=0 AND
// lease_epoch=expected). Folding it into resume_state.sessionState.workspaceArchive
// means a later cold-restore (establishSandboxSessionFromEnvelope) reads it back
// off the same envelope it already deserializes, and confirmDrainCold's
// `resume_state = null` clears it on teardown for free (delete-on-teardown).
//
// When workspaceArchive is null this function acts as a PURE CAS-GATE: it checks
// (draining AND refcount=0 AND epoch=expected) under a FOR UPDATE lock and returns
// wrote:true/false WITHOUT writing anything. This allows the reaper to guard a
// terminate that produced no archive (a backend with no persistWorkspace) against
// the re-arm race: a re-arm during the snapshot window sets refcount>0 / liveness!=
// draining, so wrote:false → the reaper MUST NOT delete the box.
//
// Returns `{ wrote, priorArchive }`:
//   - wrote:false  -> the CAS missed (re-armed / newer epoch / vanished); the
//                     caller must NOT terminate (the box is wanted again). No GC.
//   - priorArchive -> the archive THIS lease carried before (if any), so the
//                     caller can best-effort delete the superseded provider
//                     snapshot (keep-latest-per-lease GC). null on the first
//                     persist for this box or when workspaceArchive is null.
// The fence is the split-brain guard: a stale-epoch reaper writes ZERO rows and
// is told not to terminate.
export async function persistDrainSnapshot(db: Database, input: {
  accountId: string; workspaceId: string; sandboxGroupId: string;
  expectedEpoch: number;
  /** base64 of the provider snapshot-ref / tar archive from persistWorkspace().
   *  Pass null to CAS-check without writing (for backends with no persistWorkspace). */
  workspaceArchive: string | null;
}): Promise<{ wrote: boolean; priorArchive: string | null }> {
  // withRlsContext already runs `fn` inside ONE transaction with the RLS GUCs set,
  // so the SELECT...FOR UPDATE + UPDATE below are atomic (one snapshot, one lock)
  // WITHOUT an extra nested savepoint — nesting a second transaction here under
  // the RLS-scoped connection wedges the postgres-js client ("Failed query").
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      // (1) Lock + read the PRIOR archive under the CAS guard (draining AND
      // refcount=0 AND lease_epoch=expected). A miss (re-armed / newer epoch /
      // vanished) returns no row → wrote:false, the caller must NOT terminate.
      const guard = await scopedDb.execute<{ prior_archive: string | null }>(sql`
        select resume_state #>> '{sessionState,workspaceArchive}' as prior_archive
        from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining' and refcount = 0 and lease_epoch = ${input.expectedEpoch}
        for update
      `);
      if (guard.length === 0) {
        return { wrote: false, priorArchive: null };
      }
      const priorArchive = guard[0]!.prior_archive ?? null;
      // null workspaceArchive = pure CAS-check (re-arm guard for no-archive backends).
      // The FOR UPDATE lock above is the only synchronization needed; no write.
      if (input.workspaceArchive === null) {
        return { wrote: true, priorArchive: null };
      }
      // (2) Merge the NEW archive into resume_state.sessionState.workspaceArchive.
      // jsonb_set's create_missing does NOT create intermediate objects, so a
      // direct set of '{sessionState,workspaceArchive}' is a silent no-op when
      // `sessionState` is absent (a null resume_state, or a legacy flat envelope).
      // Instead: rebuild `sessionState` as (existing sessionState OR '{}') merged
      // (||) with `{workspaceArchive: <b64>}` — this CREATES sessionState if absent
      // AND preserves its existing siblings (providerState/manifest/exposedPorts).
      // The archive is bound as a jsonb string scalar (to_jsonb(text)). Re-asserting
      // the CAS guard keeps the write atomic with the FOR UPDATE lock above.
      await scopedDb.execute(sql`
        update sandbox_leases set
          resume_state = jsonb_set(
            -- Defensive: only treat resume_state / its sessionState as an object
            -- when it actually IS one; a null/scalar (legacy or malformed envelope)
            -- starts from '{}' so jsonb_set never throws "cannot set path in scalar".
            case when jsonb_typeof(resume_state) = 'object' then resume_state else '{}'::jsonb end,
            '{sessionState}',
            (case when jsonb_typeof(resume_state -> 'sessionState') = 'object'
                  then resume_state -> 'sessionState' else '{}'::jsonb end)
              || jsonb_build_object('workspaceArchive', to_jsonb(${input.workspaceArchive}::text)),
            true
          ),
          updated_at = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and liveness = 'draining' and refcount = 0 and lease_epoch = ${input.expectedEpoch}
      `);
      return { wrote: true, priorArchive };
    });
}

// §4.9 — non-locking snapshot for the API handshake & health.
export async function readLease(db: Database, workspaceId: string, sandboxGroupId: string): Promise<LeaseSnapshot | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<LeaseRow>(sql`
      select * from sandbox_leases
      where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}
      limit 1
    `);
    return rows[0] ? mapLeaseRow(rows[0]) : null;
  });
}

// P4.2 — record the (re-)resolved desktop data-plane URL on an ALREADY-WARM
// lease, EPOCH-FENCED. commitWarmingToWarm records the URL at cold→warming→warm
// (the spawn path); this is the WARM-path counterpart used when a viewer mints
// the URL against a box that some other holder already brought up, and on
// rollover-rotation (re-resolve under the current epoch). The fence is the
// split-brain guard: a stale-epoch writer (a box re-established under a newer
// epoch) updates ZERO rows and the caller backs off. Returns the updated
// snapshot, or null on a fence miss (epoch advanced / lease vanished).
export async function recordLeaseDataPlaneUrl(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  expectedEpoch: number;
  dataPlaneUrl: string | null;
}): Promise<LeaseSnapshot | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          data_plane_url = ${input.dataPlaneUrl ?? null},
          updated_at     = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and lease_epoch = ${input.expectedEpoch}
          and liveness in ('warm', 'draining')
        returning *
      `);
      return rows[0] ? mapLeaseRow(rows[0]) : null;
    });
}

// P5.t — record the (re-)resolved ttyd terminal data-plane URL (7681) on an
// ALREADY-WARM lease, EPOCH-FENCED. The exact terminal twin of
// recordLeaseDataPlaneUrl: the REAL PTY rides a SEPARATE provider tunnel from the
// desktop noVNC, so its URL is cached in its own column. mintTerminalStream calls
// this after resolving the 7681 tunnel; the fast-path then re-mints only a fresh
// token against the cached URL. The fence is the split-brain guard (a stale-epoch
// writer updates ZERO rows). Returns the updated snapshot, or null on a fence
// miss (epoch advanced / lease vanished).
export async function recordLeaseTerminalDataPlaneUrl(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  expectedEpoch: number;
  terminalDataPlaneUrl: string | null;
}): Promise<LeaseSnapshot | null> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<LeaseRow>(sql`
        update sandbox_leases set
          terminal_data_plane_url = ${input.terminalDataPlaneUrl ?? null},
          updated_at              = now()
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
          and lease_epoch = ${input.expectedEpoch}
          and liveness in ('warm', 'draining')
        returning *
      `);
      return rows[0] ? mapLeaseRow(rows[0]) : null;
    });
}

// ============================================================================
// Bring-your-own-compute (M2): first-class swappable sandboxes + enrollment +
// per-machine metrics + the per-session epoch-fenced active-sandbox pointer
// (migration 0024 / dossier §10.3 + §10.7 + §23). All workspace-scoped behind
// the same RLS the lease DAOs use.
// ============================================================================

export type SandboxKind = (typeof schema.sandboxKindValues)[number];
export type EnrollmentExposure = (typeof schema.enrollmentExposureValues)[number];
export type EnrollmentStatus = (typeof schema.enrollmentStatusValues)[number];
export type EnrollmentOs = (typeof schema.enrollmentOsValues)[number];

export type EnrollmentRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  pubkey: string;
  exposure: EnrollmentExposure;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  status: EnrollmentStatus;
  os: EnrollmentOs;
  arch: string;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  updatedAt: string;
};

function mapEnrollment(row: typeof schema.enrollments.$inferSelect): EnrollmentRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    pubkey: row.pubkey,
    exposure: row.exposure as EnrollmentExposure,
    hasDisplay: row.hasDisplay,
    allowScreenControl: row.allowScreenControl,
    status: row.status as EnrollmentStatus,
    os: row.os as EnrollmentOs,
    arch: row.arch,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type SandboxRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  kind: SandboxKind;
  name: string;
  enrollmentId: string | null;
  createdAt: string;
  updatedAt: string;
};

function mapSandbox(row: typeof schema.sandboxes.$inferSelect): SandboxRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    kind: row.kind as SandboxKind,
    name: row.name,
    enrollmentId: row.enrollmentId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---- enrollments ----------------------------------------------------------

// Register (or idempotently re-register) a machine. A re-enroll of the SAME
// (workspace, pubkey) is an UPSERT — it refreshes the consent/OS fields and, if
// the machine was previously revoked, re-activates it (status->active, revoked_at
// cleared) — never a duplicate machine row. The agent's ed25519 pubkey is the
// machine identity; the unique (workspace, pubkey) index is the conflict target.
export async function createEnrollment(db: Database, input: {
  accountId: string;
  workspaceId: string;
  pubkey: string;
  exposure?: EnrollmentExposure;
  hasDisplay?: boolean;
  allowScreenControl?: boolean;
  os?: EnrollmentOs;
  arch?: string;
}): Promise<EnrollmentRecord> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.enrollments).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      pubkey: input.pubkey,
      exposure: input.exposure ?? "whole-machine",
      hasDisplay: input.hasDisplay ?? false,
      allowScreenControl: input.allowScreenControl ?? false,
      os: input.os ?? "linux",
      arch: input.arch ?? "x86_64",
      status: "active",
    }).onConflictDoUpdate({
      target: [schema.enrollments.workspaceId, schema.enrollments.pubkey],
      set: {
        exposure: input.exposure ?? "whole-machine",
        hasDisplay: input.hasDisplay ?? false,
        allowScreenControl: input.allowScreenControl ?? false,
        os: input.os ?? "linux",
        arch: input.arch ?? "x86_64",
        // A re-enroll re-activates a previously revoked machine.
        status: "active",
        revokedAt: null,
        updatedAt: new Date(),
      },
    }).returning();
    if (!row) {
      throw new Error("Failed to create enrollment");
    }
    return mapEnrollment(row);
  });
}

export async function getEnrollment(db: Database, workspaceId: string, enrollmentId: string): Promise<EnrollmentRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.enrollments)
      .where(and(eq(schema.enrollments.workspaceId, workspaceId), eq(schema.enrollments.id, enrollmentId)))
      .limit(1);
    return row ? mapEnrollment(row) : null;
  });
}

// List a workspace's enrollments, newest first. `status` filters the lifecycle
// (omit for all; 'active' for the Machines dashboard's live list).
export async function listEnrollments(db: Database, workspaceId: string, options: { status?: EnrollmentStatus } = {}): Promise<EnrollmentRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const where = options.status
      ? and(eq(schema.enrollments.workspaceId, workspaceId), eq(schema.enrollments.status, options.status))
      : eq(schema.enrollments.workspaceId, workspaceId);
    const rows = await scopedDb.select().from(schema.enrollments)
      .where(where)
      .orderBy(desc(schema.enrollments.createdAt));
    return rows.map(mapEnrollment);
  });
}

// Revoke a machine (uninstall --purge / dashboard revoke). Idempotent: an already
// -revoked row is a no-op (revoked:false). status->revoked, revoked_at stamped.
export async function revokeEnrollment(db: Database, input: {
  accountId: string; workspaceId: string; enrollmentId: string;
}): Promise<{ revoked: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const rows = await scopedDb.update(schema.enrollments)
      .set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.enrollments.workspaceId, input.workspaceId),
        eq(schema.enrollments.id, input.enrollmentId),
        eq(schema.enrollments.status, "active"),
      ))
      .returning({ id: schema.enrollments.id });
    return { revoked: rows.length > 0 };
  });
}

// Heartbeat liveness cursor: the agent reports it is alive. last_seen_at is read
// by the online/reconnecting/offline derivation in the Machines surface.
export async function touchEnrollmentLastSeen(db: Database, input: {
  accountId: string; workspaceId: string; enrollmentId: string;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    await scopedDb.update(schema.enrollments)
      .set({ lastSeenAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.enrollments.workspaceId, input.workspaceId),
        eq(schema.enrollments.id, input.enrollmentId),
      ));
  });
}

// ---- device-flow enrollment requests (M5, migration 0025) -----------------
//
// The OAuth 2.0 device-authorization (RFC 8628) PENDING request: one short-TTL,
// single-use row per in-flight enrollment. The agent starts a flow (gets a
// device_code + user_code), the user approves it (LOUD consent capture +
// createEnrollment + createSandbox), and the agent polls the device_code for the
// resulting EnrollmentCredentials. Dossier §10.2 + §18.

export type DeviceEnrollmentStatus = (typeof schema.deviceEnrollmentStatusValues)[number];

export type DeviceEnrollmentRequestRecord = {
  id: string;
  deviceCode: string;
  userCode: string;
  accountId: string;
  workspaceId: string;
  pubkey: string;
  os: EnrollmentOs;
  arch: string;
  machineName: string | null;
  requestedExposure: EnrollmentExposure;
  canOfferDisplay: boolean;
  requestsScreenControl: boolean;
  status: DeviceEnrollmentStatus;
  approvedBySubjectId: string | null;
  approvedBySubjectLabel: string | null;
  allowScreenControl: boolean;
  approvedAt: string | null;
  enrollmentId: string | null;
  sandboxId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

function mapDeviceEnrollmentRequest(row: typeof schema.deviceEnrollmentRequests.$inferSelect): DeviceEnrollmentRequestRecord {
  return {
    id: row.id,
    deviceCode: row.deviceCode,
    userCode: row.userCode,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    pubkey: row.pubkey,
    os: row.os as EnrollmentOs,
    arch: row.arch,
    machineName: row.machineName ?? null,
    requestedExposure: row.requestedExposure as EnrollmentExposure,
    canOfferDisplay: row.canOfferDisplay,
    requestsScreenControl: row.requestsScreenControl,
    status: row.status as DeviceEnrollmentStatus,
    approvedBySubjectId: row.approvedBySubjectId ?? null,
    approvedBySubjectLabel: row.approvedBySubjectLabel ?? null,
    allowScreenControl: row.allowScreenControl,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    enrollmentId: row.enrollmentId ?? null,
    sandboxId: row.sandboxId ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Persist a fresh PENDING device-auth request (the agent's POST /start). The
// caller supplies the unguessable device_code + user_code (minted with a CSPRNG)
// and the short TTL. RLS-scoped to the workspace the flow binds to.
export async function createDeviceEnrollmentRequest(db: Database, input: {
  accountId: string;
  workspaceId: string;
  deviceCode: string;
  userCode: string;
  pubkey: string;
  os?: EnrollmentOs;
  arch?: string;
  machineName?: string | null;
  requestedExposure?: EnrollmentExposure;
  canOfferDisplay?: boolean;
  requestsScreenControl?: boolean;
  expiresAt: Date;
}): Promise<DeviceEnrollmentRequestRecord> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.deviceEnrollmentRequests).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      deviceCode: input.deviceCode,
      userCode: input.userCode,
      pubkey: input.pubkey,
      os: input.os ?? "linux",
      arch: input.arch ?? "x86_64",
      machineName: input.machineName ?? null,
      requestedExposure: input.requestedExposure ?? "whole-machine",
      canOfferDisplay: input.canOfferDisplay ?? false,
      requestsScreenControl: input.requestsScreenControl ?? false,
      status: "pending",
      expiresAt: input.expiresAt,
    }).returning();
    if (!row) {
      throw new Error("Failed to create device enrollment request");
    }
    return mapDeviceEnrollmentRequest(row);
  });
}

// Look up a request by its opaque device_code (the agent's poll key). The
// device_code IS the capability (unguessable + unique) and the agent has NO
// workspace context yet, so resolve (account_id, workspace_id) via the SECURITY
// DEFINER resolver (mirrors the global reaper's cross-workspace read), then re-read
// the FULL row under that workspace's RLS scope. Returns null when unknown.
export async function getDeviceEnrollmentRequestByDeviceCode(db: Database, deviceCode: string): Promise<DeviceEnrollmentRequestRecord | null> {
  const resolved = await db.execute<{ account_id: string; workspace_id: string }>(sql`
    select account_id, workspace_id from opengeni_private.resolve_device_enrollment_request(${deviceCode})
  `);
  const ctx = resolved[0];
  if (!ctx) {
    return null;
  }
  return await withRlsContext(db, { accountId: ctx.account_id, workspaceId: ctx.workspace_id }, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.deviceEnrollmentRequests)
      .where(eq(schema.deviceEnrollmentRequests.deviceCode, deviceCode))
      .limit(1);
    return row ? mapDeviceEnrollmentRequest(row) : null;
  });
}

// Look up the PENDING request for a user_code within a workspace (the approve
// lookup). Workspace-scoped: a user can only approve a request bound to a
// workspace they hold a grant in. Returns null when no LIVE pending row matches.
export async function getPendingDeviceEnrollmentRequestByUserCode(db: Database, workspaceId: string, userCode: string): Promise<DeviceEnrollmentRequestRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.deviceEnrollmentRequests)
      .where(and(
        eq(schema.deviceEnrollmentRequests.workspaceId, workspaceId),
        eq(schema.deviceEnrollmentRequests.userCode, userCode),
        eq(schema.deviceEnrollmentRequests.status, "pending"),
      ))
      .limit(1);
    return row ? mapDeviceEnrollmentRequest(row) : null;
  });
}

// Look up the PENDING request for a user_code GLOBALLY (no workspace context) —
// the click-Grant approve page lookup (design 11 §B.1). The user_code is globally
// unique among LIVE (pending) rows, so — exactly like getDeviceEnrollmentRequestByDeviceCode
// resolves a device_code — this resolves (account_id, workspace_id) via the 0026
// SECURITY DEFINER resolver, then re-reads the FULL pending row under that
// workspace's RLS scope. The ROUTE then re-checks the caller holds a grant in the
// resolved workspace before returning anything. Returns null when no live pending
// row matches (an unknown / terminal / expired code).
export async function getPendingDeviceEnrollmentRequestByUserCodeGlobal(db: Database, userCode: string): Promise<DeviceEnrollmentRequestRecord | null> {
  const resolved = await db.execute<{ account_id: string; workspace_id: string }>(sql`
    select account_id, workspace_id from opengeni_private.resolve_pending_device_enrollment_by_user_code(${userCode})
  `);
  const ctx = resolved[0];
  if (!ctx) {
    return null;
  }
  return await withRlsContext(db, { accountId: ctx.account_id, workspaceId: ctx.workspace_id }, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.deviceEnrollmentRequests)
      .where(and(
        eq(schema.deviceEnrollmentRequests.userCode, userCode),
        eq(schema.deviceEnrollmentRequests.status, "pending"),
      ))
      .limit(1);
    return row ? mapDeviceEnrollmentRequest(row) : null;
  });
}

// The SHARED finalize core (design 11 §A2.3 "reuse, don't fork"): "upsert the
// enrollment (idempotent on (workspace_id, pubkey)) + ensure a kind='selfhosted'
// sandbox row" — the exact end state BOTH the device approve and the headless
// token exchange must produce. Takes an ALREADY-RLS-SCOPED `scopedDb` so the
// caller controls the transaction boundary:
//   * approveDeviceEnrollmentRequest calls it INSIDE its FOR-UPDATE txn (so the
//     re-read fence + the request stamp stay in ONE txn — semantics unchanged), and
//   * finalizeEnrollmentByToken calls it inside its OWN txn (no pending row exists
//     for a stateless token).
// Idempotent: a re-run for the same (workspace, pubkey) re-activates the existing
// enrollment (M2 upsert) and REUSES its selfhosted sandbox — never a duplicate.
async function finalizeEnrollmentInScope(scopedDb: Database, input: {
  accountId: string;
  workspaceId: string;
  pubkey: string;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  os: EnrollmentOs;
  arch: string;
  sandboxName: string;
  now: Date;
}): Promise<{ enrollment: EnrollmentRecord; sandbox: SandboxRecord }> {
  // createEnrollment (idempotent upsert) — whole-machine is mandatory; display +
  // screen-control come from the agent's offer + the consenting decision. We inline
  // the insert here (rather than calling createEnrollment, which opens its OWN
  // scope) so it shares the caller's transaction.
  const [enrollmentRow] = await scopedDb.insert(schema.enrollments).values({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    pubkey: input.pubkey,
    exposure: "whole-machine",
    hasDisplay: input.hasDisplay,
    allowScreenControl: input.allowScreenControl,
    os: input.os,
    arch: input.arch,
    status: "active",
  }).onConflictDoUpdate({
    target: [schema.enrollments.workspaceId, schema.enrollments.pubkey],
    set: {
      exposure: "whole-machine",
      hasDisplay: input.hasDisplay,
      allowScreenControl: input.allowScreenControl,
      os: input.os,
      arch: input.arch,
      status: "active",
      revokedAt: null,
      updatedAt: input.now,
    },
  }).returning();
  if (!enrollmentRow) {
    throw new Error("Failed to create enrollment during finalize");
  }
  const enrollment = mapEnrollment(enrollmentRow);

  // Ensure a selfhosted sandbox for this enrollment. A re-finalize of the SAME
  // machine reuses the existing sandbox rather than creating a duplicate.
  const [existingSandbox] = await scopedDb.select().from(schema.sandboxes)
    .where(and(
      eq(schema.sandboxes.workspaceId, input.workspaceId),
      eq(schema.sandboxes.enrollmentId, enrollment.id),
    ))
    .limit(1);
  let sandbox: SandboxRecord;
  if (existingSandbox) {
    sandbox = mapSandbox(existingSandbox);
  } else {
    const [sandboxRow] = await scopedDb.insert(schema.sandboxes).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      kind: "selfhosted",
      name: input.sandboxName,
      enrollmentId: enrollment.id,
    }).returning();
    if (!sandboxRow) {
      throw new Error("Failed to create sandbox during finalize");
    }
    sandbox = mapSandbox(sandboxRow);
  }
  return { enrollment, sandbox };
}

// FINALIZE a headless enroll-token exchange (design 11 §A2.3). Produces the SAME
// end state as approveDeviceEnrollmentRequest — an enrollments row + a selfhosted
// sandbox row — but WITHOUT a pending device-flow request (a stateless `oget_`
// token carries the grant). Idempotent via the shared finalize core's upsert.
export async function finalizeEnrollmentByToken(db: Database, input: {
  accountId: string;
  workspaceId: string;
  pubkey: string;
  hasDisplay: boolean;
  allowScreenControl: boolean;
  os: EnrollmentOs;
  arch: string;
  sandboxName: string;
  now?: Date;
}): Promise<{ enrollment: EnrollmentRecord; sandbox: SandboxRecord }> {
  const now = input.now ?? new Date();
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    return await finalizeEnrollmentInScope(scopedDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      pubkey: input.pubkey,
      hasDisplay: input.hasDisplay,
      allowScreenControl: input.allowScreenControl,
      os: input.os,
      arch: input.arch,
      sandboxName: input.sandboxName,
      now,
    });
  });
}

// THE LOUD-CONSENT APPROVE (the user's POST /approve). In ONE transaction:
//   1. re-read the pending row FOR UPDATE (fence against a double-approve / a
//      concurrent expiry),
//   2. createEnrollment (idempotent upsert: pubkey, whole-machine exposure,
//      has_display from can_offer_display, allow_screen_control per the user's
//      decision, os/arch) → an enrollments row,
//   3. createSandbox (kind selfhosted, enrollment_id, a generated name) → a
//      sandboxes row (acceptance #2),
//   4. stamp the request approved + the consent record (WHO approved WHEN to WHAT)
//      + the resulting enrollment_id / sandbox_id.
// IDEMPOTENT: a re-approve of an ALREADY-approved row (same user_code re-submitted)
// re-runs the enrollment upsert (M2 reactivate semantics) and returns the existing
// enrollment/sandbox — never a duplicate. An expired / denied / consumed row is a
// no-op (approved:false). Returns the enrollment + sandbox so the route echoes them.
export async function approveDeviceEnrollmentRequest(db: Database, input: {
  accountId: string;
  workspaceId: string;
  requestId: string;
  allowScreenControl: boolean;
  approvedBySubjectId: string;
  approvedBySubjectLabel?: string | null;
  // A name for the generated sandbox (machine name or a fallback).
  sandboxName: string;
  now?: Date;
}): Promise<{ approved: boolean; enrollment: EnrollmentRecord | null; sandbox: SandboxRecord | null }> {
  const now = input.now ?? new Date();
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    // Re-read FOR UPDATE under the txn so a concurrent approve / expiry can't race.
    const [pending] = await scopedDb.select().from(schema.deviceEnrollmentRequests)
      .where(and(
        eq(schema.deviceEnrollmentRequests.workspaceId, input.workspaceId),
        eq(schema.deviceEnrollmentRequests.id, input.requestId),
      ))
      .for("update")
      .limit(1);
    if (!pending) {
      return { approved: false, enrollment: null, sandbox: null };
    }
    // Already terminally approved → idempotent return of the existing rows (re-run
    // the consent fields in case allow_screen_control changed on re-approve).
    const expired = pending.expiresAt.getTime() <= now.getTime();
    if (pending.status === "denied" || pending.status === "consumed") {
      return { approved: false, enrollment: null, sandbox: null };
    }
    if (pending.status === "pending" && expired) {
      return { approved: false, enrollment: null, sandbox: null };
    }

    // The SHARED finalize core: upsert the enrollment (idempotent) + ensure a
    // selfhosted sandbox. RLS is already set on scopedDb's session and this call
    // runs INSIDE this FOR-UPDATE txn, so the re-read fence + the stamp below + the
    // enrollment/sandbox writes all commit atomically (semantics unchanged from the
    // pre-refactor inline block — acceptance #2 stays one machine). The headless
    // token exchange (finalizeEnrollmentByToken) calls the SAME core.
    const { enrollment, sandbox } = await finalizeEnrollmentInScope(scopedDb, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      pubkey: pending.pubkey,
      hasDisplay: pending.canOfferDisplay,
      allowScreenControl: input.allowScreenControl,
      os: pending.os as EnrollmentOs,
      arch: pending.arch,
      sandboxName: input.sandboxName,
      now,
    });

    // Stamp the request approved + the LOUD CONSENT record (who/when/what).
    await scopedDb.update(schema.deviceEnrollmentRequests)
      .set({
        status: "approved",
        allowScreenControl: input.allowScreenControl,
        approvedBySubjectId: input.approvedBySubjectId,
        approvedBySubjectLabel: input.approvedBySubjectLabel ?? null,
        approvedAt: now,
        enrollmentId: enrollment.id,
        sandboxId: sandbox.id,
        updatedAt: now,
      })
      .where(eq(schema.deviceEnrollmentRequests.id, pending.id));

    return { approved: true, enrollment, sandbox };
  });
}

// Mark a pending request DENIED (an explicit user "no" at the approve page).
// Idempotent: a non-pending row is a no-op (denied:false).
export async function denyDeviceEnrollmentRequest(db: Database, input: {
  accountId: string; workspaceId: string; requestId: string;
}): Promise<{ denied: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const rows = await scopedDb.update(schema.deviceEnrollmentRequests)
      .set({ status: "denied", updatedAt: new Date() })
      .where(and(
        eq(schema.deviceEnrollmentRequests.workspaceId, input.workspaceId),
        eq(schema.deviceEnrollmentRequests.id, input.requestId),
        eq(schema.deviceEnrollmentRequests.status, "pending"),
      ))
      .returning({ id: schema.deviceEnrollmentRequests.id });
    return { denied: rows.length > 0 };
  });
}

// Flip an APPROVED request to CONSUMED once the agent has polled its credentials
// (single-use). Fenced on status='approved' so a double-poll consumes exactly once;
// a second poll then re-reads the consumed row and still returns credentials (the
// agent may legitimately retry the same poll) — the route decides. Returns whether
// THIS call performed the consume transition.
export async function consumeDeviceEnrollmentRequest(db: Database, input: {
  accountId: string; workspaceId: string; requestId: string;
}): Promise<{ consumed: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const rows = await scopedDb.update(schema.deviceEnrollmentRequests)
      .set({ status: "consumed", updatedAt: new Date() })
      .where(and(
        eq(schema.deviceEnrollmentRequests.workspaceId, input.workspaceId),
        eq(schema.deviceEnrollmentRequests.id, input.requestId),
        eq(schema.deviceEnrollmentRequests.status, "approved"),
      ))
      .returning({ id: schema.deviceEnrollmentRequests.id });
    return { consumed: rows.length > 0 };
  });
}

// ---- sandboxes ------------------------------------------------------------

// Create a first-class named sandbox (the pointer target a session swaps to). The
// DB CHECK pins selfhosted<->enrollment_id: a selfhosted sandbox MUST carry an
// enrollment; a modal sandbox MUST NOT. We surface that as a typed pre-check so
// the caller gets a clear error rather than a raw constraint violation.
export async function createSandbox(db: Database, input: {
  accountId: string;
  workspaceId: string;
  kind: SandboxKind;
  name: string;
  enrollmentId?: string | null;
}): Promise<SandboxRecord> {
  const enrollmentId = input.enrollmentId ?? null;
  if (input.kind === "selfhosted" && !enrollmentId) {
    throw new Error("A selfhosted sandbox requires an enrollmentId.");
  }
  if (input.kind !== "selfhosted" && enrollmentId) {
    throw new Error(`A ${input.kind} sandbox must not carry an enrollmentId.`);
  }
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.sandboxes).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name,
      enrollmentId,
    }).returning();
    if (!row) {
      throw new Error("Failed to create sandbox");
    }
    return mapSandbox(row);
  });
}

export async function getSandbox(db: Database, workspaceId: string, sandboxId: string): Promise<SandboxRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sandboxes)
      .where(and(eq(schema.sandboxes.workspaceId, workspaceId), eq(schema.sandboxes.id, sandboxId)))
      .limit(1);
    return row ? mapSandbox(row) : null;
  });
}

// List a workspace's sandboxes, newest first (the sandboxes_list tool surface).
export async function listSandboxes(db: Database, workspaceId: string): Promise<SandboxRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.sandboxes)
      .where(eq(schema.sandboxes.workspaceId, workspaceId))
      .orderBy(desc(schema.sandboxes.createdAt));
    return rows.map(mapSandbox);
  });
}

// ---- the per-session active-sandbox pointer (epoch-fenced swap) -----------

export type ActiveSandboxPointer = {
  activeSandboxId: string | null;
  activeEpoch: number;
};

// Read the session's current pointer (the routing proxy re-reads this PER TOOL
// CALL). NULL active_sandbox_id == "use the session's own group sandbox".
export async function readActiveSandbox(db: Database, workspaceId: string, sessionId: string): Promise<ActiveSandboxPointer | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select({
      activeSandboxId: schema.sessions.activeSandboxId,
      activeEpoch: schema.sessions.activeEpoch,
    }).from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .limit(1);
    if (!row) {
      return null;
    }
    return { activeSandboxId: row.activeSandboxId ?? null, activeEpoch: Number(row.activeEpoch) };
  });
}

// THE SWAP. Repoint a session at `targetSandboxId` (NULL == back to the group
// sandbox) and BUMP active_epoch under a fence: the write is gated on the
// session's current active_epoch == expectedEpoch, so a concurrent double-swap
// (two callers both reading epoch N) lets exactly ONE win — the loser sees
// swapped:false and re-reads. The bumped epoch fences any in-flight op cached
// against the old pointer, which then retries against the new active sandbox.
// integer epoch returns a JS number; Number()-coerced defensively (lease lesson).
export async function setActiveSandbox(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  targetSandboxId: string | null;
  expectedEpoch: number;
}): Promise<{ swapped: boolean; pointer: ActiveSandboxPointer | null }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const rows = await scopedDb.execute<{ active_sandbox_id: string | null; active_epoch: number | string }>(sql`
      update sessions set
        active_sandbox_id = ${input.targetSandboxId},
        active_epoch      = active_epoch + 1,
        updated_at        = now()
      where workspace_id = ${input.workspaceId} and id = ${input.sessionId}
        and active_epoch = ${input.expectedEpoch}
      returning active_sandbox_id, active_epoch
    `);
    const row = rows[0];
    if (!row) {
      return { swapped: false, pointer: null };
    }
    return {
      swapped: true,
      pointer: { activeSandboxId: row.active_sandbox_id ?? null, activeEpoch: Number(row.active_epoch) },
    };
  });
}

// ---- per-machine metrics (§10.7) ------------------------------------------

// The sampled signal set the agent piggybacks on the heartbeat. Every field is
// optional (a platform/sample may not provide it — no GPU, headless, etc.).
export type MachineMetricsSample = {
  cpuPercent?: number | null;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  memUsedBytes?: number | null;
  memTotalBytes?: number | null;
  diskUsedBytes?: number | null;
  diskTotalBytes?: number | null;
  gpuUtilPercent?: number | null;
  gpuMemUsedBytes?: number | null;
  gpuMemTotalBytes?: number | null;
  contention?: number | null;
  sampledAt: Date;
};

function metricColumns(sample: MachineMetricsSample) {
  return {
    cpuPercent: sample.cpuPercent ?? null,
    load1: sample.load1 ?? null,
    load5: sample.load5 ?? null,
    load15: sample.load15 ?? null,
    memUsedBytes: sample.memUsedBytes ?? null,
    memTotalBytes: sample.memTotalBytes ?? null,
    diskUsedBytes: sample.diskUsedBytes ?? null,
    diskTotalBytes: sample.diskTotalBytes ?? null,
    gpuUtilPercent: sample.gpuUtilPercent ?? null,
    gpuMemUsedBytes: sample.gpuMemUsedBytes ?? null,
    gpuMemTotalBytes: sample.gpuMemTotalBytes ?? null,
    contention: sample.contention ?? null,
    sampledAt: sample.sampledAt,
  };
}

// Last-sample UPSERT: one row per enrollment, overwritten every sample (PK on
// enrollment_id is the conflict target). The Machines dashboard's "now" read.
export async function upsertMachineMetricsLatest(db: Database, input: {
  accountId: string; workspaceId: string; enrollmentId: string; sample: MachineMetricsSample;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const cols = metricColumns(input.sample);
    await scopedDb.insert(schema.machineMetricsLatest).values({
      enrollmentId: input.enrollmentId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      ...cols,
    }).onConflictDoUpdate({
      target: schema.machineMetricsLatest.enrollmentId,
      set: { ...cols, updatedAt: new Date() },
    });
  });
}

// Append a downsampled (~1/min) series row (the history the dashboard time-range
// reads + the later retention sweep prune).
export async function insertMachineMetricsSeries(db: Database, input: {
  accountId: string; workspaceId: string; enrollmentId: string; sample: MachineMetricsSample;
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    await scopedDb.insert(schema.machineMetricsSeries).values({
      enrollmentId: input.enrollmentId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      ...metricColumns(input.sample),
    });
  });
}

// The target spacing between series rows: the agent heartbeats ~every 5s, but we
// downsample the long-term history to ~1/min (dossier §10.7). A new series row is
// appended only when >= this much time has elapsed since the last one.
export const MACHINE_METRICS_SERIES_INTERVAL_MS = 60_000;

/**
 * Ingest ONE sampled metrics point for an enrollment (the M10 ingestion seam):
 *   1. UPSERT machine_metrics_latest (the "now" row, one per enrollment) — always.
 *   2. APPEND a machine_metrics_series row only when >= ~1/min has elapsed since
 *      the last series row (downsample) — so the 5s heartbeat cadence does not
 *      flood the history table.
 * Both happen under the same RLS context. Returns whether a series row was
 * appended (the downsample decision) so the caller / tests can assert the ~1/min
 * spacing. A null/absent `sampledAt` on the prior row treats it as "no prior" →
 * append.
 */
export async function ingestMachineMetricsSample(db: Database, input: {
  accountId: string; workspaceId: string; enrollmentId: string; sample: MachineMetricsSample;
  /** Override the downsample interval (tests). Defaults to ~1/min. */
  seriesIntervalMs?: number;
}): Promise<{ latestUpserted: true; seriesAppended: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const cols = metricColumns(input.sample);
    // 1. Latest upsert — always.
    await scopedDb.insert(schema.machineMetricsLatest).values({
      enrollmentId: input.enrollmentId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      ...cols,
    }).onConflictDoUpdate({
      target: schema.machineMetricsLatest.enrollmentId,
      set: { ...cols, updatedAt: new Date() },
    });

    // 2. Series append — downsampled. Read the most recent series sampled_at and
    // only append when the new sample is >= the interval newer (or there is no
    // prior row). Done in-context so RLS scopes the read to this workspace.
    const intervalMs = input.seriesIntervalMs ?? MACHINE_METRICS_SERIES_INTERVAL_MS;
    const [prior] = await scopedDb.select({ sampledAt: schema.machineMetricsSeries.sampledAt })
      .from(schema.machineMetricsSeries)
      .where(eq(schema.machineMetricsSeries.enrollmentId, input.enrollmentId))
      .orderBy(desc(schema.machineMetricsSeries.sampledAt))
      .limit(1);
    const priorMs = prior?.sampledAt ? prior.sampledAt.getTime() : null;
    const sampleMs = input.sample.sampledAt.getTime();
    const seriesAppended = priorMs === null || sampleMs - priorMs >= intervalMs;
    if (seriesAppended) {
      await scopedDb.insert(schema.machineMetricsSeries).values({
        enrollmentId: input.enrollmentId,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        ...cols,
      });
    }
    return { latestUpserted: true, seriesAppended };
  });
}

// The mapped read shape of a stored metrics sample (latest or a series point).
// numeric columns come back as strings from postgres-js; map them to numbers (or
// null when never reported). The byte columns are bigint(mode:"number").
export type MachineMetricsRow = {
  enrollmentId: string;
  cpuPercent: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  gpuUtilPercent: number | null;
  gpuMemUsedBytes: number | null;
  gpuMemTotalBytes: number | null;
  contention: number | null;
  sampledAt: string;
};

function numericOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapMetricsRow(row: {
  enrollmentId: string;
  cpuPercent: number | string | null;
  load1: number | string | null;
  load5: number | string | null;
  load15: number | string | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  gpuUtilPercent: number | string | null;
  gpuMemUsedBytes: number | null;
  gpuMemTotalBytes: number | null;
  contention: number | string | null;
  sampledAt: Date;
}): MachineMetricsRow {
  return {
    enrollmentId: row.enrollmentId,
    cpuPercent: numericOrNull(row.cpuPercent),
    load1: numericOrNull(row.load1),
    load5: numericOrNull(row.load5),
    load15: numericOrNull(row.load15),
    memUsedBytes: row.memUsedBytes ?? null,
    memTotalBytes: row.memTotalBytes ?? null,
    diskUsedBytes: row.diskUsedBytes ?? null,
    diskTotalBytes: row.diskTotalBytes ?? null,
    gpuUtilPercent: numericOrNull(row.gpuUtilPercent),
    gpuMemUsedBytes: row.gpuMemUsedBytes ?? null,
    gpuMemTotalBytes: row.gpuMemTotalBytes ?? null,
    contention: numericOrNull(row.contention),
    sampledAt: row.sampledAt.toISOString(),
  };
}

// Read the latest sample for ONE enrollment (the dashboard "now" read), or null
// when none has landed (never seen / offline before a first heartbeat).
export async function readMachineMetricsLatest(db: Database, workspaceId: string, enrollmentId: string): Promise<MachineMetricsRow | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.machineMetricsLatest)
      .where(and(
        eq(schema.machineMetricsLatest.workspaceId, workspaceId),
        eq(schema.machineMetricsLatest.enrollmentId, enrollmentId),
      ))
      .limit(1);
    return row ? mapMetricsRow(row) : null;
  });
}

// Read the latest sample for EVERY enrollment in a workspace, keyed by
// enrollmentId — the Machines list joins this onto the fleet entries with ONE
// query rather than N per-machine reads.
export async function readMachineMetricsLatestForWorkspace(db: Database, workspaceId: string): Promise<Map<string, MachineMetricsRow>> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.machineMetricsLatest)
      .where(eq(schema.machineMetricsLatest.workspaceId, workspaceId));
    const byEnrollment = new Map<string, MachineMetricsRow>();
    for (const row of rows) {
      byEnrollment.set(row.enrollmentId, mapMetricsRow(row));
    }
    return byEnrollment;
  });
}

// Read the downsampled series for ONE enrollment over a time window (the
// dashboard time-range read). `sinceMs` bounds the window (e.g. now - 1h);
// ordered oldest-first for a left-to-right chart. `limit` caps the row count
// (defensive against an unbounded window).
export async function readMachineMetricsSeries(db: Database, input: {
  workspaceId: string; enrollmentId: string; since: Date; limit?: number;
}): Promise<MachineMetricsRow[]> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.machineMetricsSeries)
      .where(and(
        eq(schema.machineMetricsSeries.workspaceId, input.workspaceId),
        eq(schema.machineMetricsSeries.enrollmentId, input.enrollmentId),
        gte(schema.machineMetricsSeries.sampledAt, input.since),
      ))
      .orderBy(asc(schema.machineMetricsSeries.sampledAt))
      .limit(input.limit ?? 5_000);
    return rows.map(mapMetricsRow);
  });
}

// ============================================================================
// P3.2 — the un-redacted-pixel consent gate + viewer revocation.
//
// The desktop-stream path is gated behind an explicit acknowledgment that the
// pixel plane is un-redacted (it can show cloud creds the agent cat's into a
// terminal — strictly broader than the redacted Channel-A event log). For a
// SHARED box (the group has >1 session) the principal must additionally consent
// to the shared-exposure disclosure: watching A's desktop also shows B's agent
// on the one :0 framebuffer (addendum E.1 / stress g). Consent is per-PRINCIPAL
// and per-GROUP (one :0 per group), recorded in session_stream_acknowledgments
// (0019). Reuses the acknowledgment machinery — no new permission beyond
// stream:acknowledge.
// ============================================================================

export interface StreamAcknowledgment {
  acknowledgedUnredacted: boolean;
  acknowledgedShared: boolean;
}

// Record (or upsert) a principal's acknowledgment of the group's un-redacted
// pixel plane (and, when shared, the shared-exposure disclosure). Keyed on
// (workspace, group, subject); a re-ack (e.g. a solo→shared upgrade adding the
// shared consent) is ON CONFLICT DO UPDATE, never a duplicate row.
export async function recordStreamAcknowledgment(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  subjectId: string;
  acknowledgeUnredacted: boolean;
  acknowledgeShared: boolean;
}): Promise<StreamAcknowledgment> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const rows = await scopedDb.execute<{ acknowledged_unredacted: boolean; acknowledged_shared: boolean }>(sql`
        insert into session_stream_acknowledgments
          (account_id, workspace_id, sandbox_group_id, subject_id,
           acknowledged_unredacted, acknowledged_shared, acknowledged_at, updated_at)
        values
          (${input.accountId}, ${input.workspaceId}, ${input.sandboxGroupId}, ${input.subjectId},
           ${input.acknowledgeUnredacted}, ${input.acknowledgeShared}, now(), now())
        on conflict (workspace_id, sandbox_group_id, subject_id) do update set
          -- Acknowledgment is monotonic: a later ack can ADD the shared consent
          -- but never silently withdraw a prior one (OR the bits in).
          acknowledged_unredacted = session_stream_acknowledgments.acknowledged_unredacted or excluded.acknowledged_unredacted,
          acknowledged_shared     = session_stream_acknowledgments.acknowledged_shared     or excluded.acknowledged_shared,
          acknowledged_at         = now(),
          updated_at              = now()
        returning acknowledged_unredacted, acknowledged_shared
      `);
      const row = rows[0]!;
      return { acknowledgedUnredacted: row.acknowledged_unredacted, acknowledgedShared: row.acknowledged_shared };
    });
}

// Read a principal's recorded acknowledgment for a group, or null if they have
// never acknowledged the un-redacted pixel plane. The negotiation read + the
// desktop-stream gate both consult this.
export async function getStreamAcknowledgment(db: Database, input: {
  workspaceId: string;
  sandboxGroupId: string;
  subjectId: string;
}): Promise<StreamAcknowledgment | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<{ acknowledged_unredacted: boolean; acknowledged_shared: boolean }>(sql`
      select acknowledged_unredacted, acknowledged_shared
      from session_stream_acknowledgments
      where workspace_id = ${input.workspaceId}
        and sandbox_group_id = ${input.sandboxGroupId}
        and subject_id = ${input.subjectId}
      limit 1
    `);
    if (!rows[0]) return null;
    return { acknowledgedUnredacted: rows[0].acknowledged_unredacted, acknowledgedShared: rows[0].acknowledged_shared };
  });
}

// Enumerate the session ids in a group (workspace-scoped). The shared-exposure
// disclosure surfaces the OTHER sessions' ids ONLY — never their goal/metadata/
// conversation. The query selects ONLY the id column (id is the disclosure
// boundary; stress g). RLS-scoped: a foreign-workspace group returns no rows.
export async function listSessionIdsInGroup(db: Database, workspaceId: string, sandboxGroupId: string): Promise<string[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute<{ id: string }>(sql`
      select id from sessions
      where workspace_id = ${workspaceId} and sandbox_group_id = ${sandboxGroupId}
      order by created_at asc
    `);
    return rows.map((r) => r.id);
  });
}

// OD-6 v1 — revoke a viewer: DROP that viewer's holder from the GROUP lease so
// refcount recomputes (the box drains iff nothing else holds it — a turn-held or
// other-viewer-held box survives), AND block its reconnect by recording the
// revoked subject so a re-attach with the same viewerId is refused. The
// live-RFB force-disconnect of an already-open socket is a P4 follow-up; the
// holder-drop (so the box can drain) is here.
//
// Returns the post-drop lease liveness/refcount (null if the lease was already
// cold-and-reaped — a revoke is then an idempotent no-op). A revoked viewer who
// independently holds a holder on a SIBLING session may still watch via that
// session (correct — authorized there); this drops ONLY the named viewerId's
// holder.
export async function revokeViewer(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  viewerId: string;
  idleGraceMs: number;
}): Promise<{ liveness: SandboxLeaseLiveness; refcount: number } | null> {
  // The drop is exactly releaseLeaseHolder's idempotent delete-my-row +
  // recompute (refcount recomputes; warm→draining is guarded refcount=0 AND
  // turn_holders=0, so a turn-held box never drains on a viewer revoke). The
  // reconnect-block is a P4 concern (the holder-drop is the v1 deliverable —
  // the box can now drain); a re-attach mints a fresh viewerId regardless.
  return await releaseLeaseHolder(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sandboxGroupId: input.sandboxGroupId,
    kind: "viewer",
    holderId: input.viewerId,
    idleGraceMs: input.idleGraceMs,
  });
}

// ============================================================================
// Warm-time metering (P2.1) — the COST hole the lease design opens.
//
// A box held warm by a viewer with no agent turn running emits ZERO model usage
// today; the provider bills by wall-clock and OpenGeni meters nothing. Warm-time
// accrues on TWO stateless ticks: (a) the turn's existing activity heartbeat
// (while a turn runs); (b) the reaper sweep (for viewer-only boxes between turns).
//
// The meter is GROUP-KEYED + epoch-keyed + tick-keyed:
//   idempotencyKey = usage:sandbox.warm_seconds:<group>:<epoch>:<tick>
// so a SHARED box (N sessions on one group) is metered EXACTLY ONCE per tick
// (N sessions != N x bill — a session-keyed meter would N x-over-bill), and a
// re-dispatched/overlapping tick at the same (group,epoch,tick) can never
// double-charge (recordUsageEvent is onConflictDoNothing on idempotencyKey).
//
// Cursor advance + usage insert are ATOMIC: both run inside ONE FOR UPDATE txn on
// the lease row (the M3 cross-statement-atomicity fix). The insert uses ON
// CONFLICT DO NOTHING on idempotency_key (matching recordUsageEvent), and the
// cursor (last_meter_at/last_meter_tick) is advanced in the SAME txn — so the tick
// index and the metered seconds can never desync, and a partial-failure rollback
// leaves BOTH the cursor and the event untouched.
// ============================================================================

export interface AccrueWarmSecondsResult {
  /** false when nothing was accrued (epoch fenced / not warm / no elapsed / the
   *  first tick that only seeds the cursor). */
  accrued: boolean;
  /** Whole seconds metered this tick (0 when accrued:false). */
  seconds: number;
  /** The monotonic tick index this accrual was recorded under. */
  tick: number;
  /** usd_micros charged for this tick (0 when rate is 0). */
  costMicros: number;
}

/**
 * Accrue warm-seconds for the elapsed wall-clock since the lease's last meter
 * cursor, idempotent on (sandbox_group_id, lease_epoch, tick). EPOCH-FENCED +
 * liveness-guarded (warm only): a stale-epoch tick or a draining/cold lease is a
 * no-op, so a superseded writer that re-fires cannot mis-meter. The FIRST tick on
 * a never-metered lease (last_meter_at IS NULL) only SEEDS the cursor — it
 * accrues nothing (there is no prior cursor to diff against), matching the
 * "delta since last tick" contract. warmRateMicrosPerSecond > 0 also records a
 * sandbox.warm_cost event (cost = seconds x rate) AND debits the same micros from
 * the credit balance via applyCreditDebitUpToBalance (the model-cost precedent),
 * idempotent on the SAME (group, epoch, tick) key. The usage event is the
 * REQUESTED cost; the ledger is the ACTUAL debit (they legitimately differ when
 * balance is low — M2). Set debitCredits:false to meter without debiting.
 */
export async function accrueWarmSeconds(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sandboxGroupId: string;
  /** The epoch the tick observed; the fence — a stale writer no-ops. */
  expectedEpoch: number;
  /** usd_micros per warm-second for this box's backend (0 = meter only, no cost). */
  warmRateMicrosPerSecond: number;
  /** Optional attribution: the founding/observing session (visibility only — the
   *  group meter key makes the workspace charge correct regardless). */
  subjectId?: string | null;
  /** Debit credits for warm-cost (default true). The force-drain at 0 balance
   *  depends on this decrementing the balance. */
  debitCredits?: boolean;
}): Promise<AccrueWarmSecondsResult> {
  const none: AccrueWarmSecondsResult = { accrued: false, seconds: 0, tick: 0, costMicros: 0 };
  const result = await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => await scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      // Lock the group's lease row so the cursor advance + the usage insert are
      // one atomic step (no other tick can interleave between the diff and the
      // cursor write).
      const rows = await tx.execute<LeaseRow & { meter_elapsed_s: number | null }>(sql`
        select *,
          case when last_meter_at is null then null
               else floor(extract(epoch from (now() - last_meter_at)))::int end as meter_elapsed_s
        from sandbox_leases
        where workspace_id = ${input.workspaceId} and sandbox_group_id = ${input.sandboxGroupId}
        for update
      `);
      const row = rows[0];
      if (!row) return none;

      // Epoch fence + liveness guard: only a live-epoch warm box meters. A stale
      // (superseded) tick or a draining/cold/warming lease is a no-op.
      if (Number(row.lease_epoch) !== input.expectedEpoch || row.liveness !== "warm") {
        return none;
      }

      // First tick on a never-metered lease: SEED the cursor, accrue nothing.
      if (row.last_meter_at == null) {
        await tx.execute(sql`
          update sandbox_leases set last_meter_at = now(), updated_at = now()
          where id = ${row.id}
        `);
        return none;
      }

      const elapsedS = Number(row.meter_elapsed_s ?? 0);
      if (elapsedS <= 0) {
        // No whole second elapsed yet — leave the cursor untouched so the
        // remainder accrues on the next tick (no silent seconds loss).
        return none;
      }

      const tick = Number(row.last_meter_tick) + 1;
      const costMicros = Math.round(elapsedS * Math.max(0, input.warmRateMicrosPerSecond));

      // (1) The warm-seconds meter — GROUP+epoch+tick keyed, ON CONFLICT DO
      // NOTHING (the idempotency that makes a shared box one stream + a re-fire a
      // no-op). sourceResourceId is keyed on (group, epoch).
      await tx.execute(sql`
        insert into usage_events
          (account_id, workspace_id, subject_id, event_type, quantity, unit,
           source_resource_type, source_resource_id, idempotency_key, occurred_at)
        values
          (${input.accountId}, ${input.workspaceId}, ${input.subjectId ?? null},
           'sandbox.warm_seconds', ${elapsedS}, 'seconds',
           'sandbox_lease', ${`${input.sandboxGroupId}:${input.expectedEpoch}`},
           ${`usage:sandbox.warm_seconds:${input.sandboxGroupId}:${input.expectedEpoch}:${tick}`},
           now())
        on conflict (idempotency_key) do nothing
      `);

      // (2) The warm-cost meter (only when a rate is configured). Same keying.
      if (costMicros > 0) {
        await tx.execute(sql`
          insert into usage_events
            (account_id, workspace_id, subject_id, event_type, quantity, unit,
             source_resource_type, source_resource_id, idempotency_key, occurred_at)
          values
            (${input.accountId}, ${input.workspaceId}, ${input.subjectId ?? null},
             'sandbox.warm_cost', ${costMicros}, 'usd_micros',
             'sandbox_lease', ${`${input.sandboxGroupId}:${input.expectedEpoch}`},
             ${`usage:sandbox.warm_cost:${input.sandboxGroupId}:${input.expectedEpoch}:${tick}`},
             now())
          on conflict (idempotency_key) do nothing
        `);
      }

      // (3) Advance the cursor IN THE SAME TXN — the atomicity that makes the tick
      // index and the metered seconds inseparable.
      await tx.execute(sql`
        update sandbox_leases set
          last_meter_at = now(), last_meter_tick = ${tick}, updated_at = now()
        where id = ${row.id}
      `);

      return { accrued: true, seconds: elapsedS, tick, costMicros };
    }));

  // Debit credits for the warm-cost OUTSIDE the lease-row txn (applyCreditDebit
  // takes its own per-account advisory lock — never nest it under the lease row
  // lock). Idempotent on the SAME (group, epoch, tick) key so a re-fire of an
  // already-committed tick cannot double-debit. The ledger records the ACTUAL
  // debit (min(requested, balance)); the warm_cost usage event above is the
  // requested cost.
  if (result.accrued && result.costMicros > 0 && (input.debitCredits ?? true)) {
    await applyCreditDebitUpToBalance(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      type: "sandbox.warm_cost",
      requestedAmountMicros: result.costMicros,
      sourceType: "sandbox_lease",
      sourceId: `${input.sandboxGroupId}:${input.expectedEpoch}`,
      idempotencyKey: `debit:sandbox.warm_cost:${input.sandboxGroupId}:${input.expectedEpoch}:${result.tick}`,
    }).catch(() => undefined);
  }

  return result;
}

// §2.2/2.3 — the per-workspace warm-cap + force-drain. Under the EXISTING usage
// lock (withWorkspaceUsageLock — NOT a bare count, so two concurrent ticks in
// different sessions of one workspace can't both read "under cap" and race past
// it). A workspace at 0 balance OR over its warm-second cap force-drains its
// VIEWER-ONLY boxes: CAS warm->draining guarded `AND turn_holders = 0` so a box
// with a running (paying) turn is NEVER killed. The reaper then issues the
// provider stop() at refcount 0 (this fn is DB-only — no provider call).
//
// Group-wide force-drain on workspace balance exhaustion is deliberate (one
// balance drains a multi-session box): the workspace, not the session, is the
// billing unit — correctness (charged once) is automatic from the group meter key.
export interface ForceDrainResult {
  /** Whether the workspace was over a limit (0 balance or over the warm cap). */
  overLimit: boolean;
  /** The reason, for observability. */
  reason: "balance" | "warm_cap" | null;
  /** The (workspaceId, sandboxGroupId) viewer-only boxes CASed warm->draining. */
  drained: { workspaceId: string; sandboxGroupId: string }[];
}

// Start of the current UTC month (the default warm-cap window). Local helper so
// packages/db has no dependency on a worker/api date util; callers may override
// via capWindowStart to keep the fn time-source-agnostic for tests.
function startOfUtcMonthDefault(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

export async function forceDrainOverLimitViewerOnlyBoxes(db: Database, input: {
  workspaceId: string;
  /** account balance gate: when <= 0 (and a billing/managed mode is on) drain. */
  balanceMicros: number;
  enforceBalance: boolean;
  /** warm-second cap (cumulative this UTC month). 0 = unbounded (no cap gate). */
  maxWarmSecondsPerWorkspace: number;
  /** start of the cap window (caller passes startOfUtcMonth() so the fn stays
   *  time-source-agnostic for tests). */
  capWindowStart?: Date;
  /** drain-grace horizon stamped on the newly-draining rows (matches the reaper). */
  idleGraceMs: number;
}): Promise<ForceDrainResult> {
  return await withWorkspaceUsageLock(db, input.workspaceId, async (scopedDb) => {
    // Determine over-limit under the lock (so the cap read + the drain are one
    // serialized critical section per workspace).
    let reason: "balance" | "warm_cap" | null = null;
    if (input.enforceBalance && input.balanceMicros <= 0) {
      reason = "balance";
    } else if (input.maxWarmSecondsPerWorkspace > 0) {
      const since = input.capWindowStart ?? startOfUtcMonthDefault();
      const [{ total } = { total: 0 }] = await scopedDb.select({
        total: sql<number>`coalesce(sum(${schema.usageEvents.quantity}), 0)`,
      }).from(schema.usageEvents).where(and(
        eq(schema.usageEvents.workspaceId, input.workspaceId),
        eq(schema.usageEvents.eventType, "sandbox.warm_seconds"),
        gt(schema.usageEvents.occurredAt, since),
      ));
      if (Number(total) >= input.maxWarmSecondsPerWorkspace) {
        reason = "warm_cap";
      }
    }

    if (!reason) {
      return { overLimit: false, reason: null, drained: [] };
    }

    // Force-drain VIEWER-ONLY warm boxes: CAS warm->draining guarded
    // turn_holders = 0 (a paying turn is NEVER killed). Stamp the grace deadline
    // so the reaper terminates at refcount 0 past the grace, exactly as a normal
    // refcount->0 drain would.
    // Drop the viewer holders of every warm VIEWER-ONLY lease (turn_holders=0 — a
    // paying turn is never killed) so refcount → 0 (otherwise the viewer holder
    // pins refcount > 0 and the reaper never terminates at refcount=0, and the
    // holder heartbeat would re-arm the lease). Scoped to the warm viewer-only
    // leases via a subselect so a turn-held box's holders are untouched.
    await scopedDb.execute(sql`
      delete from sandbox_lease_holders h
      where h.kind = 'viewer'
        and h.lease_id in (
          select id from sandbox_leases
          where workspace_id = ${input.workspaceId}
            and liveness = 'warm' and turn_holders = 0
        )
    `);
    // CAS the now-holderless leases warm→draining at refcount 0 with the grace
    // deadline stamped — so the SAME reaper sweep's refcount=0 drain predicate
    // then terminates the box.
    const drained = await scopedDb.execute<{ sandbox_group_id: string }>(sql`
      update sandbox_leases set
        liveness = 'draining',
        refcount = 0, turn_holders = 0, viewer_holders = 0,
        expires_at = now() + (${String(input.idleGraceMs)} || ' milliseconds')::interval,
        updated_at = now()
      where workspace_id = ${input.workspaceId}
        and liveness = 'warm' and turn_holders = 0
      returning sandbox_group_id
    `);

    return {
      overLimit: true,
      reason,
      drained: drained.map((r) => ({ workspaceId: input.workspaceId, sandboxGroupId: r.sandbox_group_id })),
    };
  });
}

export async function saveRunState(db: Database, input: {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId?: string | null;
  serializedRunState: string;
  pendingApprovals: unknown[];
}): Promise<void> {
  await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [{ maxVersion } = { maxVersion: 0 }] = await scopedDb.select({
      maxVersion: sql<number>`coalesce(max(${schema.agentRunStates.stateVersion}), 0)`,
    }).from(schema.agentRunStates).where(and(eq(schema.agentRunStates.workspaceId, input.workspaceId), eq(schema.agentRunStates.sessionId, input.sessionId)));
    await scopedDb.insert(schema.agentRunStates).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId ?? null,
      stateVersion: Number(maxVersion) + 1,
      serializedRunState: input.serializedRunState,
      pendingApprovals: input.pendingApprovals,
    });
  });
}

export type CreateSessionGoalInput = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  text: string;
  successCriteria?: string | null;
  maxAutoContinuations?: number | null;
  createdBy: SessionGoalCreatedBy;
};

export async function createSessionGoal(db: Database, input: CreateSessionGoalInput): Promise<SessionGoal> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.sessionGoals).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      text: input.text,
      successCriteria: input.successCriteria ?? null,
      maxAutoContinuations: input.maxAutoContinuations ?? null,
      createdBy: input.createdBy,
    }).returning();
    if (!row) {
      throw new Error("Failed to create session goal");
    }
    return mapSessionGoal(row);
  });
}

export async function getSessionGoal(db: Database, workspaceId: string, sessionId: string): Promise<SessionGoal | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessionGoals)
      .where(and(eq(schema.sessionGoals.workspaceId, workspaceId), eq(schema.sessionGoals.sessionId, sessionId)))
      .limit(1);
    return row ? mapSessionGoal(row) : null;
  });
}

/**
 * goal_set semantics: insert, or replace the existing goal in place. A replace
 * re-activates the goal (even when paused or completed), bumps the version,
 * and resets the continuation counters — re-stating the objective re-arms the
 * auto-continuation budget.
 */
export async function upsertSessionGoal(db: Database, input: CreateSessionGoalInput): Promise<{ goal: SessionGoal; replaced: boolean }> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [existing] = await scopedDb.select().from(schema.sessionGoals)
      .where(and(eq(schema.sessionGoals.workspaceId, input.workspaceId), eq(schema.sessionGoals.sessionId, input.sessionId)))
      .for("update")
      .limit(1);
    if (!existing) {
      const [row] = await scopedDb.insert(schema.sessionGoals).values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        text: input.text,
        successCriteria: input.successCriteria ?? null,
        maxAutoContinuations: input.maxAutoContinuations ?? null,
        createdBy: input.createdBy,
      }).returning();
      if (!row) {
        throw new Error("Failed to upsert session goal");
      }
      return { goal: mapSessionGoal(row), replaced: false };
    }
    const [row] = await scopedDb.update(schema.sessionGoals).set({
      status: "active",
      text: input.text,
      successCriteria: input.successCriteria ?? null,
      maxAutoContinuations: input.maxAutoContinuations ?? null,
      evidence: null,
      rationale: null,
      pausedReason: null,
      createdBy: input.createdBy,
      version: existing.version + 1,
      autoContinuations: 0,
      noProgressStreak: 0,
      lastContinuationTurnId: null,
      versionAtLastContinuation: null,
      updatedAt: new Date(),
    }).where(eq(schema.sessionGoals.id, existing.id)).returning();
    if (!row) {
      throw new Error("Failed to upsert session goal");
    }
    return { goal: mapSessionGoal(row), replaced: true };
  });
}

/**
 * goal_update semantics: revise text/criteria without changing status. The
 * version bump counts as progress for the no-progress detector.
 */
export async function updateSessionGoal(db: Database, workspaceId: string, sessionId: string, input: {
  text?: string;
  successCriteria?: string | null;
}): Promise<SessionGoal> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.sessionGoals).set({
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.successCriteria !== undefined ? { successCriteria: input.successCriteria } : {}),
      version: sql`${schema.sessionGoals.version} + 1`,
      noProgressStreak: 0,
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionGoals.workspaceId, workspaceId), eq(schema.sessionGoals.sessionId, sessionId))).returning();
    if (!row) {
      throw new Error(`Session goal not found: ${sessionId}`);
    }
    return mapSessionGoal(row);
  });
}

/**
 * Sets a session's display title. The clobber guard lives entirely in this
 * single atomic UPDATE: a user-set title is permanent, so agent/auto writes
 * carry an `AND title_source IS DISTINCT FROM 'user'` guard (NULL-safe in
 * Postgres) while user writes are unconditional. Never read-modify-write.
 * Returns `{ updated, title }`: `updated` is false when an agent write was
 * skipped because a user title already pinned the session, true otherwise;
 * `title` is the resulting title (null when skipped).
 */
export async function updateSessionTitle(db: Database, input: {
  workspaceId: string;
  sessionId: string;
  title: string;
  source: "user" | "agent";
}): Promise<{ updated: boolean; title: string | null }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.sessions).set({
      title: input.title,
      titleSource: input.source,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.sessions.workspaceId, input.workspaceId),
      eq(schema.sessions.id, input.sessionId),
      ...(input.source === "agent" ? [sql`${schema.sessions.titleSource} is distinct from 'user'`] : []),
    )).returning({ title: schema.sessions.title });
    return { updated: Boolean(row), title: row?.title ?? null };
  });
}

/**
 * Status transition helper. Idempotent: requesting the current status returns
 * `changed: false` so callers can skip emitting a duplicate event. `completed`
 * is terminal for transitions; only `upsertSessionGoal` can replace a
 * completed goal. Resuming to `active` clears the pause fields and resets the
 * continuation counters.
 */
export async function setSessionGoalStatus(db: Database, workspaceId: string, sessionId: string, input: {
  status: SessionGoalStatus;
  evidence?: string;
  rationale?: string;
  pausedReason?: string;
}): Promise<{ goal: SessionGoal; changed: boolean }> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [existing] = await scopedDb.select().from(schema.sessionGoals)
      .where(and(eq(schema.sessionGoals.workspaceId, workspaceId), eq(schema.sessionGoals.sessionId, sessionId)))
      .for("update")
      .limit(1);
    if (!existing) {
      throw new Error(`Session goal not found: ${sessionId}`);
    }
    if (existing.status === input.status) {
      return { goal: mapSessionGoal(existing), changed: false };
    }
    if (existing.status === "completed") {
      throw new Error("session goal is completed; set a new goal to continue");
    }
    const [row] = await scopedDb.update(schema.sessionGoals).set({
      status: input.status,
      version: existing.version + 1,
      updatedAt: new Date(),
      ...(input.status === "completed" ? {
        evidence: input.evidence ?? null,
        pausedReason: null,
      } : {}),
      ...(input.status === "paused" ? {
        rationale: input.rationale ?? null,
        pausedReason: input.pausedReason ?? null,
      } : {}),
      ...(input.status === "active" ? {
        rationale: null,
        pausedReason: null,
        autoContinuations: 0,
        noProgressStreak: 0,
        // A re-armed goal starts a fresh continuation epoch; stale pointers to
        // a pre-pause continuation turn must not feed the progress detector.
        lastContinuationTurnId: null,
        versionAtLastContinuation: null,
      } : {}),
    }).where(eq(schema.sessionGoals.id, existing.id)).returning();
    if (!row) {
      throw new Error(`Session goal not found: ${sessionId}`);
    }
    return { goal: mapSessionGoal(row), changed: true };
  });
}

export async function setSessionGoalLastContinuationTurn(db: Database, workspaceId: string, sessionId: string, turnId: string): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.sessionGoals).set({
      lastContinuationTurnId: turnId,
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionGoals.workspaceId, workspaceId), eq(schema.sessionGoals.sessionId, sessionId)));
  });
}

export type GoalContinuationDecision =
  | { decision: "none" }
  | { decision: "queue" }
  | { decision: "paused"; reason: "no_progress" | "max_auto_continuations" | "limits"; goal: SessionGoal }
  | { decision: "continue"; goal: SessionGoal; autoContinuation: number; cap: number | null };

/**
 * Core continuation decision, taken in one transaction with the goal row
 * locked. Queued work always wins; any non-terminal turn (queued, running, or
 * requires_action awaiting a human approval) blocks auto-continuation. The
 * no-progress and max-continuation guards mutate counters here only, so a
 * replaying workflow re-reads recorded activity results and never recomputes
 * them.
 */
export async function evaluateGoalContinuation(db: Database, input: {
  workspaceId: string;
  sessionId: string;
  // Optional: when absent (the default posture) goals are uncapped and length
  // is governed by the no-progress and budget guards only.
  defaultMaxAutoContinuations?: number | null;
  noProgressLimit: number;
  // Caller-computed billing/limits block reason. Applied inside the locked
  // decision (before the counter bump) so a budget pause never consumes
  // continuation budget.
  budgetBlocked?: string | null;
}): Promise<GoalContinuationDecision> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.sessionGoals)
      .where(and(eq(schema.sessionGoals.workspaceId, input.workspaceId), eq(schema.sessionGoals.sessionId, input.sessionId)))
      .for("update")
      .limit(1);
    if (!row || row.status !== "active") {
      return { decision: "none" } as const;
    }
    const [pendingTurn] = await tx.select({ id: schema.sessionTurns.id, status: schema.sessionTurns.status })
      .from(schema.sessionTurns)
      .where(and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        inArray(schema.sessionTurns.status, ["queued", "running", "requires_action"]),
      ))
      .limit(1);
    if (pendingTurn) {
      // "queue" tells the workflow to claim immediately; running/requires_action
      // turns (e.g. a pending approval on a restarted workflow) must not be
      // bypassed by a continuation, so they decline instead.
      return pendingTurn.status === "queued" ? { decision: "queue" } as const : { decision: "none" } as const;
    }
    let autoContinuations = row.autoContinuations;
    let noProgressStreak = row.noProgressStreak;
    if (row.lastContinuationTurnId) {
      const [lastFinished] = await tx.select({ id: schema.sessionTurns.id })
        .from(schema.sessionTurns)
        .where(and(
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, input.sessionId),
          sql`${schema.sessionTurns.finishedAt} is not null`,
        ))
        .orderBy(desc(schema.sessionTurns.position), desc(schema.sessionTurns.createdAt))
        .limit(1);
      if (lastFinished && lastFinished.id !== row.lastContinuationTurnId) {
        // A user/scheduled turn ran since the last continuation: human
        // re-engagement re-arms the auto-continuation budget.
        autoContinuations = 0;
        noProgressStreak = 0;
      } else if (lastFinished) {
        const [{ toolCalls } = { toolCalls: 0 }] = await tx.select({
          toolCalls: sql<number>`count(*)::int`,
        }).from(schema.sessionEvents)
          .where(and(
            eq(schema.sessionEvents.workspaceId, input.workspaceId),
            eq(schema.sessionEvents.turnId, row.lastContinuationTurnId),
            eq(schema.sessionEvents.type, "agent.toolCall.created"),
          ));
        const goalRevised = row.versionAtLastContinuation !== null && row.version > row.versionAtLastContinuation;
        if (Number(toolCalls) > 0 || goalRevised) {
          noProgressStreak = 0;
        } else {
          // A turn that died on retryable provider backpressure says nothing
          // about whether the goal can progress; freezing the streak keeps a
          // sustained rate-limit window from masquerading as a stuck goal.
          // The auto-continuation cap remains the backstop for a real outage.
          const [{ backpressureFailures } = { backpressureFailures: 0 }] = await tx.select({
            backpressureFailures: sql<number>`count(*)::int`,
          }).from(schema.sessionEvents)
            .where(and(
              eq(schema.sessionEvents.workspaceId, input.workspaceId),
              eq(schema.sessionEvents.turnId, row.lastContinuationTurnId),
              eq(schema.sessionEvents.type, "turn.failed"),
              sql`${schema.sessionEvents.payload} ->> 'recovery' = 'goal_continuation'`,
            ));
          if (Number(backpressureFailures) === 0) {
            noProgressStreak = noProgressStreak + 1;
          }
        }
      }
    }
    if (noProgressStreak >= input.noProgressLimit) {
      const [paused] = await tx.update(schema.sessionGoals).set({
        status: "paused",
        pausedReason: "no_progress",
        autoContinuations,
        noProgressStreak,
        version: row.version + 1,
        updatedAt: new Date(),
      }).where(eq(schema.sessionGoals.id, row.id)).returning();
      return { decision: "paused", reason: "no_progress", goal: mapSessionGoal(paused!) } as const;
    }
    // No configured default means uncapped: goal length is bounded by the
    // no-progress and budget guards above, never by count. When a default is
    // configured it is a hard ceiling; per-goal overrides can only lower it.
    const capCandidates = [row.maxAutoContinuations, input.defaultMaxAutoContinuations]
      .filter((value): value is number => typeof value === "number");
    const cap = capCandidates.length > 0 ? Math.min(...capCandidates) : null;
    if (cap !== null && autoContinuations >= cap) {
      const [paused] = await tx.update(schema.sessionGoals).set({
        status: "paused",
        pausedReason: "max_auto_continuations",
        autoContinuations,
        noProgressStreak,
        version: row.version + 1,
        updatedAt: new Date(),
      }).where(eq(schema.sessionGoals.id, row.id)).returning();
      return { decision: "paused", reason: "max_auto_continuations", goal: mapSessionGoal(paused!) } as const;
    }
    if (input.budgetBlocked) {
      // Budget exhaustion pauses the goal visibly without bumping the
      // continuation counter — no turn is synthesized for this pass.
      const [paused] = await tx.update(schema.sessionGoals).set({
        status: "paused",
        pausedReason: "limits",
        rationale: input.budgetBlocked,
        autoContinuations,
        noProgressStreak,
        version: row.version + 1,
        updatedAt: new Date(),
      }).where(eq(schema.sessionGoals.id, row.id)).returning();
      return { decision: "paused", reason: "limits", goal: mapSessionGoal(paused!) } as const;
    }
    const [updated] = await tx.update(schema.sessionGoals).set({
      autoContinuations: autoContinuations + 1,
      noProgressStreak,
      versionAtLastContinuation: row.version,
      updatedAt: new Date(),
    }).where(eq(schema.sessionGoals.id, row.id)).returning();
    return { decision: "continue", goal: mapSessionGoal(updated!), autoContinuation: autoContinuations + 1, cap } as const;
  }));
}

function mapSessionGoal(row: typeof schema.sessionGoals.$inferSelect): SessionGoal {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    status: row.status as SessionGoal["status"],
    text: row.text,
    successCriteria: row.successCriteria,
    evidence: row.evidence,
    rationale: row.rationale,
    pausedReason: row.pausedReason,
    createdBy: row.createdBy as SessionGoal["createdBy"],
    version: row.version,
    autoContinuations: row.autoContinuations,
    noProgressStreak: row.noProgressStreak,
    maxAutoContinuations: row.maxAutoContinuations,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createTurn(db: Database, input: {
  workspaceId: string;
  sessionId: string;
  triggerEventId: string;
  temporalWorkflowId: string;
}): Promise<string> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const session = await requireSession(scopedDb, input.workspaceId, input.sessionId);
    const trigger = await getSessionEvent(scopedDb, input.workspaceId, input.triggerEventId);
    const position = await nextTurnPosition(scopedDb, input.workspaceId, input.sessionId);
    const [row] = await scopedDb.insert(schema.sessionTurns).values({
      accountId: session.accountId,
      workspaceId: session.workspaceId,
      sessionId: input.sessionId,
      triggerEventId: input.triggerEventId,
      temporalWorkflowId: input.temporalWorkflowId,
      status: "running",
      source: "user",
      position,
      prompt: promptFromTrigger(trigger?.payload) ?? session.initialMessage,
      resources: resourcesFromTrigger(trigger?.payload) ?? session.resources,
      tools: toolsFromTrigger(trigger?.payload) ?? session.tools,
      model: session.model,
      reasoningEffort: reasoningEffortFromSession(session),
      sandboxBackend: session.sandboxBackend,
      metadata: {},
      startedAt: new Date(),
    }).returning({ id: schema.sessionTurns.id });
    if (!row) {
      throw new Error("Failed to create turn");
    }
    await scopedDb.update(schema.sessions).set({
      activeTurnId: row.id,
      status: "running",
      updatedAt: new Date(),
    }).where(and(eq(schema.sessions.workspaceId, input.workspaceId), eq(schema.sessions.id, input.sessionId)));
    return row.id;
  });
}

export async function enqueueSessionTurn(db: Database, input: EnqueueSessionTurnInput): Promise<SessionTurn> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const position = await nextTurnPosition(tx as unknown as Database, input.workspaceId, input.sessionId);
    const [row] = await tx.insert(schema.sessionTurns).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      triggerEventId: input.triggerEventId,
      temporalWorkflowId: input.temporalWorkflowId,
      status: "queued",
      source: input.source,
      position,
      prompt: input.prompt,
      resources: input.resources,
      tools: input.tools,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      sandboxBackend: input.sandboxBackend,
      metadata: input.metadata,
    }).returning();
    if (!row) {
      throw new Error("Failed to enqueue session turn");
    }
    return mapSessionTurn(row);
  }));
}

export async function claimNextQueuedTurn(db: Database, workspaceId: string, sessionId: string, workflowId: string): Promise<SessionTurn | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const rows = await tx.execute(sql<{ id: string }>`
      select id from session_turns
      where workspace_id = ${workspaceId} and session_id = ${sessionId} and status = 'queued'
      order by position asc, created_at asc, id asc
      for update skip locked
      limit 1
    `);
    const id = rows[0]?.id as string | undefined;
    if (!id) {
      return null;
    }
    const [row] = await tx.update(schema.sessionTurns).set({
      status: "running",
      temporalWorkflowId: workflowId,
      startedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, id))).returning();
    if (!row) {
      throw new Error(`Session turn not found: ${id}`);
    }
    await tx.update(schema.sessions).set({
      status: "running",
      activeTurnId: row.id,
      updatedAt: new Date(),
    }).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
    return mapSessionTurn(row);
  }));
}

export async function setSessionStatus(db: Database, workspaceId: string, sessionId: string, status: SessionStatus, activeTurnId?: string | null): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.sessions).set({
      status,
      activeTurnId: activeTurnId === undefined ? undefined : activeTurnId,
      updatedAt: new Date(),
    }).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

export type WakeParentForChildCompletionInput = {
  workspaceId: string;
  parentSessionId: string;
  // Stable per terminal episode, unique across episodes: the idempotency key
  // for exactly-once delivery (a unique session_events.client_event_id).
  clientEventId: string;
  // System-authored wake text rendered to the manager as its next turn input.
  text: string;
  // Structured payload describing the completed child (id, status, goal).
  childCompletion: Record<string, unknown>;
  reasoningEffortFallback: ReasoningEffort;
};

export type WakeParentForChildCompletionResult =
  | { delivered: false; reason: "already_delivered" | "parent_cancelled" }
  | { delivered: true; turn: SessionTurn; triggerEvent: SessionEvent; events: SessionEvent[]; temporalWorkflowId: string };

/**
 * Deliver a one-shot completion wake from a spawned worker into its parent
 * (manager) session: append a system-authored `user.message`, transition the
 * parent idle/failed -> queued (a queued/running parent already has a turn in
 * flight and keeps it), and enqueue the resulting turn. The whole thing runs
 * under the parent's row lock in one transaction, and is idempotent on
 * `clientEventId`: a duplicate call for the same terminal episode (activity
 * retry, the workflow's idle re-check) is a no-op that enqueues no second
 * turn. The caller publishes the returned events and signals the parent's
 * Temporal workflow (signalWithStart) only when `delivered` is true.
 *
 * Mirrors `acceptSessionUserMessage`/`postUserMessageTurn` in the API domain:
 * cancelled is the one parent state that refuses the wake (an explicit stop);
 * failed stays revivable, matching the revivable-failed-sessions contract.
 */
export async function wakeParentSessionForChildCompletion(
  db: Database,
  input: WakeParentForChildCompletionInput,
): Promise<WakeParentForChildCompletionResult> {
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [parent] = await tx.select().from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, input.workspaceId), eq(schema.sessions.id, input.parentSessionId)))
      .for("update")
      .limit(1);
    if (!parent) {
      throw new Error(`Parent session not found: ${input.parentSessionId}`);
    }
    if (parent.status === "cancelled") {
      // Cancelled is the one terminal state that refuses new input; a manager a
      // human explicitly stopped is not revived by a worker finishing.
      return { delivered: false, reason: "parent_cancelled" as const };
    }
    // Idempotency gate: a wake for this terminal episode was already delivered.
    const [existing] = await tx.select({ id: schema.sessionEvents.id }).from(schema.sessionEvents)
      .where(and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.parentSessionId),
        eq(schema.sessionEvents.clientEventId, input.clientEventId),
      ))
      .limit(1);
    if (existing) {
      return { delivered: false, reason: "already_delivered" as const };
    }

    const shouldQueue = parent.status === "idle" || parent.status === "failed";
    const workflowId = parent.temporalWorkflowId ?? `session-${parent.id}`;
    let sequence = parent.lastSequence;
    const now = new Date();
    const eventRows = [
      {
        type: "user.message",
        payload: { text: input.text, childCompletion: input.childCompletion },
        clientEventId: input.clientEventId,
      },
      ...(shouldQueue ? [{ type: "session.status.changed", payload: { status: "queued" }, clientEventId: null as string | null }] : []),
    ].map((event) => ({
      accountId: parent.accountId,
      workspaceId: parent.workspaceId,
      sessionId: parent.id,
      sequence: ++sequence,
      type: event.type,
      payload: sanitizeEventPayload(event.payload),
      clientEventId: event.clientEventId ?? null,
      turnId: null,
      producerId: null,
      producerSeq: null,
      occurredAt: now,
    }));
    const inserted = (await tx.insert(schema.sessionEvents).values(eventRows).returning()).map(mapEvent);
    const triggerEvent = inserted[0]!;

    const position = await nextTurnPosition(tx as unknown as Database, input.workspaceId, parent.id);
    const [turnRow] = await tx.insert(schema.sessionTurns).values({
      accountId: parent.accountId,
      workspaceId: parent.workspaceId,
      sessionId: parent.id,
      triggerEventId: triggerEvent.id,
      temporalWorkflowId: workflowId,
      status: "queued",
      source: "user",
      position,
      prompt: input.text,
      resources: [],
      tools: parent.tools as ToolRef[],
      model: parent.model,
      reasoningEffort: reasoningEffortForMetadata(parent.metadata, input.reasoningEffortFallback),
      sandboxBackend: parent.sandboxBackend as SandboxBackend,
      metadata: { childCompletion: input.childCompletion },
    }).returning();
    if (!turnRow) {
      throw new Error("Failed to enqueue parent wake turn");
    }
    const turn = mapSessionTurn(turnRow);

    sequence += 1;
    const [queuedEventRow] = await tx.insert(schema.sessionEvents).values({
      accountId: parent.accountId,
      workspaceId: parent.workspaceId,
      sessionId: parent.id,
      sequence,
      type: "turn.queued",
      payload: sanitizeEventPayload({ turnId: turn.id, triggerEventId: triggerEvent.id, source: turn.source }),
      clientEventId: null,
      turnId: turn.id,
      producerId: null,
      producerSeq: null,
      occurredAt: now,
    }).returning();
    const events = [...inserted, ...(queuedEventRow ? [mapEvent(queuedEventRow)] : [])];

    await tx.update(schema.sessions).set({
      lastSequence: sequence,
      ...(shouldQueue ? { status: "queued" as const, activeTurnId: null } : {}),
      updatedAt: now,
    }).where(and(eq(schema.sessions.workspaceId, input.workspaceId), eq(schema.sessions.id, parent.id)));

    return { delivered: true as const, turn, triggerEvent, events, temporalWorkflowId: workflowId };
  }));
}

export async function setTemporalWorkflowId(db: Database, workspaceId: string, sessionId: string, workflowId: string): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.sessions).set({
      temporalWorkflowId: workflowId,
      updatedAt: new Date(),
    }).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
  });
}

export async function finishTurn(db: Database, workspaceId: string, turnId: string, status: SessionStatus | SessionTurnStatus): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    await scopedDb.update(schema.sessionTurns).set({
      status: turnStatusForFinish(status),
      finishedAt: status === "requires_action" ? undefined : new Date(),
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId)));
  });
}

/**
 * Put a preempted (worker shutdown mid-flight) turn back on the session
 * queue so the workflow's next claim re-dispatches it on a healthy worker.
 * The trigger event is swapped when the resumed attempt should enter
 * through a synthesized resume notice instead of replaying the original
 * trigger (the original input is already part of persisted conversation
 * truth by then). Keeping the original position lets the resumed turn run
 * before any turns queued behind it. Accepts `running` turns and
 * `requires_action` turns: an approval rerun re-dispatches the same turn
 * without a fresh claim, so the row still carries the approval-wait status
 * while the rerun activity executes.
 */
export async function requeuePreemptedTurn(db: Database, workspaceId: string, turnId: string, triggerEventId: string): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.sessionTurns).set({
      status: "queued",
      triggerEventId,
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId), inArray(schema.sessionTurns.status, ["running", "requires_action"]))).returning({ id: schema.sessionTurns.id });
    if (!row) {
      throw new Error(`Preemptible session turn not found: ${turnId}`);
    }
  });
}

/**
 * Bump the per-turn worker-death redispatch counter and return the new value.
 * Stored in the turn row's metadata (not workflow-local state) so the
 * crash-loop guard is replay-safe: the count survives workflow replay, worker
 * restarts, and even a session-workflow re-run, and the increment is a single
 * atomic statement.
 */
export async function incrementTurnWorkerDeathRedispatches(db: Database, workspaceId: string, turnId: string): Promise<number> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.execute(sql<{ count: number }>`
      update session_turns
      set metadata = jsonb_set(
            coalesce(metadata, '{}'::jsonb),
            '{workerDeathRedispatches}',
            to_jsonb(coalesce((metadata->>'workerDeathRedispatches')::int, 0) + 1),
            true
          ),
          updated_at = now()
      where workspace_id = ${workspaceId} and id = ${turnId}
      returning (metadata->>'workerDeathRedispatches')::int as count
    `);
    const count = rows[0]?.count;
    if (count === undefined || count === null) {
      throw new Error(`Session turn not found: ${turnId}`);
    }
    return Number(count);
  });
}

export async function getSessionTurn(db: Database, workspaceId: string, turnId: string): Promise<SessionTurn | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessionTurns).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId))).limit(1);
    return row ? mapSessionTurn(row) : null;
  });
}

export async function listSessionTurns(db: Database, workspaceId: string, sessionId: string, limit = 100): Promise<SessionTurn[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const rows = await scopedDb.select().from(schema.sessionTurns)
      .where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.sessionId, sessionId)))
      .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt))
      .limit(limit);
    return rows.map(mapSessionTurn);
  });
}

export async function updateQueuedSessionTurn(db: Database, workspaceId: string, turnId: string, input: UpdateQueuedSessionTurnInput): Promise<SessionTurn> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.sessionTurns).set({
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      ...(input.resources !== undefined ? { resources: input.resources } : {}),
      ...(input.tools !== undefined ? { tools: input.tools } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.sandboxBackend !== undefined ? { sandboxBackend: input.sandboxBackend } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId), eq(schema.sessionTurns.status, "queued"))).returning();
    if (!row) {
      throw new Error(`Queued session turn not found: ${turnId}`);
    }
    return mapSessionTurn(row);
  });
}

export async function cancelQueuedSessionTurn(db: Database, workspaceId: string, turnId: string): Promise<SessionTurn> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.update(schema.sessionTurns).set({
      status: "cancelled",
      finishedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId), eq(schema.sessionTurns.status, "queued"))).returning();
    if (!row) {
      throw new Error(`Queued session turn not found: ${turnId}`);
    }
    return mapSessionTurn(row);
  });
}

export async function reorderQueuedSessionTurns(db: Database, workspaceId: string, sessionId: string, turnIds: string[]): Promise<SessionTurn[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const rows = await tx.select().from(schema.sessionTurns)
      .where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.sessionId, sessionId), eq(schema.sessionTurns.status, "queued"), inArray(schema.sessionTurns.id, turnIds)));
    if (rows.length !== turnIds.length) {
      throw new Error("All reordered turns must be queued turns in the session");
    }
    let index = 0;
    for (const turnId of turnIds) {
      index += 1;
      await tx.update(schema.sessionTurns).set({
        position: index,
        updatedAt: new Date(),
      }).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.id, turnId)));
    }
    const updated = await tx.select().from(schema.sessionTurns)
      .where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.sessionId, sessionId), eq(schema.sessionTurns.status, "queued")))
      .orderBy(asc(schema.sessionTurns.position), asc(schema.sessionTurns.createdAt));
    return updated.map(mapSessionTurn);
  }));
}

export async function appendSessionEvents(db: Database, workspaceId: string, sessionId: string, inputs: AppendEventInput[]): Promise<SessionEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .for("update")
      .limit(1);
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let sequence = row.lastSequence;
    const values = inputs.map((input) => ({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId,
      sequence: ++sequence,
      type: input.type,
      payload: sanitizeEventPayload(input.payload ?? {}),
      clientEventId: input.clientEventId ?? null,
      turnId: input.turnId ?? null,
      producerId: input.producerId ?? null,
      producerSeq: input.producerSeq ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    }));
    const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
    await tx.update(schema.sessions).set({ lastSequence: sequence, updatedAt: new Date() }).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
    return inserted.map(mapEvent);
  }));
}

export async function appendSessionEventsAndUpdateSession(db: Database, workspaceId: string, sessionId: string, inputs: AppendEventInput[], update: {
  resources?: ResourceRef[];
  tools?: ToolRef[];
  model?: string;
  metadata?: Record<string, unknown>;
  status?: SessionStatus;
  activeTurnId?: string | null;
}): Promise<SessionEvent[]> {
  if (inputs.length === 0) {
    return [];
  }
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.sessions)
      .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
      .for("update")
      .limit(1);
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    let sequence = row.lastSequence;
    const now = new Date();
    const values = inputs.map((input) => ({
      accountId: row.accountId,
      workspaceId: row.workspaceId,
      sessionId,
      sequence: ++sequence,
      type: input.type,
      payload: sanitizeEventPayload(input.payload ?? {}),
      clientEventId: input.clientEventId ?? null,
      turnId: input.turnId ?? null,
      producerId: input.producerId ?? null,
      producerSeq: input.producerSeq ?? null,
      occurredAt: input.occurredAt ?? now,
    }));
    const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
    await tx.update(schema.sessions).set({
      lastSequence: sequence,
      ...(update.resources !== undefined ? { resources: update.resources } : {}),
      ...(update.tools !== undefined ? { tools: update.tools } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.activeTurnId !== undefined ? { activeTurnId: update.activeTurnId } : {}),
      updatedAt: now,
    }).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
    return inserted.map(mapEvent);
  }));
}

export async function appendSessionEventsWithLockedSessionUpdate(db: Database, workspaceId: string, sessionId: string, build: (session: Session) => {
  events: AppendEventInput[];
  update?: {
    resources?: ResourceRef[];
    tools?: ToolRef[];
    model?: string;
    metadata?: Record<string, unknown>;
    status?: SessionStatus;
    activeTurnId?: string | null;
  };
}): Promise<SessionEvent[]> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => await scopedDb.transaction(async (tx) => {
    const [sessionRow] = await tx.select().from(schema.sessions).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId))).for("update").limit(1);
    if (!sessionRow) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const built = build(mapSession(sessionRow));
    if (built.events.length === 0) {
      return [];
    }
    let sequence = sessionRow.lastSequence;
    const now = new Date();
    const values = built.events.map((input) => ({
      accountId: sessionRow.accountId,
      workspaceId: sessionRow.workspaceId,
      sessionId,
      sequence: ++sequence,
      type: input.type,
      payload: sanitizeEventPayload(input.payload ?? {}),
      clientEventId: input.clientEventId ?? null,
      turnId: input.turnId ?? null,
      producerId: input.producerId ?? null,
      producerSeq: input.producerSeq ?? null,
      occurredAt: input.occurredAt ?? now,
    }));
    const inserted = await tx.insert(schema.sessionEvents).values(values).returning();
    const update = built.update ?? {};
    await tx.update(schema.sessions).set({
      lastSequence: sequence,
      ...(update.resources !== undefined ? { resources: update.resources } : {}),
      ...(update.tools !== undefined ? { tools: update.tools } : {}),
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.metadata !== undefined ? { metadata: update.metadata } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      ...(update.activeTurnId !== undefined ? { activeTurnId: update.activeTurnId } : {}),
      updatedAt: now,
    }).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
    return inserted.map(mapEvent);
  }));
}

export function sessionSubject(workspaceId: string, sessionId: string): string {
  return `workspaces.${workspaceId}.sessions.${sessionId}.events`;
}

function mapSession(row: typeof schema.sessions.$inferSelect): Session {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    status: row.status as SessionStatus,
    initialMessage: row.initialMessage,
    title: row.title ?? null,
    titleSource: (row.titleSource as "user" | "agent" | null) ?? null,
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    metadata: row.metadata,
    model: row.model,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    sandboxOs: row.sandboxOs as SandboxOs,
    sandboxGroupId: row.sandboxGroupId,
    // The first-class swappable-sandbox pointer (M2). null == use the group
    // sandbox; active_epoch is the swap fence. Defensive Number() coercion keeps
    // the fence exact even if the column type ever drifts (the lease-epoch lesson).
    activeSandboxId: row.activeSandboxId ?? null,
    activeEpoch: Number(row.activeEpoch),
    environmentId: row.environmentId,
    firstPartyMcpPermissions: (row.firstPartyMcpPermissions as Permission[] | null) ?? null,
    parentSessionId: row.parentSessionId ?? null,
    createIdempotencyKey: row.createIdempotencyKey ?? null,
    temporalWorkflowId: row.temporalWorkflowId,
    activeTurnId: row.activeTurnId,
    lastInputTokens: row.lastInputTokens ?? null,
    lastSequence: row.lastSequence,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEventType,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
  };
}

function mapSessionTurn(row: typeof schema.sessionTurns.$inferSelect): SessionTurn {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    temporalWorkflowId: row.temporalWorkflowId,
    status: row.status as SessionTurnStatus,
    source: row.source as SessionTurnSource,
    position: row.position,
    prompt: row.prompt,
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    model: row.model,
    reasoningEffort: row.reasoningEffort as ReasoningEffort,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    sandboxOs: (row.sandboxOs as SandboxOs | null) ?? null,
    metadata: row.metadata,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function nextTurnPosition(db: Database, workspaceId: string, sessionId: string): Promise<number> {
  const [{ maxPosition } = { maxPosition: 0 }] = await db.select({
    maxPosition: sql<number>`coalesce(max(${schema.sessionTurns.position}), 0)`,
  }).from(schema.sessionTurns).where(and(eq(schema.sessionTurns.workspaceId, workspaceId), eq(schema.sessionTurns.sessionId, sessionId)));
  return Number(maxPosition) + 1;
}

function turnStatusForFinish(status: SessionStatus | SessionTurnStatus): SessionTurnStatus {
  if (status === "idle") {
    return "completed";
  }
  if (status === "queued") {
    return "queued";
  }
  if (status === "running") {
    return "running";
  }
  return status;
}

function promptFromTrigger(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "text" in payload && typeof payload.text === "string") {
    return payload.text;
  }
  return null;
}

function resourcesFromTrigger(payload: unknown): ResourceRef[] | null {
  if (payload && typeof payload === "object" && "resources" in payload && Array.isArray(payload.resources)) {
    return payload.resources as ResourceRef[];
  }
  return null;
}

function toolsFromTrigger(payload: unknown): ToolRef[] | null {
  if (payload && typeof payload === "object" && "tools" in payload && Array.isArray(payload.tools)) {
    return payload.tools as ToolRef[];
  }
  return null;
}

function reasoningEffortFromSession(session: Session): ReasoningEffort {
  const value = session.metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "medium";
}

function mapFile(row: typeof schema.files.$inferSelect): FileAsset {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status as FileStatus,
    filename: row.filename,
    safeFilename: row.safeFilename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    bucket: row.bucket,
    objectKey: row.objectKey,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapScheduledTask(row: typeof schema.scheduledTasks.$inferSelect): ScheduledTask {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status as ScheduledTaskStatus,
    schedule: row.schedule as ScheduledTaskScheduleSpec,
    temporalScheduleId: row.temporalScheduleId,
    runMode: row.runMode as ScheduledTaskRunMode,
    overlapPolicy: row.overlapPolicy as ScheduledTaskOverlapPolicy,
    agentConfig: row.agentConfig as ScheduledTaskAgentConfig,
    reusableSessionId: row.reusableSessionId,
    environmentId: row.environmentId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapScheduledTaskRun(row: typeof schema.scheduledTaskRuns.$inferSelect): ScheduledTaskRun {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    taskId: row.taskId,
    status: row.status as ScheduledTaskRunStatus,
    triggerType: row.triggerType as ScheduledTaskTriggerType,
    scheduledAt: row.scheduledAt ? row.scheduledAt.toISOString() : null,
    firedAt: row.firedAt.toISOString(),
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapAccount(row: typeof schema.managedAccounts.$inferSelect): ManagedAccount {
  return {
    id: row.id,
    name: row.name,
    externalSource: row.externalSource,
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapPackInstallation(row: typeof schema.packInstallations.$inferSelect): PackInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    packId: row.packId,
    status: row.status as PackInstallationStatus,
    metadata: row.metadata,
    enabledAt: row.enabledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWorkspacePack(row: typeof schema.workspacePacks.$inferSelect): WorkspaceRegisteredPack {
  return {
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    // Manifests are validated with the CapabilityPack contract at the API
    // boundary before they are stored.
    pack: row.manifest as unknown as CapabilityPack,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCapabilityCatalogItem(row: typeof schema.capabilityCatalogItems.$inferSelect): CapabilityCatalogItem {
  const runtime = row.kind === "mcp" && row.endpointUrl
    ? {
      available: true,
      mcpServerId: mcpServerIdForCapability(row.id, row.metadata),
      transport: "streamable-http",
      notes: row.authModel
        ? "Requires credential headers supplied in the enable request."
        : null,
    }
    : {
      available: false,
      notes: row.kind === "mcp"
        ? "Remote streamable HTTP endpoint is required for runtime use."
        : null,
    };
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    kind: row.kind as CapabilityKind,
    source: row.source as CapabilitySource,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: row.tags,
    homepageUrl: row.homepageUrl,
    endpointUrl: row.endpointUrl,
    installUrl: row.installUrl,
    authModel: row.authModel,
    tools: [],
    runtime,
    enabled: false,
    enabledReason: null,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWorkspace(row: typeof schema.workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    slug: row.slug,
    externalSource: row.externalSource,
    externalId: row.externalId,
    agentInstructions: row.agentInstructions ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapWorkspaceMember(row: typeof schema.workspaceMemberships.$inferSelect): WorkspaceMember {
  return {
    subjectId: row.subjectId,
    subjectLabel: row.subjectLabel,
    role: row.role,
    permissions: row.permissions as Permission[],
    createdAt: row.createdAt.toISOString(),
  };
}

function mapCapabilityInstallation(row: typeof schema.capabilityInstallations.$inferSelect): CapabilityInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    capabilityId: row.capabilityId,
    kind: row.kind as CapabilityKind,
    status: row.status as CapabilityInstallationStatus,
    config: redactInstallationConfig(row.config),
    metadata: row.metadata,
    enabledAt: row.enabledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Stored credential-header ciphertext never leaves the database through the
 * generic installation mapping — callers see only the sorted header names.
 * The runtime reads ciphertext through listEnabledMcpCapabilityServers and
 * the enable flow through getStoredCapabilityHeaderCiphertext.
 */
function redactInstallationConfig(config: Record<string, unknown>): Record<string, unknown> {
  const headersEncrypted = encryptedHeadersConfig(config.headersEncrypted);
  if (!headersEncrypted) {
    return config;
  }
  const { headersEncrypted: _omitted, ...rest } = config;
  return { ...rest, headerNames: Object.keys(headersEncrypted).sort() };
}

function mapSocialConnection(row: typeof schema.socialConnections.$inferSelect): SocialConnection {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    provider: row.provider as SocialProvider,
    accountHandle: row.accountHandle,
    accountName: row.accountName,
    externalAccountId: row.externalAccountId,
    status: row.status as SocialConnectionStatus,
    scopes: row.scopes,
    credentialRef: row.credentialRef,
    tokenMetadata: row.tokenMetadata,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapApiKey(row: typeof schema.apiKeys.$inferSelect): ApiKey {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    permissions: row.permissions as Permission[],
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapGitHubInstallation(row: typeof schema.githubInstallations.$inferSelect): GitHubInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    installationId: row.installationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapUsageEvent(row: typeof schema.usageEvents.$inferSelect): UsageEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    accountId: row.accountId,
    subjectId: row.subjectId,
    eventType: row.eventType as UsageEvent["eventType"],
    quantity: row.quantity,
    unit: row.unit,
    sourceResourceType: row.sourceResourceType,
    sourceResourceId: row.sourceResourceId,
    idempotencyKey: row.idempotencyKey,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    exportedToBillingAt: row.exportedToBillingAt ? row.exportedToBillingAt.toISOString() : null,
    billingProviderEventId: row.billingProviderEventId,
  };
}

function mapSocialPost(row: typeof schema.socialPosts.$inferSelect): SocialPost {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    connectionId: row.connectionId,
    provider: row.provider as SocialProvider,
    externalPostId: row.externalPostId,
    url: row.url,
    authorHandle: row.authorHandle,
    text: row.text,
    publishedAt: row.publishedAt.toISOString(),
    metrics: row.metrics,
    raw: row.raw,
    createdAt: row.createdAt.toISOString(),
  };
}

function stringArrayConfig(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? [...new Set(values.map((item) => item.trim()))] : undefined;
}

function positiveIntegerConfig(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0) {
    return Number(value);
  }
  return undefined;
}

function booleanConfig(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function encryptedHeadersConfig(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mcpConnectivityOk(metadata: Record<string, unknown>): boolean {
  const value = metadata.mcpConnectivity;
  return !!value && typeof value === "object" && "status" in value && value.status === "ok";
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}
