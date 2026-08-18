import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

export const OUTLOOK_CONTACTS_DEFINITION_ID = "microsoft-outlook-contacts";

/** Maps the Outlook Contacts curated ApiIntegration onto the shared integration view-model. */
export function useOutlookContactsIntegration({
  workspaceId,
  definitions,
  instances,
}: {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
}): IntegrationAdapter {
  return useIntegrationDefinitionRow({
    id: "outlook-contacts",
    name: "Outlook Contacts",
    description: "Read and manage contacts in a connected Outlook account.",
    mark: { monogram: "OP" },
    definitionId: OUTLOOK_CONTACTS_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
  });
}
