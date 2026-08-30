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

export async function createWorkspaceGatewayCustomModel(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    upstreamModelId: string;
    label?: string | null;
    createdBySubjectId: string;
  },
): Promise<WorkspaceGatewayCustomModel> {
  return await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-gateway-custom-models:${input.workspaceId}`}, 0))`,
    );
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
    const [retired] = await scopedDb
      .select()
      .from(schema.workspaceGatewayCustomModels)
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.upstreamModelId, input.upstreamModelId),
        ),
      )
      .limit(1);
    if (retired?.retiredAt) {
      const [restored] = await scopedDb
        .update(schema.workspaceGatewayCustomModels)
        .set({ retiredAt: null, updatedAt: new Date() })
        .where(eq(schema.workspaceGatewayCustomModels.id, retired.id))
        .returning();
      if (!restored) throw new Error("workspace Gateway custom model restore returned no row");
      return mapCustomModel(restored);
    }
    const [row] = await scopedDb
      .insert(schema.workspaceGatewayCustomModels)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        upstreamModelId: input.upstreamModelId,
        label: input.label ?? null,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    if (!row) throw new Error("workspace Gateway custom model write returned no row");
    return mapCustomModel(row);
  });
}

export async function deleteWorkspaceGatewayCustomModel(
  db: Database,
  input: { accountId: string; workspaceId: string; customModelId: string },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) => {
    const removed = await scopedDb
      .update(schema.workspaceGatewayCustomModels)
      .set({ retiredAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.workspaceGatewayCustomModels.accountId, input.accountId),
          eq(schema.workspaceGatewayCustomModels.workspaceId, input.workspaceId),
          eq(schema.workspaceGatewayCustomModels.id, input.customModelId),
          isNull(schema.workspaceGatewayCustomModels.retiredAt),
        ),
      )
      .returning({ id: schema.workspaceGatewayCustomModels.id });
    return removed.length > 0;
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
      .limit(1);
    return row ? mapCustomModel(row) : null;
  });
}
