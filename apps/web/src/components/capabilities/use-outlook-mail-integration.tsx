import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

export const OUTLOOK_MAIL_DEFINITION_ID = "microsoft-outlook-mail";

/** Maps the Outlook Mail curated ApiIntegration onto the shared integration view-model. */
export function useOutlookMailIntegration({
  workspaceId,
  definitions,
  instances,
}: {
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
}): IntegrationAdapter {
  return useIntegrationDefinitionRow({
    id: "outlook-mail",
    name: "Outlook Mail",
    description: "Read, send, and organize mail in a connected Outlook mailbox.",
    mark: { monogram: "OM" },
    definitionId: OUTLOOK_MAIL_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
  });
}
