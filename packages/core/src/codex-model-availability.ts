import { CODEX_CLIENT_VERSION, fetchCodexModels } from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider, type Settings } from "@opengeni/config";
import {
  buildSubscriptionCoreCodexConnectionTokenResolver,
  buildSubscriptionCoreCodexOperationFetch,
  listSubscriptionCoreCodexServingConnections,
  readCodexCutoverDisposition,
  subscriptionCoreCodexConnectionAllowsModel,
  type CodexCredentialTokenSnapshot,
  type Database,
  type SubscriptionCoreCodexServingConnection,
} from "@opengeni/db";
import type { ModelAvailabilityObservation } from "./model-catalog";

const CATALOG_CACHE_MS = 60_000;
const CATALOG_ERROR_CACHE_MS = 5_000;
type CatalogCacheEntry = {
  expiresAt: number;
  result: Promise<{ ok: boolean; slugs: string[]; checkedAt: string }>;
};
const catalogs = new Map<string, CatalogCacheEntry>();

/** The workspace, organization and acting subject of a Codex catalog read. */
export type WorkspaceCodexCatalogContext = {
  accountId: string;
  workspaceId: string;
  /**
   * The person whose new work the catalog describes: the authenticated
   * caller, or a scheduled task's execution owner. Their own personal
   * connection counts only in their own Personal workspace; null or a
   * non-human subject sees shared capacity only.
   */
  subjectId: string | null;
};

export type WorkspaceCodexCatalogReadiness = {
  /** Codex models are ready in this workspace (the catalog's connection readiness). */
  active: boolean;
  /** Live per-model availability, keyed by model definition version. */
  observations: Record<string, ModelAvailabilityObservation>;
};

type CatalogDependencies = {
  disposition: typeof readCodexCutoverDisposition;
  listServing: typeof listSubscriptionCoreCodexServingConnections;
  fetchModels: typeof fetchCodexModels;
  getCoreToken: (
    db: Database,
    settings: Settings,
    context: WorkspaceCodexCatalogContext,
    connectionId: string,
  ) => Promise<CodexCredentialTokenSnapshot>;
};

const CATALOG_SERVICE_SUBJECT = "service:subscription-core";

const defaultCatalogDependencies = (): CatalogDependencies => ({
  disposition: readCodexCutoverDisposition,
  listServing: listSubscriptionCoreCodexServingConnections,
  fetchModels: fetchCodexModels,
  // A connection-level read (no operation lease), like live usage: the 0671
  // seam serves only shared organization- or workspace-scoped connections in
  // this workspace's scope, and refreshes under the per-connection key.
  getCoreToken: (targetDb, targetSettings, context, connectionId) =>
    buildSubscriptionCoreCodexConnectionTokenResolver(
      targetDb,
      targetSettings,
      {
        kind: "workspace",
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        subjectId: context.subjectId ?? CATALOG_SERVICE_SUBJECT,
      },
      connectionId,
      null,
    ).getToken(),
});

function codexCatalogModels(settings: Settings) {
  return configuredModels(withCodexCatalogProvider(settings)).filter(
    (model) =>
      model.credentialSource.kind === "connected_subscription" &&
      model.credentialSource.provider === "codex",
  );
}

/** One shared core connection's live model list (cached per refresh generation). */
async function loadCoreConnectionCatalog(
  db: Database,
  settings: Settings,
  context: WorkspaceCodexCatalogContext,
  connection: SubscriptionCoreCodexServingConnection,
  deps: CatalogDependencies,
): Promise<{ ok: boolean; slugs: string[]; checkedAt: string }> {
  try {
    // The token read rechecks the enabled cutover and the workspace scope
    // before the cache is consulted.
    const token = await deps.getCoreToken(db, settings, context, connection.connectionId);
    const key = `core:${context.workspaceId}:${connection.connectionId}:${token.credentialVersion}`;
    const cached = catalogs.get(key);
    if (cached && cached.expiresAt > Date.now()) return await cached.result;
    for (const [id, entry] of catalogs) {
      if (entry.expiresAt <= Date.now()) catalogs.delete(id);
    }
    if (catalogs.size >= 1_024) catalogs.delete(catalogs.keys().next().value!);
    const entry: CatalogCacheEntry = {
      expiresAt: Date.now() + CATALOG_CACHE_MS,
      result: deps
        .fetchModels(
          {
            accessToken: token.accessToken,
            chatgptAccountId: token.chatgptAccountId,
            isFedramp: token.isFedramp,
            clientVersion: CODEX_CLIENT_VERSION,
          },
          buildSubscriptionCoreCodexOperationFetch(
            db,
            {
              kind: "workspace",
              accountId: context.accountId,
              workspaceId: context.workspaceId,
              subjectId: context.subjectId ?? CATALOG_SERVICE_SUBJECT,
            },
            null,
            connection.connectionId,
          ),
        )
        .catch(() => ({ ok: false, slugs: [] as string[] }))
        .then((result) => {
          entry.expiresAt = Date.now() + (result.ok ? CATALOG_CACHE_MS : CATALOG_ERROR_CACHE_MS);
          return { ok: result.ok, slugs: result.slugs, checkedAt: new Date().toISOString() };
        }),
    };
    catalogs.set(key, entry);
    return await entry.result;
  } catch {
    return { ok: false, slugs: [], checkedAt: new Date().toISOString() };
  }
}

/**
 * Codex readiness and live model availability for a workspace catalog,
 * default-model or picker read, by the organization's Codex cutover row:
 *
 * - a missing or disabled row (maintenance): Codex is not ready and no legacy Codex
 *   table is read;
 * - an enabled row (`core`): the core connections that can serve new work of
 *   `context.subjectId` here. A shared connection's live model list is read
 *   through the connection-level core seam. A personal connection's list
 *   cannot be read outside an exact accepted turn, so a model it permits and
 *   has not been refused for (no live model cooldown) is reported without an
 *   observation (selectable, status unknown); placement still decides.
 */
export async function loadWorkspaceCodexCatalogReadiness(
  db: Database,
  settings: Settings,
  context: WorkspaceCodexCatalogContext,
  options: {
    observeAvailability?: boolean;
    /** Deployment-level readiness settings, when different from the model catalog. */
    activeSettings?: Pick<Settings, "codexSubscriptionEnabled">;
  } = {},
  deps: CatalogDependencies = defaultCatalogDependencies(),
): Promise<WorkspaceCodexCatalogReadiness> {
  const activeSettings = options.activeSettings ?? settings;
  const observe = options.observeAvailability !== false;
  // Codex disabled for the deployment: never ready, nothing read.
  if (!activeSettings.codexSubscriptionEnabled) return { active: false, observations: {} };
  const disposition = await deps.disposition(db, context.accountId, context.workspaceId);
  if (disposition === "maintenance") return { active: false, observations: {} };
  const serving = await deps.listServing(db, context);
  if (!observe || !settings.codexSubscriptionEnabled || serving.length === 0) {
    return { active: serving.length > 0, observations: {} };
  }
  const shared = serving.filter((connection) => connection.ownership === "shared");
  const personal = serving.filter((connection) => connection.ownership === "personal");
  const live = await Promise.all(
    shared.map(async (connection) => ({
      connection,
      ...(await loadCoreConnectionCatalog(db, settings, context, connection, deps)),
    })),
  );
  const observations: Record<string, ModelAvailabilityObservation> = {};
  for (const model of codexCatalogModels(settings)) {
    // Support and permission must hold on the SAME serving connection.
    const permitted = live.filter(({ connection }) =>
      subscriptionCoreCodexConnectionAllowsModel(connection, model.id),
    );
    const reachable = permitted.filter(({ ok }) => ok);
    const supported = reachable.find(({ slugs }) => slugs.includes(model.upstreamModelId));
    if (supported) {
      observations[model.definitionVersion] = {
        status: "available",
        reason: null,
        checkedAt: supported.checkedAt,
      };
      continue;
    }
    // The person's own connection may serve it: its list is unknown here.
    if (
      personal.some(
        (connection) =>
          subscriptionCoreCodexConnectionAllowsModel(connection, model.id) &&
          !connection.cooledDownModelIds.includes(model.id),
      )
    ) {
      continue;
    }
    const uncertain = reachable.length === 0 ? permitted.find(({ ok }) => !ok) : undefined;
    observations[model.definitionVersion] = {
      status: "unavailable",
      reason: uncertain ? "provider_unhealthy" : "not_entitled",
      checkedAt: (uncertain ?? permitted[0])?.checkedAt ?? new Date().toISOString(),
    };
  }
  return { active: true, observations };
}
