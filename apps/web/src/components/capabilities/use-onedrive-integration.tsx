import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

export const ONEDRIVE_DEFINITION_ID = "microsoft-onedrive";

/** Maps the OneDrive curated ApiIntegration onto the shared integration view-model. */
export function useOneDriveIntegration({
  workspaceId,
  definitions,
  instances,
}: {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
}): IntegrationAdapter {
  return useIntegrationDefinitionRow({
    id: "onedrive",
    name: "OneDrive",
    description: "Files, folders, and sharing links in a connected OneDrive account.",
    mark: { monogram: "OD" },
    definitionId: ONEDRIVE_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
  });
}
