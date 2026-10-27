import outlookLogo from "@/assets/integration-logos/outlook-mail.svg";
import {
  useIntegrationDefinitionRow,
  type IntegrationAdapter,
} from "@/components/capabilities/use-api-integration-accounts";
import type {
  ApiIntegrationInstallationSummary,
  IntegrationDefinitionSummary,
} from "@opengeni/react/app/types";

export const OUTLOOK_MAIL_DEFINITION_ID = "microsoft-outlook-mail";
export const OUTLOOK_LOGO_URL = outlookLogo;

/** Maps the Outlook Mail curated ApiIntegration onto the shared integration view-model. */
export function useOutlookMailIntegration({
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
    ownership: "personal",
    id: "outlook-mail",
    name: "Outlook Mail",
    description: "Read, send, and organize mail in a connected Outlook mailbox.",
    mark: { logoSrc: OUTLOOK_LOGO_URL, monogram: "OM" },
    definitionId: OUTLOOK_MAIL_DEFINITION_ID,
    workspaceId,
    definitions,
    instances,
    ...(refresh ? { refresh } : {}),
    ...(onRuntimeChanged ? { onRuntimeChanged } : {}),
    ...(refreshRevision !== undefined ? { refreshRevision } : {}),
  });
}
