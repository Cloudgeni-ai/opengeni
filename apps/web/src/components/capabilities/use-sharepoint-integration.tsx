import sharePointLogo from "@/assets/integration-logos/sharepoint.svg";
import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import type {
  ApiIntegrationInstallationSummary,
  IntegrationDefinitionSummary,
} from "@opengeni/react/app/types";

export const SHAREPOINT_DEFINITION_ID = "microsoft-sharepoint";
export const SHAREPOINT_LOGO_URL = sharePointLogo;

/** Work/school SharePoint sites, libraries, lists and search; separate from OneDrive. */
export function useSharePointIntegration(input: {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
  refresh?: () => Promise<void>;
  onRuntimeChanged?: () => void;
  refreshRevision?: number;
}): IntegrationAdapter {
  return useIntegrationDefinitionRow({
    ...input,
    ownership: "personal",
    id: "sharepoint",
    name: "SharePoint",
    description: "Sites, document libraries, lists, and search in a work or school account.",
    mark: { logoSrc: SHAREPOINT_LOGO_URL, monogram: "SP" },
    definitionId: SHAREPOINT_DEFINITION_ID,
  });
}
