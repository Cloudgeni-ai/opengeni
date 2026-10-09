import { CODEX_CLIENT_VERSION, fetchCodexModels } from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider, type Settings } from "@opengeni/config";
import {
  buildCodexTokenResolver,
  buildSubscriptionCoreCodexConnectionTokenResolver,
  buildSubscriptionCoreCodexOperationFetch,
  connectionModelAllowed,
  getCodexRotationSettings,
  legacyWorkspaceCodexSubscriptionActive,
  listCodexAccountStatuses,
  listSubscriptionCoreCodexServingConnections,
  loadCodexCredentialForRun,
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

type Dependencies = {
  listAccounts: typeof listCodexAccountStatuses;
  getRotation: typeof getCodexRotationSettings;
  loadCredential: typeof loadCodexCredentialForRun;
  fetchModels: typeof fetchCodexModels;
  getToken: (
    db: Database,
    settings: Settings,
    workspaceId: string,
    credentialId: string,
  ) => ReturnType<ReturnType<typeof buildCodexTokenResolver>["getToken"]>;
};

// Resolved per call (as before #3781) so module-level spies on these imports take effect.
const defaultDependencies = (): Dependencies => ({
  listAccounts: listCodexAccountStatuses,
  getRotation: getCodexRotationSettings,
  loadCredential: loadCodexCredentialForRun,
  fetchModels: fetchCodexModels,
  getToken: (targetDb, targetSettings, targetWorkspaceId, credentialId) =>
    buildCodexTokenResolver(targetDb, targetSettings, targetWorkspaceId, credentialId).getToken(),
});

type AccountCatalog = {
  account: Awaited<ReturnType<typeof listCodexAccountStatuses>>[number];
  ok: boolean;
  slugs: string[];
  checkedAt: string;
};

/** Each allocatable account's live model list (cached briefly per credential version). */
async function loadAccountCatalogs(
  db: Database,
  settings: Settings,
  workspaceId: string,
  deps: Dependencies,
): Promise<AccountCatalog[]> {
  const [accounts, rotation] = await Promise.all([
    deps.listAccounts(db, workspaceId),
    deps.getRotation(db, workspaceId),
  ]);
  const candidates = accounts.filter(
    (account) =>
      account.status === "active" &&
      account.allocatorEnabled &&
      (rotation?.rotationEnabled || account.isActive),
  );
  const live = await Promise.all(
    candidates.map(async (account) => {
      const unavailable = () => ({
        account,
        ok: false,
        slugs: [] as string[],
        checkedAt: new Date().toISOString(),
      });
      try {
        // Recheck current workspace/source authority before consulting the cache.
        const credential = await deps.loadCredential(db, settings, workspaceId, account.id);
        if (!credential || credential.status !== "active") return unavailable();
        let key = `${workspaceId}:${credential.id}:${credential.version}`;
        let cached = catalogs.get(key);
        if (!cached || cached.expiresAt <= Date.now()) {
          const token = await deps.getToken(db, settings, workspaceId, credential.id);
          key = `${workspaceId}:${credential.id}:${token.credentialVersion}`;
          cached = catalogs.get(key);
          if (cached && cached.expiresAt > Date.now()) {
            return { account, ...(await cached.result) };
          }
          for (const [id, entry] of catalogs) {
            if (entry.expiresAt <= Date.now()) catalogs.delete(id);
          }
          if (catalogs.size >= 1_024) catalogs.delete(catalogs.keys().next().value!);
          const entry: CatalogCacheEntry = {
            expiresAt: Date.now() + CATALOG_CACHE_MS,
            result: deps
              .fetchModels({
                accessToken: token.accessToken,
                chatgptAccountId: token.chatgptAccountId,
                isFedramp: token.isFedramp,
                clientVersion: CODEX_CLIENT_VERSION,
              })
              .catch(() => ({ ok: false, slugs: [] as string[] }))
              .then((result) => {
                entry.expiresAt =
                  Date.now() + (result.ok ? CATALOG_CACHE_MS : CATALOG_ERROR_CACHE_MS);
                return { ok: result.ok, slugs: result.slugs, checkedAt: new Date().toISOString() };
              }),
          };
          catalogs.set(key, entry);
          cached = entry;
        }
        return { account, ...(await cached.result) };
      } catch {
        return unavailable();
      }
    }),
  );
  return live;
}

/**
 * Accounts whose live model list was read and does not include
 * `upstreamModelId`. The turn allocator skips them for that model, so a pool
 * that mixes plans (a free login beside paid ones) never leases a turn to an
 * account that cannot serve it. Unreadable accounts are not listed: a failed
 * read proves nothing, and a turn leased to one quarantines it and fails over.
 */
export async function loadCodexAccountsLackingModel(
  db: Database,
  settings: Settings,
  workspaceId: string,
  upstreamModelId: string,
  deps: Dependencies = defaultDependencies(),
): Promise<Set<string>> {
  if (!settings.codexSubscriptionEnabled) return new Set();
  const live = await loadAccountCatalogs(db, settings, workspaceId, deps);
  return new Set(
    live
      .filter(({ ok, slugs }) => ok && !slugs.includes(upstreamModelId))
      .map(({ account }) => account.id),
  );
}

/**
 * Live provider support is separate from deployment membership and model
 * permissions. Legacy only: it reads the legacy Codex pool, so callers must
 * have established the `legacy` cutover disposition (see
 * `loadWorkspaceCodexCatalogReadiness`).
 */
export async function loadWorkspaceCodexModelAvailability(
  db: Database,
  settings: Settings,
  workspaceId: string,
  deps: Dependencies = defaultDependencies(),
): Promise<Record<string, ModelAvailabilityObservation>> {
  if (!settings.codexSubscriptionEnabled) return {};
  const live = await loadAccountCatalogs(db, settings, workspaceId, deps);
  return Object.fromEntries(
    configuredModels(withCodexCatalogProvider(settings))
      .filter(
        (model) =>
          model.credentialSource.kind === "connected_subscription" &&
          model.credentialSource.provider === "codex",
      )
      .map((model) => {
        // Support and permission must hold on the SAME serving account.
        const permitted = live.filter(({ account }) =>
          connectionModelAllowed(account.allowedModelIds, model.id),
        );
        // One reachable permitted account serving the model is enough: the
        // allocator skips accounts whose live list lacks it
        // (loadCodexAccountsLackingModel), so a smaller plan in the pool never
        // hides what the others serve. An account whose catalog read fails
        // (revoked token, provider outage) proves nothing either way; a turn
        // leased to it quarantines it and fails over.
        const reachable = permitted.filter(({ ok }) => ok);
        const supported = reachable.some(({ slugs }) => slugs.includes(model.upstreamModelId));
        const uncertain = reachable.length === 0 ? permitted.find(({ ok }) => !ok) : undefined;
        return [
          model.definitionVersion,
          {
            status: supported ? "available" : "unavailable",
            reason: supported ? null : uncertain ? "provider_unhealthy" : "not_entitled",
            checkedAt: (uncertain ?? permitted[0])?.checkedAt ?? new Date().toISOString(),
          } satisfies ModelAvailabilityObservation,
        ];
      }),
  );
}

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
  legacyActive: typeof legacyWorkspaceCodexSubscriptionActive;
  legacyAvailability: typeof loadWorkspaceCodexModelAvailability;
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
  legacyActive: legacyWorkspaceCodexSubscriptionActive,
  legacyAvailability: loadWorkspaceCodexModelAvailability,
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
 * - no row (`legacy`): the legacy active pool and live availability,
 *   unchanged;
 * - a disabled row (maintenance): Codex is not ready and no legacy Codex
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
    /** The deployment settings the legacy active read gates on, when different. */
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
  if (disposition === "legacy") {
    const [active, observations] = await Promise.all([
      deps.legacyActive(db, activeSettings, context.workspaceId),
      observe
        ? deps.legacyAvailability(db, settings, context.workspaceId)
        : Promise.resolve<Record<string, ModelAvailabilityObservation>>({}),
    ]);
    return { active, observations };
  }
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
