/* URL state for the Developer pages (workspace and organization settings):
     (none)                                   the list
     view=new-webhook                         Add webhook
     webhook=<id>                             a webhook's page
     webhook=<id>&view=edit-webhook           Edit webhook
     view=credential-provider                 the credential provider's page
     view=connect-credential-provider         Connect (or replace) a provider
     view=connect-agent                       Connect an agent (organization only)
     agent=<id>                               a connected agent's page (organization only)
     view=new-service-account                 New service account (organization only)
     serviceAccount=<id>                      a service account's page (organization only) */

export type DeveloperView =
  | "new-webhook"
  | "edit-webhook"
  | "credential-provider"
  | "connect-credential-provider"
  | "connect-agent"
  | "new-service-account";

export const DEVELOPER_VIEWS: readonly DeveloperView[] = [
  "new-webhook",
  "edit-webhook",
  "credential-provider",
  "connect-credential-provider",
  "connect-agent",
  "new-service-account",
];

export type DeveloperLocation = {
  view?: DeveloperView;
  webhook?: string;
  agent?: string;
  serviceAccount?: string;
};

export function parseDeveloperView(value: unknown): DeveloperView | undefined {
  return DEVELOPER_VIEWS.find((view) => view === value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWebhookParam(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

export function parseAgentParam(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

export function parseServiceAccountParam(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
}

/** A service account's page or New service account: owned by the Service accounts section. */
export function isServiceAccountsLocation(location: DeveloperLocation): boolean {
  return location.view === "new-service-account" || Boolean(location.serviceAccount);
}

/** A connected agent's page or Connect an agent: owned by the Connected agents section. */
export function isConnectedAgentsLocation(location: DeveloperLocation): boolean {
  return location.view === "connect-agent" || Boolean(location.agent);
}

/** The search params of one location, dropping what doesn't apply. */
export function developerSearch(location: DeveloperLocation): DeveloperLocation {
  const webhook = location.webhook;
  const view = location.view;
  if (view === "edit-webhook") return webhook ? { view, webhook } : {};
  if (view) return { view };
  if (location.agent) return { agent: location.agent };
  if (location.serviceAccount) return { serviceAccount: location.serviceAccount };
  return webhook ? { webhook } : {};
}

/** A sub-page brings its own back link and title. */
export function isDeveloperSubPage(location: DeveloperLocation): boolean {
  return Boolean(location.view || location.webhook || location.agent || location.serviceAccount);
}
