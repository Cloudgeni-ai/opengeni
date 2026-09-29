import { and, desc, eq, sql } from "drizzle-orm";
import { rawRows, type Database, withRlsContext } from "./database";
import {
  workspaceCredentialProviders,
  workspaceWebhookDeliveries,
  workspaceWebhooks,
} from "./schema";

export type WorkspaceIntegrationScope = {
  accountId: string;
  workspaceId: string;
};

export const WORKSPACE_WEBHOOK_LIMIT = 10;
export const WORKSPACE_WEBHOOK_MAX_ATTEMPTS = 12;

export class WorkspaceWebhookLimitError extends Error {
  constructor() {
    super(`a workspace may have at most ${WORKSPACE_WEBHOOK_LIMIT} webhooks`);
    this.name = "WorkspaceWebhookLimitError";
  }
}

export type WorkspaceCredentialProviderRow = typeof workspaceCredentialProviders.$inferSelect;
export type WorkspaceWebhookRow = typeof workspaceWebhooks.$inferSelect;
export type WorkspaceWebhookDeliveryRow = typeof workspaceWebhookDeliveries.$inferSelect;

export async function getWorkspaceCredentialProvider(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<WorkspaceCredentialProviderRow | null> {
  return withRlsContext(db, scope, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(workspaceCredentialProviders)
      .where(
        and(
          eq(workspaceCredentialProviders.accountId, scope.accountId),
          eq(workspaceCredentialProviders.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Create or replace the workspace's single provider. Omit the secret to keep it. */
export async function upsertWorkspaceCredentialProvider(
  db: Database,
  input: WorkspaceIntegrationScope & {
    url: string;
    secretEncrypted?: string;
    enabled: boolean;
    timeoutMs: number;
    createdBySubjectId: string | null;
  },
): Promise<WorkspaceCredentialProviderRow> {
  return withRlsContext(db, input, async (scopedDb) => {
    if (input.secretEncrypted === undefined) {
      const [updated] = await scopedDb
        .update(workspaceCredentialProviders)
        .set({
          url: input.url,
          enabled: input.enabled,
          timeoutMs: input.timeoutMs,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(workspaceCredentialProviders.accountId, input.accountId),
            eq(workspaceCredentialProviders.workspaceId, input.workspaceId),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error("a signing secret is required when creating a credential provider");
      }
      return updated;
    }
    const [row] = await scopedDb
      .insert(workspaceCredentialProviders)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        url: input.url,
        secretEncrypted: input.secretEncrypted,
        enabled: input.enabled,
        timeoutMs: input.timeoutMs,
        createdBySubjectId: input.createdBySubjectId,
      })
      .onConflictDoUpdate({
        target: workspaceCredentialProviders.workspaceId,
        set: {
          url: input.url,
          secretEncrypted: input.secretEncrypted,
          enabled: input.enabled,
          timeoutMs: input.timeoutMs,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  });
}

export async function deleteWorkspaceCredentialProvider(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<boolean> {
  return withRlsContext(db, scope, async (scopedDb) => {
    const deleted = await scopedDb
      .delete(workspaceCredentialProviders)
      .where(
        and(
          eq(workspaceCredentialProviders.accountId, scope.accountId),
          eq(workspaceCredentialProviders.workspaceId, scope.workspaceId),
        ),
      )
      .returning({ id: workspaceCredentialProviders.id });
    return deleted.length > 0;
  });
}

export async function listWorkspaceWebhooks(
  db: Database,
  scope: WorkspaceIntegrationScope,
): Promise<WorkspaceWebhookRow[]> {
  return withRlsContext(db, scope, async (scopedDb) =>
    scopedDb
      .select()
      .from(workspaceWebhooks)
      .where(
        and(
          eq(workspaceWebhooks.accountId, scope.accountId),
          eq(workspaceWebhooks.workspaceId, scope.workspaceId),
        ),
      )
      .orderBy(workspaceWebhooks.createdAt, workspaceWebhooks.id),
  );
}

export async function getWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string },
): Promise<WorkspaceWebhookRow | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .select()
      .from(workspaceWebhooks)
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

export async function createWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & {
    url: string;
    secretEncrypted: string;
    eventTypes: string[];
    enabled: boolean;
    description: string | null;
    createdBySubjectId: string | null;
  },
): Promise<WorkspaceWebhookRow> {
  return withRlsContext(db, input, async (scopedDb) => {
    // Serialize creates per workspace so the count check cannot race.
    await scopedDb.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-webhooks:${input.workspaceId}`}, 0))`,
    );
    const [counted] = await rawRows<{ count: number }>(
      scopedDb,
      sql`select count(*)::integer as count from workspace_webhooks
        where account_id = ${input.accountId}::uuid and workspace_id = ${input.workspaceId}::uuid`,
    );
    if ((counted?.count ?? 0) >= WORKSPACE_WEBHOOK_LIMIT) {
      throw new WorkspaceWebhookLimitError();
    }
    const [row] = await scopedDb
      .insert(workspaceWebhooks)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        url: input.url,
        secretEncrypted: input.secretEncrypted,
        eventTypes: input.eventTypes,
        enabled: input.enabled,
        description: input.description,
        createdBySubjectId: input.createdBySubjectId,
      })
      .returning();
    return row!;
  });
}

export async function updateWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & {
    webhookId: string;
    url?: string;
    eventTypes?: string[];
    enabled?: boolean;
    description?: string | null;
  },
): Promise<WorkspaceWebhookRow | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .update(workspaceWebhooks)
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .returning();
    return row ?? null;
  });
}

export async function deleteWorkspaceWebhook(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string },
): Promise<boolean> {
  return withRlsContext(db, input, async (scopedDb) => {
    const deleted = await scopedDb
      .delete(workspaceWebhooks)
      .where(
        and(
          eq(workspaceWebhooks.accountId, input.accountId),
          eq(workspaceWebhooks.workspaceId, input.workspaceId),
          eq(workspaceWebhooks.id, input.webhookId),
        ),
      )
      .returning({ id: workspaceWebhooks.id });
    return deleted.length > 0;
  });
}

export async function listWorkspaceWebhookDeliveries(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string; limit?: number },
): Promise<WorkspaceWebhookDeliveryRow[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  return withRlsContext(db, input, async (scopedDb) =>
    scopedDb
      .select()
      .from(workspaceWebhookDeliveries)
      .where(
        and(
          eq(workspaceWebhookDeliveries.accountId, input.accountId),
          eq(workspaceWebhookDeliveries.workspaceId, input.workspaceId),
          eq(workspaceWebhookDeliveries.webhookId, input.webhookId),
        ),
      )
      .orderBy(desc(workspaceWebhookDeliveries.createdAt), desc(workspaceWebhookDeliveries.id))
      .limit(limit),
  );
}

/** Put a settled delivery back on the queue with a fresh attempt budget. */
export async function redeliverWorkspaceWebhookDelivery(
  db: Database,
  input: WorkspaceIntegrationScope & { webhookId: string; deliveryId: string },
): Promise<WorkspaceWebhookDeliveryRow | null> {
  return withRlsContext(db, input, async (scopedDb) => {
    const [row] = await scopedDb
      .update(workspaceWebhookDeliveries)
      .set({
        attempts: 0,
        deliveredAt: null,
        failedAt: null,
        claimId: null,
        claimUntil: null,
        nextAttemptAt: sql`now()`,
      })
      .where(
        and(
          eq(workspaceWebhookDeliveries.accountId, input.accountId),
          eq(workspaceWebhookDeliveries.workspaceId, input.workspaceId),
          eq(workspaceWebhookDeliveries.webhookId, input.webhookId),
          eq(workspaceWebhookDeliveries.id, input.deliveryId),
          sql`(${workspaceWebhookDeliveries.deliveredAt} is not null or ${workspaceWebhookDeliveries.failedAt} is not null)`,
        ),
      )
      .returning();
    return row ?? null;
  });
}

export type ClaimedWorkspaceWebhookDelivery = {
  deliveryId: string;
  accountId: string;
  workspaceId: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
  url: string;
  secretEncrypted: string;
};

/** Cross-workspace claim for the single dispatcher loop. */
export async function claimWorkspaceWebhookDeliveries(
  db: Database,
  input: { claimId: string; limit?: number; claimSeconds?: number },
): Promise<ClaimedWorkspaceWebhookDelivery[]> {
  const rows = await rawRows<{
    delivery_id: string;
    account_id: string;
    workspace_id: string;
    webhook_id: string;
    event_id: string;
    event_type: string;
    payload: unknown;
    attempts: number;
    url: string;
    secret_encrypted: string;
  }>(
    db,
    sql`select * from opengeni_private.claim_workspace_webhook_deliveries_v1(
      ${input.claimId}::uuid, ${input.limit ?? 32}::integer, ${input.claimSeconds ?? 60}::integer
    )`,
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    attempts: row.attempts,
    url: row.url,
    secretEncrypted: row.secret_encrypted,
  }));
}

export async function settleWorkspaceWebhookDelivery(
  db: Database,
  input: {
    deliveryId: string;
    claimId: string;
    status: number | null;
    error: string | null;
    maxAttempts?: number;
  },
): Promise<boolean> {
  const [row] = await rawRows<{ settled: boolean }>(
    db,
    sql`select opengeni_private.settle_workspace_webhook_delivery_v1(
      ${input.deliveryId}::uuid,
      ${input.claimId}::uuid,
      ${input.status}::integer,
      ${input.error}::text,
      ${input.maxAttempts ?? WORKSPACE_WEBHOOK_MAX_ATTEMPTS}::integer
    ) as settled`,
  );
  return row?.settled === true;
}

export async function pruneWorkspaceWebhookDeliveries(
  db: Database,
  input: { retentionSeconds?: number; limit?: number } = {},
): Promise<number> {
  const [row] = await rawRows<{ pruned: number }>(
    db,
    sql`select opengeni_private.prune_workspace_webhook_deliveries_v1(
      ${input.retentionSeconds ?? 604_800}::integer, ${input.limit ?? 500}::integer
    ) as pruned`,
  );
  return row?.pruned ?? 0;
}
