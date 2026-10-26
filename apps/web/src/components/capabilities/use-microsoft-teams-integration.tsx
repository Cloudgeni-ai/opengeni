import microsoftTeamsLogo from "@/assets/integration-logos/microsoft-teams.svg";
import { useIntegrationDefinitionRow } from "@/components/capabilities/use-api-integration-accounts";
import type { IntegrationAdapter } from "@/components/capabilities/use-api-integration-accounts";
import type {
  ApiIntegrationInstallationSummary,
  IntegrationDefinitionSummary,
} from "@opengeni/react/app/types";

export const MICROSOFT_TEAMS_DEFINITION_ID = "microsoft-teams";
export const MICROSOFT_TEAMS_LOGO_URL = microsoftTeamsLogo;

/** User-delegated Graph access is separate from the workspace bot installation. */
export function useMicrosoftTeamsIntegration(input: {
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
    personalOnly: true,
    id: "microsoft-teams",
    name: "Microsoft Teams",
    description: "Let Opengeni read Teams conversations and send messages as you.",
    mark: { logoSrc: MICROSOFT_TEAMS_LOGO_URL, monogram: "MT" },
    definitionId: MICROSOFT_TEAMS_DEFINITION_ID,
  });
}
