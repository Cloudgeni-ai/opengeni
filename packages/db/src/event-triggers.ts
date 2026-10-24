import {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  EventCondition,
  InboundEventSummary,
  type EventActor,
  type EventDelivery,
  type EventDeliveryStatus,
  type EventSourceKind,
  type EventSourceStatus,
  type EventSourceVisibility,
  type EventTrigger,
  type InboundEvent,
  type ParsedEventTriggerInput,
  type ScheduledTaskEvents,
  type ScheduledTaskRunEventOccurrence,
  type WebhookEventAdapter,
} from "@opengeni/contracts";
import { createHmac } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { rawRows, withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

// Migration 0929. Event sources deliver into a workspace; each raw delivery is
// stored, verified and deduplicated, then normalized into events. Matching an
// event against active triggers queues it in its automation's inbox in the
// same transaction. The dispatcher folds an automation's inbox into one
// occurrence, which becomes one scheduled-task run with trigger type `event`.

type SourceRow = typeof schema.eventSources.$inferSelect;
type DeliveryRow = typeof schema.eventDeliveries.$inferSelect;
type EventRow = typeof schema.inboundEvents.$inferSelect;
type TriggerRow = typeof schema.eventTriggers.$inferSelect;

/** The Temporal workflow id, and so the run producer key, of an occurrence's run. */
export function eventOccurrenceProducerKey(occurrenceId: string): string {
  return `scheduled-task-event:${occurrenceId}`;
}

export type EventSourceRecord = {
  id: string;
  accountId: string;
  workspaceId: string;
  kind: EventSourceKind;
  adapter: WebhookEventAdapter | null;
  name: string;
  ownerSubjectId: string | null;
  visibility: EventSourceVisibility;
  status: EventSourceStatus;
  statusReason: string | null;
  secretEncrypted: string | null;
  externalKey: string | null;
  mcpServerId: string | null;
  connectionId: string | null;
  /** The webhook URL's route id; null for sources without a URL. */
  routeId: string | null;
  lastDeliveryAt: Date | null;
  createdBySubjectId: string;
  createdAt: Date;
  updatedAt: Date;
};

function mapSource(row: SourceRow, routeId: string | null): EventSourceRecord {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    kind: row.kind as EventSourceKind,
    adapter: (row.adapter as WebhookEventAdapter | null) ?? null,
    name: row.name,
    ownerSubjectId: row.ownerSubjectId,
    visibility: row.visibility as EventSourceVisibility,
    status: row.status as EventSourceStatus,
    statusReason: row.statusReason,
    secretEncrypted: row.secretEncrypted,
    externalKey: row.externalKey,
    mcpServerId: row.mcpServerId,
    connectionId: row.connectionId,
    routeId,
    lastDeliveryAt: row.lastDeliveryAt,
    createdBySubjectId: row.createdBySubjectId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Whether a person (or, with null, a workspace-level caller) may see and use a source. */
export function eventSourceVisibleTo(
  source: Pick<EventSourceRecord, "visibility" | "ownerSubjectId">,
  subjectId: string | null,
): boolean {
  return (
    source.visibility === "workspace" ||
    source.ownerSubjectId === null ||
    (subjectId !== null && source.ownerSubjectId === subjectId)
  );
}

async function routesBySource(db: Database, sourceIds: string[]): Promise<Map<string, string>> {
  if (sourceIds.length === 0) return new Map();
  const rows = await db
    .select({
      sourceId: schema.eventIngressRoutes.sourceId,
      routeId: schema.eventIngressRoutes.routeId,
    })
    .from(schema.eventIngressRoutes)
    .where(
      and(
        inArray(schema.eventIngressRoutes.sourceId, sourceIds),
        eq(schema.eventIngressRoutes.kind, "webhook"),
      ),
    );
  return new Map(rows.map((row) => [row.sourceId, row.routeId]));
}

export type CreateEventSourceInput = {
  accountId: string;
  workspaceId: string;
  createdBySubjectId: string;
  kind: EventSourceKind;
  name: string;
  ownerSubjectId: string | null;
  visibility: EventSourceVisibility;
  adapter?: WebhookEventAdapter | null;
  secretEncrypted?: string | null;
  /** Defaults to active; a pasted webhook waiting for its secret starts blocked. */
  status?: EventSourceStatus;
  statusReason?: string | null;
  externalKey?: string | null;
  mcpServerId?: string | null;
  connectionId?: string | null;
  /** A GitHub source's routes are keyed with this (see githubInstallationRouteKey). */
  routeSecret?: Uint8Array | null;
};

/**
 * Create a source. Webhook sources are always new and get a routed URL. App
 * and MCP sources are one per installation, mailbox or connection: creating
 * one that exists returns it unchanged (`created: false`), except that a
 * GitHub source's routes are recomputed either way, which repairs lost ones.
 */
export async function createEventSource(
  db: Database,
  input: CreateEventSourceInput,
): Promise<{ source: EventSourceRecord; created: boolean }> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const values = {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        adapter: input.adapter ?? null,
        name: input.name,
        ownerSubjectId: input.ownerSubjectId,
        visibility: input.visibility,
        secretEncrypted: input.secretEncrypted ?? null,
        ...(input.status ? { status: input.status, statusReason: input.statusReason ?? null } : {}),
        externalKey: input.externalKey ?? null,
        mcpServerId: input.mcpServerId ?? null,
        connectionId: input.connectionId ?? null,
        createdBySubjectId: input.createdBySubjectId,
      };
      const [inserted] = await tx
        .insert(schema.eventSources)
        .values(values)
        .onConflictDoNothing()
        .returning();
      if (!inserted) {
        const [existing] = await tx
          .select()
          .from(schema.eventSources)
          .where(
            and(
              eq(schema.eventSources.workspaceId, input.workspaceId),
              eq(schema.eventSources.kind, input.kind),
              input.kind === "mcp"
                ? and(
                    eq(schema.eventSources.mcpServerId, input.mcpServerId ?? ""),
                    input.ownerSubjectId === null
                      ? isNull(schema.eventSources.ownerSubjectId)
                      : eq(schema.eventSources.ownerSubjectId, input.ownerSubjectId),
                    input.connectionId
                      ? eq(schema.eventSources.connectionId, input.connectionId)
                      : isNull(schema.eventSources.connectionId),
                  )
                : eq(schema.eventSources.externalKey, input.externalKey ?? ""),
            ),
          )
          .limit(1);
        if (!existing) throw new Error("event source create conflicted without an existing source");
        if (input.kind === "github") {
          await syncGitHubEventRoutes(tx, input.workspaceId, input.routeSecret ?? null);
        }
        return { source: mapSource(existing, null), created: false };
      }
      // A generic webhook's URL names its own route, and a GitHub source is
      // routed by its workspace's installations. Slack callbacks arrive
      // already resolved to their workspace, Gmail is read rather than
      // delivered, and an MCP subscription adds its webhook route when it
      // subscribes, so those get none here.
      let routeId: string | null = null;
      if (input.kind === "github") {
        await syncGitHubEventRoutes(tx, inserted.workspaceId, input.routeSecret ?? null);
      } else if (input.kind === "webhook") {
        const [route] = await tx
          .insert(schema.eventIngressRoutes)
          .values({
            accountId: inserted.accountId,
            workspaceId: inserted.workspaceId,
            sourceId: inserted.id,
            kind: "webhook",
          })
          .returning({ routeId: schema.eventIngressRoutes.routeId });
        routeId = route?.routeId ?? null;
      }
      if (eventSourceKindHasFeed(input.kind)) {
        await tx.insert(schema.eventSourceFeeds).values({
          sourceId: inserted.id,
          accountId: inserted.accountId,
          workspaceId: inserted.workspaceId,
        });
      }
      return { source: mapSource(inserted, routeId), created: true };
    }),
  );
}

/**
 * Sources whose events Opengeni reads from the app's change history instead
 * of receiving them: each has a feed (migration 0935) the feed pump reads.
 */
export function eventSourceKindHasFeed(kind: EventSourceKind): boolean {
  return kind === "gmail";
}

/** Have the feed pump read these sources' feeds now. */
export async function wakeEventSourceFeeds(
  scoped: Database,
  workspaceId: string,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  await scoped
    .update(schema.eventSourceFeeds)
    .set({ nextActionAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(schema.eventSourceFeeds.workspaceId, workspaceId),
        inArray(schema.eventSourceFeeds.sourceId, [...sourceIds]),
        sql`${schema.eventSourceFeeds.nextActionAt} > now()`,
      ),
    );
}

/**
 * The route key of one GitHub App installation's deliveries.
 * event_ingress_routes has no tenant RLS (intake finds the workspace through
 * it), so it never holds a provider identity: the key is an HMAC-SHA-256 of
 * the installation under the deployment's route secret. Equality lookups work
 * the same; the table alone tells nobody which installation a workspace uses.
 */
export function githubInstallationRouteKey(
  routeSecret: Uint8Array,
  installationId: number,
): string {
  return createHmac("sha256", routeSecret)
    .update(`github installation ${installationId}`)
    .digest("hex");
}

/**
 * A workspace's GitHub source receives the deliveries of every GitHub App
 * installation bound to the workspace. Its routes are recomputed from the
 * bindings whenever a binding or the source changes, inside the writer's
 * workspace scope. Intake still checks each delivery's repository against the
 * workspace's current binding, so a route is only ever a candidate. Without a
 * route secret (a deployment with no encryption key) nothing can be routed,
 * so the source keeps no routes.
 */
export async function syncGitHubEventRoutes(
  scoped: Database,
  workspaceId: string,
  routeSecret: Uint8Array | null,
): Promise<void> {
  const sources = await scoped
    .select({ id: schema.eventSources.id, accountId: schema.eventSources.accountId })
    .from(schema.eventSources)
    .where(
      and(eq(schema.eventSources.workspaceId, workspaceId), eq(schema.eventSources.kind, "github")),
    );
  if (sources.length === 0) return;
  const installations = routeSecret
    ? await scoped
        .select({ installationId: schema.githubInstallations.installationId })
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.workspaceId, workspaceId))
    : [];
  const wanted = new Set(
    installations.map((row) => githubInstallationRouteKey(routeSecret!, row.installationId)),
  );
  for (const source of sources) {
    const routes = await scoped
      .select({
        routeId: schema.eventIngressRoutes.routeId,
        externalKey: schema.eventIngressRoutes.externalKey,
      })
      .from(schema.eventIngressRoutes)
      .where(eq(schema.eventIngressRoutes.sourceId, source.id));
    const stale = routes.filter((route) => !wanted.has(route.externalKey ?? ""));
    if (stale.length > 0) {
      await scoped.delete(schema.eventIngressRoutes).where(
        inArray(
          schema.eventIngressRoutes.routeId,
          stale.map((route) => route.routeId),
        ),
      );
    }
    const present = new Set(routes.map((route) => route.externalKey));
    const missing = [...wanted].filter((key) => !present.has(key));
    if (missing.length > 0) {
      await scoped.insert(schema.eventIngressRoutes).values(
        missing.map((externalKey) => ({
          accountId: source.accountId,
          workspaceId,
          sourceId: source.id,
          kind: "github",
          externalKey,
        })),
      );
    }
  }
}

/** Sources a person can see: shared ones, workspace app sources and their own. */
export async function listEventSources(
  db: Database,
  workspaceId: string,
  viewerSubjectId: string | null,
): Promise<EventSourceRecord[]> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.eventSources)
      .where(
        and(
          eq(schema.eventSources.workspaceId, workspaceId),
          or(
            eq(schema.eventSources.visibility, "workspace"),
            isNull(schema.eventSources.ownerSubjectId),
            ...(viewerSubjectId ? [eq(schema.eventSources.ownerSubjectId, viewerSubjectId)] : []),
          ),
        ),
      )
      .orderBy(desc(schema.eventSources.createdAt), desc(schema.eventSources.id));
    const routes = await routesBySource(
      scoped,
      rows.map((row) => row.id),
    );
    return rows.map((row) => mapSource(row, routes.get(row.id) ?? null));
  });
}

/** One source, including its encrypted secret. Callers check visibility. */
export async function getEventSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
): Promise<EventSourceRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.eventSources)
      .where(
        and(eq(schema.eventSources.workspaceId, workspaceId), eq(schema.eventSources.id, sourceId)),
      )
      .limit(1);
    if (!row) return null;
    const routes = await routesBySource(scoped, [row.id]);
    return mapSource(row, routes.get(row.id) ?? null);
  });
}

/** A workspace's app source for one app identity (a Slack team), if it has one. */
export async function findAppEventSource(
  db: Database,
  workspaceId: string,
  kind: "slack",
  externalKey: string,
): Promise<EventSourceRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.eventSources)
      .where(
        and(
          eq(schema.eventSources.workspaceId, workspaceId),
          eq(schema.eventSources.kind, kind),
          eq(schema.eventSources.externalKey, externalKey),
        ),
      )
      .limit(1);
    return row ? mapSource(row, null) : null;
  });
}

export async function updateEventSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
  patch: {
    name?: string;
    visibility?: EventSourceVisibility;
    status?: EventSourceStatus;
    statusReason?: string | null;
    secretEncrypted?: string;
  },
): Promise<EventSourceRecord | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .update(schema.eventSources)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.status !== undefined
          ? {
              status: patch.status,
              statusReason: patch.status === "active" ? null : (patch.statusReason ?? null),
            }
          : {}),
        ...(patch.secretEncrypted !== undefined ? { secretEncrypted: patch.secretEncrypted } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(schema.eventSources.workspaceId, workspaceId), eq(schema.eventSources.id, sourceId)),
      )
      .returning();
    if (!row) return null;
    // Turning a source off or on, or sharing it, changes whether its feed is wanted.
    if (patch.status !== undefined || patch.visibility !== undefined) {
      await wakeEventSourceFeeds(scoped, workspaceId, [row.id]);
    }
    const routes = await routesBySource(scoped, [row.id]);
    return mapSource(row, routes.get(row.id) ?? null);
  });
}

/**
 * Delete a source and its history. A source automations still use is kept:
 * the result names them so the caller can say which to change first.
 */
export async function deleteEventSource(
  db: Database,
  workspaceId: string,
  sourceId: string,
): Promise<{ kind: "deleted" } | { kind: "missing" } | { kind: "in_use"; taskIds: string[] }> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const users = await rawRows<{ task_id: string }>(
        tx,
        sql`select distinct trigger.task_id from event_triggers trigger
          join scheduled_tasks task on task.id = trigger.task_id and task.workspace_id = trigger.workspace_id
          where trigger.workspace_id = ${workspaceId} and trigger.source_id = ${sourceId}
            and task.deleted_at is null
          order by trigger.task_id limit 20`,
      );
      if (users.length > 0)
        return { kind: "in_use" as const, taskIds: users.map((row) => row.task_id) };
      const deleted = await tx
        .delete(schema.eventSources)
        .where(
          and(
            eq(schema.eventSources.workspaceId, workspaceId),
            eq(schema.eventSources.id, sourceId),
          ),
        )
        .returning({ id: schema.eventSources.id });
      return deleted.length > 0 ? { kind: "deleted" as const } : { kind: "missing" as const };
    }),
  );
}

/** Credential-free lookup of a webhook URL's route; the source row still authenticates. */
export async function resolveEventIngressRoute(
  db: Database,
  routeId: string,
): Promise<{
  accountId: string;
  workspaceId: string;
  sourceId: string;
  kind: EventSourceKind;
} | null> {
  const [row] = await db
    .select({
      accountId: schema.eventIngressRoutes.accountId,
      workspaceId: schema.eventIngressRoutes.workspaceId,
      sourceId: schema.eventIngressRoutes.sourceId,
      kind: schema.eventIngressRoutes.kind,
    })
    .from(schema.eventIngressRoutes)
    .where(eq(schema.eventIngressRoutes.routeId, routeId))
    .limit(1);
  return row ? { ...row, kind: row.kind as EventSourceKind } : null;
}

/** Every workspace GitHub source one GitHub App installation delivers to. */
export async function listGitHubEventRoutes(
  db: Database,
  routeSecret: Uint8Array,
  installationId: number,
): Promise<Array<{ accountId: string; workspaceId: string; sourceId: string }>> {
  return await db
    .select({
      accountId: schema.eventIngressRoutes.accountId,
      workspaceId: schema.eventIngressRoutes.workspaceId,
      sourceId: schema.eventIngressRoutes.sourceId,
    })
    .from(schema.eventIngressRoutes)
    .where(
      and(
        eq(schema.eventIngressRoutes.kind, "github"),
        eq(
          schema.eventIngressRoutes.externalKey,
          githubInstallationRouteKey(routeSecret, installationId),
        ),
      ),
    )
    .limit(100);
}

/** One normalized event, bounded to its columns. */
export type StoredEventInput = {
  externalId: string | null;
  streamKey: string;
  type: string;
  occurredAt: Date;
  subject: string | null;
  summary: string;
  url: string | null;
  actor: EventActor;
  data: Record<string, unknown>;
  dataTruncated: boolean;
  gapBefore: boolean;
};

/** The parts of a stored trigger a matcher reads. */
export type EventTriggerMatchInput = {
  eventTypes: readonly string[];
  conditions: readonly EventCondition[];
  includeOwnEvents: boolean;
};

/** Decides whether an event fires a trigger; supplied by the caller (core matching). */
export type EventTriggerMatcher = (
  event: Pick<StoredEventInput, "type" | "subject" | "summary" | "url" | "actor" | "data">,
  trigger: EventTriggerMatchInput,
) => boolean;

export type RecordEventDeliveryInput = {
  accountId: string;
  workspaceId: string;
  sourceId: string;
  /** The MCP subscription stream the delivery arrived on; empty for other sources. */
  streamKey?: string;
  status: EventDeliveryStatus;
  reason: string | null;
  /** The sender's delivery identity, or a digest of the body. */
  dedupeKey: string;
  /** The verified raw body, kept for replay; null for rejected deliveries. */
  body: Uint8Array | null;
  bodyBytes: number;
  bodySha256: string;
  headers: Record<string, string>;
  events: StoredEventInput[];
  replayOfDeliveryId?: string | null;
  match: EventTriggerMatcher;
  /** How long the dispatcher waits for more events before starting a run. */
  settleMs?: number;
};

export type RecordEventDeliveryResult = {
  delivery: EventDelivery;
  /** The sender delivered this same delivery before; nothing new was stored. */
  duplicate: boolean;
  /** Events stored now; events the source already delivered are skipped. */
  eventIds: string[];
  /** Automations that queued at least one of the events. */
  matchedTaskIds: string[];
};

export const EVENT_DISPATCH_SETTLE_MS = 3_000;

/** The events one delivery became: their ids, and their types each once, in order. */
type DeliveryEvents = { ids: string[]; types: string[] };

const NO_DELIVERY_EVENTS: DeliveryEvents = { ids: [], types: [] };

function deliveryEventsOf(events: ReadonlyArray<{ id: string; type: string }>): DeliveryEvents {
  return {
    ids: events.map((event) => event.id),
    types: [...new Set(events.map((event) => event.type))],
  };
}

function mapDelivery(row: DeliveryRow, events: DeliveryEvents): EventDelivery {
  return {
    id: row.id,
    sourceId: row.sourceId,
    receivedAt: row.receivedAt.toISOString(),
    status: row.status as EventDeliveryStatus,
    reason: row.reason,
    eventIds: events.ids,
    eventTypes: events.types,
    bodyBytes: row.bodyBytes,
    bodyRetained: row.body !== null,
    duplicateCount: row.duplicateCount,
    replayOfDeliveryId: row.replayOfDeliveryId,
  };
}

const storedConditions = z.array(EventCondition);

/**
 * Store one delivery and its events, and queue matching events in their
 * automations' inboxes, all in one transaction. A repeated delivery (same
 * dedupe key) only counts the repeat. Events the source already delivered
 * (same external id on the same stream) are skipped.
 */
export async function recordEventDelivery(
  db: Database,
  input: RecordEventDeliveryInput,
): Promise<RecordEventDeliveryResult> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction((tx) => recordEventDeliveryInTransaction(tx, input)),
  );
}

/**
 * `recordEventDelivery` inside a caller's workspace-scoped transaction, so a
 * caller can commit its own state (an MCP subscription's cursor) atomically
 * with the delivery.
 */
export async function recordEventDeliveryInTransaction(
  tx: Database,
  input: RecordEventDeliveryInput,
): Promise<RecordEventDeliveryResult> {
  const settleMs = Math.max(0, Math.floor(input.settleMs ?? EVENT_DISPATCH_SETTLE_MS));
  const [stored] = await rawRows<DeliveryRowRaw & { duplicate: boolean }>(
    tx,
    sql`insert into event_deliveries (
        account_id, workspace_id, source_id, stream_key, status, reason, dedupe_key, body,
        body_bytes, body_sha256, headers, replay_of_delivery_id
      ) values (
        ${input.accountId}, ${input.workspaceId}, ${input.sourceId}, ${input.streamKey ?? ""},
        ${input.status}, ${input.reason}, ${input.dedupeKey},
        ${input.body ? Buffer.from(input.body) : null}, ${input.bodyBytes}, ${input.bodySha256},
        ${JSON.stringify(input.headers)}::jsonb, ${input.replayOfDeliveryId ?? null}
      )
      on conflict (source_id, dedupe_key) where replay_of_delivery_id is null
      do update set duplicate_count = event_deliveries.duplicate_count + 1,
        last_duplicate_at = now()
      returning *, (xmax <> 0) as duplicate`,
  );
  if (!stored) throw new Error("event delivery was not stored");
  const deliveryRow = deliveryRowFromRaw(stored);
  if (stored.duplicate) {
    const events = await deliveryEvents(tx, input.workspaceId, [deliveryRow.id]);
    return {
      delivery: mapDelivery(deliveryRow, events.get(deliveryRow.id) ?? NO_DELIVERY_EVENTS),
      duplicate: true,
      eventIds: [],
      matchedTaskIds: [],
    };
  }
  const inserted: Array<{ id: string; event: StoredEventInput }> = [];
  for (const event of input.events) {
    const [row] = await tx
      .insert(schema.inboundEvents)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        deliveryId: deliveryRow.id,
        externalId: event.externalId,
        streamKey: event.streamKey,
        type: event.type,
        occurredAt: event.occurredAt,
        subject: event.subject,
        summary: event.summary,
        url: event.url,
        actorKind: event.actor.kind,
        actorName: event.actor.name,
        data: event.data,
        dataTruncated: event.dataTruncated,
        gapBefore: event.gapBefore,
        // The write time, not the transaction's: events of one delivery
        // then list in the order the source sent them.
        receivedAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing()
      .returning({ id: schema.inboundEvents.id });
    if (row) inserted.push({ id: row.id, event });
  }
  const matched = await queueMatchingEvents(tx, input, inserted, settleMs);
  const [updated] = await tx
    .update(schema.eventDeliveries)
    .set({ eventCount: inserted.length })
    .where(eq(schema.eventDeliveries.id, deliveryRow.id))
    .returning();
  await tx
    .update(schema.eventSources)
    .set({ lastDeliveryAt: sql`now()` })
    .where(
      and(
        eq(schema.eventSources.workspaceId, input.workspaceId),
        eq(schema.eventSources.id, input.sourceId),
      ),
    );
  return {
    delivery: mapDelivery(
      updated ?? deliveryRow,
      deliveryEventsOf(inserted.map((entry) => ({ id: entry.id, type: entry.event.type }))),
    ),
    duplicate: false,
    eventIds: inserted.map((entry) => entry.id),
    matchedTaskIds: matched,
  };
}

type DeliveryRowRaw = {
  id: string;
  account_id: string;
  workspace_id: string;
  source_id: string;
  stream_key: string;
  received_at: Date | string;
  status: string;
  reason: string | null;
  dedupe_key: string;
  body: Uint8Array | null;
  body_bytes: number;
  body_sha256: string;
  headers: Record<string, string>;
  event_count: number;
  duplicate_count: number;
  last_duplicate_at: Date | string | null;
  replay_of_delivery_id: string | null;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function deliveryRowFromRaw(raw: DeliveryRowRaw): DeliveryRow {
  return {
    id: raw.id,
    accountId: raw.account_id,
    workspaceId: raw.workspace_id,
    sourceId: raw.source_id,
    streamKey: raw.stream_key,
    receivedAt: asDate(raw.received_at),
    status: raw.status,
    reason: raw.reason,
    dedupeKey: raw.dedupe_key,
    body: raw.body,
    bodyBytes: raw.body_bytes,
    bodySha256: raw.body_sha256,
    headers: raw.headers,
    eventCount: raw.event_count,
    duplicateCount: raw.duplicate_count,
    lastDuplicateAt: raw.last_duplicate_at === null ? null : asDate(raw.last_duplicate_at),
    replayOfDeliveryId: raw.replay_of_delivery_id,
  };
}

async function deliveryEvents(
  db: Database,
  workspaceId: string,
  deliveryIds: string[],
): Promise<Map<string, DeliveryEvents>> {
  const result = new Map<string, DeliveryEvents>();
  if (deliveryIds.length === 0) return result;
  const rows = await db
    .select({
      id: schema.inboundEvents.id,
      type: schema.inboundEvents.type,
      deliveryId: schema.inboundEvents.deliveryId,
    })
    .from(schema.inboundEvents)
    .where(
      and(
        eq(schema.inboundEvents.workspaceId, workspaceId),
        inArray(schema.inboundEvents.deliveryId, deliveryIds),
      ),
    )
    .orderBy(schema.inboundEvents.occurredAt, schema.inboundEvents.id);
  const byDelivery = new Map<string, Array<{ id: string; type: string }>>();
  for (const row of rows) {
    if (!row.deliveryId) continue;
    byDelivery.set(row.deliveryId, [...(byDelivery.get(row.deliveryId) ?? []), row]);
  }
  for (const [deliveryId, events] of byDelivery) result.set(deliveryId, deliveryEventsOf(events));
  return result;
}

/**
 * Evaluate the source's active triggers on runnable automations and queue
 * each matching event once per automation. A trigger only sees a private
 * source when its automation belongs to the source's owner, and an event only
 * fires the triggers of the stream it arrived on (an MCP subscription).
 */
async function queueMatchingEvents(
  tx: Database,
  input: RecordEventDeliveryInput,
  events: Array<{ id: string; event: StoredEventInput }>,
  settleMs: number,
): Promise<string[]> {
  if (events.length === 0) return [];
  const triggers = await rawRows<{
    id: string;
    task_id: string;
    event_types: string[];
    conditions: unknown;
    include_own_events: boolean;
    stream_key: string;
  }>(
    tx,
    sql`select trigger.id, trigger.task_id, trigger.event_types, trigger.conditions,
        trigger.include_own_events, trigger.stream_key
      from event_triggers trigger
      join scheduled_tasks task
        on task.id = trigger.task_id and task.workspace_id = trigger.workspace_id
      join scheduled_task_event_settings settings
        on settings.task_id = trigger.task_id and settings.workspace_id = trigger.workspace_id
      join event_sources source
        on source.id = trigger.source_id and source.workspace_id = trigger.workspace_id
      where trigger.workspace_id = ${input.workspaceId} and trigger.source_id = ${input.sourceId}
        and trigger.status = 'active' and task.status = 'active' and task.deleted_at is null
        and settings.completed_at is null
        and (source.visibility = 'workspace' or source.owner_subject_id is null
          or source.owner_subject_id = task.owner_subject_id)
      order by trigger.task_id, trigger.position`,
  );
  const queued = new Map<string, Map<string, { triggerIds: string[]; occurredAt: Date }>>();
  for (const trigger of triggers) {
    const conditions = storedConditions.safeParse(trigger.conditions);
    if (!conditions.success) continue;
    for (const { id, event } of events) {
      if (
        trigger.stream_key !== event.streamKey ||
        !input.match(event, {
          eventTypes: trigger.event_types,
          conditions: conditions.data,
          includeOwnEvents: trigger.include_own_events,
        })
      ) {
        continue;
      }
      const forTask = queued.get(trigger.task_id) ?? new Map();
      const entry = forTask.get(id) ?? { triggerIds: [], occurredAt: event.occurredAt };
      entry.triggerIds.push(trigger.id);
      forTask.set(id, entry);
      queued.set(trigger.task_id, forTask);
    }
  }
  if (queued.size === 0) return [];
  const rows = [...queued].flatMap(([taskId, forTask]) =>
    [...forTask].map(([eventId, entry]) => ({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      taskId,
      eventId,
      triggerIds: entry.triggerIds,
      occurredAt: entry.occurredAt,
    })),
  );
  await tx.insert(schema.scheduledTaskEventInbox).values(rows).onConflictDoNothing();
  const taskIds = [...queued.keys()];
  await tx.execute(
    sql`update scheduled_task_event_settings
      set dispatch_due_at = coalesce(dispatch_due_at,
        now() + make_interval(secs => ${settleMs / 1000}::double precision)),
        updated_at = now()
      where workspace_id = ${input.workspaceId}
        and task_id in (${sql.join(
          taskIds.map((taskId) => sql`${taskId}::uuid`),
          sql`, `,
        )})`,
  );
  return taskIds;
}

/** A stored delivery with what a replay needs. */
export type EventDeliveryForReplay = {
  delivery: EventDelivery;
  body: Uint8Array | null;
  headers: Record<string, string>;
  /** The MCP subscription stream it arrived on; empty for other sources. */
  streamKey: string;
};

export async function getEventDeliveryForReplay(
  db: Database,
  workspaceId: string,
  sourceId: string,
  deliveryId: string,
): Promise<EventDeliveryForReplay | null> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const [row] = await scoped
      .select()
      .from(schema.eventDeliveries)
      .where(
        and(
          eq(schema.eventDeliveries.workspaceId, workspaceId),
          eq(schema.eventDeliveries.sourceId, sourceId),
          eq(schema.eventDeliveries.id, deliveryId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const events = await deliveryEvents(scoped, workspaceId, [row.id]);
    return {
      delivery: mapDelivery(row, events.get(row.id) ?? NO_DELIVERY_EVENTS),
      body: row.body,
      headers: row.headers,
      streamKey: row.streamKey,
    };
  });
}

type Cursor = { at: Date; id: string };

export function encodeEventCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeEventCursor(cursor: string | null | undefined): Cursor | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const date = at ? new Date(at) : null;
  if (
    !date ||
    !Number.isFinite(date.getTime()) ||
    !id ||
    !z.string().uuid().safeParse(id).success
  ) {
    return null;
  }
  return { at: date, id };
}

export async function listEventDeliveries(
  db: Database,
  workspaceId: string,
  sourceId: string,
  options: { limit: number; cursor?: string | null },
): Promise<{ deliveries: EventDelivery[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const cursor = decodeEventCursor(options.cursor);
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select()
      .from(schema.eventDeliveries)
      .where(
        and(
          eq(schema.eventDeliveries.workspaceId, workspaceId),
          eq(schema.eventDeliveries.sourceId, sourceId),
          ...(cursor
            ? [
                or(
                  lt(schema.eventDeliveries.receivedAt, cursor.at),
                  and(
                    eq(schema.eventDeliveries.receivedAt, cursor.at),
                    lt(schema.eventDeliveries.id, cursor.id),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(schema.eventDeliveries.receivedAt), desc(schema.eventDeliveries.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const events = await deliveryEvents(
      scoped,
      workspaceId,
      page.map((row) => row.id),
    );
    const last = page.at(-1);
    return {
      deliveries: page.map((row) => mapDelivery(row, events.get(row.id) ?? NO_DELIVERY_EVENTS)),
      nextCursor: rows.length > limit && last ? encodeEventCursor(last.receivedAt, last.id) : null,
    };
  });
}

function mapEvent(row: EventRow, sourceKind: EventSourceKind): InboundEvent {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceKind,
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    subject: row.subject,
    summary: row.summary,
    url: row.url,
    actor: { kind: row.actorKind as EventActor["kind"], name: row.actorName },
    data: row.data,
    dataTruncated: row.dataTruncated,
    gapBefore: row.gapBefore,
  };
}

/** Recent events of the given sources, newest first. */
export async function listInboundEvents(
  db: Database,
  workspaceId: string,
  options: { sourceIds: string[]; limit: number; cursor?: string | null },
): Promise<{ events: InboundEvent[]; nextCursor: string | null }> {
  if (options.sourceIds.length === 0) return { events: [], nextCursor: null };
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit)));
  const cursor = decodeEventCursor(options.cursor);
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select({ event: schema.inboundEvents, sourceKind: schema.eventSources.kind })
      .from(schema.inboundEvents)
      .innerJoin(schema.eventSources, eq(schema.eventSources.id, schema.inboundEvents.sourceId))
      .where(
        and(
          eq(schema.inboundEvents.workspaceId, workspaceId),
          inArray(schema.inboundEvents.sourceId, options.sourceIds),
          ...(cursor
            ? [
                or(
                  lt(schema.inboundEvents.receivedAt, cursor.at),
                  and(
                    eq(schema.inboundEvents.receivedAt, cursor.at),
                    lt(schema.inboundEvents.id, cursor.id),
                  ),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(schema.inboundEvents.receivedAt), desc(schema.inboundEvents.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      events: page.map((row) => mapEvent(row.event, row.sourceKind as EventSourceKind)),
      nextCursor:
        rows.length > limit && last
          ? encodeEventCursor(last.event.receivedAt, last.event.id)
          : null,
    };
  });
}

/** The event types a source delivered recently, most frequent first. */
export async function listRecentEventTypes(
  db: Database,
  workspaceId: string,
  sourceId: string,
  limit = 100,
): Promise<Array<{ type: string; count: number; lastReceivedAt: Date }>> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await rawRows<{
      type: string;
      count: number | string;
      last_received_at: Date | string;
    }>(
      scoped,
      sql`select type, count(*) as count, max(received_at) as last_received_at
        from inbound_events
        where workspace_id = ${workspaceId} and source_id = ${sourceId}
        group by type
        order by count(*) desc, type
        limit ${Math.max(1, Math.min(500, Math.floor(limit)))}`,
    );
    return rows.map((row) => ({
      type: row.type,
      count: Number(row.count),
      lastReceivedAt: asDate(row.last_received_at),
    }));
  });
}

/** Events by id, in the order asked; ids that expired or never existed are absent. */
export async function getInboundEvents(
  db: Database,
  workspaceId: string,
  eventIds: string[],
): Promise<InboundEvent[]> {
  if (eventIds.length === 0) return [];
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const rows = await scoped
      .select({ event: schema.inboundEvents, sourceKind: schema.eventSources.kind })
      .from(schema.inboundEvents)
      .innerJoin(schema.eventSources, eq(schema.eventSources.id, schema.inboundEvents.sourceId))
      .where(
        and(
          eq(schema.inboundEvents.workspaceId, workspaceId),
          inArray(schema.inboundEvents.id, eventIds),
        ),
      );
    const byId = new Map(
      rows.map((row) => [row.event.id, mapEvent(row.event, row.sourceKind as EventSourceKind)]),
    );
    return eventIds.flatMap((id) => {
      const event = byId.get(id);
      return event ? [event] : [];
    });
  });
}

function mapTrigger(row: TriggerRow, sourceKind: EventSourceKind): EventTrigger {
  const conditions = storedConditions.safeParse(row.conditions);
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceKind,
    eventTypes: row.eventTypes,
    conditions: conditions.success ? conditions.data : [],
    includeOwnEvents: row.includeOwnEvents,
    arguments: row.arguments ?? null,
    status: row.status as EventTrigger["status"],
    statusReason: row.statusReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The event triggers and event run policy of automations that have them. */
export async function getScheduledTaskEvents(
  db: Database,
  workspaceId: string,
  taskIds: string[],
): Promise<Map<string, ScheduledTaskEvents>> {
  const result = new Map<string, ScheduledTaskEvents>();
  if (taskIds.length === 0) return result;
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const settings = await scoped
      .select()
      .from(schema.scheduledTaskEventSettings)
      .where(
        and(
          eq(schema.scheduledTaskEventSettings.workspaceId, workspaceId),
          inArray(schema.scheduledTaskEventSettings.taskId, taskIds),
        ),
      );
    if (settings.length === 0) return result;
    const triggers = await scoped
      .select({ trigger: schema.eventTriggers, sourceKind: schema.eventSources.kind })
      .from(schema.eventTriggers)
      .innerJoin(schema.eventSources, eq(schema.eventSources.id, schema.eventTriggers.sourceId))
      .where(
        and(
          eq(schema.eventTriggers.workspaceId, workspaceId),
          inArray(
            schema.eventTriggers.taskId,
            settings.map((row) => row.taskId),
          ),
        ),
      )
      .orderBy(schema.eventTriggers.taskId, schema.eventTriggers.position);
    for (const row of settings) {
      result.set(row.taskId, {
        triggers: triggers
          .filter((entry) => entry.trigger.taskId === row.taskId)
          .map((entry) => mapTrigger(entry.trigger, entry.sourceKind as EventSourceKind)),
        maxRunsPerHour: row.maxRunsPerHour,
        once: row.once,
        completedAt: row.completedAt?.toISOString() ?? null,
        throttledSince: row.throttledSince?.toISOString() ?? null,
      });
    }
    return result;
  });
}

/**
 * Replace an automation's event triggers and set its event run policy. A
 * trigger keeps its id while its position stays, so runs keep pointing at it.
 * No triggers removes the policy too; the automation is a plain schedule
 * again. `once` re-arms whenever it is set. MCP triggers carry the stream key
 * of their subscription, which is created here when missing.
 */
export async function setScheduledTaskEvents(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    taskId: string;
    triggers: Array<ParsedEventTriggerInput & { streamKey?: string }>;
    maxRunsPerHour?: number | undefined;
    once?: boolean | undefined;
  },
): Promise<ScheduledTaskEvents | null> {
  await withWorkspaceRls(db, input.workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      await tx.execute(
        sql`select id from scheduled_tasks where workspace_id = ${input.workspaceId} and id = ${input.taskId} for update`,
      );
      const previous = await tx
        .select({
          sourceId: schema.eventTriggers.sourceId,
          streamKey: schema.eventTriggers.streamKey,
        })
        .from(schema.eventTriggers)
        .where(
          and(
            eq(schema.eventTriggers.workspaceId, input.workspaceId),
            eq(schema.eventTriggers.taskId, input.taskId),
          ),
        );
      if (input.triggers.length === 0) {
        await tx
          .delete(schema.eventTriggers)
          .where(
            and(
              eq(schema.eventTriggers.workspaceId, input.workspaceId),
              eq(schema.eventTriggers.taskId, input.taskId),
            ),
          );
        await tx
          .delete(schema.scheduledTaskEventSettings)
          .where(
            and(
              eq(schema.scheduledTaskEventSettings.workspaceId, input.workspaceId),
              eq(schema.scheduledTaskEventSettings.taskId, input.taskId),
            ),
          );
        await tx.execute(
          sql`update scheduled_task_event_inbox set status = 'skipped'
            where workspace_id = ${input.workspaceId} and task_id = ${input.taskId} and status = 'pending'`,
        );
        await syncEventSubscriptions(tx, input.workspaceId, input.taskId, previous);
        return;
      }
      await tx
        .insert(schema.scheduledTaskEventSettings)
        .values({
          taskId: input.taskId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          maxRunsPerHour: input.maxRunsPerHour ?? DEFAULT_EVENT_RUNS_PER_HOUR,
          once: input.once ?? false,
        })
        .onConflictDoUpdate({
          target: schema.scheduledTaskEventSettings.taskId,
          set: {
            ...(input.maxRunsPerHour !== undefined ? { maxRunsPerHour: input.maxRunsPerHour } : {}),
            ...(input.once !== undefined
              ? input.once
                ? { once: true, completedAt: null, armedAt: sql`now()` }
                : { once: false, completedAt: null }
              : {}),
            updatedAt: sql`now()`,
          },
        });
      const existing = await tx
        .select()
        .from(schema.eventTriggers)
        .where(
          and(
            eq(schema.eventTriggers.workspaceId, input.workspaceId),
            eq(schema.eventTriggers.taskId, input.taskId),
          ),
        );
      const byPosition = new Map(existing.map((row) => [row.position, row]));
      for (const [position, trigger] of input.triggers.entries()) {
        const values = {
          sourceId: trigger.sourceId,
          eventTypes: trigger.eventTypes,
          conditions: trigger.conditions,
          includeOwnEvents: trigger.includeOwnEvents,
          arguments: trigger.arguments ?? null,
          streamKey: trigger.streamKey ?? "",
          status: "active",
          statusReason: null,
        };
        const current = byPosition.get(position);
        if (current) {
          await tx
            .update(schema.eventTriggers)
            .set({ ...values, updatedAt: sql`now()` })
            .where(eq(schema.eventTriggers.id, current.id));
        } else {
          await tx.insert(schema.eventTriggers).values({
            ...values,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            taskId: input.taskId,
            position,
          });
        }
      }
      const stale = existing.filter((row) => row.position >= input.triggers.length);
      if (stale.length > 0) {
        await tx.delete(schema.eventTriggers).where(
          inArray(
            schema.eventTriggers.id,
            stale.map((row) => row.id),
          ),
        );
      }
      await syncEventSubscriptions(tx, input.workspaceId, input.taskId, previous);
    }),
  );
  return (
    (await getScheduledTaskEvents(db, input.workspaceId, [input.taskId])).get(input.taskId) ?? null
  );
}

/**
 * Create the MCP subscriptions an automation's triggers want and wake every
 * subscription and source feed it uses or used, so the pumps start, keep or
 * end each one now instead of at its next poll or refresh. The pumps decide
 * from the committed triggers and automation whether a subscription or feed
 * is still wanted, so this may run before a status change in the same
 * transaction.
 */
export async function syncEventSubscriptions(
  tx: Database,
  workspaceId: string,
  taskId: string,
  previous: ReadonlyArray<{ sourceId: string; streamKey: string }> = [],
): Promise<void> {
  await tx.execute(
    sql`insert into mcp_event_subscriptions (
        account_id, workspace_id, source_id, stream_key, event_name, arguments
      )
      select distinct on (trigger.source_id, trigger.stream_key)
        trigger.account_id, trigger.workspace_id, trigger.source_id, trigger.stream_key,
        trigger.event_types[1], coalesce(trigger.arguments, '{}'::jsonb)
      from event_triggers trigger
      join scheduled_tasks task
        on task.id = trigger.task_id and task.workspace_id = trigger.workspace_id
      join event_sources source
        on source.id = trigger.source_id and source.workspace_id = trigger.workspace_id
      where trigger.workspace_id = ${workspaceId} and trigger.task_id = ${taskId}
        and trigger.stream_key <> '' and trigger.status <> 'disabled'
        and source.kind = 'mcp' and task.deleted_at is null
      order by trigger.source_id, trigger.stream_key
      on conflict (source_id, stream_key) do nothing`,
  );
  const earlier = previous.filter((entry) => entry.streamKey !== "");
  await tx.execute(
    sql`update mcp_event_subscriptions subscription
      set next_action_at = now(), updated_at = now()
      where subscription.workspace_id = ${workspaceId} and subscription.next_action_at > now()
        and (
          (subscription.source_id, subscription.stream_key) in (
            select trigger.source_id, trigger.stream_key from event_triggers trigger
            where trigger.workspace_id = ${workspaceId} and trigger.task_id = ${taskId}
              and trigger.stream_key <> '')
          ${
            earlier.length > 0
              ? sql`or (subscription.source_id, subscription.stream_key) in (${sql.join(
                  earlier.map((entry) => sql`(${entry.sourceId}::uuid, ${entry.streamKey})`),
                  sql`, `,
                )})`
              : sql``
          }
        )`,
  );
  await tx.execute(
    sql`update event_source_feeds feed
      set next_action_at = now(), updated_at = now()
      where feed.workspace_id = ${workspaceId} and feed.next_action_at > now()
        and (
          feed.source_id in (
            select trigger.source_id from event_triggers trigger
            where trigger.workspace_id = ${workspaceId} and trigger.task_id = ${taskId})
          ${
            previous.length > 0
              ? sql`or feed.source_id in (${sql.join(
                  previous.map((entry) => sql`${entry.sourceId}::uuid`),
                  sql`, `,
                )})`
              : sql``
          }
        )`,
  );
}

/** A resumed automation starts over: `once` can fire again and the guard forgets the past episode. */
export async function rearmScheduledTaskEvents(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, async (scoped) => {
    await scoped.execute(
      sql`update scheduled_task_event_settings
        set armed_at = now(), completed_at = null, throttle_notified = false, updated_at = now()
        where workspace_id = ${workspaceId} and task_id = ${taskId}`,
    );
    await syncEventSubscriptions(scoped, workspaceId, taskId);
  });
}

/**
 * Have the pumps look at an automation's MCP streams and source feeds now,
 * after it was paused, resumed or deleted, so a stream nothing wants is ended
 * at once and a feed starts reading as soon as an automation listens again.
 */
export async function wakeScheduledTaskEventSubscriptions(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    syncEventSubscriptions(scoped, workspaceId, taskId),
  );
}

/** Mark a trigger blocked (or active again) with a plain-language reason. */
export async function setEventTriggerStatus(
  db: Database,
  workspaceId: string,
  triggerId: string,
  status: EventTrigger["status"],
  statusReason: string | null,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped
      .update(schema.eventTriggers)
      .set({
        status,
        statusReason: status === "active" ? null : statusReason,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schema.eventTriggers.workspaceId, workspaceId),
          eq(schema.eventTriggers.id, triggerId),
        ),
      ),
  );
}

/** An automation whose trigger changed state because its source or stream did. */
export type EventTriggerNotice = {
  taskId: string;
  taskName: string;
  /** The chat the owner opens from the notice; null when the automation never ran. */
  sessionId: string | null;
};

/**
 * Block (or unblock) every trigger listening on one stream of a source (the
 * empty stream key is every trigger of a source without streams), with a
 * plain-language reason. Returns the automations whose triggers changed state
 * now, so the owner is told once per episode.
 */
export async function setEventStreamTriggerStatus(
  db: Database,
  workspaceId: string,
  stream: { sourceId: string; streamKey: string },
  status: "active" | "blocked",
  reason: string | null,
): Promise<EventTriggerNotice[]> {
  const statusReason = status === "active" ? null : (reason ?? "Blocked").slice(0, 500);
  return await withWorkspaceRls(db, workspaceId, async (scoped) => {
    const changed = await rawRows<{ task_id: string; was: string }>(
      scoped,
      sql`with previous as (
          select id, status from event_triggers
          where workspace_id = ${workspaceId} and source_id = ${stream.sourceId}
            and stream_key = ${stream.streamKey} and status <> 'disabled'
          for update
        )
        update event_triggers trigger
        set status = ${status}, status_reason = ${statusReason}, updated_at = now()
        from previous
        where trigger.id = previous.id
          and (trigger.status <> ${status} or trigger.status_reason is distinct from ${statusReason})
        returning trigger.task_id, previous.status as was`,
    );
    const transitioned = [
      ...new Set(changed.filter((row) => row.was !== status).map((row) => row.task_id)),
    ];
    if (transitioned.length === 0) return [];
    const tasks = await rawRows<{ id: string; name: string; session_id: string | null }>(
      scoped,
      sql`select task.id, task.name,
          coalesce(task.reusable_session_id, (
            select run.session_id from scheduled_task_runs run
            where run.workspace_id = task.workspace_id and run.task_id = task.id
              and run.session_id is not null
            order by run.created_at desc limit 1)) as session_id
        from scheduled_tasks task
        where task.workspace_id = ${workspaceId} and task.deleted_at is null
          and task.id in (${sql.join(
            transitioned.map((taskId) => sql`${taskId}::uuid`),
            sql`, `,
          )})
        order by task.id`,
    );
    return tasks.map((task) => ({
      taskId: task.id,
      taskName: task.name,
      sessionId: task.session_id,
    }));
  });
}

/** Identity-only inventory of automations whose inbox is due; every read after it is workspace-scoped. */
export async function listDueEventTriggerTasks(
  db: Database,
  limit = 32,
): Promise<Array<{ taskId: string; workspaceId: string }>> {
  const rows = await rawRows<{ task_id: string; workspace_id: string }>(
    db,
    sql`select * from opengeni_private.list_due_event_trigger_tasks_v1(${limit})`,
  );
  return rows.map((row) => ({ taskId: row.task_id, workspaceId: row.workspace_id }));
}

/** At most this many events are carried into one run; the rest are counted. */
export const EVENT_OCCURRENCE_CARRIED_EVENTS_MAX = 50;
const EVENT_OCCURRENCE_SUMMARIES_MAX_BYTES = 60 * 1024;

export type EventOccurrenceToStart = {
  id: string;
  accountId: string;
  workspaceId: string;
  taskId: string;
  startAttempts: number;
};

export type EventThrottleNotice = {
  taskId: string;
  taskName: string;
  /** The chat the owner opens from the notice. */
  sessionId: string;
  maxRunsPerHour: number;
  resumesAt: Date;
};

export type EventTriggerDispatch = {
  /** Occurrences whose run should be started now (new, or earlier starts that failed). */
  start: EventOccurrenceToStart[];
  /** The storm guard engaged for this automation; tell its owner once. */
  throttleNotice: EventThrottleNotice | null;
};

type DispatchFacts = {
  account_id: string;
  task_status: string;
  task_deleted: boolean;
  task_name: string;
  session_id: string | null;
  max_runs_per_hour: number;
  once: boolean;
  completed_at: Date | string | null;
  armed_at: Date | string;
  throttled_since: Date | string | null;
  throttle_notified: boolean;
  consumed_since_armed: boolean;
  recent_occurrences: number;
  oldest_recent_occurrence_at: Date | string | null;
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * One dispatcher step for one automation, under its settings lock. Pending
 * inbox events become one occurrence unless the storm guard holds them back,
 * the automation is not runnable (they are skipped), or a once-automation has
 * already run (it completes instead). Occurrences whose start failed earlier
 * are returned again. A concurrent dispatcher holding the lock makes this a
 * no-op.
 */
export async function claimEventTriggerDispatch(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<EventTriggerDispatch> {
  return await withWorkspaceRls(db, workspaceId, async (scoped) =>
    scoped.transaction(async (tx) => {
      const none: EventTriggerDispatch = { start: [], throttleNotice: null };
      const locked = await rawRows<{ task_id: string }>(
        tx,
        sql`select task_id from scheduled_task_event_settings
          where workspace_id = ${workspaceId} and task_id = ${taskId}
            and dispatch_due_at is not null and dispatch_due_at <= now()
          for update skip locked`,
      );
      if (locked.length === 0) return none;
      const [facts] = await rawRows<DispatchFacts>(
        tx,
        sql`select task.account_id, task.status as task_status,
            task.deleted_at is not null as task_deleted, task.name as task_name,
            coalesce(task.reusable_session_id, (
              select run.session_id from scheduled_task_runs run
              where run.workspace_id = task.workspace_id and run.task_id = task.id
                and run.session_id is not null
              order by run.created_at desc limit 1)) as session_id,
            settings.max_runs_per_hour, settings.once, settings.completed_at, settings.armed_at,
            settings.throttled_since, settings.throttle_notified,
            (exists (select 1 from scheduled_task_runs run
                where run.workspace_id = task.workspace_id and run.task_id = task.id
                  and run.created_at >= settings.armed_at)
              or exists (select 1 from scheduled_task_event_occurrences occurrence
                where occurrence.workspace_id = task.workspace_id and occurrence.task_id = task.id
                  and occurrence.created_at >= settings.armed_at)) as consumed_since_armed,
            (select count(*)::int from scheduled_task_event_occurrences occurrence
              where occurrence.workspace_id = task.workspace_id and occurrence.task_id = task.id
                and occurrence.created_at > now() - interval '1 hour') as recent_occurrences,
            (select min(occurrence.created_at) from scheduled_task_event_occurrences occurrence
              where occurrence.workspace_id = task.workspace_id and occurrence.task_id = task.id
                and occurrence.created_at > now() - interval '1 hour') as oldest_recent_occurrence_at
          from scheduled_task_event_settings settings
          join scheduled_tasks task on task.id = settings.task_id and task.workspace_id = settings.workspace_id
          where settings.workspace_id = ${workspaceId} and settings.task_id = ${taskId}`,
      );
      const failedStarts = await tx
        .select()
        .from(schema.scheduledTaskEventOccurrences)
        .where(
          and(
            eq(schema.scheduledTaskEventOccurrences.workspaceId, workspaceId),
            eq(schema.scheduledTaskEventOccurrences.taskId, taskId),
            eq(schema.scheduledTaskEventOccurrences.status, "pending"),
          ),
        )
        .orderBy(schema.scheduledTaskEventOccurrences.createdAt);
      const clearDue = () =>
        tx.execute(
          sql`update scheduled_task_event_settings set dispatch_due_at = null, updated_at = now()
            where workspace_id = ${workspaceId} and task_id = ${taskId}`,
        );
      const skipPending = () =>
        tx.execute(
          sql`update scheduled_task_event_inbox set status = 'skipped'
            where workspace_id = ${workspaceId} and task_id = ${taskId} and status = 'pending'`,
        );
      if (!facts || facts.task_deleted || facts.task_status !== "active") {
        // Events never wait for a paused or deleted automation, and an
        // unstarted run of one is dropped with them.
        await skipPending();
        if (failedStarts.length > 0) {
          await tx.delete(schema.scheduledTaskEventOccurrences).where(
            inArray(
              schema.scheduledTaskEventOccurrences.id,
              failedStarts.map((row) => row.id),
            ),
          );
        }
        await clearDue();
        return none;
      }
      const retry = failedStarts.map((row) => ({
        id: row.id,
        accountId: row.accountId,
        workspaceId: row.workspaceId,
        taskId: row.taskId,
        startAttempts: row.startAttempts,
      }));
      if (facts.completed_at !== null || (facts.once && facts.consumed_since_armed)) {
        await skipPending();
        if (facts.completed_at === null) {
          await tx.execute(
            sql`update scheduled_task_event_settings set completed_at = now(), updated_at = now()
              where workspace_id = ${workspaceId} and task_id = ${taskId}`,
          );
        }
        await clearDue();
        return { start: retry, throttleNotice: null };
      }
      const pending = await tx
        .select({
          inbox: schema.scheduledTaskEventInbox,
          event: {
            id: schema.inboundEvents.id,
            sourceId: schema.inboundEvents.sourceId,
            type: schema.inboundEvents.type,
            occurredAt: schema.inboundEvents.occurredAt,
            subject: schema.inboundEvents.subject,
            summary: schema.inboundEvents.summary,
            url: schema.inboundEvents.url,
            actorKind: schema.inboundEvents.actorKind,
            actorName: schema.inboundEvents.actorName,
            gapBefore: schema.inboundEvents.gapBefore,
          },
          sourceKind: schema.eventSources.kind,
        })
        .from(schema.scheduledTaskEventInbox)
        .innerJoin(
          schema.inboundEvents,
          eq(schema.inboundEvents.id, schema.scheduledTaskEventInbox.eventId),
        )
        .innerJoin(schema.eventSources, eq(schema.eventSources.id, schema.inboundEvents.sourceId))
        .where(
          and(
            eq(schema.scheduledTaskEventInbox.workspaceId, workspaceId),
            eq(schema.scheduledTaskEventInbox.taskId, taskId),
            eq(schema.scheduledTaskEventInbox.status, "pending"),
          ),
        )
        .orderBy(schema.scheduledTaskEventInbox.occurredAt, schema.scheduledTaskEventInbox.id);
      if (pending.length === 0) {
        await clearDue();
        return { start: retry, throttleNotice: null };
      }
      if (facts.recent_occurrences >= facts.max_runs_per_hour) {
        const oldest = facts.oldest_recent_occurrence_at
          ? asDate(facts.oldest_recent_occurrence_at)
          : new Date();
        const resumesAt = new Date(oldest.getTime() + 3_600_000);
        const notify = !facts.throttle_notified && facts.session_id !== null;
        await tx.execute(
          sql`update scheduled_task_event_settings
            set throttled_since = coalesce(throttled_since, now()),
              throttle_notified = throttle_notified or ${notify},
              dispatch_due_at = ${resumesAt.toISOString()}::timestamptz, updated_at = now()
            where workspace_id = ${workspaceId} and task_id = ${taskId}`,
        );
        return {
          start: retry,
          throttleNotice: notify
            ? {
                taskId,
                taskName: facts.task_name,
                sessionId: facts.session_id!,
                maxRunsPerHour: facts.max_runs_per_hour,
                resumesAt,
              }
            : null,
        };
      }
      const summaries: InboundEventSummary[] = [];
      const carried: string[] = [];
      let summaryBytes = 2;
      for (const entry of pending) {
        if (carried.length >= EVENT_OCCURRENCE_CARRIED_EVENTS_MAX) break;
        const summary = InboundEventSummary.parse({
          id: entry.event.id,
          sourceId: entry.event.sourceId,
          sourceKind: entry.sourceKind,
          type: entry.event.type,
          occurredAt: entry.event.occurredAt.toISOString(),
          subject: entry.event.subject,
          summary: entry.event.summary,
          url: entry.event.url,
          actor: { kind: entry.event.actorKind, name: entry.event.actorName },
        });
        const size = byteLength(summary) + 1;
        if (summaryBytes + size > EVENT_OCCURRENCE_SUMMARIES_MAX_BYTES) break;
        summaryBytes += size;
        summaries.push(summary);
        carried.push(entry.event.id);
      }
      const triggerIds = [...new Set(pending.flatMap((entry) => entry.inbox.triggerIds))].slice(
        0,
        16,
      );
      const [occurrence] = await tx
        .insert(schema.scheduledTaskEventOccurrences)
        .values({
          accountId: facts.account_id,
          workspaceId,
          taskId,
          triggerIds,
          eventCount: pending.length,
          eventIds: carried,
          events: summaries,
          gapBefore: pending.some((entry) => entry.event.gapBefore),
        })
        .returning();
      if (!occurrence) throw new Error("event occurrence was not created");
      await tx
        .update(schema.scheduledTaskEventInbox)
        .set({ status: "batched", occurrenceId: occurrence.id })
        .where(
          inArray(
            schema.scheduledTaskEventInbox.id,
            pending.map((entry) => entry.inbox.id),
          ),
        );
      await tx.execute(
        sql`update scheduled_task_event_settings
          set dispatch_due_at = null, throttled_since = null, throttle_notified = false,
            completed_at = case when once then now() else completed_at end, updated_at = now()
          where workspace_id = ${workspaceId} and task_id = ${taskId}`,
      );
      return {
        start: [
          ...retry,
          {
            id: occurrence.id,
            accountId: occurrence.accountId,
            workspaceId,
            taskId,
            startAttempts: 0,
          },
        ],
        throttleNotice: null,
      };
    }),
  );
}

export async function markEventOccurrenceStarted(
  db: Database,
  workspaceId: string,
  occurrenceId: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped.execute(
      sql`update scheduled_task_event_occurrences
        set status = 'started', started_at = now(), start_attempts = start_attempts + 1, last_error = null
        where workspace_id = ${workspaceId} and id = ${occurrenceId} and status = 'pending'`,
    ),
  );
}

/** A failed start is retried by the dispatcher with a growing delay, up to ten minutes. */
export async function recordEventOccurrenceStartFailure(
  db: Database,
  workspaceId: string,
  occurrenceId: string,
  error: string,
): Promise<void> {
  await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped.execute(
      sql`with failed as (
          update scheduled_task_event_occurrences
          set start_attempts = start_attempts + 1, last_error = left(${error}, 1000)
          where workspace_id = ${workspaceId} and id = ${occurrenceId} and status = 'pending'
          returning task_id, start_attempts
        )
        update scheduled_task_event_settings settings
        set dispatch_due_at = least(coalesce(settings.dispatch_due_at, 'infinity'::timestamptz),
          now() + make_interval(secs => least(600, 5 * power(2, least(failed.start_attempts, 8)))::double precision)),
          updated_at = now()
        from failed
        where settings.workspace_id = ${workspaceId} and settings.task_id = failed.task_id`,
    ),
  );
}

/** The occurrence an event run carries, with full event data while the events are kept. */
export type EventOccurrenceForRun = {
  id: string;
  taskId: string;
  triggerIds: string[];
  eventCount: number;
  gapBefore: boolean;
  summaries: InboundEventSummary[];
  events: InboundEvent[];
};

const storedSummaries = z.array(InboundEventSummary);

export async function getEventOccurrenceForRun(
  db: Database,
  workspaceId: string,
  occurrenceId: string,
): Promise<EventOccurrenceForRun | null> {
  const [row] = await withWorkspaceRls(db, workspaceId, (scoped) =>
    scoped
      .select()
      .from(schema.scheduledTaskEventOccurrences)
      .where(
        and(
          eq(schema.scheduledTaskEventOccurrences.workspaceId, workspaceId),
          eq(schema.scheduledTaskEventOccurrences.id, occurrenceId),
        ),
      )
      .limit(1),
  );
  if (!row) return null;
  const summaries = storedSummaries.safeParse(row.events);
  return {
    id: row.id,
    taskId: row.taskId,
    triggerIds: row.triggerIds,
    eventCount: row.eventCount,
    gapBefore: row.gapBefore,
    summaries: summaries.success ? summaries.data : [],
    events: await getInboundEvents(db, workspaceId, row.eventIds),
  };
}

const OCCURRENCE_PRODUCER_KEY = /^scheduled-task-event:([0-9a-f-]{36})$/u;

/** The occurrence id an event run's producer key names. */
export function eventOccurrenceIdFromProducerKey(
  producerKey: string | null | undefined,
): string | null {
  return producerKey ? (OCCURRENCE_PRODUCER_KEY.exec(producerKey)?.[1] ?? null) : null;
}

/** The occurrence an event run was started for, found through the run's producer key. */
export async function getEventOccurrenceForScheduledTaskRun(
  db: Database,
  workspaceId: string,
  runId: string,
): Promise<EventOccurrenceForRun | null> {
  const [run] = await withWorkspaceRls(db, workspaceId, (scoped) =>
    rawRows<{ producer_key: string | null }>(
      scoped,
      sql`select producer_key from scheduled_task_runs
        where workspace_id = ${workspaceId} and id = ${runId} and trigger_type = 'event'`,
    ),
  );
  const occurrenceId = eventOccurrenceIdFromProducerKey(run?.producer_key);
  return occurrenceId ? await getEventOccurrenceForRun(db, workspaceId, occurrenceId) : null;
}

/** The events each event run carried, keyed by run id. */
export async function getScheduledTaskRunEventOccurrences(
  db: Database,
  workspaceId: string,
  runIds: string[],
): Promise<Map<string, ScheduledTaskRunEventOccurrence>> {
  const result = new Map<string, ScheduledTaskRunEventOccurrence>();
  if (runIds.length === 0) return result;
  const rows = await withWorkspaceRls(db, workspaceId, (scoped) =>
    rawRows<{ run_id: string; trigger_ids: string[]; event_count: number; events: unknown }>(
      scoped,
      sql`select run.id as run_id, occurrence.trigger_ids, occurrence.event_count, occurrence.events
        from scheduled_task_runs run
        join scheduled_task_event_occurrences occurrence
          on occurrence.workspace_id = run.workspace_id and occurrence.task_id = run.task_id
          and run.producer_key = 'scheduled-task-event:' || occurrence.id::text
        where run.workspace_id = ${workspaceId} and run.trigger_type = 'event'
          and run.id in (${sql.join(
            runIds.map((runId) => sql`${runId}::uuid`),
            sql`, `,
          )})`,
    ),
  );
  for (const row of rows) {
    const summaries = storedSummaries.safeParse(row.events);
    result.set(row.run_id, {
      triggerIds: row.trigger_ids,
      eventCount: row.event_count,
      events: summaries.success ? summaries.data : [],
    });
  }
  return result;
}

/** Retention: one bounded pass; returns how many rows changed so callers can repeat. */
export async function pruneEventIntake(
  db: Database,
  input: { bodyRetentionSeconds: number; eventRetentionSeconds: number; limit?: number },
): Promise<number> {
  const [row] = await rawRows<{ changed: number }>(
    db,
    sql`select opengeni_private.prune_event_intake_v1(
      ${Math.floor(input.bodyRetentionSeconds)}, ${Math.floor(input.eventRetentionSeconds)},
      ${Math.floor(input.limit ?? 500)}) as changed`,
  );
  return Number(row?.changed ?? 0);
}
