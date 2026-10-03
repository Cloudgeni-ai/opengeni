import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const privateSchema = pgSchema("opengeni_private");
const keyColumns = () => ({
  accountId: uuid("account_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  day: date("day").notNull(),
  dimensions: jsonb("dimensions").$type<Record<string, unknown>>().notNull(),
});
const stamp = (name: string) => timestamp(name, { withTimezone: true });

export const insightsListRateSnapshots = privateSchema.table(
  "insights_list_rate_snapshots",
  {
    id: text("id").primaryKey(),
    version: text("version").notNull().unique(),
    profiles: jsonb("profiles").$type<Record<string, unknown>>().notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: stamp("created_at")
      .notNull()
      .default(sql`clock_timestamp()`),
    lastFactId: uuid("last_fact_id"),
    allocatedCalls: bigint("allocated_calls", { mode: "bigint" }).notNull().default(0n),
    unknownCalls: bigint("unknown_calls", { mode: "bigint" }).notNull().default(0n),
    completed: boolean("completed").notNull().default(false),
  },
  (table) => ({
    active: uniqueIndex("insights_list_rate_snapshot_active_idx")
      .on(table.active)
      .where(sql`${table.active}`),
    id: check("insights_list_rate_snapshots_id_check", sql`${table.id} ~ '^[0-9a-f]{64}$'`),
    version: check(
      "insights_list_rate_snapshots_version_check",
      sql`length(${table.version}) between 1 and 200`,
    ),
    profiles: check(
      "insights_list_rate_snapshots_profiles_check",
      sql`jsonb_typeof(${table.profiles})='object'`,
    ),
    allocated: check(
      "insights_list_rate_snapshots_allocated_calls_check",
      sql`${table.allocatedCalls}>=0`,
    ),
    unknown: check(
      "insights_list_rate_snapshots_unknown_calls_check",
      sql`${table.unknownCalls}>=0`,
    ),
  }),
);

export const insightsUsageDaily = privateSchema.table(
  "insights_usage_daily",
  {
    ...keyColumns(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull().default(0n),
    eventCount: bigint("event_count", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.accountId, table.workspaceId, table.day, table.dimensions] }),
    accountDay: index("insights_usage_daily_account_day_idx").on(
      table.accountId,
      table.day,
      table.workspaceId,
    ),
    count: check("insights_usage_daily_event_count_check", sql`${table.eventCount}>=0`),
  }),
);
export const insightsModelDaily = privateSchema.table(
  "insights_model_daily",
  {
    ...keyColumns(),
    measures: jsonb("measures")
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    contributions: jsonb("contributions")
      .$type<Array<Record<string, unknown>>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    recordedAt: stamp("recorded_at"),
    recordedAtMin: stamp("recorded_at_min"),
    occurredAtMin: stamp("occurred_at_min"),
    occurredAtMax: stamp("occurred_at_max"),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.accountId, table.workspaceId, table.day, table.dimensions] }),
    accountDay: index("insights_model_daily_account_day_idx").on(
      table.accountId,
      table.day,
      table.workspaceId,
    ),
    session: index("insights_model_daily_session_idx").on(
      table.workspaceId,
      sql`(${table.dimensions}->>'session_id')`,
      table.day,
    ),
    count: check(
      "insights_model_daily_measures_check",
      sql`coalesce((${table.measures}->>'calls')::bigint,0)>=0`,
    ),
  }),
);
export const insightsModelDailyTimestamps = privateSchema.table(
  "insights_model_daily_timestamps",
  {
    ...keyColumns(),
    recordedAt: stamp("recorded_at").notNull(),
    occurredAt: stamp("occurred_at").notNull(),
    calls: bigint("calls", { mode: "bigint" }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [
        table.accountId,
        table.workspaceId,
        table.day,
        table.dimensions,
        table.recordedAt,
        table.occurredAt,
      ],
    }),
    group: foreignKey({
      columns: [table.accountId, table.workspaceId, table.day, table.dimensions],
      foreignColumns: [
        insightsModelDaily.accountId,
        insightsModelDaily.workspaceId,
        insightsModelDaily.day,
        insightsModelDaily.dimensions,
      ],
    }).onDelete("cascade"),
    occurrence: index("insights_model_daily_occurrence_idx").on(
      table.accountId,
      table.workspaceId,
      table.day,
      table.dimensions,
      table.occurredAt,
    ),
    count: check("insights_model_daily_timestamps_calls_check", sql`${table.calls}>=0`),
  }),
);
export const insightsChargeDaily = privateSchema.table(
  "insights_charge_daily",
  {
    ...keyColumns(),
    workspaceId: uuid("workspace_id"),
    quantity: bigint("quantity", { mode: "bigint" }).notNull().default(0n),
    entries: bigint("entries", { mode: "bigint" }).notNull().default(0n),
  },
  (table) => ({
    key: unique("insights_charge_daily_key")
      .on(table.accountId, table.workspaceId, table.day, table.dimensions)
      .nullsNotDistinct(),
    accountDay: index("insights_charge_daily_account_day_idx").on(
      table.accountId,
      table.day,
      table.workspaceId,
    ),
    quantity: check("insights_charge_daily_quantity_check", sql`${table.quantity}>=0`),
    count: check("insights_charge_daily_entries_check", sql`${table.entries}>=0`),
  }),
);
export const insightsChargeLinks = privateSchema.table(
  "insights_charge_links",
  {
    ledgerId: uuid("ledger_id").primaryKey(),
    ...keyColumns(),
    workspaceId: uuid("workspace_id"),
    sourceId: text("source_id").notNull(),
    occurredAt: stamp("occurred_at").notNull(),
    quantity: bigint("quantity", { mode: "bigint" }).notNull(),
    creditRow: jsonb("credit_row").$type<Record<string, unknown>>().notNull(),
  },
  (table) => ({
    source: index("insights_charge_links_source_idx").on(
      table.accountId,
      table.workspaceId,
      table.sourceId,
    ),
    window: index("insights_charge_links_window_idx").on(
      table.accountId,
      table.workspaceId,
      table.occurredAt,
    ),
  }),
);
