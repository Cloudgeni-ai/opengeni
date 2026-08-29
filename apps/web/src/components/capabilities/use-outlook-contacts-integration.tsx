import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import { OUTLOOK_LOGO_URL } from "@/components/capabilities/use-outlook-mail-integration";
import type { ApiIntegrationInstallationSummary, IntegrationDefinitionSummary } from "@/types";

export const OUTLOOK_CONTACTS_DEFINITION_ID = "microsoft-outlook-contacts";

/** Maps the Outlook Contacts curated ApiIntegration onto the shared integration view-model. */
export function useOutlookContactsIntegration({
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
    id: "outlook-contacts",
    name: "Outlook Contacts",
    description: "Read and manage contacts in a connected Outlook account.",
    mark: { logoSrc: OUTLOOK_LOGO_URL, monogram: "OC" },
    definitionId: OUTLOOK_CONTACTS_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
    ...(refresh ? { refresh } : {}),
    ...(onRuntimeChanged ? { onRuntimeChanged } : {}),
    ...(refreshRevision !== undefined ? { refreshRevision } : {}),
  });
}
