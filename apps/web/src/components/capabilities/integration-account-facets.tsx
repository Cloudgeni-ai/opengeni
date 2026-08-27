import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

import { GoogleDriveKnowledgeSourceDialog } from "@/components/capabilities/google-drive-knowledge-source-dialog";
import { IntegrationFacetsPanel } from "@/components/capabilities/integration-facets-panel";
import type { ApiIntegrationInstallationSummary } from "@/types";

/**
 * The per-account facets surface (Knowledge sources, Inbound triggers,
 * Delivery destinations, Identity links) for exactly one installed
 * ApiIntegration instance.
 *
 * It exists as its own module so the integration sheet can lazy-load the whole
 * facets panel and its Google Drive knowledge-source dialog behind one static
 * boundary: the dialog stays an ordinary component type inside the panel
 * (never a lazy element handed across a prop), while neither lands in the
 * Capabilities route's first chunk.
 */
export function IntegrationAccountFacets({
  client,
  workspaceId,
  instance,
  facetCount,
  canManage,
  canManagePersonalDestination,
  canManageWorkspaceDestination,
  canManageOrganizationDestination,
  refreshRevision,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  instance: ApiIntegrationInstallationSummary;
  facetCount: number;
  canManage: boolean;
  canManagePersonalDestination: boolean;
  canManageWorkspaceDestination: boolean;
  canManageOrganizationDestination: boolean;
  refreshRevision: number;
}) {
  return (
    <IntegrationFacetsPanel
      client={client}
      workspaceId={workspaceId}
      instance={instance}
      facetCount={facetCount}
      canManage={canManage}
      canManagePersonalDestination={canManagePersonalDestination}
      canManageWorkspaceDestination={canManageWorkspaceDestination}
      canManageOrganizationDestination={canManageOrganizationDestination}
      refreshRevision={refreshRevision}
      GoogleDriveDialog={GoogleDriveKnowledgeSourceDialog}
    />
  );
}
