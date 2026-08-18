import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

export const OUTLOOK_CALENDAR_DEFINITION_ID = "microsoft-outlook-calendar";

/** Maps the Outlook Calendar curated ApiIntegration onto the shared integration view-model. */
export function useOutlookCalendarIntegration({
  workspaceId,
  definitions,
  instances,
}: {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
}): IntegrationAdapter {
  return useIntegrationDefinitionRow({
    id: "outlook-calendar",
    name: "Outlook Calendar",
    description: "Read and schedule events on a connected Outlook calendar.",
    mark: { monogram: "OC" },
    definitionId: OUTLOOK_CALENDAR_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
  });
}
