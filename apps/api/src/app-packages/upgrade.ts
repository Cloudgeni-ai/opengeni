import {
  APP_PACKAGE_MAX_BYTES,
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
  getWorkspaceArtifactContentRef,
  getWorkspaceArtifactCurrent,
  publishWorkspaceArtifactVersion,
  WorkspaceArtifactOperationError,
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
import { prepareWorkspaceArtifactPublication } from "../site-uploads";
import { readWorkspaceArtifactContent } from "../workspace-artifact-content";
import { redactWorkspaceArtifactProvenance } from "../workspace-artifact-provenance";
import { AppPackageError, jsonBytes, reason } from "./service";
import { appSyncHooks, syncName } from "./syncs";

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
};

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
  if (jsonBytes(raw) > APP_PACKAGE_MAX_BYTES + 1024 * 1024)
    throw new AppPackageError("too_large", "This package is too large");
  const { package: pkg, problems } = parseAppPackage(raw);
  const viewer = await siteViewerForGrant(deps.db, grant);
  const [artifact, ref] = await Promise.all([
    getWorkspaceArtifactCurrent(deps.db, grant.workspaceId, viewer, appId),
    getWorkspaceArtifactContentRef(deps.db, grant.workspaceId, viewer, appId),
  ]);
  // Managers only: the same check as reading the app's data definitions.
  const data = await describeSiteData(deps, grant, appId);
  const sql = await describeSiteSql(deps, grant, appId);
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

  // Collections: added, changed or unchanged; the app's others are kept.
  const existingCollections = new Map(data.collections.map((entry) => [entry.name, entry]));
  const collections: AppPackageCollection[] = [];
  const plan: AppPackageUpgradePlan = {
    version: {
      changed: html || source || toolsChanged,
      html,
      source,
      tools: toolsChanged,
    },
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

  return {
    pkg,
    plan,
    tools: [...kept, ...added],
    currentVersionId: ref.version.id,
    collections,
    migrations,
    queries,
    sqlEnabled: sql.enabled,
  };
}

function refused(message: string, plan: AppPackageUpgradePlan): ApiHttpError {
  return new ApiHttpError(409, {
    code: "conflict",
    message,
    details: { plan },
  });
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

  return {
    app: await current(),
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
  const result = await publishWorkspaceArtifactVersion(deps.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    artifactId: appId,
    viewer: await siteViewerForGrant(deps.db, grant),
    expectedCurrentVersionId: prepared.currentVersionId,
    ...content,
    ...provenance,
  });
  await afterSiteArtifactMutation(deps, result, { scan: true });
}
