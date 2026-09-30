import {
  OPENGENI_DELIVERY_ID_HEADER,
  OPENGENI_EVENT_ID_HEADER,
  OPENGENI_SIGNATURE_HEADER,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";
import type { CredentialProviderRequest, WorkspaceWebhookEvent } from "@opengeni/contracts";
import type { OpenGeniClient } from "./client";
import type {
  CreateOrganizationWebhookRequest,
  CreateOrganizationWebhookResponse,
  GetOrganizationCredentialProviderResponse,
  ListOrganizationWebhookDeliveriesResponse,
  ListOrganizationWebhooksResponse,
  OrganizationWebhook,
  OrganizationWebhookDelivery,
  PutOrganizationCredentialProviderRequest,
  PutOrganizationCredentialProviderResponse,
  RotateWorkspaceCredentialProviderSecretResponse,
  RotateOrganizationCredentialProviderSecretResponse,
  RotateWorkspaceWebhookSecretResponse,
  RotateOrganizationWebhookSecretResponse,
  UpdateOrganizationWebhookRequest,
  WorkspaceWebhook,
} from "@opengeni/contracts";

export type {
  CreateOrganizationWebhookRequest,
  CreateOrganizationWebhookResponse,
  CreateWorkspaceWebhookRequest,
  CreateWorkspaceWebhookResponse,
  CredentialProviderRequest,
  CredentialProviderInitiatorContext,
  CredentialProviderResponse,
  CredentialProviderMcpHeaders,
  CredentialProviderMcpMaterial,
  GetOrganizationCredentialProviderResponse,
  GetWorkspaceCredentialProviderResponse,
  InitiatingHuman,
  IntegrationWorkspaceFilter,
  ListOrganizationWebhookDeliveriesResponse,
  ListOrganizationWebhooksResponse,
  ListWorkspaceWebhookDeliveriesResponse,
  ListWorkspaceWebhooksResponse,
  PutWorkspaceCredentialProviderRequest,
  PutWorkspaceCredentialProviderResponse,
  PutOrganizationCredentialProviderRequest,
  PutOrganizationCredentialProviderResponse,
  RotateWorkspaceCredentialProviderSecretResponse,
  RotateOrganizationCredentialProviderSecretResponse,
  RotateWorkspaceWebhookSecretResponse,
  RotateOrganizationWebhookSecretResponse,
  OrganizationCredentialProvider,
  OrganizationWebhook,
  OrganizationWebhookDelivery,
  UpdateOrganizationWebhookRequest,
  UpdateWorkspaceWebhookRequest,
  WorkspaceCredentialProvider,
  WorkspaceWebhook,
  WorkspaceWebhookDelivery,
  WorkspaceWebhookEvent,
  WorkspaceWebhookEventType,
} from "@opengeni/contracts";
export {
  OPENGENI_DELIVERY_ID_HEADER,
  OPENGENI_EVENT_ID_HEADER,
  OPENGENI_SIGNATURE_HEADER,
  WORKSPACE_WEBHOOK_EVENT_TYPES,
  signOpenGeniPayload,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";

export type WorkspaceSandboxImages = { images: string[]; selected: string | null };

export class OpenGeniSignatureError extends Error {
  constructor() {
    super("OpenGeni signature verification failed");
    this.name = "OpenGeniSignatureError";
  }
}

type SignedRequest = {
  /** The exact raw request body. Parse it only after verification. */
  body: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
  toleranceSeconds?: number;
};

function header(headers: SignedRequest["headers"], name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    }
  }
  return null;
}

async function verifiedObject(input: SignedRequest): Promise<Record<string, unknown>> {
  const valid = await verifyOpenGeniSignature({
    secret: input.secret,
    body: input.body,
    signature: header(input.headers, OPENGENI_SIGNATURE_HEADER),
    ...(input.toleranceSeconds !== undefined ? { toleranceSeconds: input.toleranceSeconds } : {}),
  });
  if (!valid) throw new OpenGeniSignatureError();
  const parsed: unknown = JSON.parse(input.body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenGeniSignatureError();
  }
  return parsed as Record<string, unknown>;
}

/**
 * Verify and parse one webhook delivery. Delivery is at least once: dedupe on
 * `event.id` (also sent as the `OpenGeni-Event-Id` header).
 */
export async function verifyWebhookEvent(input: SignedRequest): Promise<{
  event: WorkspaceWebhookEvent;
  deliveryId: string | null;
}> {
  const event = await verifiedObject(input);
  if (
    typeof event.id !== "string" ||
    typeof event.type !== "string" ||
    typeof event.workspaceId !== "string" ||
    typeof event.sessionId !== "string"
  ) {
    throw new OpenGeniSignatureError();
  }
  return {
    event: event as WorkspaceWebhookEvent,
    deliveryId: header(input.headers, OPENGENI_DELIVERY_ID_HEADER),
  };
}

/**
 * Verify the exact bytes and parse a provider request, including its frozen
 * initiatorContext when sent by an upgraded worker. Provenance grants no access.
 */
export async function verifyCredentialProviderRequest(
  input: SignedRequest,
): Promise<CredentialProviderRequest> {
  const parsed = await verifiedObject(input);
  if (parsed.type !== "credentials.request" || typeof parsed.workspaceId !== "string") {
    throw new OpenGeniSignatureError();
  }
  return parsed as CredentialProviderRequest;
}

/** Identity header names, for receivers that log or dedupe. */
export const OPENGENI_WEBHOOK_HEADERS = {
  signature: OPENGENI_SIGNATURE_HEADER,
  eventId: OPENGENI_EVENT_ID_HEADER,
  deliveryId: OPENGENI_DELIVERY_ID_HEADER,
} as const;

/** Server-side integration administration is opt-in, outside the eager browser client. */
export async function getOrganizationCredentialProvider(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
): Promise<GetOrganizationCredentialProviderResponse> {
  return client.requestJson(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/credential-provider`,
  );
}

/** Replace configuration; explicit filter required. Store the first returned signing secret. */
export async function putOrganizationCredentialProvider(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  request: PutOrganizationCredentialProviderRequest,
): Promise<PutOrganizationCredentialProviderResponse> {
  return client.requestJson(
    "PUT",
    `/v1/organizations/${encodeURIComponent(organizationId)}/credential-provider`,
    request,
  );
}

export async function deleteOrganizationCredentialProvider(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
): Promise<void> {
  await client.requestJson<void>(
    "DELETE",
    `/v1/organizations/${encodeURIComponent(organizationId)}/credential-provider`,
    undefined,
    {},
    { responseType: "void" },
  );
}

export async function listOrganizationWebhooks(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
): Promise<ListOrganizationWebhooksResponse> {
  return client.requestJson(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks`,
  );
}

/** Create a webhook and return its signing secret once. */
export async function createOrganizationWebhook(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  request: CreateOrganizationWebhookRequest,
): Promise<CreateOrganizationWebhookResponse> {
  return client.requestJson(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks`,
    request,
  );
}

export async function getOrganizationWebhook(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  webhookId: string,
): Promise<OrganizationWebhook> {
  return client.requestJson(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/${encodeURIComponent(webhookId)}`,
  );
}

export async function updateOrganizationWebhook(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  webhookId: string,
  request: UpdateOrganizationWebhookRequest,
): Promise<OrganizationWebhook> {
  return client.requestJson(
    "PATCH",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/${encodeURIComponent(webhookId)}`,
    request,
  );
}

export async function deleteOrganizationWebhook(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  webhookId: string,
): Promise<void> {
  await client.requestJson<void>(
    "DELETE",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/${encodeURIComponent(webhookId)}`,
    undefined,
    {},
    { responseType: "void" },
  );
}

export async function listOrganizationWebhookDeliveries(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  webhookId: string,
  options: { limit?: number } = {},
): Promise<ListOrganizationWebhookDeliveriesResponse> {
  return client.requestJson(
    "GET",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
    undefined,
    options.limit !== undefined ? { limit: String(options.limit) } : {},
  );
}

/** Requeue a settled delivery with a fresh attempt budget. */
export async function redeliverOrganizationWebhookDelivery(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  webhookId: string,
  deliveryId: string,
): Promise<OrganizationWebhookDelivery> {
  return client.requestJson(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
  );
}

export async function getWorkspaceWebhook(
  client: Pick<OpenGeniClient, "requestJson">,
  workspaceId: string,
  webhookId: string,
): Promise<WorkspaceWebhook> {
  return client.requestJson("GET", `/v1/workspaces/${workspaceId}/webhooks/${webhookId}`);
}

/** Rotate immediately. Store the new secret; the old signing secret stops working. */
export async function rotateWorkspaceCredentialProviderSecret(
  client: Pick<OpenGeniClient, "requestJson">,
  workspaceId: string,
): Promise<RotateWorkspaceCredentialProviderSecretResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/credential-provider/rotate-secret`,
  );
}

export async function rotateOrganizationCredentialProviderSecret(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
): Promise<RotateOrganizationCredentialProviderSecretResponse> {
  return client.requestJson(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/credential-provider/rotate-secret`,
  );
}

export async function rotateOrganizationWebhookSecret(
  client: Pick<OpenGeniClient, "requestJson">,
  organizationId: string,
  webhookId: string,
): Promise<RotateOrganizationWebhookSecretResponse> {
  return client.requestJson(
    "POST",
    `/v1/organizations/${encodeURIComponent(organizationId)}/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
  );
}

export async function rotateWorkspaceWebhookSecret(
  client: Pick<OpenGeniClient, "requestJson">,
  workspaceId: string,
  webhookId: string,
): Promise<RotateWorkspaceWebhookSecretResponse> {
  return client.requestJson(
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/webhooks/${encodeURIComponent(webhookId)}/rotate-secret`,
  );
}
