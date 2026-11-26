import {
  APP_PACKAGE_MAX_BYTES,
  APP_PACKAGE_SNAPSHOTS_KEPT,
  parseAppPackage,
  siteSqlDestructiveChanges,
  stableJson,
  type AccessGrant,
  type AppPackage,
  type AppPackageCollection,
  type AppPackageProblem,
  type AppPackageUpgradePlan,
  type AppPackageUpgradeResponse,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import { siteViewerForGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  artifactRequestedToolsMissingFromAttemptCatalog,
  consumeAppPackageSnapshot,
  getAppPackageInstall,
  getAppPackageId,
  getWorkspaceArtifactContentRef,
  getWorkspaceArtifactCurrent,
  getAppPackageSnapshot,
  publishWorkspaceArtifactVersion,
  putAppPackageInstall,
  saveAppPackageSnapshot,
  setAppPackageId,
  WorkspaceArtifactOperationError,
  type AppPackageInstall,
} from "@opengeni/db";
import { createHash } from "node:crypto";
import { ApiHttpError } from "../http/api-error";
import { defineSiteDataCollection, describeSiteData } from "../site-data/operations";
import { siteSqlGatewayConfig, siteSqlOffered } from "../site-sql/gateway";
import {
  defineSiteSqlQuery,
  describeSiteSql,
  migrateSiteSql,
  setSiteSqlSettings,
} from "../site-sql/service";
import {
  afterSiteArtifactMutation,
  requireSiteVersionPublishOpen,
} from "../site-publishing/service";
import { connectorToolIdentity, readSiteToolAccountInventory } from "../site-tool-routing";
import { decodeSiteAssetFiles, storeSiteAssetFiles, type DecodedSiteAssets } from "../site-assets";
import { prepareWorkspaceArtifactPublication } from "../site-uploads";
import { readWorkspaceArtifactContent } from "../workspace-artifact-content";
import { redactWorkspaceArtifactProvenance } from "../workspace-artifact-provenance";
import {
  AppPackageError,
  appPackageFilesAt,
  exportAppPackage,
  jsonBytes,
  ownPackageId,
  reason,
} from "./service";
import { appSyncHooks, syncName } from "./syncs";
import {
  APP_CUSTOMIZED_MESSAGE,
  appPackageCustomized,
  applyPackageSkills,
  planPackageSkills,
  type PackageSkillPlan,
  type PackageSkillWriter,
} from "./skills";
import { addPackageAutomations } from "./automations";

/**
 * Upgrading an app from a package (docs/app-packages.md#upgrade): a plan of
 * what differs between the package and the app, and applying it as a new
 * version of the same app through the ordinary publish path, plus only what
 * is new in its data definitions. Nothing is deleted: collections and syncs
 * the package doesn't have stay. Changes that could hide, reassign or delete
 * existing data need `allowDestructive`; a migration whose name the app
 * already has with different SQL stops the upgrade before anything changes.
 */

/** Who upgrades, for the new version's history (an HTTP caller or an agent attempt). */
export type AppUpgradeProvenance = {
  operationKey: string;
  actorSubjectId: string;
  sourceSessionId: string | null;
  sourceTurnId: string | null;
  sourceAttemptId: string | null;
  sourceExecutionGeneration: number | null;
  sourceToolName: "app_upgrade" | null;
};

/**
 * The operation key of an upgrade: the caller's idempotency key within its
 * namespace, the app and the package's content, so the same key with another
 * package (or app) is another upgrade.
 */
export function appUpgradeOperationKey(
  prefix: "subject" | "attempt",
  namespace: string,
  appId: string,
  idempotencyKey: string,
  pkg: unknown,
): string {
  const digest = createHash("sha256").update(stableJson(pkg)).digest("hex");
  return `${prefix}:${createHash("sha256")
    .update(`${namespace}:app-upgrade:${appId}:${digest}:${idempotencyKey}`)
    .digest("hex")}`;
}

/**
 * The key of one "go back" request (its caller and idempotency key), kept on
 * the saved state it applied, so a retry of `previous: true` finds the same
 * one after it was gone back to.
 */
export function appRestoreRequestKey(
  prefix: "subject" | "attempt",
  namespace: string,
  appId: string,
  idempotencyKey: string,
): string {
  return `${prefix}:${createHash("sha256")
    .update(`${namespace}:app-restore:${appId}:${idempotencyKey}`)
    .digest("hex")}`;
}

const toolKey = (tool: ToolGatewayIdentity) => `${tool.serverId}\u0000${tool.toolName}`;

type Prepared = {
  pkg: AppPackage;
  plan: AppPackageUpgradePlan;
  /** The tools the new version declares: the app's own entries it keeps, then the package's new ones. */
  tools: ToolGatewayIdentity[];
  currentVersionId: string;
  collections: AppPackageCollection[];
  migrations: AppPackage["sql"]["migrations"];
  queries: AppPackage["sql"]["queries"];
  sqlEnabled: boolean;
  /** The package's asset files, checked; null without any (or when they're invalid). */
  assets: DecodedSiteAssets | null;
  /** What came with the app from its package, or null when it wasn't installed from one. */
  install: AppPackageInstall | null;
  skills: PackageSkillPlan | null;
};

/** A version's asset files for comparing: path and content, by path. */
function assetIdentity(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  return files
    .map((file) => `${file.path}\u0000${file.sha256}`)
    .sort()
    .join("\n");
}

/** A collection definition with the store's defaults, for comparing. */
function collectionShape(collection: {
  accessMode: string;
  privateRecords?: boolean | undefined;
  guestAccess?: string | undefined;
  jsonSchema?: unknown;
  indexedFields?: unknown;
  uniqueFields?: unknown;
}) {
  return {
    accessMode: collection.accessMode,
    privateRecords: collection.privateRecords ?? false,
    jsonSchema: collection.jsonSchema ?? null,
    indexedFields: collection.indexedFields ?? [],
    uniqueFields: collection.uniqueFields ?? [],
  };
}

/** A named query's settings for comparing; omitted fields read as the defaults. */
function queryShape(query: {
  sql: string;
  audience?: string | undefined;
  description?: string | null | undefined;
  maxRows?: number | null | undefined;
}) {
  return {
    sql: query.sql.trim(),
    audience: query.audience ?? "signed_in",
    description: query.description ?? null,
    maxRows: query.maxRows ?? null,
  };
}

/** Migration SQL as compared: the same text up to surrounding space and line endings. */
function migrationText(sql: string): string {
  return sql.replaceAll("\r\n", "\n").trim();
}

async function prepare(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  raw: unknown,
): Promise<Prepared> {
  if (!deps.objectStorage)
    throw new AppPackageError("unavailable", "File storage isn't configured");
  if (jsonBytes(raw) > APP_PACKAGE_MAX_BYTES)
    throw new AppPackageError(
      "too_large",
      `This package is over ${APP_PACKAGE_MAX_BYTES / (1024 * 1024)} MB`,
    );
  const { package: pkg, problems } = parseAppPackage(raw);
  const viewer = await siteViewerForGrant(deps.db, grant);
  const [artifact, ref] = await Promise.all([
    getWorkspaceArtifactCurrent(deps.db, grant.workspaceId, viewer, appId),
    getWorkspaceArtifactContentRef(deps.db, grant.workspaceId, viewer, appId),
  ]);
  // Managers only: the same check as reading the app's data definitions.
  const data = await describeSiteData(deps, grant, appId);
  const sql = await describeSiteSql(deps, grant, appId);
  const install = await getAppPackageInstall(deps.db, grant.workspaceId, appId);
  // A customized app is forked for good: an update could break or drop the
  // fields its changes rely on, so it gets no package updates.
  if (await appPackageCustomized(deps, grant, install, ref.version.id))
    throw new ApiHttpError(409, {
      code: "conflict",
      message: APP_CUSTOMIZED_MESSAGE,
      details: { reason: "customized" },
    });
  const content = await readWorkspaceArtifactContent(deps.objectStorage, ref);
  const destructive: AppPackageProblem[] = [];
  const conflicts: AppPackageProblem[] = [];
  if (artifact.status !== "active")
    conflicts.push({
      part: "app",
      reason: "The app is archived; restore it to upgrade it",
    });

  // The version: HTML, source and tools.
  const html = content.html !== pkg.app.html;
  const source =
    stableJson(ref.sourceKey ? (content.source ?? null) : null) !==
    stableJson(pkg.app.source ?? null);
  let inventory: Parameters<typeof connectorToolIdentity>[0] = {
    canonical: new Map(),
    plain: new Set(),
    accounts: [],
  };
  if (content.requestedTools.length > 0)
    try {
      inventory = await readSiteToolAccountInventory(deps, grant);
    } catch (error) {
      problems.push({
        part: "tools",
        reason: reason(error, "reading connected accounts"),
      });
    }
  const packaged = new Set(pkg.tools.map(toolKey));
  const kept: ToolGatewayIdentity[] = [];
  const removed: ToolGatewayIdentity[] = [];
  const present = new Set<string>();
  for (const tool of content.requestedTools) {
    const portable = connectorToolIdentity(inventory, content.requestedTools, tool);
    present.add(toolKey(portable));
    if (packaged.has(toolKey(portable))) kept.push(tool);
    else if (!removed.some((entry) => toolKey(entry) === toolKey(portable))) removed.push(portable);
  }
  const added = pkg.tools.filter((tool) => !present.has(toolKey(tool)));
  const toolsChanged = added.length > 0 || removed.length > 0;
  // The asset files, checked now: a bad one stops the upgrade before
  // anything runs (and a dry run shows it).
  let decodedAssets: DecodedSiteAssets | null = null;
  if (pkg.app.assets)
    try {
      decodedAssets = decodeSiteAssetFiles(pkg.app.assets);
    } catch (error) {
      if (!(error instanceof WorkspaceArtifactOperationError)) throw error;
      conflicts.push({ part: "version", name: "assets", reason: error.message });
    }
  const assets =
    assetIdentity(ref.assetManifest?.files ?? []) !== assetIdentity(decodedAssets?.decoded ?? []);

  // Provenance: another app's package is confirmed like a destructive
  // change. An app made here has the id its exports carry; a package
  // without one isn't checked.
  const currentPackageId =
    (await getAppPackageId(deps.db, grant.workspaceId, appId)) ?? ownPackageId(appId);
  if (pkg.packageId && pkg.packageId !== currentPackageId)
    destructive.push({ part: "package", reason: "This package is from a different app" });

  // Collections: added, changed or unchanged; the app's others are kept.
  const existingCollections = new Map(data.collections.map((entry) => [entry.name, entry]));
  const collections: AppPackageCollection[] = [];
  const plan: AppPackageUpgradePlan = {
    version: {
      changed: html || source || toolsChanged || assets,
      html,
      source,
      tools: toolsChanged,
      assets,
    },
    package: { id: pkg.packageId ?? null, current: currentPackageId },
    tools: { added, removed },
    collections: { added: [], changed: [], unchanged: [], kept: [] },
    migrations: { applied: [], new: [], conflicting: [] },
    queries: { added: [], changed: [], removed: [], unchanged: [] },
    syncs: { added: [], changed: [], unchanged: [], kept: [] },
    destructive,
    conflicts,
    problems,
  };
  for (const collection of pkg.data.collections) {
    const existing = existingCollections.get(collection.name);
    if (!existing) {
      plan.collections.added.push(collection.name);
      collections.push(collection);
      continue;
    }
    const before = collectionShape(existing);
    const after = collectionShape(collection);
    const guestChanged =
      collection.guestAccess !== undefined && collection.guestAccess !== existing.guestAccess;
    if (stableJson(before) === stableJson(after) && !guestChanged) {
      plan.collections.unchanged.push(collection.name);
      continue;
    }
    plan.collections.changed.push(collection.name);
    collections.push(collection);
    // Who can read and write its records: existing records could be hidden
    // from people who see them now, or shown to people who don't. The store
    // allows that only while the collection is empty, so with records it
    // stops the upgrade before anything changes.
    if (
      existing.recordCount > 0 &&
      (before.accessMode !== after.accessMode || before.privateRecords !== after.privateRecords)
    )
      conflicts.push({
        part: "collection",
        name: collection.name,
        reason: `Changes who can read and write its ${existing.recordCount} records (${existing.accessMode} to ${collection.accessMode}${
          before.privateRecords !== after.privateRecords
            ? after.privateRecords
              ? ", private records"
              : ", records no longer private"
            : ""
        }), which works only while it is empty`,
      });
    if (guestChanged)
      destructive.push({
        part: "collection",
        name: collection.name,
        reason: `Changes what guests of a public app can do (${existing.guestAccess} to ${collection.guestAccess})`,
      });
  }
  const packagedCollections = new Set(pkg.data.collections.map((entry) => entry.name));
  for (const entry of data.collections)
    if (!packagedCollections.has(entry.name)) plan.collections.kept.push(entry.name);

  // Migrations: append-only, matched by name.
  const applied = new Map(sql.migrations.map((entry) => [entry.name, entry.sql]));
  const migrations: AppPackage["sql"]["migrations"] = [];
  for (const migration of pkg.sql.migrations) {
    const existing = applied.get(migration.name);
    if (existing !== undefined) {
      if (migrationText(existing) === migrationText(migration.sql))
        plan.migrations.applied.push(migration.name);
      else {
        plan.migrations.conflicting.push(migration.name);
        conflicts.push({
          part: "migration",
          name: migration.name,
          reason:
            "The app already ran a migration with this name and different SQL. Migrations can't be changed once they ran; give the change a new migration name.",
        });
      }
      continue;
    }
    plan.migrations.new.push(migration.name);
    migrations.push(migration);
    const found = siteSqlDestructiveChanges(migration.sql);
    if (found.length > 0)
      destructive.push({
        part: "migration",
        name: migration.name,
        reason: `Its SQL could delete or overwrite existing rows (${found.join(", ")})`,
      });
  }

  // Named queries: added, changed, removed (they hold no data).
  const existingQueries = new Map(sql.queries.map((entry) => [entry.name, entry]));
  const queries: AppPackage["sql"]["queries"] = [];
  for (const query of pkg.sql.queries) {
    const existing = existingQueries.get(query.name);
    if (!existing) plan.queries.added.push(query.name);
    else if (stableJson(queryShape(existing)) !== stableJson(queryShape(query)))
      plan.queries.changed.push(query.name);
    else {
      plan.queries.unchanged.push(query.name);
      continue;
    }
    queries.push(query);
  }
  const packagedQueries = new Set(pkg.sql.queries.map((entry) => entry.name));
  for (const entry of sql.queries)
    if (!packagedQueries.has(entry.name)) plan.queries.removed.push(entry.name);
  const sqlChanges =
    migrations.length + queries.length + plan.queries.removed.length > 0 ||
    (pkg.sql.migrations.length > 0 && !sql.enabled);
  if (
    sqlChanges &&
    (!siteSqlOffered(deps.settings) || siteSqlGatewayConfig(deps.settings) === null)
  )
    conflicts.push({
      part: "sql",
      reason: `App databases aren't available on this deployment, so its ${migrations.length} new migrations and query changes can't run`,
    });

  // Syncs, by name, through the sync feature's hook.
  const hooks = appSyncHooks();
  if (pkg.syncs.length > 0 || hooks.planUpgrade) {
    if (!hooks.planUpgrade)
      pkg.syncs.forEach((sync, index) =>
        problems.push({
          part: "sync",
          name: syncName(sync, index),
          reason: "Syncs can't be upgraded on this deployment",
        }),
      );
    else
      try {
        const synced = await hooks.planUpgrade({
          deps,
          grant,
          appId,
          syncs: pkg.syncs,
        });
        plan.syncs = {
          added: synced.added,
          changed: synced.changed,
          unchanged: synced.unchanged,
          kept: synced.kept,
        };
        for (const entry of synced.destructive ?? [])
          destructive.push({ part: "sync", name: entry.name, reason: entry.reason });
        for (const entry of synced.problems)
          problems.push({
            part: "sync",
            name: entry.name,
            reason: entry.reason,
          });
      } catch (error) {
        problems.push({
          part: "sync",
          reason: reason(error, "comparing syncs"),
        });
      }
  }

  // What came with the app: its version label, Skills and automations.
  plan.packageVersion = {
    current: install?.packageVersion ?? null,
    next: pkg.packageVersion ?? null,
  };
  let skills: PackageSkillPlan | null = null;
  if (pkg.skills?.length || install?.skills.length) {
    skills = await planPackageSkills(deps, grant, {
      skills: pkg.skills ?? [],
      links: install?.skills ?? [],
      packageId: pkg.packageId ?? currentPackageId,
      mode: "upgrade",
    });
    plan.skills = {
      added: skills.added,
      changed: skills.changed,
      unchanged: skills.unchanged,
      kept: skills.kept,
    };
    problems.push(...skills.problems);
  }
  const automationNames = new Set((install?.automations ?? []).map((entry) => entry.name));
  plan.automations = {
    added: (pkg.automations ?? [])
      .map((automation) => automation.name)
      .filter((name) => !automationNames.has(name)),
    kept: [...automationNames],
  };

  return {
    pkg,
    plan,
    tools: [...kept, ...added],
    currentVersionId: ref.version.id,
    collections,
    migrations,
    queries,
    sqlEnabled: sql.enabled,
    assets: decodedAssets,
    install,
    skills,
  };
}

function refused(message: string, plan: AppPackageUpgradePlan): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message,
    details: { plan },
  });
}

/** Whether applying the plan changes anything at all. */
export function upgradePlanChanges(plan: AppPackageUpgradePlan): boolean {
  return (
    plan.version.changed ||
    plan.collections.added.length + plan.collections.changed.length > 0 ||
    plan.migrations.new.length > 0 ||
    plan.queries.added.length + plan.queries.changed.length + plan.queries.removed.length > 0 ||
    plan.syncs.added.length + plan.syncs.changed.length > 0 ||
    (plan.skills?.added.length ?? 0) + (plan.skills?.changed.length ?? 0) > 0 ||
    (plan.automations?.added.length ?? 0) > 0 ||
    (plan.packageVersion?.next ?? null) !== (plan.packageVersion?.current ?? null)
  );
}

/**
 * The package an upgrade applies: the one given, or with `previous` a saved
 * state of the app from before an upgrade: the one with that id (also once
 * gone back to, so a retry applies the same one) or, with `true`, the latest
 * not gone back to. Its package is the saved definitions plus the app's
 * files at the saved version. The app must be one the caller sees; the
 * upgrade itself checks they manage it.
 */
export async function resolveAppUpgradeSource(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  request: {
    package?: Record<string, unknown> | undefined;
    previous?: boolean | string | undefined;
  },
  /** appRestoreRequestKey of this request, when it has an idempotency key. */
  restoreKey: string | null = null,
): Promise<{ package: unknown; snapshotId: string | null }> {
  if (!request.previous) return { package: request.package, snapshotId: null };
  const viewer = await siteViewerForGrant(deps.db, grant);
  await getWorkspaceArtifactCurrent(deps.db, grant.workspaceId, viewer, appId);
  const snapshot = await getAppPackageSnapshot(
    deps.db,
    grant.workspaceId,
    appId,
    typeof request.previous === "string" ? { id: request.previous } : { restoreKey },
  );
  if (!snapshot)
    throw new ApiHttpError(409, {
      code: "conflict",
      message: "This app has no earlier version saved to go back to",
    });
  const saved = snapshot.package as { app?: Record<string, unknown> };
  const files = await appPackageFilesAt(deps, grant, appId, snapshot.versionId);
  return {
    package: { ...saved, app: { ...saved.app, ...files } },
    snapshotId: snapshot.id,
  };
}

/**
 * Plan, and unless `dryRun` apply, an upgrade of an app from a package. The
 * caller must be a manager of the app (and, on the routes, have
 * artifacts:publish). Apply order: new and changed collections, then the
 * database (only new migrations, in order, stopping at the first failure;
 * then new and changed queries), then the new version, then removed queries,
 * then syncs. The same `provenance.operationKey` publishes the version once,
 * and every other step skips what is already done, so a retry completes a
 * partial upgrade.
 */
export async function upgradeAppFromPackage(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  input: {
    package: unknown;
    dryRun?: boolean | undefined;
    allowDestructive?: boolean | undefined;
    provenance: AppUpgradeProvenance | null;
    /** Who saves the package's Skills, or why no one can. */
    skillWriter: PackageSkillWriter;
    /** The saved state this applies (going back), marked gone back to once it applied. */
    snapshotId?: string | null | undefined;
    /** appRestoreRequestKey of this request, kept on the saved state it applied. */
    restoreKey?: string | null | undefined;
  },
): Promise<AppPackageUpgradeResponse> {
  const prepared = await prepare(deps, grant, appId, input.package);
  const { plan, pkg } = prepared;
  const upgraded: AppPackageUpgradeResponse["upgraded"] = {
    version: false,
    collections: [],
    migrations: [],
    queries: [],
    syncs: [],
    skills: [],
    automations: [],
  };
  const notUpgraded: AppPackageProblem[] = [];
  const viewer = await siteViewerForGrant(deps.db, grant);
  const current = async () =>
    redactWorkspaceArtifactProvenance(
      await getWorkspaceArtifactCurrent(deps.db, grant.workspaceId, viewer, appId),
    );
  if (input.dryRun)
    return {
      app: await current(),
      dryRun: true,
      applied: false,
      plan,
      upgraded,
      notUpgraded,
    };
  if (!input.provenance)
    throw new AppPackageError("validation", "Give an idempotencyKey to apply an upgrade");
  if (plan.conflicts.length > 0)
    throw refused(
      `The upgrade can't run: ${plan.conflicts[0]!.name ? `${plan.conflicts[0]!.name}: ` : ""}${plan.conflicts[0]!.reason}`,
      plan,
    );
  const otherApp = plan.destructive.find((entry) => entry.part === "package");
  if (otherApp && !input.allowDestructive)
    throw refused(`${otherApp.reason}; confirm with allowDestructive to upgrade anyway`, plan);
  if (plan.destructive.length > 0 && !input.allowDestructive)
    throw refused(
      `The upgrade has changes that could hide or delete existing data (${plan.destructive
        .map((entry) => entry.name ?? entry.part)
        .join(", ")}); confirm them with allowDestructive`,
      plan,
    );

  const tools = plan.version.changed
    ? await toolsForCaller(deps, grant, prepared, input.provenance, notUpgraded)
    : prepared.tools;

  // 0. The app as it is now, to go back to: saved once per upgrade (not
  // when going back), keeping the latest few. Without it the upgrade still
  // runs; the app's earlier versions stay in its history.
  if (!input.snapshotId && upgradePlanChanges(plan)) {
    try {
      const before = await current();
      if (!before.currentVersion) throw new Error("The app has no published version");
      // Its files stay in the app's version history; only the definitions are saved.
      const exported = await exportAppPackage(deps, grant, appId, {}, { files: false });
      const { html: _html, source: _source, assets: _assets, ...app } = exported.package.app;
      await saveAppPackageSnapshot(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        appId,
        packageVersion: prepared.install?.packageVersion ?? null,
        versionId: before.currentVersion.id,
        operationKey: input.provenance.operationKey,
        package: { ...exported.package, app } as unknown as Record<string, unknown>,
        keep: APP_PACKAGE_SNAPSHOTS_KEPT,
      });
    } catch (error) {
      notUpgraded.push({
        part: "app",
        reason: reason(error, "saving the app as it was, to go back to"),
      });
    }
  }

  // 1. Collections the package adds or changes.
  for (const { name, ...definition } of prepared.collections) {
    try {
      await defineSiteDataCollection(deps, grant, appId, name, definition);
      upgraded.collections.push(name);
    } catch (error) {
      notUpgraded.push({
        part: "collection",
        name,
        reason: reason(error, "defining a collection"),
      });
    }
  }

  // 2. The database: only new migrations, in order, then new and changed queries.
  let stopped: string | null = null;
  if (prepared.migrations.length > 0 || prepared.queries.length > 0) {
    if (!prepared.sqlEnabled)
      try {
        await setSiteSqlSettings(deps, grant, appId, { enabled: true });
      } catch (error) {
        stopped = "the database";
        notUpgraded.push({
          part: "sql",
          reason: reason(error, "turning on the database"),
        });
      }
    for (const migration of prepared.migrations) {
      if (stopped) {
        notUpgraded.push({
          part: "migration",
          name: migration.name,
          reason: `Skipped because ${stopped} failed`,
        });
        continue;
      }
      try {
        await migrateSiteSql(deps, grant, appId, migration);
        upgraded.migrations.push(migration.name);
      } catch (error) {
        stopped = `migration ${migration.name}`;
        notUpgraded.push({
          part: "migration",
          name: migration.name,
          reason: reason(error, "running a migration"),
        });
      }
    }
  }
  if (stopped) {
    // The new version may need what didn't run: stop here; a retry continues.
    for (const query of prepared.queries)
      notUpgraded.push({
        part: "query",
        name: query.name,
        reason: `Skipped because ${stopped} failed`,
      });
    if (plan.version.changed)
      notUpgraded.push({
        part: "version",
        reason: `Not published because ${stopped} failed`,
      });
    return {
      app: await current(),
      dryRun: false,
      applied: true,
      plan,
      upgraded,
      notUpgraded,
    };
  }
  for (const { name, description, maxRows, ...query } of prepared.queries) {
    try {
      await defineSiteSqlQuery(deps, grant, appId, name, {
        ...query,
        ...(description ? { description } : {}),
        ...(maxRows !== null && maxRows !== undefined ? { maxRows } : {}),
      });
      upgraded.queries.push(name);
    } catch (error) {
      notUpgraded.push({
        part: "query",
        name,
        reason: reason(error, "defining a query"),
      });
    }
  }

  // 3. The package's version as a new version of this app.
  if (plan.version.changed) {
    await publishVersion(deps, grant, appId, prepared, tools, input.provenance);
    upgraded.version = true;
  }
  // The app now comes from this package.
  if (pkg.packageId) await setAppPackageId(deps.db, grant.workspaceId, appId, pkg.packageId);

  // 4. Queries the new version no longer has.
  for (const name of plan.queries.removed) {
    try {
      await defineSiteSqlQuery(deps, grant, appId, name, null);
      upgraded.queries.push(name);
    } catch (error) {
      notUpgraded.push({
        part: "query",
        name,
        reason: reason(error, "removing a query"),
      });
    }
  }

  // 5. Syncs: new ones paused, changed ones in place (owner and status kept).
  const hooks = appSyncHooks();
  if (hooks.applyUpgrade && (plan.syncs.added.length > 0 || plan.syncs.changed.length > 0)) {
    try {
      const result = await hooks.applyUpgrade({
        deps,
        grant,
        appId,
        syncs: pkg.syncs,
        upgradeKey: input.provenance.operationKey,
      });
      upgraded.syncs.push(...result.upgraded);
      for (const entry of result.notUpgraded)
        notUpgraded.push({
          part: "sync",
          name: entry.name,
          reason: entry.reason,
        });
    } catch (error) {
      notUpgraded.push({
        part: "sync",
        reason: reason(error, "upgrading syncs"),
      });
    }
  }

  // 6. Skills (replacing their files) and new automations (switched off).
  let skillLinks = prepared.install?.skills ?? [];
  if (prepared.skills) {
    const applied = await applyPackageSkills(
      deps,
      grant,
      {
        plan: prepared.skills,
        links: skillLinks,
        writer: input.skillWriter,
        operationKey: input.provenance.operationKey,
        appTitle: (await current()).title,
      },
      notUpgraded,
    );
    skillLinks = applied.links;
    upgraded.skills = applied.written;
  }
  let automations = prepared.install?.automations ?? [];
  if (pkg.automations?.length) {
    const added = await addPackageAutomations(
      deps,
      grant,
      {
        appId,
        automations: pkg.automations,
        existing: automations,
        surface: input.provenance.sourceAttemptId === null ? "http" : "first_party_mcp",
      },
      notUpgraded,
    );
    automations = added.automations;
    upgraded.automations = added.added;
  }

  // What the app now has from its package: the version it published is the
  // one later "Modified" checks compare with.
  const after = await current();
  await putAppPackageInstall(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    appId,
    packageVersion: input.snapshotId
      ? (pkg.packageVersion ?? null)
      : (pkg.packageVersion ?? prepared.install?.packageVersion ?? null),
    versionId: after.currentVersion?.id ?? null,
    skills: skillLinks,
    automations,
  });
  if (input.snapshotId)
    await consumeAppPackageSnapshot(deps.db, grant.workspaceId, {
      snapshotId: input.snapshotId,
      restoreKey: input.restoreKey ?? input.provenance.operationKey,
    });

  return {
    app: after,
    dryRun: false,
    applied: true,
    plan,
    upgraded,
    notUpgraded,
  };
}

/**
 * The tools the new version declares. An agent may only declare tools its
 * chat has: new ones it lacks are left out and reported, and when it lacks
 * one the app already uses the upgrade is refused before anything changes
 * (publishing would refuse it).
 */
async function toolsForCaller(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  prepared: Prepared,
  provenance: AppUpgradeProvenance,
  notUpgraded: AppPackageProblem[],
): Promise<ToolGatewayIdentity[]> {
  if (provenance.sourceAttemptId === null || prepared.tools.length === 0) return prepared.tools;
  const missing = await artifactRequestedToolsMissingFromAttemptCatalog(
    deps.db,
    {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sourceSessionId: provenance.sourceSessionId,
      sourceTurnId: provenance.sourceTurnId,
      sourceAttemptId: provenance.sourceAttemptId,
      sourceExecutionGeneration: provenance.sourceExecutionGeneration,
    },
    prepared.tools,
  );
  if (missing.length === 0) return prepared.tools;
  const added = new Set(prepared.plan.tools.added.map(toolKey));
  if (missing.some((tool) => !added.has(toolKey(tool))))
    throw new WorkspaceArtifactOperationError(
      "This chat doesn't have every tool the app already uses, so it can't publish a new version of it; upgrade from the app's menu instead",
    );
  const left = new Set(missing.map(toolKey));
  for (const tool of prepared.plan.tools.added)
    if (left.has(toolKey(tool)))
      notUpgraded.push({
        part: "tools",
        name: tool.toolName,
        reason:
          "This chat doesn't have this tool, so the app doesn't use it. Upgrade from the app's menu to keep it.",
      });
  return prepared.tools.filter((tool) => !left.has(toolKey(tool)));
}

async function publishVersion(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  appId: string,
  prepared: Prepared,
  tools: ToolGatewayIdentity[],
  provenance: AppUpgradeProvenance,
): Promise<void> {
  await requireSiteVersionPublishOpen(
    deps,
    { accountId: grant.accountId, workspaceId: grant.workspaceId },
    appId,
  );
  const content = await prepareWorkspaceArtifactPublication(deps, grant, {
    html: prepared.pkg.app.html,
    ...(prepared.pkg.app.source ? { source: prepared.pkg.app.source } : {}),
    requestedTools: tools,
  });
  // A multi-file build's files; the new version gets its own token.
  const assetManifest = prepared.pkg.app.assets
    ? await storeSiteAssetFiles(
        deps.objectStorage!,
        grant.workspaceId,
        prepared.assets ?? prepared.pkg.app.assets,
      )
    : null;
  const result = await publishWorkspaceArtifactVersion(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    artifactId: appId,
    viewer: await siteViewerForGrant(deps.db, grant),
    expectedCurrentVersionId: prepared.currentVersionId,
    ...content,
    assetManifest,
    ...provenance,
  });
  await afterSiteArtifactMutation(deps, result, { scan: true });
}
