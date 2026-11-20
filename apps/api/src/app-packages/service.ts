import {
  APP_PACKAGE_DEMO_MAX_BYTES,
  APP_PACKAGE_DEMO_RECORDS_PER_COLLECTION,
  APP_PACKAGE_DEMO_ROWS_PER_TABLE,
  APP_PACKAGE_FORMAT,
  APP_PACKAGE_MAX_BYTES,
  APP_PACKAGE_VERSION,
  AppPackageFormatError,
  AppPackageSqlRow,
  appPackageFilename,
  isSiteSqlTableName,
  normalizeWorkspaceArtifactSlug,
  parseAppPackage,
  stableJson,
  type AccessGrant,
  type AppPackage,
  type AppPackageDemoRecord,
  type AppPackageExportRequest,
  type AppPackageExportResponse,
  type AppPackageInstallResponse,
  type AppPackageProblem,
  type SiteDataAccessMode,
  type SiteDataWriteOperation,
  type ToolGatewayIdentity,
  type WorkspaceArtifactVisibility,
} from "@opengeni/contracts";
import { resolveNewSiteAudience, siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  artifactRequestedToolsMissingFromAttemptCatalog,
  createWorkspaceArtifact,
  getWorkspaceArtifactContentRef,
  getWorkspaceArtifactCurrent,
  SiteDataError,
  WorkspaceArtifactConflictError,
  WorkspaceArtifactNotFoundError,
  WorkspaceArtifactOperationError,
  WorkspaceArtifactOwnerRequiredError,
} from "@opengeni/db";
import { errorMessage } from "@opengeni/contracts/values";
import { createHash } from "node:crypto";
import { ApiHttpError } from "../http/api-error";
import { siteDataHttpError } from "../routes/site-data";
import { siteSqlHttpError } from "../routes/site-sql";
import {
  defineSiteDataCollection,
  describeSiteData,
  exportSiteData,
  writeSiteData,
} from "../site-data/operations";
import { siteSqlGatewayConfig, siteSqlOffered } from "../site-sql/gateway";
import {
  defineSiteSqlQuery,
  describeSiteSql,
  exportSiteSql,
  importSiteSql,
  inspectSiteSql,
  migrateSiteSql,
  setSiteSqlSettings,
  SiteSqlError,
} from "../site-sql/service";
import { connectorToolIdentities, readSiteToolAccountInventory } from "../site-tool-routing";
import { prepareWorkspaceArtifactPublication } from "../site-uploads";
import { readWorkspaceArtifactContent } from "../workspace-artifact-content";
import { redactWorkspaceArtifactProvenance } from "../workspace-artifact-provenance";
import { appSyncHooks, syncName } from "./syncs";

/**
 * App packages: export an app (a Site) with its definitions as one file, and
 * install such a file into the caller's workspace as a new app with empty
 * data (or the package's demo data). Every step reuses the ordinary Site,
 * Site Data and Site SQL services with the caller's own authority, so the
 * permission rules are exactly theirs. Installs are lenient: a part that
 * can't be installed is reported and the rest still installs. See
 * docs/app-packages.md.
 */

export class AppPackageError extends Error {
  constructor(
    readonly code: "validation" | "too_large" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AppPackageError";
  }
}

/** Package, Site, Site Data and Site SQL failures in the public error envelope; null for others. */
export function appPackageHttpError(error: unknown): ApiHttpError | null {
  if (error instanceof ApiHttpError) return error;
  if (error instanceof AppPackageFormatError)
    return new ApiHttpError(422, { code: "validation_failed", message: error.message });
  if (error instanceof AppPackageError)
    return new ApiHttpError(
      error.code === "too_large" ? 413 : error.code === "unavailable" ? 503 : 422,
      {
        code:
          error.code === "too_large"
            ? "limit_exceeded"
            : error.code === "unavailable"
              ? "upstream_unavailable"
              : "validation_failed",
        message: error.message,
      },
    );
  if (error instanceof SiteDataError) return siteDataHttpError(error);
  if (error instanceof SiteSqlError) return siteSqlHttpError(error);
  if (error instanceof WorkspaceArtifactNotFoundError)
    return new ApiHttpError(404, { code: "not_found", message: "App not found" });
  if (error instanceof WorkspaceArtifactOwnerRequiredError)
    return new ApiHttpError(403, { code: "forbidden", message: error.message });
  if (error instanceof WorkspaceArtifactConflictError)
    return new ApiHttpError(409, { code: "conflict", message: error.message });
  if (error instanceof WorkspaceArtifactOperationError)
    return new ApiHttpError(422, { code: "validation_failed", message: error.message });
  return null;
}

function reason(error: unknown, context: string): string {
  if (
    error instanceof SiteDataError ||
    error instanceof SiteSqlError ||
    error instanceof AppPackageError ||
    error instanceof WorkspaceArtifactOperationError
  )
    return error.message;
  console.warn(`[app-packages] ${context} failed`, { error: errorMessage(error) });
  return "Something went wrong on our side";
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function selected(
  demo: AppPackageExportRequest["demoData"],
  kind: "collections" | "tables",
  all: readonly string[],
): string[] {
  if (demo === undefined || demo === false) return [];
  if (demo === true) return [...all];
  return [...new Set(demo[kind] ?? [])];
}

/**
 * One package file with the app's current version, its declared tools, Site
 * Data collection definitions, Site SQL migrations and named queries, its
 * syncs, and (only when asked) bounded demo data. Needs the manager role on
 * the app, like reading its data definitions.
 */
export async function exportAppPackage(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  request: AppPackageExportRequest = {},
): Promise<AppPackageExportResponse> {
  if (!deps.objectStorage)
    throw new AppPackageError("unavailable", "File storage isn't configured");
  const viewer = await siteViewerForGrant(deps.db, grant);
  const [artifact, ref] = await Promise.all([
    getWorkspaceArtifactCurrent(deps.db, grant.workspaceId, viewer, appId),
    getWorkspaceArtifactContentRef(deps.db, grant.workspaceId, viewer, appId),
  ]);
  // Managers only: the same check as reading the app's data definitions.
  const data = await describeSiteData(deps, grant, appId);
  const sql = await describeSiteSql(deps, grant, appId);
  const content = await readWorkspaceArtifactContent(deps.objectStorage, ref);
  const notExported: AppPackageProblem[] = [];

  let syncs: AppPackage["syncs"] = [];
  try {
    syncs = await appSyncHooks().list({ deps, grant, appId });
  } catch (error) {
    notExported.push({ part: "sync", reason: reason(error, "listing syncs") });
  }

  const pkg: AppPackage = {
    format: APP_PACKAGE_FORMAT,
    version: APP_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    app: {
      title: artifact.title,
      description: artifact.description,
      html: content.html,
      // An HTML-only app has no retained source of its own.
      ...(ref.sourceKey ? { source: content.source } : {}),
    },
    tools: await portableTools(deps, grant, content.requestedTools, notExported),
    data: {
      collections: data.collections.map((collection) => ({
        name: collection.name,
        accessMode: collection.accessMode,
        privateRecords: collection.privateRecords,
        guestAccess: collection.guestAccess,
        jsonSchema: collection.jsonSchema,
        indexedFields: collection.indexedFields,
        uniqueFields: collection.uniqueFields,
      })),
    },
    sql: {
      migrations: sql.migrations.map((migration) => ({ name: migration.name, sql: migration.sql })),
      queries: sql.queries.map((query) => ({
        name: query.name,
        sql: query.sql,
        audience: query.audience,
        description: query.description,
        maxRows: query.maxRows,
      })),
    },
    syncs,
  };

  const demo = await exportDemoData(deps, grant, appId, request.demoData, {
    collections: data.collections.map((collection) => ({
      name: collection.name,
      accessMode: collection.accessMode,
    })),
    sqlExists: sql.enabled || sql.migrations.length > 0,
    notExported,
    budget: Math.min(APP_PACKAGE_DEMO_MAX_BYTES, APP_PACKAGE_MAX_BYTES - jsonBytes(pkg)),
  });
  if (demo) pkg.demoData = demo;

  if (jsonBytes(pkg) > APP_PACKAGE_MAX_BYTES) {
    if (pkg.demoData) {
      delete pkg.demoData;
      notExported.push({ part: "demo_data", reason: "The package would be too large with it" });
    }
    if (jsonBytes(pkg) > APP_PACKAGE_MAX_BYTES)
      throw new AppPackageError(
        "too_large",
        `This app is larger than ${APP_PACKAGE_MAX_BYTES / (1024 * 1024)} MB, too large for a package`,
      );
  }
  return { package: pkg, filename: appPackageFilename(artifact.title), notExported };
}

const SHARED_ACCESS_MODES: ReadonlySet<SiteDataAccessMode> = new Set(["shared", "shared_read"]);

/**
 * The app's tools as another workspace can use them: account routes (the
 * author's own accounts) become their connector-level entries, so each
 * installer and viewer uses their own account.
 */
async function portableTools(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  declared: readonly ToolGatewayIdentity[],
  notExported: AppPackageProblem[],
): Promise<ToolGatewayIdentity[]> {
  if (declared.length === 0) return [];
  try {
    return connectorToolIdentities(await readSiteToolAccountInventory(deps, grant), declared);
  } catch (error) {
    // Without the reader's accounts, tools stay as declared and the gap is reported.
    notExported.push({ part: "tools", reason: reason(error, "reading connected accounts") });
    return connectorToolIdentities(
      { canonical: new Map(), plain: new Set(), accounts: [] },
      declared,
    );
  }
}

async function exportDemoData(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  demo: AppPackageExportRequest["demoData"],
  context: {
    collections: ReadonlyArray<{ name: string; accessMode: SiteDataAccessMode }>;
    sqlExists: boolean;
    notExported: AppPackageProblem[];
    budget: number;
  },
): Promise<AppPackage["demoData"]> {
  if (demo === undefined || demo === false) return undefined;
  const { notExported } = context;
  let budget = Math.max(0, context.budget);
  const records: Record<string, AppPackageDemoRecord[]> = {};
  const names = context.collections.map((collection) => collection.name);
  for (const name of selected(demo, "collections", names)) {
    const collection = context.collections.find((candidate) => candidate.name === name);
    if (!collection) {
      notExported.push({ part: "demo_data", name, reason: "No collection with this name" });
      continue;
    }
    // Only shared records are the app's own; per-person and submitted
    // records belong to the people who wrote them.
    if (!SHARED_ACCESS_MODES.has(collection.accessMode)) {
      notExported.push({
        part: "demo_data",
        name,
        reason: "Its records belong to the people who wrote them, so they aren't demo data",
      });
      continue;
    }
    try {
      const exported = await exportSiteData(deps, grant, appId, name, "json");
      const all = JSON.parse(exported.content) as Array<{
        key: string | null;
        data: Record<string, unknown>;
      }>;
      const kept: AppPackageDemoRecord[] = [];
      for (const entry of all) {
        const item: AppPackageDemoRecord = entry.key
          ? { key: entry.key, data: entry.data }
          : { data: entry.data };
        const size = jsonBytes(item) + 1;
        if (kept.length >= APP_PACKAGE_DEMO_RECORDS_PER_COLLECTION || size > budget) break;
        kept.push(item);
        budget -= size;
      }
      if (kept.length < all.length || exported.truncated)
        notExported.push({
          part: "demo_data",
          name,
          reason: `Only the first ${kept.length} records fit in the package`,
        });
      records[name] = kept;
    } catch (error) {
      notExported.push({ part: "demo_data", name, reason: reason(error, "exporting records") });
    }
  }

  const sqlRows: Record<string, AppPackageSqlRow[]> = {};
  const wantsTables = demo === true || (typeof demo === "object" && (demo.tables?.length ?? 0) > 0);
  if (wantsTables && context.sqlExists) {
    let tables: string[] = [];
    try {
      const inspected = await inspectSiteSql(deps, grant, appId);
      tables = inspected.tables
        .filter((table) => table.type === "table" && isSiteSqlTableName(table.name))
        .map((table) => table.name);
    } catch (error) {
      notExported.push({
        part: "demo_data",
        name: "database",
        reason: reason(error, "reading the app database"),
      });
    }
    for (const name of tables.length > 0 ? selected(demo, "tables", tables) : []) {
      if (!tables.includes(name)) {
        notExported.push({ part: "demo_data", name, reason: "No table with this name" });
        continue;
      }
      try {
        const exported = await exportSiteSql(deps, grant, appId, {
          format: "json",
          table: name,
          maxBytes: Math.max(1, Math.min(budget, 4 * 1024 * 1024)),
        });
        const parsed = JSON.parse(exported.content) as {
          tables: Record<string, { rows: unknown[] }>;
        };
        const rows = parsed.tables[name]?.rows ?? [];
        const kept: AppPackageSqlRow[] = [];
        let invalid = false;
        for (const row of rows) {
          const checked = AppPackageSqlRow.safeParse(row);
          if (!checked.success) {
            invalid = true;
            break;
          }
          const size = jsonBytes(checked.data) + 1;
          if (kept.length >= APP_PACKAGE_DEMO_ROWS_PER_TABLE || size > budget) break;
          kept.push(checked.data);
          budget -= size;
        }
        if (invalid) {
          notExported.push({
            part: "demo_data",
            name,
            reason: "It has binary or very long values, which packages don't carry",
          });
          continue;
        }
        if (kept.length < rows.length || exported.truncated)
          notExported.push({
            part: "demo_data",
            name,
            reason: `Only the first ${kept.length} rows fit in the package`,
          });
        sqlRows[name] = kept;
      } catch (error) {
        notExported.push({ part: "demo_data", name, reason: reason(error, "exporting rows") });
      }
    }
  } else if (wantsTables && typeof demo === "object") {
    notExported.push({ part: "demo_data", reason: "This app has no database" });
  }
  if (Object.keys(records).length === 0 && Object.keys(sqlRows).length === 0) return undefined;
  return { records, sqlRows };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * The operation key of an install: the caller's idempotency key within its
 * namespace (a person, or an agent's turn) and the package's content, so the
 * same key with a different package installs a different app instead of
 * changing the first one.
 */
export function appInstallOperationKey(
  prefix: "subject" | "attempt",
  namespace: string,
  idempotencyKey: string,
  pkg: unknown,
): string {
  const digest = createHash("sha256").update(stableJson(pkg)).digest("hex");
  return `${prefix}:${createHash("sha256")
    .update(`${namespace}:app-install:${digest}:${idempotencyKey}`)
    .digest("hex")}`;
}

/** Who installs, for the new app's history (an HTTP caller or an agent attempt). */
export type AppInstallProvenance = {
  operationKey: string;
  actorSubjectId: string;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
  sourceToolName: "app_install" | null;
};

/**
 * Install a package as a new app in the caller's workspace: create the app
 * from the package's version (declaring its tools, so viewers get connect
 * cards), define its collections, turn on its database and run its
 * migrations and named queries, add its syncs paused, and load demo data
 * when the package has some and the caller didn't decline it. The app starts
 * with no data otherwise. A part that fails is reported in `notInstalled`;
 * the rest still installs. The same `provenance.operationKey` returns the
 * same app and completes whatever an earlier attempt left undone.
 */
export async function installAppPackage(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: {
    package: unknown;
    title?: string | undefined;
    visibility?: WorkspaceArtifactVisibility | undefined;
    demoData?: boolean | undefined;
    provenance: AppInstallProvenance;
  },
): Promise<AppPackageInstallResponse> {
  if (!deps.objectStorage)
    throw new AppPackageError("unavailable", "File storage isn't configured");
  if (jsonBytes(input.package) > APP_PACKAGE_MAX_BYTES + 1024 * 1024)
    throw new AppPackageError("too_large", "This package is too large");
  const { package: pkg, problems } = parseAppPackage(input.package);
  const notInstalled: AppPackageProblem[] = [...problems];
  const installed: AppPackageInstallResponse["installed"] = {
    tools: 0,
    collections: [],
    migrations: [],
    queries: [],
    syncs: [],
    demoRecords: 0,
    demoRows: 0,
  };

  // 1. The app itself, from the package's version.
  const viewer = await siteViewerForGrant(deps.db, grant);
  const audience = await resolveNewSiteAudience({
    db: deps.db,
    settings: deps.settings,
    grant,
    viewer,
    requested: input.visibility,
    sourceSessionId: input.provenance.sourceSessionId,
  });
  const title = (input.title ?? pkg.app.title).trim() || "Installed app";
  const appId = crypto.randomUUID();
  const create = async (tools: ToolGatewayIdentity[]) =>
    await createWorkspaceArtifact(deps.db, {
      ...audience,
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      artifactId: appId,
      slug: `${(normalizeWorkspaceArtifactSlug(title) || "app").slice(0, 87)}-${appId.slice(0, 8)}`,
      requestedSlug: null,
      title,
      description: pkg.app.description,
      ...(await prepareWorkspaceArtifactPublication(deps, grant, {
        html: pkg.app.html,
        ...(pkg.app.source ? { source: pkg.app.source } : {}),
        requestedTools: tools,
      })),
      ...input.provenance,
    });
  let tools = pkg.tools;
  // An agent may only declare tools its chat has: keep those, report the rest.
  if (input.provenance.sourceAttemptId !== null && tools.length > 0) {
    try {
      const missing = await artifactRequestedToolsMissingFromAttemptCatalog(
        deps.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sourceSessionId: input.provenance.sourceSessionId,
          sourceTurnId: input.provenance.sourceTurnId,
          sourceAttemptId: input.provenance.sourceAttemptId,
          sourceExecutionGeneration: input.provenance.sourceExecutionGeneration,
        },
        tools,
      );
      const key = (tool: ToolGatewayIdentity) => `${tool.serverId}\u0000${tool.toolName}`;
      const left = new Set(missing.map(key));
      tools = tools.filter((tool) => !left.has(key(tool)));
      for (const tool of missing)
        notInstalled.push({
          part: "tools",
          name: tool.toolName,
          reason:
            "This chat doesn't have this tool, so the app doesn't use it. Connect it and install again, or install from the Apps page to keep it.",
        });
    } catch (error) {
      notInstalled.push({ part: "tools", reason: reason(error, "reading this chat's tools") });
      tools = [];
    }
  }
  let created: Awaited<ReturnType<typeof create>>;
  try {
    created = await create(tools);
  } catch (error) {
    // Too many tools to pair with the installer's accounts: install without them.
    if (tools.length === 0 || !(error instanceof WorkspaceArtifactOperationError)) throw error;
    tools = [];
    created = await create(tools);
    notInstalled.push({ part: "tools", reason: error.message });
  }
  const app = created.artifact;
  installed.tools = tools.length;

  // 2. Site Data collections (defining one again is a no-op change).
  for (const { name, ...definition } of pkg.data.collections) {
    try {
      await defineSiteDataCollection(deps, grant, app.id, name, definition);
      installed.collections.push(name);
    } catch (error) {
      notInstalled.push({
        part: "collection",
        name,
        reason: reason(error, "defining a collection"),
      });
    }
  }

  // 3. The app database: migrations in order, then named queries.
  const wantsDemo = input.demoData !== false && pkg.demoData !== undefined;
  const sqlRows = wantsDemo ? (pkg.demoData?.sqlRows ?? {}) : {};
  const needsSql =
    pkg.sql.migrations.length > 0 || pkg.sql.queries.length > 0 || Object.keys(sqlRows).length > 0;
  let sqlReady = false;
  if (needsSql) {
    if (!siteSqlOffered(deps.settings) || siteSqlGatewayConfig(deps.settings) === null) {
      notInstalled.push({
        part: "sql",
        reason: `App databases aren't available on this deployment, so ${pkg.sql.migrations.length} migrations and ${pkg.sql.queries.length} queries weren't installed`,
      });
    } else {
      try {
        await setSiteSqlSettings(deps, grant, app.id, { enabled: true });
        sqlReady = true;
      } catch (error) {
        notInstalled.push({ part: "sql", reason: reason(error, "turning on the database") });
      }
    }
  }
  if (sqlReady) {
    let existing = new Set<string>();
    try {
      existing = new Set(
        (await describeSiteSql(deps, grant, app.id)).migrations.map((entry) => entry.name),
      );
    } catch {
      // A fresh app has none; a failed read only means migrating may report conflicts.
    }
    let failed: string | null = null;
    for (const migration of pkg.sql.migrations) {
      if (failed) {
        notInstalled.push({
          part: "migration",
          name: migration.name,
          reason: `Skipped because migration ${failed} failed`,
        });
        continue;
      }
      if (existing.has(migration.name)) {
        installed.migrations.push(migration.name);
        continue;
      }
      try {
        await migrateSiteSql(deps, grant, app.id, migration);
        installed.migrations.push(migration.name);
      } catch (error) {
        failed = migration.name;
        notInstalled.push({
          part: "migration",
          name: migration.name,
          reason: reason(error, "running a migration"),
        });
      }
    }
    for (const { name, description, maxRows, ...query } of pkg.sql.queries) {
      try {
        await defineSiteSqlQuery(deps, grant, app.id, name, {
          ...query,
          ...(description ? { description } : {}),
          ...(maxRows !== null && maxRows !== undefined ? { maxRows } : {}),
        });
        installed.queries.push(name);
      } catch (error) {
        notInstalled.push({ part: "query", name, reason: reason(error, "defining a query") });
      }
    }
  }

  // 4. Syncs, paused until the installer confirms the account they use.
  if (pkg.syncs.length > 0) {
    try {
      const result = await appSyncHooks().createPaused({
        deps,
        grant,
        appId: app.id,
        syncs: pkg.syncs,
        installKey: input.provenance.operationKey,
      });
      installed.syncs.push(...result.created);
      for (const entry of result.notCreated)
        notInstalled.push({ part: "sync", name: entry.name, reason: entry.reason });
    } catch (error) {
      const why = reason(error, "creating syncs");
      pkg.syncs.forEach((sync, index) =>
        notInstalled.push({ part: "sync", name: syncName(sync, index), reason: why }),
      );
    }
  }

  // 5. Demo data, only into collections and tables that are still empty.
  if (wantsDemo && pkg.demoData) {
    installed.demoRecords = await installDemoRecords(
      deps,
      grant,
      app.id,
      pkg.demoData.records,
      notInstalled,
    );
    if (sqlReady)
      installed.demoRows = await installDemoRows(deps, grant, app.id, sqlRows, notInstalled);
    else if (Object.keys(sqlRows).length > 0 && !notInstalled.some((p) => p.part === "sql"))
      notInstalled.push({ part: "demo_data", reason: "The app database isn't available" });
  }

  return {
    app: redactWorkspaceArtifactProvenance(app),
    replayed: created.replayed,
    installed,
    notInstalled,
  };
}

async function installDemoRecords(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  records: Record<string, AppPackageDemoRecord[]>,
  notInstalled: AppPackageProblem[],
): Promise<number> {
  if (Object.keys(records).length === 0) return 0;
  let counts: Map<string, number>;
  try {
    const described = await describeSiteData(deps, grant, appId);
    counts = new Map(described.collections.map((entry) => [entry.name, entry.recordCount]));
  } catch (error) {
    notInstalled.push({ part: "demo_data", reason: reason(error, "reading collections") });
    return 0;
  }
  let written = 0;
  for (const [name, entries] of Object.entries(records)) {
    const count = counts.get(name);
    if (count === undefined) {
      notInstalled.push({ part: "demo_data", name, reason: "Its collection wasn't installed" });
      continue;
    }
    // Already loaded (a replayed install) or written to since: leave it.
    if (count > 0 || entries.length === 0) continue;
    const operations: SiteDataWriteOperation[] = entries.map((entry, index) =>
      entry.key
        ? { op: "put", collection: name, key: entry.key, data: entry.data }
        : {
            op: "insert",
            collection: name,
            data: entry.data,
            idempotencyKey: `app-package-demo:${index}`,
          },
    );
    for (let start = 0; start < operations.length; start += 100) {
      try {
        await writeSiteData(deps, grant, appId, operations.slice(start, start + 100));
        written += Math.min(100, operations.length - start);
      } catch (error) {
        notInstalled.push({
          part: "demo_data",
          name,
          reason: `${operations.length - start} records weren't loaded: ${reason(error, "loading records")}`,
        });
        break;
      }
    }
  }
  return written;
}

async function installDemoRows(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  sqlRows: Record<string, AppPackageSqlRow[]>,
  notInstalled: AppPackageProblem[],
): Promise<number> {
  if (Object.keys(sqlRows).length === 0) return 0;
  let counts: Map<string, number>;
  try {
    const inspected = await inspectSiteSql(deps, grant, appId);
    counts = new Map(inspected.tables.map((table) => [table.name, table.rowCount]));
  } catch (error) {
    notInstalled.push({ part: "demo_data", reason: reason(error, "reading the database") });
    return 0;
  }
  let written = 0;
  for (const [table, rows] of Object.entries(sqlRows)) {
    const count = counts.get(table);
    if (count === undefined) {
      notInstalled.push({ part: "demo_data", name: table, reason: "Its table doesn't exist" });
      continue;
    }
    if (count > 0 || rows.length === 0) continue;
    for (let start = 0; start < rows.length; start += 1_000) {
      try {
        const result = await importSiteSql(deps, grant, appId, {
          format: "json",
          table,
          rows: rows.slice(start, start + 1_000),
          onConflict: "ignore",
        });
        written += result.imported;
      } catch (error) {
        notInstalled.push({
          part: "demo_data",
          name: table,
          reason: `${rows.length - start} rows weren't loaded: ${reason(error, "loading rows")}`,
        });
        break;
      }
    }
  }
  return written;
}
