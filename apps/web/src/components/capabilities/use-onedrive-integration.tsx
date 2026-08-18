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
  refresh,
  onRuntimeChanged,
  refreshRevision,
}: {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
  refresh?: () => Promise<void>;
  onRuntimeChanged?: () => void;
  refreshRevision?: number;
}): IntegrationAdapter {
  return useIntegrationDefinitionRow({
    id: "onedrive",
    name: "OneDrive",
    description: "Files, folders, and sharing links in a connected OneDrive account.",
    mark: { icon: "cloud" },
    definitionId: ONEDRIVE_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
    ...(refresh ? { refresh } : {}),
    ...(onRuntimeChanged ? { onRuntimeChanged } : {}),
    ...(refreshRevision !== undefined ? { refreshRevision } : {}),
  });
}
