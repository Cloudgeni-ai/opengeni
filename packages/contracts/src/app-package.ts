import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import {
  WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS,
  WORKSPACE_ARTIFACT_TITLE_MAX_CHARS,
  WorkspaceArtifact,
  WorkspaceArtifactHtml,
  WorkspaceArtifactRequestedTools,
  WorkspaceArtifactSourceBundle,
  WorkspaceArtifactVisibility,
} from "./artifacts";
import { SiteDataCollectionDefinitionRequest } from "./site-data";
import {
  SITE_SQL_IDENTIFIER,
  SITE_SQL_NAME,
  SiteSqlQueryDefinitionRequest,
  SiteSqlValueSchema,
} from "./site-sql";
import { SIDEBAR_LABEL_MAX_CHARS, SidebarAppPath } from "./sidebar-layout";
import { ToolGatewayIdentity } from "./tool-catalog";

/**
 * An app package: one JSON file that carries an app (a Site) to another
 * workspace. It holds the app's current version (HTML and optional source),
 * the tools it declares, its Site Data collection definitions, its Site SQL
 * migrations and named queries, its syncs, where it sits in the sidebar, and
 * optional bounded demo data. It never holds the app's real data. See docs/app-packages.md.
 */
export const APP_PACKAGE_FORMAT = "opengeni.app-package";
export const APP_PACKAGE_VERSION = 1;
/** A package file is at most this large (the API reads it in one request). */
export const APP_PACKAGE_MAX_BYTES = 24 * 1024 * 1024;
/** Demo data limits: records per collection, rows per table and bytes in all. */
export const APP_PACKAGE_DEMO_RECORDS_PER_COLLECTION = 1_000;
export const APP_PACKAGE_DEMO_ROWS_PER_TABLE = 5_000;
export const APP_PACKAGE_DEMO_MAX_BYTES = 8 * 1024 * 1024;
/** Shared Site files in demo data: at most this many (their bytes count toward the demo budget). */
export const APP_PACKAGE_DEMO_FILES_MAX = 200;
export const APP_PACKAGE_SYNCS_MAX = 50;
export const APP_PACKAGE_SIDEBAR_MAX = 10;
/** How long a package file `app_export` stores for download is kept. */
export const APP_PACKAGE_EXPORT_TTL_SECONDS = 24 * 60 * 60;

const Name = primitives.string.regex(SITE_SQL_NAME);

export const AppPackageCollection = /* @__PURE__ */ defineSchema(() =>
  SiteDataCollectionDefinitionRequest.extend({ name: Name }),
);
export type AppPackageCollection = z.infer<typeof AppPackageCollection>;

export const AppPackageMigration = /* @__PURE__ */ defineSchema(() =>
  z.object({ name: Name, sql: primitives.nonEmptyString.max(2 * 1024 * 1024) }),
);
export type AppPackageMigration = z.infer<typeof AppPackageMigration>;

export const AppPackageQuery = /* @__PURE__ */ defineSchema(() =>
  SiteSqlQueryDefinitionRequest.extend({
    name: Name,
    description: z.string().max(2000).nullable().optional(),
    maxRows: SiteSqlQueryDefinitionRequest.shape.maxRows.nullable(),
  }),
);
export type AppPackageQuery = z.infer<typeof AppPackageQuery>;

/**
 * A sync definition (an automation that fills app data from a connected
 * tool), kept as plain JSON: the sync feature owns its shape. Installed syncs
 * start paused until the installer confirms the account they use.
 */
export const AppPackageSync = /* @__PURE__ */ defineSchema(() =>
  z.record(primitives.string, z.unknown()),
);
export type AppPackageSync = z.infer<typeof AppPackageSync>;

/**
 * Where the app sits in the workspace's default sidebar: one link, optionally
 * to one of its pages, with its own label and the name of the group it is in.
 */
export const AppPackageSidebarItem = /* @__PURE__ */ defineSchema(() =>
  z.object({
    path: SidebarAppPath.optional(),
    label: primitives.string.trim().min(1).max(SIDEBAR_LABEL_MAX_CHARS).optional(),
    group: primitives.string.trim().min(1).max(SIDEBAR_LABEL_MAX_CHARS).optional(),
  }),
);
export type AppPackageSidebarItem = z.infer<typeof AppPackageSidebarItem>;

export const AppPackageDemoRecord = /* @__PURE__ */ defineSchema(() =>
  z.object({
    key: primitives.string.min(1).max(512).nullable().optional(),
    data: z.record(primitives.string, z.unknown()),
  }),
);
export type AppPackageDemoRecord = z.infer<typeof AppPackageDemoRecord>;

/**
 * A SQL value in demo rows: text, number, boolean, null, or a blob as
 * `{ "$base64": "…" }` (the same tag Site SQL JSON exports use).
 */
export const AppPackageSqlValue = /* @__PURE__ */ defineSchema(() =>
  z.union([
    SiteSqlValueSchema,
    z.object({
      $base64: primitives.string.max(8 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
    }),
  ]),
);
export type AppPackageSqlValue = z.infer<typeof AppPackageSqlValue>;

export const AppPackageSqlRow = /* @__PURE__ */ defineSchema(() =>
  z.record(primitives.string, AppPackageSqlValue),
);
export type AppPackageSqlRow = z.infer<typeof AppPackageSqlRow>;

/**
 * One of the app's shared Site files in demo data. `id` is its id in the
 * exporting app: install gives the copy a new id and rewrites demo values
 * that are exactly the old id.
 */
export const AppPackageDemoFile = /* @__PURE__ */ defineSchema(() =>
  z.object({
    id: primitives.uuid.optional(),
    name: primitives.string.trim().min(1).max(255),
    contentType: primitives.string.min(1).max(255),
    base64: primitives.string.max(16 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  }),
);
export type AppPackageDemoFile = z.infer<typeof AppPackageDemoFile>;

export type AppPackage = {
  format: typeof APP_PACKAGE_FORMAT;
  version: number;
  exportedAt: string;
  app: {
    title: string;
    description: string | null;
    html: string;
    /** Retained editable source; absent for HTML-only apps. */
    source?: z.infer<typeof WorkspaceArtifactSourceBundle> | undefined;
  };
  /** The tools the app declares; installers connect their own accounts. */
  tools: ToolGatewayIdentity[];
  data: { collections: AppPackageCollection[] };
  sql: { migrations: AppPackageMigration[]; queries: AppPackageQuery[] };
  syncs: AppPackageSync[];
  /** The app's links in the exporting workspace's default sidebar. */
  sidebar?: AppPackageSidebarItem[] | undefined;
  /** Present only when the author chose to include demo data. */
  demoData?:
    | {
        records: Record<string, AppPackageDemoRecord[]>;
        sqlRows: Record<string, AppPackageSqlRow[]>;
        /** The app's shared Site files (never private ones). Absent in older packages. */
        files?: AppPackageDemoFile[] | undefined;
      }
    | undefined;
};

/** Something in a package that was left out of an export or an install, and why. */
export type AppPackageProblem = {
  part:
    | "package"
    | "app"
    | "version"
    | "tools"
    | "collection"
    | "sql"
    | "migration"
    | "query"
    | "sync"
    | "sidebar"
    | "demo_data";
  name?: string | undefined;
  reason: string;
};

/** POST .../published-artifacts/:id/package: what to put in the package. */
export const AppPackageExportRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    demoData: z
      .union([
        primitives.boolean,
        z.object({
          collections: z.array(Name).max(100).optional(),
          tables: z.array(primitives.string.regex(SITE_SQL_IDENTIFIER)).max(100).optional(),
          files: primitives.boolean
            .optional()
            .describe("Include the app's shared files (never private ones)."),
        }),
      ])
      .optional()
      .describe(
        "Include demo data: true for every shared collection, table and shared file, or name the collections and tables (and files: true). Omitted: no data.",
      ),
  }),
);
export type AppPackageExportRequest = z.infer<typeof AppPackageExportRequest>;

export type AppPackageExportResponse = {
  package: AppPackage;
  /** A file name for the package, such as team-board.opengeni-app.json. */
  filename: string;
  /** Parts left out of the package, such as demo data past its limits. */
  notExported: AppPackageProblem[];
};

/** POST /v1/workspaces/:workspaceId/app-packages/install */
export const AppPackageInstallRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    package: z.record(primitives.string, z.unknown()).describe("The package file's JSON."),
    title: primitives.string.trim().min(1).max(WORKSPACE_ARTIFACT_TITLE_MAX_CHARS).optional(),
    visibility: WorkspaceArtifactVisibility.optional(),
    demoData: primitives.boolean
      .optional()
      .describe("Install the package's demo data (default true when it has some)."),
    idempotencyKey: primitives.string.trim().min(1).max(200),
  }),
);
export type AppPackageInstallRequest = z.infer<typeof AppPackageInstallRequest>;

export type AppPackageInstallResponse = {
  app: z.infer<typeof WorkspaceArtifact>;
  /** The same request was installed before; this is that app. */
  replayed: boolean;
  installed: {
    tools: number;
    collections: string[];
    migrations: string[];
    queries: string[];
    syncs: string[];
    /** Sidebar links added, to the default sidebar or the installer's own. */
    sidebar: number;
    demoRecords: number;
    demoRows: number;
    /** Shared Site files loaded from the demo data. */
    demoFiles?: number;
  };
  /** What couldn't be installed; the rest was. */
  notInstalled: AppPackageProblem[];
};

export type ParsedAppPackage = { package: AppPackage; problems: AppPackageProblem[] };

/** POST .../published-artifacts/:id/package/upgrade */
export const AppPackageUpgradeRequest = /* @__PURE__ */ defineSchema(() =>
  z.object({
    package: z.record(primitives.string, z.unknown()).describe("The package file's JSON."),
    dryRun: primitives.boolean.optional().describe("Only return the plan; nothing changes."),
    allowDestructive: primitives.boolean
      .optional()
      .describe(
        "Apply changes the plan marks destructive (they could hide, reassign or delete existing data).",
      ),
    idempotencyKey: primitives.string
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Required to apply; the same key and package apply once."),
  }),
);
export type AppPackageUpgradeRequest = z.infer<typeof AppPackageUpgradeRequest>;

/**
 * What upgrading an app from a package changes. Nothing is ever deleted:
 * collections and syncs the package doesn't have are kept. Each list names
 * collections, migrations, queries or syncs.
 */
export type AppPackageUpgradePlan = {
  /** Whether the package's version differs from the app's current one. */
  version: { changed: boolean; html: boolean; source: boolean; tools: boolean };
  tools: { added: ToolGatewayIdentity[]; removed: ToolGatewayIdentity[] };
  collections: {
    added: string[];
    changed: string[];
    unchanged: string[];
    kept: string[];
  };
  migrations: { applied: string[]; new: string[]; conflicting: string[] };
  queries: {
    added: string[];
    changed: string[];
    removed: string[];
    unchanged: string[];
  };
  syncs: {
    added: string[];
    changed: string[];
    unchanged: string[];
    kept: string[];
  };
  /** Changes that could hide, reassign or delete existing data: applying needs `allowDestructive`. */
  destructive: AppPackageProblem[];
  /** What stops the upgrade; nothing is applied while there is any. */
  conflicts: AppPackageProblem[];
  /** Parts of the package that are ignored or won't apply, and why. */
  problems: AppPackageProblem[];
};

export type AppPackageUpgradeResponse = {
  /** The app after the upgrade (unchanged for a dry run). */
  app: z.infer<typeof WorkspaceArtifact>;
  dryRun: boolean;
  /** Whether the upgrade ran (false for a dry run). */
  applied: boolean;
  plan: AppPackageUpgradePlan;
  /**
   * What this request changed. Every step skips what is already done (and
   * the same key publishes the version once), so a retry lists only what was
   * still left.
   */
  upgraded: {
    version: boolean;
    collections: string[];
    migrations: string[];
    queries: string[];
    syncs: string[];
  };
  /** What couldn't be upgraded; the rest was. */
  notUpgraded: AppPackageProblem[];
};

export class AppPackageFormatError extends Error {
  readonly name = "AppPackageFormatError";
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function issue(error: z.ZodError): string {
  return error.issues
    .slice(0, 2)
    .map((entry) => `${entry.path.join(".") || "value"}: ${entry.message}`)
    .join("; ");
}

function itemName(value: unknown, fallback: string): string {
  const name = record(value)?.name;
  return typeof name === "string" && name.length > 0 ? name.slice(0, 128) : fallback;
}

/**
 * Read a package leniently: only the format and the app's HTML are required.
 * Unknown fields are ignored, and each collection, migration, query, sync or
 * demo set that doesn't validate is left out and reported instead of failing
 * the whole package. Throws AppPackageFormatError when it isn't an app
 * package at all.
 */
export function parseAppPackage(value: unknown): ParsedAppPackage {
  const root = record(value);
  if (!root || root.format !== APP_PACKAGE_FORMAT)
    throw new AppPackageFormatError(
      `This isn't an app package (format must be "${APP_PACKAGE_FORMAT}")`,
    );
  const problems: AppPackageProblem[] = [];
  const version =
    typeof root.version === "number" && Number.isInteger(root.version) && root.version > 0
      ? root.version
      : null;
  if (version === null)
    throw new AppPackageFormatError("This app package has no valid version number");
  if (version > APP_PACKAGE_VERSION)
    problems.push({
      part: "package",
      reason: `Made by a newer Opengeni (package version ${version}); parts this version doesn't know were ignored`,
    });
  const app = record(root.app);
  const html = WorkspaceArtifactHtml.safeParse(app?.html);
  if (!app || !html.success) throw new AppPackageFormatError("This app package has no app HTML");
  const title =
    typeof app.title === "string" && app.title.trim().length > 0
      ? app.title.trim().slice(0, WORKSPACE_ARTIFACT_TITLE_MAX_CHARS)
      : "Installed app";
  const description =
    typeof app.description === "string"
      ? app.description.slice(0, WORKSPACE_ARTIFACT_DESCRIPTION_MAX_CHARS)
      : null;
  let source: AppPackage["app"]["source"];
  if (app.source !== undefined && app.source !== null) {
    const parsed = WorkspaceArtifactSourceBundle.safeParse(app.source);
    if (parsed.success) source = parsed.data;
    else
      problems.push({
        part: "app",
        name: "source",
        reason: `Its editable source was invalid and left out (${issue(parsed.error)}); the app itself installs`,
      });
  }

  const list = <T>(
    raw: unknown,
    schema: z.ZodType<T>,
    part: AppPackageProblem["part"],
    label: string,
  ): T[] => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      problems.push({ part, reason: `${label} isn't a list and was ignored` });
      return [];
    }
    const items: T[] = [];
    for (const [index, entry] of raw.entries()) {
      const parsed = schema.safeParse(entry);
      if (parsed.success) items.push(parsed.data);
      else
        problems.push({
          part,
          name: itemName(entry, `#${index + 1}`),
          reason: `Invalid (${issue(parsed.error)})`,
        });
    }
    return items;
  };

  let tools: ToolGatewayIdentity[] = [];
  const rawTools = list(root.tools, ToolGatewayIdentity, "tools", "tools");
  const checkedTools = WorkspaceArtifactRequestedTools.safeParse(rawTools);
  if (checkedTools.success) tools = checkedTools.data;
  else {
    const seen = new Set<string>();
    tools = rawTools
      .filter((tool) => {
        const key = `${tool.serverId}\u0000${tool.toolName}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 128);
    if (tools.length < rawTools.length)
      problems.push({ part: "tools", reason: "Repeated or extra tools were left out" });
  }

  const data = record(root.data);
  const collections = list(
    data?.collections,
    AppPackageCollection,
    "collection",
    "data.collections",
  );
  const sql = record(root.sql);
  const migrations = list(sql?.migrations, AppPackageMigration, "migration", "sql.migrations");
  const queries = list(sql?.queries, AppPackageQuery, "query", "sql.queries");
  const syncs = list(root.syncs, AppPackageSync, "sync", "syncs");
  if (syncs.length > APP_PACKAGE_SYNCS_MAX) {
    problems.push({
      part: "sync",
      reason: `Only the first ${APP_PACKAGE_SYNCS_MAX} syncs were read`,
    });
    syncs.length = APP_PACKAGE_SYNCS_MAX;
  }

  const sidebar = list(root.sidebar, AppPackageSidebarItem, "sidebar", "sidebar");
  if (sidebar.length > APP_PACKAGE_SIDEBAR_MAX) {
    problems.push({
      part: "sidebar",
      reason: `Only the first ${APP_PACKAGE_SIDEBAR_MAX} sidebar links were read`,
    });
    sidebar.length = APP_PACKAGE_SIDEBAR_MAX;
  }

  let demoData: AppPackage["demoData"];
  const demo = record(root.demoData);
  if (demo) {
    const records: Record<string, AppPackageDemoRecord[]> = {};
    const sqlRows: Record<string, AppPackageSqlRow[]> = {};
    for (const [name, raw] of Object.entries(record(demo.records) ?? {})) {
      const parsed = z
        .array(AppPackageDemoRecord)
        .max(APP_PACKAGE_DEMO_RECORDS_PER_COLLECTION)
        .safeParse(raw);
      if (parsed.success && SITE_SQL_NAME.test(name)) records[name] = parsed.data;
      else
        problems.push({
          part: "demo_data",
          name,
          reason: parsed.success ? "Invalid collection name" : `Invalid (${issue(parsed.error)})`,
        });
    }
    for (const [name, raw] of Object.entries(record(demo.sqlRows) ?? {})) {
      const parsed = z.array(AppPackageSqlRow).max(APP_PACKAGE_DEMO_ROWS_PER_TABLE).safeParse(raw);
      if (parsed.success && SITE_SQL_IDENTIFIER.test(name)) sqlRows[name] = parsed.data;
      else
        problems.push({
          part: "demo_data",
          name,
          reason: parsed.success ? "Invalid table name" : `Invalid (${issue(parsed.error)})`,
        });
    }
    const files: AppPackageDemoFile[] = [];
    if (demo.files !== undefined && demo.files !== null) {
      if (!Array.isArray(demo.files))
        problems.push({
          part: "demo_data",
          reason: "demoData.files isn't a list and was ignored",
        });
      else
        for (const [index, entry] of demo.files.entries()) {
          if (files.length >= APP_PACKAGE_DEMO_FILES_MAX) {
            problems.push({
              part: "demo_data",
              reason: `Only the first ${APP_PACKAGE_DEMO_FILES_MAX} files were read`,
            });
            break;
          }
          const parsed = AppPackageDemoFile.safeParse(entry);
          if (parsed.success) files.push(parsed.data);
          else
            problems.push({
              part: "demo_data",
              name: itemName(entry, `file ${index + 1}`),
              reason: `Invalid file (${issue(parsed.error)})`,
            });
        }
    }
    if (Object.keys(records).length > 0 || Object.keys(sqlRows).length > 0 || files.length > 0)
      demoData = { records, sqlRows, ...(files.length > 0 ? { files } : {}) };
  }

  return {
    package: {
      format: APP_PACKAGE_FORMAT,
      version,
      exportedAt: typeof root.exportedAt === "string" ? root.exportedAt : "",
      app: { title, description, html: html.data, ...(source ? { source } : {}) },
      tools,
      data: { collections },
      sql: { migrations, queries },
      syncs,
      ...(sidebar.length > 0 ? { sidebar } : {}),
      ...(demoData ? { demoData } : {}),
    },
    problems,
  };
}

/** A file name for an app's package: its title in lowercase words. */
export function appPackageFilename(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "app"}.opengeni-app.json`;
}
