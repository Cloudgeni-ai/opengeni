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
  WorkspaceRegisteredPack,
} from "@opengeni/contracts";
import { reasoningEffortForMetadata, CLEARED_RUN_STATE_BLOB } from "@opengeni/contracts";
import { and, asc, desc, eq, gt, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { decryptEnvironmentValue } from "./environment-crypto";
import * as schema from "./schema";

export { sql as dbSql } from "drizzle-orm";
export { decryptEnvironmentValue, encryptEnvironmentValue } from "./environment-crypto";

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
}): Promise<Workspace> {
  const [row] = await db.insert(schema.workspaces).values({
    accountId: input.accountId,
    name: input.name,
    slug: input.slug ?? null,
    externalSource: input.externalSource ?? null,
    externalId: input.externalId ?? null,
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
}): Promise<Workspace> {
  const [row] = await db.update(schema.workspaces).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
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
}): Promise<Session> {
  return await withRlsContext(db, { accountId: input.accountId, workspaceId: input.workspaceId }, async (scopedDb) => {
    const [row] = await scopedDb.insert(schema.sessions).values({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      initialMessage: input.initialMessage,
      resources: input.resources,
      tools: input.tools ?? [],
      metadata: input.metadata,
      model: input.model,
      sandboxBackend: input.sandboxBackend,
      environmentId: input.environmentId ?? null,
      firstPartyMcpPermissions: input.firstPartyMcpPermissions ?? null,
      parentSessionId: input.parentSessionId ?? null,
      status: "queued",
    }).returning();
    if (!row) {
      throw new Error("Failed to create session");
    }
    return mapSession(row);
  });
}

export async function getSession(db: Database, workspaceId: string, sessionId: string): Promise<Session | null> {
  return await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
    const [row] = await scopedDb.select().from(schema.sessions).where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId))).limit(1);
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
      item: entry.item,
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
        item: input.summaryItem,
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
        item: clearedContextMarkerItem(),
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
      payload: event.payload,
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
      payload: { turnId: turn.id, triggerEventId: triggerEvent.id, source: turn.source },
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
      payload: input.payload ?? {},
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
      payload: input.payload ?? {},
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
      payload: input.payload ?? {},
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
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    metadata: row.metadata,
    model: row.model,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    environmentId: row.environmentId,
    firstPartyMcpPermissions: (row.firstPartyMcpPermissions as Permission[] | null) ?? null,
    parentSessionId: row.parentSessionId ?? null,
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
