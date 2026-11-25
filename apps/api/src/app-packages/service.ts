import {
  APP_PACKAGE_DEMO_FILES_MAX,
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
  type AppPackageDemoFile,
  type AppPackageDemoRecord,
  type AppPackageExportRequest,
  type AppPackageExportResponse,
  type AppPackageInstallResponse,
  type AppPackageProblem,
  type SiteDataAccessMode,
  type SiteSqlValue,
  type SiteDataWriteOperation,
  type ToolGatewayIdentity,
  type WorkspaceArtifactVisibility,
} from "@opengeni/contracts";
import { resolveNewSiteAudience, siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  artifactRequestedToolsMissingFromAttemptCatalog,
  createWorkspaceArtifact,
  getAppPackageId,
  getAppPackageInstall,
  getWorkspaceArtifactContentRef,
  getWorkspaceArtifactCurrent,
  putAppPackageInstall,
  setAppPackageId,
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
  listSiteDataFiles,
  readSiteDataFileBytes,
  uploadSiteDataFile,
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
import { readSiteAssetBundle, storeSiteAssetFiles } from "../site-assets";
import { siteToolDataSources, siteToolDataTarget } from "../site-tool-data";
import { prepareWorkspaceArtifactPublication } from "../site-uploads";
import { siteSqlInsertStatements } from "../site-sql/format";
import { readWorkspaceArtifactContent } from "../workspace-artifact-content";
import { redactWorkspaceArtifactProvenance } from "../workspace-artifact-provenance";
import { exportAppSidebar, installAppSidebar } from "./sidebar";
import { appSyncHooks, syncName } from "./syncs";
import { exportPackageExtras } from "./installed";
import { applyPackageSkills, planPackageSkills, type PackageSkillWriter } from "./skills";
import { addPackageAutomations } from "./automations";

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

export function reason(error: unknown, context: string): string {
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

export function jsonBytes(value: unknown): number {
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
  const sidebar = await exportAppSidebar(deps, grant, appId, notExported);
  const extras = await exportPackageExtras(deps, grant, appId, notExported);

  const pkg: AppPackage = {
    format: APP_PACKAGE_FORMAT,
    version: APP_PACKAGE_VERSION,
    packageId: (await getAppPackageId(deps.db, grant.workspaceId, appId)) ?? ownPackageId(appId),
    ...(extras.packageVersion ? { packageVersion: extras.packageVersion } : {}),
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
    ...(sidebar.length > 0 ? { sidebar } : {}),
    ...(extras.skills ? { skills: extras.skills } : {}),
    ...(extras.automations ? { automations: extras.automations } : {}),
  };
  // A multi-file build's files, measured from the manifest before any is read.
  if (ref.assetManifest) {
    const encoded = ref.assetManifest.files.reduce(
      (total, file) => total + Math.ceil(file.sizeBytes / 3) * 4 + file.path.length + 24,
      0,
    );
    if (jsonBytes(pkg) + encoded > APP_PACKAGE_MAX_BYTES) throw tooLarge();
    pkg.app.assets = await readSiteAssetBundle(
      deps.objectStorage,
      grant.workspaceId,
      ref.assetManifest,
    );
  }

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
    if (jsonBytes(pkg) > APP_PACKAGE_MAX_BYTES) throw tooLarge();
  }
  return { package: pkg, filename: appPackageFilename(artifact.title), notExported };
}

const tooLarge = () =>
  new AppPackageError(
    "too_large",
    `The package would be over ${APP_PACKAGE_MAX_BYTES / (1024 * 1024)} MB (the app's files and definitions together)`,
  );

/**
 * The package id of an app made here: derived from its id, so every export
 * of the app carries the same one (a UUID with version 8, RFC 9562).
 */
export function ownPackageId(appId: string): string {
  const hex = createHash("sha256").update(`opengeni.app-package:${appId}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
  // Tool data from a connected account stays in its workspace (site-tool-data.ts).
  const toolData = new Set(
    (
      await siteToolDataSources(
        deps,
        { accountId: grant.accountId, workspaceId: grant.workspaceId },
        appId,
      )
    ).map((source) => source.target),
  );
  const HOLDS_TOOL_DATA = "It holds data from a connected account, so it stays in this workspace";
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
    if (toolData.has(siteToolDataTarget("collection", name))) {
      notExported.push({ part: "demo_data", name, reason: HOLDS_TOOL_DATA });
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
      if (toolData.has(siteToolDataTarget("sql"))) {
        notExported.push({ part: "demo_data", name, reason: HOLDS_TOOL_DATA });
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
            reason: "It has text values over 64 KB, which packages don't carry",
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

  // Shared Site files, after records and rows, within what is left of the budget.
  const files: AppPackageDemoFile[] = [];
  if (demo === true || (typeof demo === "object" && demo.files === true)) {
    const result = await exportDemoFiles(deps, grant, appId, budget, notExported);
    files.push(...result.files);
    budget = result.budget;
  }
  if (Object.keys(records).length === 0 && Object.keys(sqlRows).length === 0 && files.length === 0)
    return undefined;
  return { records, sqlRows, ...(files.length > 0 ? { files } : {}) };
}

/**
 * The app's shared files as demo data, oldest first, while they fit the
 * budget. Private files belong to the people who uploaded them and are never
 * exported.
 */
async function exportDemoFiles(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  budget: number,
  notExported: AppPackageProblem[],
): Promise<{ files: AppPackageDemoFile[]; budget: number }> {
  const files: AppPackageDemoFile[] = [];
  const listed: Array<{
    id: string;
    name: string;
    contentType: string;
    sizeBytes: number;
  }> = [];
  let privateFiles = 0;
  try {
    let cursor: string | null = null;
    do {
      const page = await listSiteDataFiles(deps, grant, appId, {
        limit: 100,
        cursor,
      });
      for (const file of page.files)
        if (file.scope === "shared") listed.push(file);
        else privateFiles += 1;
      cursor = page.nextCursor;
    } while (cursor && listed.length <= APP_PACKAGE_DEMO_FILES_MAX * 2);
  } catch (error) {
    notExported.push({
      part: "demo_data",
      name: "files",
      reason: reason(error, "listing files"),
    });
    return { files, budget };
  }
  if (privateFiles > 0)
    notExported.push({
      part: "demo_data",
      name: "files",
      reason: `${privateFiles} private files belong to the people who uploaded them, so they aren't demo data`,
    });
  listed.reverse();
  let skipped = 0;
  for (const entry of listed) {
    const size = Math.ceil(entry.sizeBytes / 3) * 4 + entry.name.length + 200;
    if (files.length >= APP_PACKAGE_DEMO_FILES_MAX || size > budget) {
      skipped += 1;
      continue;
    }
    try {
      const read = await readSiteDataFileBytes(deps, grant, appId, entry.id);
      if (!read) {
        notExported.push({
          part: "demo_data",
          name: entry.name,
          reason: "Its stored file is gone",
        });
        continue;
      }
      files.push({
        id: entry.id,
        name: read.file.name,
        contentType: read.file.contentType,
        base64: Buffer.from(read.bytes).toString("base64"),
      });
      budget -= size;
    } catch (error) {
      notExported.push({
        part: "demo_data",
        name: entry.name,
        reason: reason(error, "reading a file"),
      });
    }
  }
  if (skipped > 0)
    notExported.push({
      part: "demo_data",
      name: "files",
      reason: `${skipped} shared files didn't fit in the package`,
    });
  return { files, budget };
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
    /** Who saves the package's Skills (the person, or the agent's live turn), or why no one can. */
    skillWriter: PackageSkillWriter;
  },
): Promise<AppPackageInstallResponse> {
  if (!deps.objectStorage)
    throw new AppPackageError("unavailable", "File storage isn't configured");
  if (jsonBytes(input.package) > APP_PACKAGE_MAX_BYTES)
    throw new AppPackageError(
      "too_large",
      `This package is over ${APP_PACKAGE_MAX_BYTES / (1024 * 1024)} MB`,
    );
  const { package: pkg, problems } = parseAppPackage(input.package);
  const notInstalled: AppPackageProblem[] = [...problems];
  const installed: AppPackageInstallResponse["installed"] = {
    tools: 0,
    collections: [],
    migrations: [],
    queries: [],
    syncs: [],
    sidebar: 0,
    demoRecords: 0,
    demoRows: 0,
    demoFiles: 0,
    skills: [],
    automations: [],
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
  // A multi-file build's files, stored before the app exists (a bad file
  // refuses the install); the copy gets its own manifest token.
  const assetManifest = pkg.app.assets
    ? await storeSiteAssetFiles(deps.objectStorage, grant.workspaceId, pkg.app.assets)
    : null;
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
      ...(assetManifest ? { assetManifest } : {}),
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
  // Provenance: later upgrades check they come from the same app's package.
  if (pkg.packageId) await setAppPackageId(deps.db, grant.workspaceId, app.id, pkg.packageId);

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

  // 5. Its links in the sidebar.
  if (pkg.sidebar?.length)
    installed.sidebar = await installAppSidebar(deps, grant, app, pkg.sidebar, notInstalled);

  // 6. Its Skills (workspace Skills linked to the app) and automations
  // (switched off), then what came with it, so its later upgrades know.
  // A replay finds them linked already and adds nothing twice.
  const before = await getAppPackageInstall(deps.db, grant.workspaceId, app.id);
  let skillLinks = before?.skills ?? [];
  if (pkg.skills?.length) {
    const plan = await planPackageSkills(deps, grant, {
      skills: pkg.skills,
      links: skillLinks,
      packageId: pkg.packageId ?? null,
    });
    notInstalled.push(...plan.problems);
    const applied = await applyPackageSkills(
      deps,
      grant,
      {
        plan,
        links: skillLinks,
        writer: input.skillWriter,
        operationKey: input.provenance.operationKey,
        appTitle: app.title,
      },
      notInstalled,
    );
    skillLinks = applied.links;
    installed.skills = skillLinks.map((link) => link.name);
  }
  let automations = before?.automations ?? [];
  if (pkg.automations?.length) {
    automations = (
      await addPackageAutomations(
        deps,
        grant,
        {
          appId: app.id,
          automations: pkg.automations,
          existing: automations,
          surface: input.provenance.sourceAttemptId === null ? "http" : "first_party_mcp",
        },
        notInstalled,
      )
    ).automations;
    installed.automations = automations.map((entry) => entry.name);
  }
  await putAppPackageInstall(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    appId: app.id,
    packageVersion: pkg.packageVersion ?? null,
    versionId: before?.versionId ?? app.currentVersion?.id ?? null,
    skills: skillLinks,
    automations,
  });

  // 7. Demo data, only into collections, tables and file lists that are
  // still empty. Files go first: demo values that are a packaged file's id
  // then name its installed copy.
  if (wantsDemo && pkg.demoData) {
    let ids = new Map<string, string>();
    if (pkg.demoData.files?.length) {
      const loaded = await installDemoFiles(deps, grant, app.id, pkg.demoData.files, notInstalled);
      ids = loaded.ids;
      installed.demoFiles = loaded.written;
    }
    installed.demoRecords = await installDemoRecords(
      deps,
      grant,
      app.id,
      ids.size > 0 ? replaceFileIds(pkg.demoData.records, ids) : pkg.demoData.records,
      notInstalled,
    );
    if (sqlReady)
      installed.demoRows = await installDemoRows(
        deps,
        grant,
        app.id,
        ids.size > 0 ? replaceFileIds(sqlRows, ids) : sqlRows,
        notInstalled,
      );
    else if (Object.keys(sqlRows).length > 0 && !notInstalled.some((p) => p.part === "sql"))
      notInstalled.push({ part: "demo_data", reason: "The app database isn't available" });
  }

  return {
    app: redactWorkspaceArtifactProvenance(app),
    packageId: pkg.packageId ?? null,
    replayed: created.replayed,
    installed,
    notInstalled,
  };
}

/** `value` with every string that is exactly a packaged file's id replaced by its copy's id. */
export function replaceFileIds<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (typeof value === "string") return (ids.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((entry) => replaceFileIds(entry, ids)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceFileIds(entry, ids)]),
    ) as T;
  return value;
}

/**
 * Upload the package's shared files into an app that has no files yet (a
 * replayed install finds them there and loads nothing). Returns the new id
 * of each packaged file id.
 */
async function installDemoFiles(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  files: AppPackageDemoFile[],
  notInstalled: AppPackageProblem[],
): Promise<{ written: number; ids: Map<string, string> }> {
  const ids = new Map<string, string>();
  try {
    const existing = await listSiteDataFiles(deps, grant, appId, { limit: 1 });
    if (existing.files.length > 0) return { written: 0, ids };
  } catch (error) {
    notInstalled.push({
      part: "demo_data",
      name: "files",
      reason: reason(error, "listing files"),
    });
    return { written: 0, ids };
  }
  let written = 0;
  for (const file of files) {
    try {
      const uploaded = await uploadSiteDataFile(deps, grant, appId, {
        name: file.name,
        contentType: file.contentType,
        body: new Uint8Array(Buffer.from(file.base64, "base64")),
        scope: "shared",
      });
      if (file.id) ids.set(file.id, uploaded.id);
      written += 1;
    } catch (error) {
      notInstalled.push({
        part: "demo_data",
        name: file.name,
        reason: reason(error, "loading a file"),
      });
    }
  }
  return { written, ids };
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
    // Blob values load through SQL INSERTs (X'…' literals); JSON imports take scalars only.
    if (rows.some((row) => Object.values(row).some(isBlobValue))) {
      written += await installBlobRows(deps, grant, appId, table, rows, notInstalled);
      continue;
    }
    for (let start = 0; start < rows.length; start += 1_000) {
      try {
        const result = await importSiteSql(deps, grant, appId, {
          format: "json",
          table,
          rows: rows.slice(start, start + 1_000) as Record<string, SiteSqlValue>[],
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

function isBlobValue(value: unknown): value is { $base64: string } {
  return value !== null && typeof value === "object" && "$base64" in value;
}

/** Most bytes of INSERT statements per SQL import call (the import takes 2 MB). */
const BLOB_IMPORT_BYTES = 1_500_000;

/**
 * Rows with blob values, loaded as SQL INSERT statements into an empty table
 * (the same literals Site SQL dumps write), in calls under the import limit.
 */
async function installBlobRows(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  table: string,
  rows: AppPackageSqlRow[],
  notInstalled: AppPackageProblem[],
): Promise<number> {
  const columns: string[] = [];
  for (const row of rows)
    for (const column of Object.keys(row)) if (!columns.includes(column)) columns.push(column);
  const statements = siteSqlInsertStatements({
    name: table,
    columns,
    rows: rows.map((row) => columns.map((column) => row[column] ?? null)),
  });
  let written = 0;
  let chunk: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    const result = await importSiteSql(deps, grant, appId, {
      format: "sql",
      sql: chunk.join("\n"),
    });
    written += result.rowsWritten;
    chunk = [];
    bytes = 0;
  };
  try {
    for (const statement of statements) {
      const size = Buffer.byteLength(statement, "utf8") + 1;
      if (bytes + size > BLOB_IMPORT_BYTES) await flush();
      chunk.push(statement);
      bytes += size;
    }
    await flush();
  } catch (error) {
    notInstalled.push({
      part: "demo_data",
      name: table,
      reason: `${rows.length - written} rows weren't loaded: ${reason(error, "loading rows")}`,
    });
  }
  return written;
}
