import {
  configuredModels,
  withCodexCatalogProvider,
  withXaiSubscriptionCatalogProvider,
  type Settings,
} from "@opengeni/config";
import { resolveWorkspaceCatalogSettings } from "@opengeni/core";
import {
  subscriptionCoreProvider,
  type Database,
  type SubscriptionCoreFailoverModel,
  type SubscriptionCoreTurnIdentity,
} from "@opengeni/db";
import { subscriptionCoreModelPolicyProviderIds } from "@opengeni/subscriptions";

/** Shared by live placement and durable-wait evaluation, without importing
 * provider runtime hooks into the control worker. Catalog entries are not
 * authority: the core rechecks every candidate against accepted and live scope.
 */
export function servingCatalog(
  settings: Settings,
  providerIds: readonly string[],
): SubscriptionCoreFailoverModel[] {
  return configuredModels(settings).flatMap((model) => {
    if (model.billing.metering !== "external" || model.credentialSource.kind === "deployment")
      return [];
    const matches = providerIds.filter((id) =>
      subscriptionCoreModelPolicyProviderIds(
        subscriptionCoreProvider(id).adapter,
        model.id,
      ).includes(model.providerId),
    );
    if (matches.length > 1) throw new Error("Ambiguous serving catalog provider");
    const provider = matches[0];
    return provider
      ? [
          {
            id: model.id,
            provider,
            upstreamModelId: model.upstreamModelId,
            reasoningLevels: model.capabilities.reasoning.efforts.length
              ? [...model.capabilities.reasoning.efforts]
              : ["none"],
          },
        ]
      : [];
  });
}

/** The control worker has raw deployment settings, not claim's credential
 * overlays. Resolve the same current model definitions without loading keys
 * or filtering exhausted accounts out of the catalog. Core placement owns
 * authority/readiness, independently of catalog membership.
 */
export async function servingCatalogForBlockedTurn(
  db: Database,
  settings: Settings,
  identity: SubscriptionCoreTurnIdentity,
  productModelId: string,
  providerIds: readonly string[],
): Promise<SubscriptionCoreFailoverModel[]> {
  const resolved = await resolveWorkspaceCatalogSettings(db, settings, {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    retainedProductModelId: productModelId,
  });
  let catalog = resolved.settings;
  if (catalog.codexSubscriptionEnabled) catalog = withCodexCatalogProvider(catalog);
  if (catalog.supergrokSubscriptionEnabled) catalog = withXaiSubscriptionCatalogProvider(catalog);
  return servingCatalog(catalog, providerIds);
}
