import type {
  IntegrationEndpointTestResult,
  IntegrationWorkspaceFilter,
  UpdateOrganizationWebhookRequest,
  WorkspaceInheritedIntegrationsResponse,
  WorkspaceWebhookDelivery,
  WorkspaceWebhookEventType,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  createOrganizationWebhook,
  deleteOrganizationCredentialProvider,
  deleteOrganizationWebhook,
  getOrganizationCredentialProvider,
  getOrganizationWebhook,
  getWorkspaceInheritedIntegrations,
  listOrganizationWebhookDeliveries,
  listOrganizationWebhooks,
  putOrganizationCredentialProvider,
  redeliverOrganizationWebhookDelivery,
  rotateOrganizationCredentialProviderSecret,
  rotateOrganizationWebhookSecret,
  rotateWorkspaceCredentialProviderSecret,
  rotateWorkspaceWebhookSecret,
  testWorkspaceCredentialProvider,
  testWorkspaceWebhook,
  updateOrganizationWebhook,
} from "@opengeni/sdk/workspace-integrations";

/**
 * One shape for workspace and organization registrations, so the Developer
 * pages are the same components at both scopes. Organization registrations
 * carry a workspace filter; only workspace ones can be tested (a test names a
 * workspace) and see what they inherit.
 */

type OrganizationEventTypes = NonNullable<UpdateOrganizationWebhookRequest["eventTypes"]>;

export type IntegrationWebhook = {
  id: string;
  url: string;
  eventTypes: WorkspaceWebhookEventType[];
  enabled: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  workspaceFilter?: IntegrationWorkspaceFilter | null;
};

export type IntegrationProvider = {
  url: string;
  enabled: boolean;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
  workspaceFilter?: IntegrationWorkspaceFilter | null;
};

export type ProviderTest = {
  lane: "workspace" | "organization";
  url: string;
  result: IntegrationEndpointTestResult;
};

export type WebhookInput = {
  url: string;
  eventTypes: WorkspaceWebhookEventType[];
  workspaceFilter?: IntegrationWorkspaceFilter | null;
};

export type ProviderInput = {
  url: string;
  enabled: boolean;
  timeoutMs: number;
  workspaceFilter?: IntegrationWorkspaceFilter | null;
};

export interface DeveloperIntegrationsApi {
  scope: "workspace" | "organization";
  listWebhooks(): Promise<IntegrationWebhook[]>;
  createWebhook(input: WebhookInput): Promise<{ webhook: IntegrationWebhook; secret: string }>;
  updateWebhook(
    id: string,
    input: Partial<WebhookInput> & { enabled?: boolean },
  ): Promise<IntegrationWebhook>;
  deleteWebhook(id: string): Promise<void>;
  listDeliveries(id: string, limit: number): Promise<WorkspaceWebhookDelivery[]>;
  redeliver(id: string, deliveryId: string): Promise<unknown>;
  rotateWebhookSecret(id: string): Promise<string>;
  getProvider(): Promise<IntegrationProvider | null>;
  putProvider(input: ProviderInput): Promise<{ provider: IntegrationProvider; secret?: string }>;
  deleteProvider(): Promise<void>;
  rotateProviderSecret(): Promise<string>;
  /** Workspace only. */
  testWebhook?: (id: string) => Promise<IntegrationEndpointTestResult>;
  /** Workspace only: tests the provider the workspace's runs use. */
  testProvider?: () => Promise<ProviderTest>;
  /** Workspace only: organization registrations that reach this workspace. */
  inherited?: () => Promise<WorkspaceInheritedIntegrationsResponse>;
}

export type WorkspaceIntegrationsClient = Pick<
  OpenGeniBrowserClient,
  | "listWorkspaceWebhooks"
  | "createWorkspaceWebhook"
  | "updateWorkspaceWebhook"
  | "deleteWorkspaceWebhook"
  | "listWorkspaceWebhookDeliveries"
  | "redeliverWorkspaceWebhookDelivery"
  | "getWorkspaceCredentialProvider"
  | "putWorkspaceCredentialProvider"
  | "deleteWorkspaceCredentialProvider"
  | "requestJson"
>;

export function workspaceIntegrationsApi(
  client: WorkspaceIntegrationsClient,
  workspaceId: string,
): DeveloperIntegrationsApi {
  return {
    scope: "workspace",
    listWebhooks: async () => (await client.listWorkspaceWebhooks(workspaceId)).webhooks,
    createWebhook: async ({ url, eventTypes }) =>
      await client.createWorkspaceWebhook(workspaceId, { url, eventTypes }),
    updateWebhook: async (id, { url, eventTypes, enabled }) =>
      await client.updateWorkspaceWebhook(workspaceId, id, {
        ...(url !== undefined ? { url } : {}),
        ...(eventTypes !== undefined ? { eventTypes } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      }),
    deleteWebhook: async (id) => await client.deleteWorkspaceWebhook(workspaceId, id),
    listDeliveries: async (id, limit) =>
      (await client.listWorkspaceWebhookDeliveries(workspaceId, id, { limit })).deliveries,
    redeliver: async (id, deliveryId) =>
      await client.redeliverWorkspaceWebhookDelivery(workspaceId, id, deliveryId),
    rotateWebhookSecret: async (id) =>
      (await rotateWorkspaceWebhookSecret(client, workspaceId, id)).secret,
    getProvider: async () => (await client.getWorkspaceCredentialProvider(workspaceId)).provider,
    putProvider: async ({ url, enabled, timeoutMs }) =>
      await client.putWorkspaceCredentialProvider(workspaceId, { url, enabled, timeoutMs }),
    deleteProvider: async () => await client.deleteWorkspaceCredentialProvider(workspaceId),
    rotateProviderSecret: async () =>
      (await rotateWorkspaceCredentialProviderSecret(client, workspaceId)).secret,
    testWebhook: async (id) => (await testWorkspaceWebhook(client, workspaceId, id)).result,
    testProvider: async () => await testWorkspaceCredentialProvider(client, workspaceId),
    inherited: async () => await getWorkspaceInheritedIntegrations(client, workspaceId),
  };
}

export function organizationIntegrationsApi(
  client: Pick<OpenGeniBrowserClient, "requestJson">,
  organizationId: string,
): DeveloperIntegrationsApi {
  return {
    scope: "organization",
    listWebhooks: async () => (await listOrganizationWebhooks(client, organizationId)).webhooks,
    createWebhook: async ({ url, eventTypes, workspaceFilter }) =>
      await createOrganizationWebhook(client, organizationId, {
        url,
        eventTypes: eventTypes as OrganizationEventTypes,
        workspaceFilter: workspaceFilter ?? null,
      }),
    // Every organization update restates its filter, so keep the current one.
    updateWebhook: async (id, { url, eventTypes, enabled, workspaceFilter }) =>
      await updateOrganizationWebhook(client, organizationId, id, {
        ...(url !== undefined ? { url } : {}),
        ...(eventTypes !== undefined ? { eventTypes: eventTypes as OrganizationEventTypes } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        workspaceFilter:
          workspaceFilter !== undefined
            ? workspaceFilter
            : (await getOrganizationWebhook(client, organizationId, id)).workspaceFilter,
      }),
    deleteWebhook: async (id) => await deleteOrganizationWebhook(client, organizationId, id),
    listDeliveries: async (id, limit) =>
      (await listOrganizationWebhookDeliveries(client, organizationId, id, { limit })).deliveries,
    redeliver: async (id, deliveryId) =>
      await redeliverOrganizationWebhookDelivery(client, organizationId, id, deliveryId),
    rotateWebhookSecret: async (id) =>
      (await rotateOrganizationWebhookSecret(client, organizationId, id)).secret,
    getProvider: async () =>
      (await getOrganizationCredentialProvider(client, organizationId)).provider,
    putProvider: async ({ url, enabled, timeoutMs, workspaceFilter }) =>
      await putOrganizationCredentialProvider(client, organizationId, {
        url,
        enabled,
        timeoutMs,
        workspaceFilter: workspaceFilter ?? null,
      }),
    deleteProvider: async () => await deleteOrganizationCredentialProvider(client, organizationId),
    rotateProviderSecret: async () =>
      (await rotateOrganizationCredentialProviderSecret(client, organizationId)).secret,
  };
}
