import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Migration 0929: event sources, deliveries, normalized events and the event
// triggers of automations (scheduled tasks). Foreign keys to accounts,
// workspaces and scheduled tasks live in the migration.

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

export const eventSources = pgTable(
  "event_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    kind: text("kind").notNull(),
    adapter: text("adapter"),
    name: text("name").notNull(),
    ownerSubjectId: text("owner_subject_id"),
    visibility: text("visibility").notNull().default("private"),
    status: text("status").notNull().default("active"),
    statusReason: text("status_reason"),
    secretEncrypted: text("secret_encrypted"),
    externalKey: text("external_key"),
    mcpServerId: text("mcp_server_id"),
    connectionId: uuid("connection_id"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    createdBySubjectId: text("created_by_subject_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceId: uniqueIndex("event_sources_workspace_id_uq").on(table.workspaceId, table.id),
  }),
);

/** Credential-free routing from a webhook URL or a provider identity to a source. */
export const eventIngressRoutes = pgTable(
  "event_ingress_routes",
  {
    routeId: uuid("route_id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => eventSources.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    externalKey: text("external_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    source: index("event_ingress_routes_source_idx").on(table.sourceId),
    external: index("event_ingress_routes_external_idx")
      .on(table.kind, table.externalKey)
      .where(sql`${table.externalKey} is not null`),
  }),
);

export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => eventSources.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(),
    reason: text("reason"),
    dedupeKey: text("dedupe_key").notNull(),
    body: bytea("body"),
    bodyBytes: integer("body_bytes").notNull(),
    bodySha256: text("body_sha256").notNull(),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    eventCount: integer("event_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    lastDuplicateAt: timestamp("last_duplicate_at", { withTimezone: true }),
    replayOfDeliveryId: uuid("replay_of_delivery_id"),
  },
  (table) => ({
    dedupe: uniqueIndex("event_deliveries_dedupe_uq")
      .on(table.sourceId, table.dedupeKey)
      .where(sql`${table.replayOfDeliveryId} is null`),
    sourceReceived: index("event_deliveries_source_received_idx").on(
      table.workspaceId,
      table.sourceId,
      table.receivedAt,
      table.id,
    ),
  }),
);

export const inboundEvents = pgTable(
  "inbound_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => eventSources.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").references(() => eventDeliveries.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id"),
    streamKey: text("stream_key").notNull().default(""),
    type: text("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    subject: text("subject"),
    summary: text("summary").notNull(),
    url: text("url"),
    actorKind: text("actor_kind").notNull().default("unknown"),
    actorName: text("actor_name"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    dataTruncated: boolean("data_truncated").notNull().default(false),
    gapBefore: boolean("gap_before").notNull().default(false),
  },
  (table) => ({
    external: uniqueIndex("inbound_events_external_uq")
      .on(table.sourceId, table.streamKey, table.externalId)
      .where(sql`${table.externalId} is not null`),
    sourceReceived: index("inbound_events_source_received_idx").on(
      table.workspaceId,
      table.sourceId,
      table.receivedAt,
      table.id,
    ),
  }),
);

export const eventTriggers = pgTable(
  "event_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => eventSources.id, { onDelete: "cascade" }),
    position: smallint("position").notNull(),
    eventTypes: text("event_types").array().notNull(),
    conditions: jsonb("conditions").$type<unknown[]>().notNull().default([]),
    includeOwnEvents: boolean("include_own_events").notNull().default(false),
    arguments: jsonb("arguments").$type<Record<string, unknown> | null>(),
    status: text("status").notNull().default("active"),
    statusReason: text("status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    position: unique("event_triggers_position_uq").on(table.taskId, table.position),
  }),
);

export const scheduledTaskEventSettings = pgTable("scheduled_task_event_settings", {
  taskId: uuid("task_id").primaryKey(),
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  maxRunsPerHour: integer("max_runs_per_hour").notNull().default(30),
  once: boolean("once").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  armedAt: timestamp("armed_at", { withTimezone: true }).notNull().defaultNow(),
  dispatchDueAt: timestamp("dispatch_due_at", { withTimezone: true }),
  throttledSince: timestamp("throttled_since", { withTimezone: true }),
  throttleNotified: boolean("throttle_notified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scheduledTaskEventOccurrences = pgTable("scheduled_task_event_occurrences", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  taskId: uuid("task_id").notNull(),
  triggerIds: uuid("trigger_ids").array().notNull(),
  eventCount: integer("event_count").notNull(),
  eventIds: uuid("event_ids").array().notNull(),
  events: jsonb("events").$type<unknown[]>().notNull(),
  gapBefore: boolean("gap_before").notNull().default(false),
  status: text("status").notNull().default("pending"),
  startAttempts: integer("start_attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
});

export const scheduledTaskEventInbox = pgTable(
  "scheduled_task_event_inbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => inboundEvents.id, { onDelete: "cascade" }),
    triggerIds: uuid("trigger_ids").array().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("pending"),
    occurrenceId: uuid("occurrence_id").references(() => scheduledTaskEventOccurrences.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    event: unique("scheduled_task_event_inbox_event_uq").on(table.taskId, table.eventId),
  }),
);
