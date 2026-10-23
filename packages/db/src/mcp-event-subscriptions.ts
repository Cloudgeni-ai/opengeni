import { and, eq, sql } from "drizzle-orm";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import { automationsListenTo } from "./event-trigger-listening";
import {
  recordEventDeliveryInTransaction,
  type RecordEventDeliveryInput,
  type RecordEventDeliveryResult,
} from "./event-triggers";
import * as schema from "./schema";

// Migration 0932. One MCP Events subscription per (source, event name,
// canonical arguments) that runnable automations want. The subscription pump
// claims due subscriptions, polls or subscribes them as the source's owner,
// and records their events through the ordinary event intake with the
// subscription's stream key, so only that subscription's triggers fire.

type SubscriptionRow = typeof schema.mcpEventSubscriptions.$inferSelect;

export type McpEventSubscriptionMode = "poll" | "webhook";

export type McpEventSubscriptionRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  sourceId: string;
  streamKey: string;
  eventName: string;
  arguments: Record<string, unknown>;
  mode: McpEventSubscriptionMode | null;
  cursor: string | null;
  gapPending: boolean;
  routeId: string | null;
  secretEncrypted: string | null;
  serverSubscriptionId: string | null;
  refreshBefore: Date | null;
  nextActionAt: Date;
  failures: number;
  failingSince: Date | null;
  lastError: string | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function mapSubscription(row: SubscriptionRow): McpEventSubscriptionRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    streamKey: row.streamKey,
    eventName: row.eventName,
    arguments: row.arguments,
    mode: (row.mode as McpEventSubscriptionMode | null) ?? null,
    cursor: row.cursor,
    gapPending: row.gapPending,
    routeId: row.routeId,
    secretEncrypted: row.secretEncrypted,
    serverSubscriptionId: row.serverSubscriptionId,
    refreshBefore: row.refreshBefore,
    nextActionAt: row.nextActionAt,
    failures: row.failures,
    failingSince: row.failingSince,
    lastError: row.lastError,
    lastSuccessAt: row.lastSuccessAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Identity-only inventory of subscriptions whose next step is due; every read after it is workspace-scoped. */
export async function listDueMcpEventSubscriptions(
  db: Database,
  limit = 32,
): Promise<Array<{ id: string; workspaceId: string }>> {
  const rows = await rawRows<{ subscription_id: string; workspace_id: string }>(
    db,
    sql`select * from opengeni_private.list_due_mcp_event_subscriptions_v1(${limit})`,
  );
  return rows.map((row) => ({ id: row.subscription_id, workspaceId: row.workspace_id }));
}

export type ClaimedMcpEventSubscription = {
  subscription: McpEventSubscriptionRecord;
  /** False when no runnable automation wants it any more: end it. */
  wanted: boolean;
};

/**
 * Lease a due subscription for one pump step. Another pump holding the lease,
 * or a step that is no longer due, makes this a no-op (null).
 */
export async function claimMcpEventSubscription(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
  leaseMs: number,
): Promise<ClaimedMcpEventSubscription | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .update(schema.mcpEventSubscriptions)
        .set({
          leaseUntil: sql`now() + make_interval(secs => ${Math.max(1, leaseMs) / 1000}::double precision)`,
        })
        .where(
          and(
            eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
            eq(schema.mcpEventSubscriptions.id, subscriptionId),
            sql`${schema.mcpEventSubscriptions.nextActionAt} <= now()`,
            sql`(${schema.mcpEventSubscriptions.leaseUntil} is null or ${schema.mcpEventSubscriptions.leaseUntil} <= now())`,
          ),
        )
        .returning();
      if (!row) return null;
      const [wanted] = await rawRows<{ wanted: boolean }>(
        tx,
        sql`select ${automationsListenTo(workspaceId, sql`${row.sourceId}::uuid`, sql`${row.streamKey}`)} as wanted`,
      );
      return { subscription: mapSubscription(row), wanted: wanted?.wanted === true };
    }),
  );
}

export type McpEventSubscriptionStepResult = {
  /** Undefined keeps the stored value. */
  mode?: McpEventSubscriptionMode;
  cursor?: string | null;
  gapPending?: boolean;
  serverSubscriptionId?: string | null;
  refreshBefore?: Date | null;
  nextActionAt: Date;
  outcome: { kind: "success" } | { kind: "failure"; error: string };
};

/** Store a step's result and release the lease. */
export async function finishMcpEventSubscriptionStep(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
  result: McpEventSubscriptionStepResult,
): Promise<McpEventSubscriptionRecord | null> {
  const success = result.outcome.kind === "success";
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .update(schema.mcpEventSubscriptions)
      .set({
        ...(result.mode !== undefined ? { mode: result.mode } : {}),
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        ...(result.gapPending !== undefined ? { gapPending: result.gapPending } : {}),
        ...(result.serverSubscriptionId !== undefined
          ? { serverSubscriptionId: result.serverSubscriptionId }
          : {}),
        ...(result.refreshBefore !== undefined ? { refreshBefore: result.refreshBefore } : {}),
        nextActionAt: result.nextActionAt,
        leaseUntil: null,
        ...(success
          ? { failures: 0, failingSince: null, lastError: null, lastSuccessAt: sql`now()` }
          : {
              failures: sql`${schema.mcpEventSubscriptions.failures} + 1`,
              failingSince: sql`coalesce(${schema.mcpEventSubscriptions.failingSince}, now())`,
              lastError:
                result.outcome.kind === "failure"
                  ? result.outcome.error.slice(0, 500) || "The step failed"
                  : null,
            }),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
          eq(schema.mcpEventSubscriptions.id, subscriptionId),
        ),
      )
      .returning();
    return row ? mapSubscription(row) : null;
  });
}

/** End a subscription: its row and its webhook route. Later deliveries to the route get 410. */
export async function deleteMcpEventSubscription(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .delete(schema.mcpEventSubscriptions)
        .where(
          and(
            eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
            eq(schema.mcpEventSubscriptions.id, subscriptionId),
          ),
        )
        .returning({ routeId: schema.mcpEventSubscriptions.routeId });
      if (row?.routeId) {
        await tx
          .delete(schema.eventIngressRoutes)
          .where(eq(schema.eventIngressRoutes.routeId, row.routeId));
      }
    }),
  );
}

/**
 * Give a subscription its own webhook route and signing secret, once. The
 * route exists before `events/subscribe` is called, so the server's first
 * `verification` POST already finds the secret by URL.
 */
export async function ensureMcpEventSubscriptionWebhook(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
  secretEncrypted: string,
): Promise<{ routeId: string; secretEncrypted: string } | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.mcpEventSubscriptions)
        .where(
          and(
            eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
            eq(schema.mcpEventSubscriptions.id, subscriptionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return null;
      if (row.routeId && row.secretEncrypted) {
        return { routeId: row.routeId, secretEncrypted: row.secretEncrypted };
      }
      const [route] = await tx
        .insert(schema.eventIngressRoutes)
        .values({
          accountId: row.accountId,
          workspaceId: row.workspaceId,
          sourceId: row.sourceId,
          kind: "mcp",
          externalKey: null,
        })
        .returning({ routeId: schema.eventIngressRoutes.routeId });
      if (!route) throw new Error("MCP event webhook route was not created");
      await tx
        .update(schema.mcpEventSubscriptions)
        .set({
          mode: "webhook",
          routeId: route.routeId,
          secretEncrypted,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.mcpEventSubscriptions.id, row.id));
      return { routeId: route.routeId, secretEncrypted };
    }),
  );
}

/** Leave webhook mode: drop the route and secret so the subscription polls instead. */
export async function dropMcpEventSubscriptionWebhook(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .select({ routeId: schema.mcpEventSubscriptions.routeId })
        .from(schema.mcpEventSubscriptions)
        .where(
          and(
            eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
            eq(schema.mcpEventSubscriptions.id, subscriptionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return;
      await tx
        .update(schema.mcpEventSubscriptions)
        .set({
          mode: "poll",
          routeId: null,
          secretEncrypted: null,
          serverSubscriptionId: null,
          refreshBefore: null,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.mcpEventSubscriptions.id, subscriptionId));
      if (row.routeId) {
        await tx
          .delete(schema.eventIngressRoutes)
          .where(eq(schema.eventIngressRoutes.routeId, row.routeId));
      }
    }),
  );
}

/** The subscription a webhook route belongs to, including its encrypted secret. */
export async function getMcpEventSubscriptionByRoute(
  db: Database,
  workspaceId: string,
  routeId: string,
): Promise<McpEventSubscriptionRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.mcpEventSubscriptions)
      .where(
        and(
          eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
          eq(schema.mcpEventSubscriptions.routeId, routeId),
        ),
      )
      .limit(1);
    return row ? mapSubscription(row) : null;
  });
}

export async function getMcpEventSubscription(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
): Promise<McpEventSubscriptionRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.mcpEventSubscriptions)
      .where(
        and(
          eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
          eq(schema.mcpEventSubscriptions.id, subscriptionId),
        ),
      )
      .limit(1);
    return row ? mapSubscription(row) : null;
  });
}

/** Store a subscription's server id once its webhook subscribe call returned. */
export async function setMcpEventSubscriptionServerId(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
  serverSubscriptionId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped
      .update(schema.mcpEventSubscriptions)
      .set({ serverSubscriptionId, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
          eq(schema.mcpEventSubscriptions.id, subscriptionId),
        ),
      ),
  );
}

export type RecordMcpEventDeliveryInput = {
  workspaceId: string;
  subscriptionId: string;
  delivery: Omit<RecordEventDeliveryInput, "streamKey" | "accountId" | "workspaceId" | "sourceId">;
  /** The position after this delivery; undefined keeps the stored cursor. */
  cursor?: string | null;
  /** The server skipped events before this delivery. */
  truncated?: boolean;
};

export type RecordMcpEventDeliveryResult = RecordEventDeliveryResult & {
  subscription: McpEventSubscriptionRecord;
};

/**
 * Record a delivery of a subscription's events and advance its cursor in one
 * transaction, so a crash never stores events without their position or the
 * reverse. A pending or reported gap marks the first newly stored event.
 */
export async function recordMcpEventDelivery(
  db: Database,
  input: RecordMcpEventDeliveryInput,
): Promise<RecordMcpEventDeliveryResult | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.mcpEventSubscriptions)
        .where(
          and(
            eq(schema.mcpEventSubscriptions.workspaceId, input.workspaceId),
            eq(schema.mcpEventSubscriptions.id, input.subscriptionId),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return null;
      const gap = row.gapPending || input.truncated === true;
      const events = input.delivery.events.map((event, index) => ({
        ...event,
        streamKey: row.streamKey,
        gapBefore: event.gapBefore || (gap && index === 0),
      }));
      const recorded = await recordEventDeliveryInTransaction(tx, {
        ...input.delivery,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        sourceId: row.sourceId,
        streamKey: row.streamKey,
        events,
      });
      const stored = recorded.eventIds.length > 0;
      const [updated] = await tx
        .update(schema.mcpEventSubscriptions)
        .set({
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
          gapPending: gap && !stored,
          updatedAt: sql`now()`,
        })
        .where(eq(schema.mcpEventSubscriptions.id, row.id))
        .returning();
      return { ...recorded, subscription: mapSubscription(updated ?? row) };
    }),
  );
}

/** Mark that the server skipped events, with the fresh cursor it gave. */
export async function recordMcpEventGap(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
  cursor: string | null,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped
      .update(schema.mcpEventSubscriptions)
      .set({ cursor, gapPending: true, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
          eq(schema.mcpEventSubscriptions.id, subscriptionId),
        ),
      ),
  );
}

/** Wake a subscription now: the server ended it, or nothing may want it any more. */
export async function wakeMcpEventSubscription(
  db: Database,
  workspaceId: string,
  subscriptionId: string,
  options: { forgetServerSubscription?: boolean; onlyIfUnwanted?: boolean } = {},
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped.execute(
      sql`update mcp_event_subscriptions subscription
        set next_action_at = least(subscription.next_action_at, now()),
          ${options.forgetServerSubscription ? sql`server_subscription_id = null, refresh_before = null,` : sql``}
          updated_at = now()
        where subscription.workspace_id = ${workspaceId} and subscription.id = ${subscriptionId}
          ${
            options.onlyIfUnwanted
              ? sql`and not ${automationsListenTo(workspaceId, sql`subscription.source_id`, sql`subscription.stream_key`)}`
              : sql``
          }`,
    ),
  );
}

/** The streams of a source that automations listen on for one event name. */
export async function listMcpEventStreamKeys(
  db: Database,
  workspaceId: string,
  sourceId: string,
  eventName: string,
): Promise<string[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await rawRows<{ stream_key: string }>(
      scoped,
      sql`select distinct stream_key from event_triggers
        where workspace_id = ${workspaceId} and source_id = ${sourceId}
          and stream_key <> '' and event_types[1] = ${eventName}
        order by stream_key limit 50`,
    );
    return rows.map((row) => row.stream_key);
  });
}

/** The subscriptions of one source, for its owner's view of what it listens to. */
export async function listMcpEventSubscriptionsForSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
): Promise<McpEventSubscriptionRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.mcpEventSubscriptions)
      .where(
        and(
          eq(schema.mcpEventSubscriptions.workspaceId, workspaceId),
          eq(schema.mcpEventSubscriptions.sourceId, sourceId),
        ),
      )
      .orderBy(schema.mcpEventSubscriptions.eventName, schema.mcpEventSubscriptions.id);
    return rows.map(mapSubscription);
  });
}
