import { and, count, eq, isNull, sql } from "drizzle-orm";

import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type DeploymentModelCatalogRow = {
  document: unknown;
  version: number;
  updatedAt: Date;
};

export type WorkspaceCustomModelProviderKind = "vercel_gateway" | "openrouter";

export type WorkspaceProviderCustomModel = {
  id: string;
  accountId: string;
  workspaceId: string;
  providerKind: WorkspaceCustomModelProviderKind;
  upstreamModelId: string;
  label: string | null;
  version: number;
  createdBySubjectId: string;
  retiredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkspaceGatewayCustomModel = WorkspaceProviderCustomModel & {
  providerKind: "vercel_gateway";
};

export type WorkspaceOpenRouterCustomModel = WorkspaceProviderCustomModel & {
  providerKind: "openrouter";
};

export const MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS = 100;
export const MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS = 1_000;
export const MAX_WORKSPACE_OPENROUTER_CUSTOM_MODELS = MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS;
export const MAX_WORKSPACE_OPENROUTER_CUSTOM_MODEL_RECORDS =
  MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS;

export class WorkspaceGatewayCustomModelLimitError extends Error {
  constructor() {
    super(`workspace Gateway custom model limit reached (${MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS})`);
    this.name = "WorkspaceGatewayCustomModelLimitError";
  }
}

export class WorkspaceGatewayCustomModelHistoryLimitError extends Error {
  constructor() {
    super(
      `workspace Gateway custom model history limit reached (${MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS})`,
    );
    this.name = "WorkspaceGatewayCustomModelHistoryLimitError";
  }
}

export class WorkspaceOpenRouterCustomModelLimitError extends Error {
  constructor() {
    super(
      `workspace OpenRouter custom model limit reached (${MAX_WORKSPACE_OPENROUTER_CUSTOM_MODELS})`,
    );
    this.name = "WorkspaceOpenRouterCustomModelLimitError";
  }
}

export class WorkspaceOpenRouterCustomModelHistoryLimitError extends Error {
  constructor() {
    super(
      `workspace OpenRouter custom model history limit reached (${MAX_WORKSPACE_OPENROUTER_CUSTOM_MODEL_RECORDS})`,
    );
    this.name = "WorkspaceOpenRouterCustomModelHistoryLimitError";
  }
}

function customModelLimitError(providerKind: WorkspaceCustomModelProviderKind): Error {
  return providerKind === "vercel_gateway"
    ? new WorkspaceGatewayCustomModelLimitError()
    : new WorkspaceOpenRouterCustomModelLimitError();
}

function customModelHistoryLimitError(providerKind: WorkspaceCustomModelProviderKind): Error {
  return providerKind === "vercel_gateway"
    ? new WorkspaceGatewayCustomModelHistoryLimitError()
    : new WorkspaceOpenRouterCustomModelHistoryLimitError();
}

function workspaceCustomModelLockKey(
  workspaceId: string,
  providerKind: WorkspaceCustomModelProviderKind,
): string {
  return providerKind === "vercel_gateway"
    ? `workspace-gateway-custom-models:${workspaceId}`
    : `workspace-openrouter-custom-models:${workspaceId}`;
}

/** Serialize one provider's custom-model mutations while allowing concurrent acceptance reads. */
export async function withWorkspaceProviderCustomModelReadLock<T>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: WorkspaceCustomModelProviderKind;
  },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceCustomModelLockKey(input.workspaceId, input.providerKind)}, 0))`,
    );
    return await fn(scopedDb);
  });
}

/** Compatibility wrapper for existing Vercel AI Gateway admission callers. */
export async function withWorkspaceGatewayCustomModelReadLock<T>(
  db: Database,
  input: { accountId: string; workspaceId: string },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withWorkspaceProviderCustomModelReadLock(
    db,
    { ...input, providerKind: "vercel_gateway" },
    fn,
  );
}

export async function withWorkspaceOpenRouterCustomModelReadLock<T>(
  db: Database,
  input: { accountId: string; workspaceId: string },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withWorkspaceProviderCustomModelReadLock(
    db,
    { ...input, providerKind: "openrouter" },
    fn,
  );
}

async function withWorkspaceProviderCustomModelWriteLock<T>(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: WorkspaceCustomModelProviderKind;
  },
  fn: (db: Database) => Promise<T>,
): Promise<T> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${workspaceCustomModelLockKey(input.workspaceId, input.providerKind)}, 0))`,
    );
    return await fn(scopedDb);
  });
}

function mapCustomModel(
  row: typeof schema.workspaceGatewayCustomModels.$inferSelect,
): WorkspaceProviderCustomModel {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    providerKind: row.providerKind,
    upstreamModelId: row.upstreamModelId,
    label: row.label,
    version: row.version,
    createdBySubjectId: row.createdBySubjectId,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function asGatewayCustomModel(model: WorkspaceProviderCustomModel): WorkspaceGatewayCustomModel {
  if (model.providerKind !== "vercel_gateway") {
    throw new Error("workspace custom model provider mismatch");
  }
  return model as WorkspaceGatewayCustomModel;
}

function asOpenRouterCustomModel(
  model: WorkspaceProviderCustomModel,
): WorkspaceOpenRouterCustomModel {
  if (model.providerKind !== "openrouter") {
    throw new Error("workspace custom model provider mismatch");
  }
  return model as WorkspaceOpenRouterCustomModel;
}

/** Runtime read of the deployment-global singleton. Returns null when absent. */
export async function getDeploymentModelCatalog(
  db: Database,
): Promise<DeploymentModelCatalogRow | null> {
  const [row] = await db
    .select({
      document: schema.deploymentModelCatalog.document,
      version: schema.deploymentModelCatalog.version,
      updatedAt: schema.deploymentModelCatalog.updatedAt,
    })
    .from(schema.deploymentModelCatalog)
    .where(eq(schema.deploymentModelCatalog.singleton, true))
    .limit(1);
  return row ?? null;
}

async function listWorkspaceProviderCustomModels(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: WorkspaceCustomModelProviderKind;
  },
): Promise<WorkspaceProviderCustomModel[]> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .orderBy(
        schema.workspaceGatewayCustomModels.createdAt,
        schema.workspaceGatewayCustomModels.id,
      )
      .limit(MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS + 1);
    if (rows.length > MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS) {
      throw customModelLimitError(input.providerKind);
    }
    return rows.map(mapCustomModel);
  });
}

export async function listWorkspaceGatewayCustomModels(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<WorkspaceGatewayCustomModel[]> {
  return (
    await listWorkspaceProviderCustomModels(db, {
      ...input,
      providerKind: "vercel_gateway",
    })
  ).map(asGatewayCustomModel);
}

export async function listWorkspaceOpenRouterCustomModels(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<WorkspaceOpenRouterCustomModel[]> {
  return (
    await listWorkspaceProviderCustomModels(db, {
      ...input,
      providerKind: "openrouter",
    })
  ).map(asOpenRouterCustomModel);
}

async function lockActiveWorkspaceProviderCustomModelForAdmission(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: WorkspaceCustomModelProviderKind;
    upstreamModelId: string;
  },
): Promise<WorkspaceProviderCustomModel | null> {
  return await withWorkspaceProviderCustomModelReadLock(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.upstreamModelId, input.upstreamModelId),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .limit(1);
    return row ? mapCustomModel(row) : null;
  });
}

/**
 * Lock and re-read one active Gateway custom model at a fresh-selection commit
 * boundary. The shared lock remains held until an existing outer transaction commits.
 */
export async function lockActiveWorkspaceGatewayCustomModelForAdmission(
  db: Database,
  input: { accountId: string; workspaceId: string; upstreamModelId: string },
): Promise<WorkspaceGatewayCustomModel | null> {
  const model = await lockActiveWorkspaceProviderCustomModelForAdmission(db, {
    ...input,
    providerKind: "vercel_gateway",
  });
  return model ? asGatewayCustomModel(model) : null;
}

export async function lockActiveWorkspaceOpenRouterCustomModelForAdmission(
  db: Database,
  input: { accountId: string; workspaceId: string; upstreamModelId: string },
): Promise<WorkspaceOpenRouterCustomModel | null> {
  const model = await lockActiveWorkspaceProviderCustomModelForAdmission(db, {
    ...input,
    providerKind: "openrouter",
  });
  return model ? asOpenRouterCustomModel(model) : null;
}

type ReplayWorkspaceProviderCustomModelCreateResult =
  | { outcome: "missing" }
  | { outcome: "conflict" }
  | { outcome: "success"; model: WorkspaceProviderCustomModel };

async function replayWorkspaceProviderCustomModelCreate(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: WorkspaceCustomModelProviderKind;
    operationId: string;
    requestHash: string;
  },
): Promise<ReplayWorkspaceProviderCustomModelCreateResult> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.createOperationId, input.operationId),
        ),
      )
      .limit(1);
    if (!row) return { outcome: "missing" as const };
    if (row.createRequestHash !== input.requestHash || row.retiredAt) {
      return { outcome: "conflict" as const };
    }
    return { outcome: "success" as const, model: mapCustomModel(row) };
  });
}

export async function replayWorkspaceGatewayCustomModelCreate(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    requestHash: string;
  },
): Promise<
  | { outcome: "missing" }
  | { outcome: "conflict" }
  | { outcome: "success"; model: WorkspaceGatewayCustomModel }
> {
  const result = await replayWorkspaceProviderCustomModelCreate(db, {
    ...input,
    providerKind: "vercel_gateway",
  });
  return result.outcome === "success"
    ? { ...result, model: asGatewayCustomModel(result.model) }
    : result;
}

export async function replayWorkspaceOpenRouterCustomModelCreate(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    requestHash: string;
  },
): Promise<
  | { outcome: "missing" }
  | { outcome: "conflict" }
  | { outcome: "success"; model: WorkspaceOpenRouterCustomModel }
> {
  const result = await replayWorkspaceProviderCustomModelCreate(db, {
    ...input,
    providerKind: "openrouter",
  });
  return result.outcome === "success"
    ? { ...result, model: asOpenRouterCustomModel(result.model) }
    : result;
}

type CreateWorkspaceProviderCustomModelInput = {
  accountId: string;
  workspaceId: string;
  upstreamModelId: string;
  label?: string | null;
  operationId: string;
  requestHash: string;
  createdBySubjectId: string;
};

async function createWorkspaceProviderCustomModel(
  db: Database,
  input: CreateWorkspaceProviderCustomModelInput & {
    providerKind: WorkspaceCustomModelProviderKind;
  },
): Promise<WorkspaceProviderCustomModel | null> {
  return await withWorkspaceProviderCustomModelWriteLock(db, input, async (scopedDb) => {
    const [operationRow] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.createOperationId, input.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (operationRow) {
      return operationRow.createRequestHash === input.requestHash
        ? mapCustomModel(operationRow)
        : null;
    }
    const [active] = await scopedDb
      .select({ id: schema.workspaceGatewayCustomModels.id })
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.upstreamModelId, input.upstreamModelId),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .for("update")
      .limit(1);
    if (active) return null;
    const [total] = await scopedDb
      .select({ value: count() })
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
        ),
      );
    if ((total?.value ?? 0) >= MAX_WORKSPACE_GATEWAY_CUSTOM_MODEL_RECORDS) {
      throw customModelHistoryLimitError(input.providerKind);
    }
    const [current] = await scopedDb
      .select({ value: count() })
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      );
    if ((current?.value ?? 0) >= MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS) {
      throw customModelLimitError(input.providerKind);
    }
    const [row] = await scopedDb
      .insert(schema.workspaceGatewayCustomModels)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        providerKind: input.providerKind,
        upstreamModelId: input.upstreamModelId,
        label: input.label ?? null,
        createOperationId: input.operationId,
        createRequestHash: input.requestHash,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    if (!row) throw new Error("workspace custom model write returned no row");
    return mapCustomModel(row);
  });
}

export async function createWorkspaceGatewayCustomModel(
  db: Database,
  input: CreateWorkspaceProviderCustomModelInput,
): Promise<WorkspaceGatewayCustomModel | null> {
  const model = await createWorkspaceProviderCustomModel(db, {
    ...input,
    providerKind: "vercel_gateway",
  });
  return model ? asGatewayCustomModel(model) : null;
}

export async function createWorkspaceOpenRouterCustomModel(
  db: Database,
  input: CreateWorkspaceProviderCustomModelInput,
): Promise<WorkspaceOpenRouterCustomModel | null> {
  const model = await createWorkspaceProviderCustomModel(db, {
    ...input,
    providerKind: "openrouter",
  });
  return model ? asOpenRouterCustomModel(model) : null;
}

type DeleteWorkspaceProviderCustomModelInput = {
  accountId: string;
  workspaceId: string;
  customModelId: string;
  expectedVersion: number;
  operationId: string;
  requestHash: string;
};

type DeleteWorkspaceProviderCustomModelResult =
  | { outcome: "success"; model: WorkspaceProviderCustomModel }
  | { outcome: "conflict" }
  | { outcome: "not_found" };

async function deleteWorkspaceProviderCustomModel(
  db: Database,
  input: DeleteWorkspaceProviderCustomModelInput & {
    providerKind: WorkspaceCustomModelProviderKind;
  },
): Promise<DeleteWorkspaceProviderCustomModelResult> {
  return await withWorkspaceProviderCustomModelWriteLock(db, input, async (scopedDb) => {
    const [operationRow] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.deleteOperationId, input.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (operationRow) {
      return operationRow.id === input.customModelId &&
        operationRow.deleteRequestHash === input.requestHash
        ? { outcome: "success" as const, model: mapCustomModel(operationRow) }
        : { outcome: "conflict" as const };
    }
    const [target] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.id, input.customModelId),
        ),
      )
      .for("update")
      .limit(1);
    if (!target) return { outcome: "not_found" as const };
    if (target.retiredAt || target.version !== input.expectedVersion) {
      return { outcome: "conflict" as const };
    }
    const [removed] = await scopedDb
      .update(schema.workspaceGatewayCustomModels)
      .set({
        version: target.version + 1,
        deleteOperationId: input.operationId,
        deleteRequestHash: input.requestHash,
        retiredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.id, input.customModelId),
          eq(schema.workspaceGatewayCustomModels.version, input.expectedVersion),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .returning();
    return removed
      ? { outcome: "success" as const, model: mapCustomModel(removed) }
      : { outcome: "conflict" as const };
  });
}

export async function deleteWorkspaceGatewayCustomModel(
  db: Database,
  input: DeleteWorkspaceProviderCustomModelInput,
): Promise<
  | { outcome: "success"; model: WorkspaceGatewayCustomModel }
  | { outcome: "conflict" }
  | { outcome: "not_found" }
> {
  const result = await deleteWorkspaceProviderCustomModel(db, {
    ...input,
    providerKind: "vercel_gateway",
  });
  return result.outcome === "success"
    ? { ...result, model: asGatewayCustomModel(result.model) }
    : result;
}

export async function deleteWorkspaceOpenRouterCustomModel(
  db: Database,
  input: DeleteWorkspaceProviderCustomModelInput,
): Promise<
  | { outcome: "success"; model: WorkspaceOpenRouterCustomModel }
  | { outcome: "conflict" }
  | { outcome: "not_found" }
> {
  const result = await deleteWorkspaceProviderCustomModel(db, {
    ...input,
    providerKind: "openrouter",
  });
  return result.outcome === "success"
    ? { ...result, model: asOpenRouterCustomModel(result.model) }
    : result;
}

/** Retired rows remain executable for an accepted turn or existing continuation. */
async function getWorkspaceProviderCustomModelForExecution(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    providerKind: WorkspaceCustomModelProviderKind;
    upstreamModelId: string;
  },
): Promise<WorkspaceProviderCustomModel | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.providerKind, input.providerKind),
          eq(schema.workspaceGatewayCustomModels.upstreamModelId, input.upstreamModelId),
        ),
      )
      .orderBy(
        sql`(${schema.workspaceGatewayCustomModels.retiredAt} is null) desc`,
        sql`${schema.workspaceGatewayCustomModels.updatedAt} desc`,
        sql`${schema.workspaceGatewayCustomModels.createdAt} desc`,
      )
      .limit(1);
    return row ? mapCustomModel(row) : null;
  });
}

export async function getWorkspaceGatewayCustomModelForExecution(
  db: Database,
  input: { accountId: string; workspaceId: string; upstreamModelId: string },
): Promise<WorkspaceGatewayCustomModel | null> {
  const model = await getWorkspaceProviderCustomModelForExecution(db, {
    ...input,
    providerKind: "vercel_gateway",
  });
  return model ? asGatewayCustomModel(model) : null;
}

export async function getWorkspaceOpenRouterCustomModelForExecution(
  db: Database,
  input: { accountId: string; workspaceId: string; upstreamModelId: string },
): Promise<WorkspaceOpenRouterCustomModel | null> {
  const model = await getWorkspaceProviderCustomModelForExecution(db, {
    ...input,
    providerKind: "openrouter",
  });
  return model ? asOpenRouterCustomModel(model) : null;
}
