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

/** Live provider support is separate from deployment membership and model permissions. */
export async function loadWorkspaceCodexModelAvailability(
  db: Database,
  settings: Settings,
  workspaceId: string,
  deps: Dependencies = {
    listAccounts: listCodexAccountStatuses,
    getRotation: getCodexRotationSettings,
    loadCredential: loadCodexCredentialForRun,
    fetchModels: fetchCodexModels,
    getToken: (db, settings, workspaceId, credentialId) =>
      buildCodexTokenResolver(db, settings, workspaceId, credentialId).getToken(),
  },
): Promise<Record<string, ModelAvailabilityObservation>> {
  if (!settings.codexSubscriptionEnabled) return {};
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
        // The allocator may choose any permitted candidate, so all must support it.
        const supported =
          permitted.length > 0 &&
          permitted.every(({ ok, slugs }) => ok && slugs.includes(model.upstreamModelId));
        const uncertain = permitted.find(({ ok }) => !ok);
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
