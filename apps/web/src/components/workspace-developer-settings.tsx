// Settings > Developer, at workspace and organization scope: webhooks and the
// credential provider for a product built on Opengeni. The list is two
// settings cards; every webhook, the provider and both forms are pages with
// their own URL (lib/developer-route.ts).
import type { WorkspaceInheritedIntegrationsResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useCallback, useMemo, type ReactNode } from "react";

import {
  CredentialProviderFormPage,
  CredentialProviderPage,
  CredentialProviderSection,
} from "@/components/developer/credential-provider";
import {
  organizationIntegrationsApi,
  workspaceIntegrationsApi,
  type DeveloperIntegrationsApi,
  type WorkspaceIntegrationsClient,
} from "@/components/developer/integrations-api";
import { IdLine, useLoad } from "@/components/developer/shared";
import { DEVELOPER_GUIDE_URL } from "@/components/developer/test-result";
import { WebhookFormPage, WebhookPage, WebhooksSection } from "@/components/developer/webhooks";
import { SectionStack } from "@/components/ui/section";
import { developerSearch, type DeveloperLocation } from "@/lib/developer-route";

const LIST: DeveloperLocation = {};

const NO_INHERITANCE: WorkspaceInheritedIntegrationsResponse = {
  credentialProvider: null,
  webhooks: [],
};

export function DeveloperIntegrations({
  api,
  canManage,
  personal = false,
  location,
  onNavigate,
  idLine,
  backLabel = "Developer",
  onOpenOrganizationSettings,
}: {
  api: DeveloperIntegrationsApi;
  canManage: boolean;
  /** A Personal workspace: nobody administers it, so say where these live instead. */
  personal?: boolean;
  location: DeveloperLocation;
  onNavigate: (location: DeveloperLocation) => void;
  /** The workspace or organization ID and the guide, over the list. */
  idLine?: ReactNode;
  backLabel?: string;
  /** Organization administrators can open where inherited registrations live. */
  onOpenOrganizationSettings?: (() => void) | undefined;
}) {
  const readInherited = useCallback(
    async () =>
      api.inherited ? await api.inherited().catch(() => NO_INHERITANCE) : NO_INHERITANCE,
    [api],
  );
  const [inheritedState] = useLoad(readInherited);
  // Hosts put exactly these search params in the URL.
  const go = (next: DeveloperLocation) => onNavigate(developerSearch(next));
  const inherited = inheritedState.kind === "ready" ? inheritedState.value : NO_INHERITANCE;
  const toList = () => go({});

  if (location.view === "new-webhook") {
    return (
      <WebhookFormPage
        api={api}
        canManage={canManage}
        backLabel={backLabel}
        onClose={toList}
        onFinished={(webhook) => go({ webhook: webhook.id })}
      />
    );
  }
  if (location.view === "edit-webhook" && location.webhook) {
    return (
      <EditWebhook
        api={api}
        webhookId={location.webhook}
        canManage={canManage}
        onClose={() => go({ webhook: location.webhook! })}
      />
    );
  }
  if (location.webhook) {
    const webhookId = location.webhook;
    return (
      <WebhookPage
        key={webhookId}
        api={api}
        webhookId={webhookId}
        canManage={canManage}
        backLabel={backLabel}
        onBack={toList}
        onEdit={() => go({ view: "edit-webhook", webhook: webhookId })}
      />
    );
  }
  if (location.view === "credential-provider") {
    return (
      <CredentialProviderPage
        api={api}
        canManage={canManage}
        backLabel={backLabel}
        onBack={toList}
        onEdit={() => go({ view: "connect-credential-provider" })}
        onConnect={() => go({ view: "connect-credential-provider" })}
      />
    );
  }
  if (location.view === "connect-credential-provider") {
    return (
      <CredentialProviderFormPage
        api={api}
        canManage={canManage}
        backLabel={backLabel}
        onClose={toList}
        onFinished={() => go({ view: "credential-provider" })}
      />
    );
  }

  return (
    <SectionStack>
      {idLine}
      <WebhooksSection
        api={api}
        canManage={canManage}
        personal={personal}
        inherited={inherited.webhooks}
        onOpen={(webhook) => go({ webhook: webhook.id })}
        onAdd={() => go({ view: "new-webhook" })}
        onOpenOrganizationSettings={onOpenOrganizationSettings}
      />
      <CredentialProviderSection
        api={api}
        canManage={canManage}
        personal={personal}
        inherited={inherited.credentialProvider}
        onOpen={() => go({ view: "credential-provider" })}
        onConnect={() => go({ view: "connect-credential-provider" })}
      />
    </SectionStack>
  );
}

function EditWebhook({
  api,
  webhookId,
  canManage,
  onClose,
}: {
  api: DeveloperIntegrationsApi;
  webhookId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const read = useCallback(
    async () => (await api.listWebhooks()).find((webhook) => webhook.id === webhookId) ?? null,
    [api, webhookId],
  );
  const [state] = useLoad(read);
  return (
    <WebhookFormPage
      api={api}
      canManage={canManage}
      existing={state}
      backLabel="Webhook"
      onClose={onClose}
      onFinished={onClose}
    />
  );
}

export function WorkspaceDeveloperSettings({
  client,
  workspaceId,
  canManage,
  personal = false,
  location = LIST,
  onNavigate,
  onOpenOrganizationSettings,
}: {
  client: WorkspaceIntegrationsClient;
  workspaceId: string;
  canManage: boolean;
  /** A Personal workspace: nobody administers it, so say where these live instead. */
  personal?: boolean;
  location?: DeveloperLocation;
  onNavigate: (location: DeveloperLocation) => void;
  onOpenOrganizationSettings?: (() => void) | undefined;
}) {
  const api = useMemo(() => workspaceIntegrationsApi(client, workspaceId), [client, workspaceId]);
  return (
    <DeveloperIntegrations
      key={workspaceId}
      api={api}
      canManage={canManage}
      personal={personal}
      location={location}
      onNavigate={onNavigate}
      onOpenOrganizationSettings={onOpenOrganizationSettings}
      idLine={
        canManage && !personal ? (
          <IdLine label="Workspace ID" value={workspaceId} guideHref={DEVELOPER_GUIDE_URL} />
        ) : null
      }
    />
  );
}

/** Organization settings > Developer: registrations for every matching shared workspace. */
export function OrganizationDeveloperIntegrations({
  client,
  organizationId,
  canManage,
  location = LIST,
  onNavigate,
}: {
  client: Pick<OpenGeniBrowserClient, "requestJson">;
  organizationId: string;
  canManage: boolean;
  location?: DeveloperLocation;
  onNavigate: (location: DeveloperLocation) => void;
}) {
  const api = useMemo(
    () => organizationIntegrationsApi(client, organizationId),
    [client, organizationId],
  );
  return (
    <DeveloperIntegrations
      key={organizationId}
      api={api}
      canManage={canManage}
      location={location}
      onNavigate={onNavigate}
    />
  );
}
