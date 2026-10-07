import { CODEX_CLIENT_VERSION, fetchCodexModels } from "@opengeni/codex";
import { configuredModels, withCodexCatalogProvider, type Settings } from "@opengeni/config";
import {
  buildCodexTokenResolver,
  connectionModelAllowed,
  getCodexRotationSettings,
  listCodexAccountStatuses,
  loadCodexCredentialForRun,
  type Database,
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

const defaultDependencies: Dependencies = {
  listAccounts: listCodexAccountStatuses,
  getRotation: getCodexRotationSettings,
  loadCredential: loadCodexCredentialForRun,
  fetchModels: fetchCodexModels,
  getToken: (targetDb, targetSettings, targetWorkspaceId, credentialId) =>
    buildCodexTokenResolver(targetDb, targetSettings, targetWorkspaceId, credentialId).getToken(),
};

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
  deps: Dependencies = defaultDependencies,
): Promise<Set<string>> {
  if (!settings.codexSubscriptionEnabled) return new Set();
  const live = await loadAccountCatalogs(db, settings, workspaceId, deps);
  return new Set(
    live
      .filter(({ ok, slugs }) => ok && !slugs.includes(upstreamModelId))
      .map(({ account }) => account.id),
  );
}

/** Live provider support is separate from deployment membership and model permissions. */
export async function loadWorkspaceCodexModelAvailability(
  db: Database,
  settings: Settings,
  workspaceId: string,
  deps: Dependencies = defaultDependencies,
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
