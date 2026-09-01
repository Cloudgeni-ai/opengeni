import { createHash } from "node:crypto";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import { and, count, eq, isNull, sql } from "drizzle-orm";

import { type Database, setSubjectRlsContext, withRlsContext } from "./database";
import { decryptEnvironmentValue } from "./environment-crypto";
import * as schema from "./schema";

export type OrganizationModelProviderKind = "vercel_gateway" | "openrouter";
export type OrganizationModelProviderConnection = {
  providerKind: OrganizationModelProviderKind;
  status: "active" | "revoked";
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export type OrganizationModelProviderCustomModel = {
  id: string;
  accountId: string;
  providerKind: OrganizationModelProviderKind;
  upstreamModelId: string;
  label: string | null;
  version: number;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export class OrganizationModelProviderConflictError extends Error {}
export class OrganizationModelProviderLimitError extends Error {}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function organizationModelProviderCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

async function withOrganizationProviderAdministrator<T>(
  db: Database,
  input: { organizationId: string; actorSubjectId: string },
  use: (scopedDb: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      await setSubjectRlsContext(scopedDb, input.actorSubjectId);
      await scopedDb.execute(sql`
        select get_organization_administration_overview(
          ${input.organizationId}::uuid, ${input.actorSubjectId}
        )
      `);
      return await use(scopedDb);
    },
  );
}

function mapConnection(
  row: typeof schema.organizationModelProviderConnections.$inferSelect,
): OrganizationModelProviderConnection {
  return {
    providerKind: row.providerKind,
    status: row.status,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapConnectionOperation(
  row: typeof schema.organizationModelProviderConnectionOperations.$inferSelect,
): OrganizationModelProviderConnection {
  return {
    providerKind: row.providerKind,
    status: row.resultStatus,
    version: row.resultVersion,
    createdAt: row.resultCreatedAt,
    updatedAt: row.resultUpdatedAt,
  };
}

async function recordConnectionOperation(
  db: Database,
  input: {
    accountId: string;
    operationId: string;
    requestHash: string;
    connection: OrganizationModelProviderConnection;
  },
): Promise<void> {
  await db.insert(schema.organizationModelProviderConnectionOperations).values({
    accountId: input.accountId,
    providerKind: input.connection.providerKind,
    operationId: input.operationId,
    requestHash: input.requestHash,
    resultStatus: input.connection.status,
    resultVersion: input.connection.version,
    resultCreatedAt: input.connection.createdAt,
    resultUpdatedAt: input.connection.updatedAt,
  });
}

function mapModel(
  row: typeof schema.organizationModelProviderCustomModels.$inferSelect,
): OrganizationModelProviderCustomModel {
  return {
    id: row.id,
    accountId: row.accountId,
    providerKind: row.providerKind,
    upstreamModelId: row.upstreamModelId,
    label: row.label,
    version: row.version,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getOrganizationModelProviderConnection(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    providerKind: OrganizationModelProviderKind;
  },
): Promise<OrganizationModelProviderConnection | null> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.organizationId),
          eq(schema.organizationModelProviderConnections.providerKind, input.providerKind),
        ),
      )
      .limit(1);
    return row ? mapConnection(row) : null;
  });
}

export async function upsertOrganizationModelProviderConnection(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    providerKind: OrganizationModelProviderKind;
    credentialEncrypted: string;
    credentialDigest: string;
    operationId: string;
    expectedVersion?: number;
  },
): Promise<OrganizationModelProviderConnection> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider:${input.organizationId}:${input.providerKind}`}, 0))`,
    );
    const requestHash = digest({
      operation: "upsert",
      expectedVersion: input.expectedVersion,
      credentialDigest: input.credentialDigest,
    });
    const [replay] = await scopedDb
      .select()
      .from(schema.organizationModelProviderConnectionOperations)
      .where(
        and(
          eq(schema.organizationModelProviderConnectionOperations.accountId, input.organizationId),
          eq(schema.organizationModelProviderConnectionOperations.providerKind, input.providerKind),
          eq(schema.organizationModelProviderConnectionOperations.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new OrganizationModelProviderConflictError();
      return mapConnectionOperation(replay);
    }
    const [existing] = await scopedDb
      .select()
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.organizationId),
          eq(schema.organizationModelProviderConnections.providerKind, input.providerKind),
        ),
      )
      .for("update")
      .limit(1);
    const expected = input.expectedVersion ?? 0;
    if ((existing?.version ?? 0) !== expected) throw new OrganizationModelProviderConflictError();
    const [row] = existing
      ? await scopedDb
          .update(schema.organizationModelProviderConnections)
          .set({
            status: "active",
            credentialEncrypted: input.credentialEncrypted,
            version: existing.version + 1,
            operationId: input.operationId,
            requestHash,
            updatedBySubjectId: input.actorSubjectId,
            updatedAt: new Date(),
          })
          .where(eq(schema.organizationModelProviderConnections.id, existing.id))
          .returning()
      : await scopedDb
          .insert(schema.organizationModelProviderConnections)
          .values({
            accountId: input.organizationId,
            providerKind: input.providerKind,
            credentialEncrypted: input.credentialEncrypted,
            operationId: input.operationId,
            requestHash,
            updatedBySubjectId: input.actorSubjectId,
          })
          .returning();
    if (!row) throw new Error("organization provider connection write returned no row");
    const connection = mapConnection(row);
    await recordConnectionOperation(scopedDb, {
      accountId: input.organizationId,
      operationId: input.operationId,
      requestHash,
      connection,
    });
    return connection;
  });
}

export async function revokeOrganizationModelProviderConnection(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    providerKind: OrganizationModelProviderKind;
    operationId: string;
    expectedVersion: number;
  },
): Promise<OrganizationModelProviderConnection> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider:${input.organizationId}:${input.providerKind}`}, 0))`,
    );
    const requestHash = digest({ operation: "revoke", expectedVersion: input.expectedVersion });
    const [replay] = await scopedDb
      .select()
      .from(schema.organizationModelProviderConnectionOperations)
      .where(
        and(
          eq(schema.organizationModelProviderConnectionOperations.accountId, input.organizationId),
          eq(schema.organizationModelProviderConnectionOperations.providerKind, input.providerKind),
          eq(schema.organizationModelProviderConnectionOperations.operationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.requestHash !== requestHash) throw new OrganizationModelProviderConflictError();
      return mapConnectionOperation(replay);
    }
    const [existing] = await scopedDb
      .select()
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.organizationId),
          eq(schema.organizationModelProviderConnections.providerKind, input.providerKind),
        ),
      )
      .for("update")
      .limit(1);
    if (!existing) throw new OrganizationModelProviderConflictError();
    if (existing.version !== input.expectedVersion)
      throw new OrganizationModelProviderConflictError();
    const [row] = await scopedDb
      .update(schema.organizationModelProviderConnections)
      .set({
        status: "revoked",
        credentialEncrypted: "",
        version: existing.version + 1,
        operationId: input.operationId,
        requestHash,
        updatedBySubjectId: input.actorSubjectId,
        updatedAt: new Date(),
      })
      .where(eq(schema.organizationModelProviderConnections.id, existing.id))
      .returning();
    if (!row) throw new Error("organization provider revoke returned no row");
    const connection = mapConnection(row);
    await recordConnectionOperation(scopedDb, {
      accountId: input.organizationId,
      operationId: input.operationId,
      requestHash,
      connection,
    });
    return connection;
  });
}

export async function organizationModelProviderConnectionActiveForWorkspace(
  db: Database,
  input: { accountId: string; workspaceId: string; providerKind: OrganizationModelProviderKind },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({ id: schema.organizationModelProviderConnections.id })
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.accountId),
          eq(schema.organizationModelProviderConnections.providerKind, input.providerKind),
          eq(schema.organizationModelProviderConnections.status, "active"),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

export async function loadOrganizationModelProviderApiKey(
  db: Database,
  settings: Settings,
  input: { accountId: string; workspaceId: string; providerKind: OrganizationModelProviderKind },
): Promise<string | null> {
  const key = environmentsEncryptionKeyBytes(settings);
  if (!key) return null;
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select({
        credentialEncrypted: schema.organizationModelProviderConnections.credentialEncrypted,
      })
      .from(schema.organizationModelProviderConnections)
      .where(
        and(
          eq(schema.organizationModelProviderConnections.accountId, input.accountId),
          eq(schema.organizationModelProviderConnections.providerKind, input.providerKind),
          eq(schema.organizationModelProviderConnections.status, "active"),
        ),
      )
      .limit(1);
    return row ? decryptEnvironmentValue(key, row.credentialEncrypted) : null;
  });
}

export async function listOrganizationModelProviderCustomModelsForWorkspace(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: OrganizationModelProviderKind;
    includeRetired?: boolean;
  },
): Promise<OrganizationModelProviderCustomModel[]> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.accountId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          ...(input.includeRetired
            ? []
            : [isNull(schema.organizationModelProviderCustomModels.retiredAt)]),
        ),
      );
    return rows.map(mapModel);
  });
}

export async function getOrganizationModelProviderCustomModelForExecution(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: OrganizationModelProviderKind;
    upstreamModelId: string;
  },
): Promise<OrganizationModelProviderCustomModel | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.accountId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          eq(schema.organizationModelProviderCustomModels.upstreamModelId, input.upstreamModelId),
        ),
      )
      .orderBy(
        sql`(${schema.organizationModelProviderCustomModels.retiredAt} is null) desc`,
        sql`${schema.organizationModelProviderCustomModels.updatedAt} desc`,
      )
      .limit(1);
    return row ? mapModel(row) : null;
  });
}

export async function withOrganizationModelProviderCustomModelReadLock<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; providerKind: OrganizationModelProviderKind },
  use: (scopedDb: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${`organization-model-provider-models:${input.accountId}:${input.providerKind}`}, 0))`,
    );
    return await use(scopedDb);
  });
}

export async function lockActiveOrganizationModelProviderCustomModelForAdmission(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: OrganizationModelProviderKind;
    upstreamModelId: string;
  },
): Promise<OrganizationModelProviderCustomModel | null> {
  return await withOrganizationModelProviderCustomModelReadLock(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.accountId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          eq(schema.organizationModelProviderCustomModels.upstreamModelId, input.upstreamModelId),
          isNull(schema.organizationModelProviderCustomModels.retiredAt),
        ),
      )
      .limit(1);
    return row ? mapModel(row) : null;
  });
}

export async function listOrganizationModelProviderCustomModels(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    providerKind: OrganizationModelProviderKind;
  },
): Promise<OrganizationModelProviderCustomModel[]> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.organizationId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          isNull(schema.organizationModelProviderCustomModels.retiredAt),
        ),
      );
    return rows.map(mapModel);
  });
}

export async function createOrganizationModelProviderCustomModel(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    providerKind: OrganizationModelProviderKind;
    upstreamModelId: string;
    label?: string;
    operationId: string;
  },
): Promise<OrganizationModelProviderCustomModel> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider-models:${input.organizationId}:${input.providerKind}`}, 0))`,
    );
    const requestHash = digest({
      upstreamModelId: input.upstreamModelId,
      label: input.label ?? null,
    });
    const [replay] = await scopedDb
      .select()
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.organizationId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          eq(schema.organizationModelProviderCustomModels.createOperationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.createRequestHash !== requestHash)
        throw new OrganizationModelProviderConflictError();
      return mapModel(replay);
    }
    const [{ active = 0, total = 0 } = {}] = await scopedDb
      .select({
        active: count(
          sql`case when ${schema.organizationModelProviderCustomModels.retiredAt} is null then 1 end`,
        ),
        total: count(),
      })
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.organizationId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
        ),
      );
    if (Number(active) >= 100 || Number(total) >= 1000)
      throw new OrganizationModelProviderLimitError();
    const [duplicate] = await scopedDb
      .select({ id: schema.organizationModelProviderCustomModels.id })
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.organizationId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          eq(schema.organizationModelProviderCustomModels.upstreamModelId, input.upstreamModelId),
          isNull(schema.organizationModelProviderCustomModels.retiredAt),
        ),
      )
      .limit(1);
    if (duplicate) throw new OrganizationModelProviderConflictError();
    const [row] = await scopedDb
      .insert(schema.organizationModelProviderCustomModels)
      .values({
        accountId: input.organizationId,
        providerKind: input.providerKind,
        upstreamModelId: input.upstreamModelId,
        label: input.label ?? null,
        createOperationId: input.operationId,
        createRequestHash: requestHash,
        createdBySubjectId: input.actorSubjectId,
      })
      .returning();
    if (!row) throw new Error("organization custom model create returned no row");
    return mapModel(row);
  });
}

export async function retireOrganizationModelProviderCustomModel(
  db: Database,
  input: {
    organizationId: string;
    actorSubjectId: string;
    providerKind: OrganizationModelProviderKind;
    customModelId: string;
    expectedVersion: number;
    operationId: string;
  },
): Promise<OrganizationModelProviderCustomModel> {
  return await withOrganizationProviderAdministrator(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`organization-model-provider-models:${input.organizationId}:${input.providerKind}`}, 0))`,
    );
    const requestHash = digest({
      customModelId: input.customModelId,
      expectedVersion: input.expectedVersion,
    });
    const [replay] = await scopedDb
      .select()
      .from(schema.organizationModelProviderCustomModels)
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.organizationId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          eq(schema.organizationModelProviderCustomModels.deleteOperationId, input.operationId),
        ),
      )
      .limit(1);
    if (replay) {
      if (replay.deleteRequestHash !== requestHash)
        throw new OrganizationModelProviderConflictError();
      return mapModel(replay);
    }
    const [row] = await scopedDb
      .update(schema.organizationModelProviderCustomModels)
      .set({
        retiredAt: new Date(),
        deleteOperationId: input.operationId,
        deleteRequestHash: requestHash,
        version: input.expectedVersion + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.organizationModelProviderCustomModels.accountId, input.organizationId),
          eq(schema.organizationModelProviderCustomModels.providerKind, input.providerKind),
          eq(schema.organizationModelProviderCustomModels.id, input.customModelId),
          eq(schema.organizationModelProviderCustomModels.version, input.expectedVersion),
          isNull(schema.organizationModelProviderCustomModels.retiredAt),
        ),
      )
      .returning();
    if (!row) throw new OrganizationModelProviderConflictError();
    return mapModel(row);
  });
}
