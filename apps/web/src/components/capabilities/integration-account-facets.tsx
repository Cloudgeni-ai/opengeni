import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { IntegrationFacetsPanel } from "@/components/capabilities/integration-facets-panel";
import type { ApiIntegrationInstallationSummary } from "@opengeni/react/app/types";

/**
 * The per-account facets surface (Inbound triggers, Delivery destinations,
 * Identity links, and any retired Knowledge source saved earlier) for exactly
 * one installed ApiIntegration instance.
 *
 * It exists as its own module so the integration sheet can lazy-load the
 * facets panel behind one static boundary, keeping it out of the Capabilities
 * route's first chunk.
 */
export function IntegrationAccountFacets({
  client,
  workspaceId,
  instance,
  facetCount,
  canManage,
  refreshRevision,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  instance: ApiIntegrationInstallationSummary;
  facetCount: number;
  canManage: boolean;
  refreshRevision: number;
}) {
  return (
    <IntegrationFacetsPanel
      client={client}
      workspaceId={workspaceId}
      instance={instance}
      facetCount={facetCount}
      canManage={canManage}
      refreshRevision={refreshRevision}
    />
  );
}
