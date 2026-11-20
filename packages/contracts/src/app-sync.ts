import { z } from "zod";
import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { ToolGatewayIdentity } from "./tool-catalog";

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
    .describe("The App data collection the sync fills."),
);
const AppSyncPath = /* @__PURE__ */ defineSchema(() => z.string().trim().min(1).max(256));

export const AppSyncArguments = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string().max(512), z.unknown()),
);

/** The fields every stored and requested sync shares. */
export const AppSyncSettings = /* @__PURE__ */ defineSchema(() =>
  z.object({
    collection: AppSyncCollection,
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
      collection: AppSyncCollection,
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
      arguments: AppSyncArguments,
      recordsPath: AppSyncPath.nullable(),
      key: AppSyncPath,
      fields: z.array(AppSyncPath).max(APP_SYNC_MAX_FIELDS).nullable(),
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
    /** The result had more records than one run reads. */
    truncated: z.boolean().default(false),
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
    collection: z.string(),
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
  z.object({ syncId: primitives.uuid, optedIn: z.boolean() }),
);
export type AppSyncSubscriptionResponse = z.infer<typeof AppSyncSubscriptionResponse>;
