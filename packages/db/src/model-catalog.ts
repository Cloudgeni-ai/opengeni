import { and, count, eq, isNull, sql } from "drizzle-orm";

import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export type DeploymentModelCatalogRow = {
  document: unknown;
  version: number;
  updatedAt: Date;
};

export type WorkspaceGatewayCustomModel = {
  id: string;
  accountId: string;
  workspaceId: string;
  upstreamModelId: string;
  label: string | null;
  version: number;
  createdBySubjectId: string;
  retiredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS = 100;

export class WorkspaceGatewayCustomModelLimitError extends Error {
  constructor() {
    super(`workspace Gateway custom model limit reached (${MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS})`);
    this.name = "WorkspaceGatewayCustomModelLimitError";
  }
}

function mapCustomModel(
  row: typeof schema.workspaceGatewayCustomModels.$inferSelect,
): WorkspaceGatewayCustomModel {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    upstreamModelId: row.upstreamModelId,
    label: row.label,
    version: row.version,
    createdBySubjectId: row.createdBySubjectId,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

export async function listWorkspaceGatewayCustomModels(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<WorkspaceGatewayCustomModel[]> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const rows = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .orderBy(
        schema.workspaceGatewayCustomModels.createdAt,
        schema.workspaceGatewayCustomModels.id,
      )
      .limit(MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS + 1);
    if (rows.length > MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS) {
      throw new WorkspaceGatewayCustomModelLimitError();
    }
    return rows.map(mapCustomModel);
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
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
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

export async function createWorkspaceGatewayCustomModel(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    upstreamModelId: string;
    label?: string | null;
    operationId: string;
    requestHash: string;
    createdBySubjectId: string;
  },
): Promise<WorkspaceGatewayCustomModel | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-gateway-custom-models:${input.workspaceId}`}, 0))`,
    );
    const [operationRow] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
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
          eq(schema.workspaceGatewayCustomModels.upstreamModelId, input.upstreamModelId),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .for("update")
      .limit(1);
    if (active) return null;
    const [current] = await scopedDb
      .select({ value: count() })
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      );
    if ((current?.value ?? 0) >= MAX_WORKSPACE_GATEWAY_CUSTOM_MODELS) {
      throw new WorkspaceGatewayCustomModelLimitError();
    }
    const [row] = await scopedDb
      .insert(schema.workspaceGatewayCustomModels)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        upstreamModelId: input.upstreamModelId,
        label: input.label ?? null,
        createOperationId: input.operationId,
        createRequestHash: input.requestHash,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    if (!row) throw new Error("workspace Gateway custom model write returned no row");
    return mapCustomModel(row);
  });
}

export async function deleteWorkspaceGatewayCustomModel(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    customModelId: string;
    expectedVersion: number;
    operationId: string;
    requestHash: string;
  },
): Promise<
  | { outcome: "success"; model: WorkspaceGatewayCustomModel }
  | { outcome: "conflict" }
  | { outcome: "not_found" }
> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-gateway-custom-models:${input.workspaceId}`}, 0))`,
    );
    const [operationRow] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
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

/** Retired rows are invisible to new selection but remain executable for an
 * already accepted turn or an existing session continuation. */
export async function getWorkspaceGatewayCustomModelForExecution(
  db: Database,
  input: { accountId: string; workspaceId: string; upstreamModelId: string },
): Promise<WorkspaceGatewayCustomModel | null> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
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
