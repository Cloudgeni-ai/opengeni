import { z } from "zod";
import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { ToolGatewayIdentity } from "./tool-catalog";
import { SITE_SQL_IDENTIFIER, isSiteSqlTableName } from "./site-sql";

/**
 * App data sync: an automation action that calls one connected tool with fixed
 * arguments, keeps chosen fields of each returned record and upserts them by
 * key into a collection of an App's (Site's) data. No model runs. See
 * docs/app-sync.md.
 */

/** How many records one sync run reads from a tool result. */
export const APP_SYNC_MAX_RECORDS = 1_000;
/** How many fields a sync keeps per record. */
export const APP_SYNC_MAX_FIELDS = 100;
/** People a personal sync runs for in one run. */
export const APP_SYNC_MAX_SUBSCRIBERS = 200;
/** Records one run reads in total across pages (per person for a personal sync). */
export const APP_SYNC_MAX_RUN_RECORDS = 10_000;
/** Tool calls (pages) one run makes at most (per person for a personal sync). */
export const APP_SYNC_MAX_PAGES = 50;
/** Pages a paged sync reads per run when it doesn't say. */
export const APP_SYNC_DEFAULT_PAGES = 10;
/** Columns a Site SQL target fills. */
export const APP_SYNC_MAX_COLUMNS = 100;

/**
 * `shared` runs on the owner's connection and fills data everyone in the App
 * shares. `personal` runs once per person who opted in, on that person's own
 * connection, and fills only their own records of a `per_viewer` collection.
 */
export const AppSyncMode = /* @__PURE__ */ defineSchema(() =>
  z
    .enum(["shared", "personal"])
    .describe(
      "shared: runs on the owner's connection and fills a shared collection. personal: runs for each person who opted in, on their own connection, and fills only their own records of a per_viewer collection.",
    ),
);
export type AppSyncMode = z.infer<typeof AppSyncMode>;

const AppSyncCollection = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)
    .describe("The app data collection the sync fills."),
);
const AppSyncPath = /* @__PURE__ */ defineSchema(() => z.string().trim().min(1).max(256));

export const AppSyncArguments = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string().max(512), z.unknown()),
);

const AppSyncArgumentName = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .trim()
    .min(1)
    .max(256)
    .describe("The tool argument (dot path) the sync sets on each next call."),
);
const AppSyncMaxPages = /* @__PURE__ */ defineSchema(() =>
  z
    .number()
    .int()
    .min(1)
    .max(APP_SYNC_MAX_PAGES)
    .optional()
    .describe(`Most tool calls per run (default ${APP_SYNC_DEFAULT_PAGES}).`),
);

/**
 * Paging across tool calls. `cursor`: each result carries the next page's
 * cursor at `cursorPath`, passed back as `cursorArgument`; the run ends when
 * there is none. `page`: `pageArgument` counts up from `firstPage`; the run
 * ends at a page with no new records.
 */
export const AppSyncPaging = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("cursor"),
        cursorPath: AppSyncPath.describe(
          "Dot path to the next page's cursor in the tool result (for example `nextCursor`).",
        ),
        cursorArgument: AppSyncArgumentName,
        maxPages: AppSyncMaxPages,
      })
      .strict(),
    z
      .object({
        mode: z.literal("page"),
        pageArgument: AppSyncArgumentName,
        firstPage: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .optional()
          .describe("The first page number (default 1)."),
        maxPages: AppSyncMaxPages,
      })
      .strict(),
  ]),
);
export type AppSyncPaging = z.infer<typeof AppSyncPaging>;

const SqlIdentifier = /* @__PURE__ */ defineSchema(() => z.string().regex(SITE_SQL_IDENTIFIER));

/**
 * A Site SQL table a shared sync fills instead of a collection: each record
 * is upserted by `keyColumn` (which gets the record's key and must be the
 * table's primary key or unique), and `columns` maps each other column to a
 * dot path in the record.
 */
export const AppSyncTableTarget = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      table: SqlIdentifier.refine(isSiteSqlTableName, "Not a table name an app can use").describe(
        "The app's Site SQL table to fill.",
      ),
      keyColumn: SqlIdentifier.describe(
        "The column that holds each record's key; it must be the table's primary key or have a unique index.",
      ),
      columns: z
        .record(SqlIdentifier, AppSyncPath)
        .refine(
          (value) => Object.keys(value).length <= APP_SYNC_MAX_COLUMNS,
          `At most ${APP_SYNC_MAX_COLUMNS} columns`,
        )
        .describe(
          "Each column to fill and the dot path of its value in the record. Objects and lists are stored as JSON text.",
        ),
    })
    .strict(),
);
export type AppSyncTableTarget = z.infer<typeof AppSyncTableTarget>;

const AppSyncMaxRecords = /* @__PURE__ */ defineSchema(() =>
  z
    .number()
    .int()
    .min(1)
    .max(APP_SYNC_MAX_RUN_RECORDS)
    .describe(
      `Most records one run reads across pages (default ${APP_SYNC_MAX_RECORDS}, at most ${APP_SYNC_MAX_RUN_RECORDS}).`,
    ),
);

/** The fields every stored and requested sync shares. */
export const AppSyncSettings = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Required unless the sync fills a Site SQL table (`target`). */
    collection: AppSyncCollection.optional(),
    mode: AppSyncMode.default("shared"),
    tool: ToolGatewayIdentity.describe("The connected tool to call."),
    arguments: AppSyncArguments.default({}).describe(
      "Fixed arguments passed to the tool on every run.",
    ),
    recordsPath: AppSyncPath.nullable()
      .default(null)
      .describe(
        "Dot path to the list of records in the tool result (for example `data.items`). When omitted the sync uses the result itself if it is a list, or its only list.",
      ),
    key: AppSyncPath.describe(
      "Dot path to each record's unique key (for example `id`). Records with the same key are updated, not added again.",
    ),
    fields: z
      .array(AppSyncPath)
      .max(APP_SYNC_MAX_FIELDS)
      .nullable()
      .default(null)
      .describe(
        "Dot paths of the fields to keep (stored under the same path). Omit to keep the whole record.",
      ),
    // Optional with no default, so a definition that doesn't use them stays
    // the same plain JSON it was (packages compare definitions as JSON).
    target: AppSyncTableTarget.optional().describe(
      "Shared syncs: fill this Site SQL table instead of a collection.",
    ),
    paging: AppSyncPaging.optional().describe("Read several pages, one tool call each."),
    maxRecords: AppSyncMaxRecords.optional(),
    removeMissing: z
      .boolean()
      .optional()
      .describe(
        "After a complete run (every page read, nothing cut off, no failure), remove the records this sync wrote that the tool no longer returns.",
      ),
  }),
);

/**
 * The stored automation action. The server builds it (it sets the owner and
 * declared tools), so every field is explicit and nothing defaults.
 */
export const AppSyncAction = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("app_sync"),
      siteId: primitives.uuid,
      /** Null when the sync fills a Site SQL table (`target`). */
      collection: AppSyncCollection.nullable(),
      mode: AppSyncMode,
      /** The person whose connection a shared sync uses; never a request field. */
      ownerSubjectId: z.string().min(1).max(1024),
      tool: ToolGatewayIdentity,
      /**
       * `tool` and, for a tool on the owner's own account, its connector's
       * canonical identity, so each person's personal run resolves to their
       * own account (see site-tool-routing.ts).
       */
      declaredTools: z.array(ToolGatewayIdentity).max(8),
      /**
       * The connector-level identity of `tool` (its canonical connector when
       * `tool` is one person's account route). Exports carry it, and each run
       * resolves it to the running person's own account. Absent on syncs
       * saved before it existed; derived from `declaredTools` then.
       */
      connectorTool: ToolGatewayIdentity.nullable().optional(),
      arguments: AppSyncArguments,
      recordsPath: AppSyncPath.nullable(),
      key: AppSyncPath,
      fields: z.array(AppSyncPath).max(APP_SYNC_MAX_FIELDS).nullable(),
      target: AppSyncTableTarget.nullable().optional(),
      paging: AppSyncPaging.nullable().optional(),
      maxRecords: z.number().int().min(1).max(APP_SYNC_MAX_RUN_RECORDS).nullable().optional(),
      removeMissing: z.boolean().optional(),
      /**
       * The account (its route's server id) the owner chose for a shared
       * sync. Every run checks it is still theirs. Absent on syncs saved
       * before the choice existed; they keep using the owner's first account.
       */
      ownerAccount: z.string().min(1).max(256).nullable().optional(),
    })
    .strict(),
);
export type AppSyncAction = z.infer<typeof AppSyncAction>;

/** What one sync run did. */
export const AppSyncRunSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Records found in the tool result (capped at APP_SYNC_MAX_RECORDS). */
    received: z.number().int().nonnegative().default(0),
    /** Records written (created or updated). */
    written: z.number().int().nonnegative().default(0),
    /** Records without a usable key. */
    skipped: z.number().int().nonnegative().default(0),
    /** The run stopped before the tool's last record (a limit, or a cursor that repeated). */
    truncated: z.boolean().default(false),
    /** Tool calls made (pages read). */
    pages: z.number().int().nonnegative().default(0),
    /** Records removed because the tool no longer returned them (`removeMissing`). */
    removed: z.number().int().nonnegative().default(0),
    /** Personal syncs: how many people the run was for, and how many failed. */
    people: z
      .object({
        total: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      })
      .nullable()
      .default(null),
  }),
);
export type AppSyncRunSummary = z.infer<typeof AppSyncRunSummary>;

export const AppSyncLastRun = /* @__PURE__ */ defineSchema(() =>
  z.object({
    runId: primitives.uuid.nullable(),
    status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
    at: z.string(),
    error: z.string().nullable(),
    summary: AppSyncRunSummary.nullable(),
  }),
);
export type AppSyncLastRun = z.infer<typeof AppSyncLastRun>;

/**
 * What an App's own page may read about its syncs: when each last ran and
 * whether it failed. For a personal sync, the last run and opt-in are the
 * viewer's own.
 */
export const AppSyncStatus = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid,
    name: z.string(),
    /** The collection it fills, or for a Site SQL target the table. */
    collection: z.string(),
    /** The Site SQL table it fills; null for a collection. */
    table: z.string().nullable().optional(),
    mode: AppSyncMode,
    active: z.boolean(),
    lastRun: AppSyncLastRun.nullable(),
    /** Personal syncs: whether the viewer opted in. Null for shared syncs. */
    optedIn: z.boolean().nullable(),
  }),
);
export type AppSyncStatus = z.infer<typeof AppSyncStatus>;

export const AppSyncStatusResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ syncs: z.array(AppSyncStatus) }),
);
export type AppSyncStatusResponse = z.infer<typeof AppSyncStatusResponse>;

export const AppSyncSubscriptionResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    syncId: primitives.uuid,
    optedIn: z.boolean(),
    /** The account the person's runs use, when they chose one. */
    account: z.string().nullable().optional(),
  }),
);

/** `PUT …/syncs/:syncId/subscription`: opt in, on this account when the person has several. */
export const AppSyncOptInRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      account: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("The account to run on (an `accounts[].id` from the opt-in review)."),
    })
    .strict(),
);
export type AppSyncOptInRequest = z.infer<typeof AppSyncOptInRequest>;

/** One of the person's own accounts a sync can run on. */
export const AppSyncAccountChoice = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Pass as `account`. */
    id: z.string(),
    /** "ada@example.com" */
    label: z.string(),
    connector: z.string(),
    /** A workspace-shared account (shared syncs only). */
    shared: z.boolean(),
  }),
);
export type AppSyncAccountChoice = z.infer<typeof AppSyncAccountChoice>;

/**
 * What the platform's opt-in confirmation shows: the sync, the tool it calls,
 * where it writes and the person's own accounts to run it on.
 */
export const AppSyncOptInReview = /* @__PURE__ */ defineSchema(() =>
  z.object({
    syncId: primitives.uuid,
    name: z.string(),
    mode: AppSyncMode,
    collection: z.string(),
    tool: z.object({ toolName: z.string(), connector: z.string().nullable() }),
    accounts: z.array(AppSyncAccountChoice),
    /** The account their runs use now, when opted in with one. */
    account: z.string().nullable(),
    optedIn: z.boolean(),
    /** Why they can't opt in yet (for example nothing connected), or null. */
    blocked: z.string().nullable(),
  }),
);
export type AppSyncOptInReview = z.infer<typeof AppSyncOptInReview>;
export type AppSyncSubscriptionResponse = z.infer<typeof AppSyncSubscriptionResponse>;
