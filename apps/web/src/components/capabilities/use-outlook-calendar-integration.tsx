import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import { OUTLOOK_LOGO_URL } from "@/components/capabilities/use-outlook-mail-integration";
import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

export const OUTLOOK_CALENDAR_DEFINITION_ID = "microsoft-outlook-calendar";

/** Maps the Outlook Calendar curated ApiIntegration onto the shared integration view-model. */
export function useOutlookCalendarIntegration({
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
    id: "outlook-calendar",
    name: "Outlook Calendar",
    description: "Read and schedule events on a connected Outlook calendar.",
    mark: { logoSrc: OUTLOOK_LOGO_URL, monogram: "OC" },
    definitionId: OUTLOOK_CALENDAR_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
    ...(refresh ? { refresh } : {}),
    ...(onRuntimeChanged ? { onRuntimeChanged } : {}),
    ...(refreshRevision !== undefined ? { refreshRevision } : {}),
  });
}
