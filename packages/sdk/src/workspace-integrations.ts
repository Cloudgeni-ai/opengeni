import {
  OPENGENI_DELIVERY_ID_HEADER,
  OPENGENI_EVENT_ID_HEADER,
  OPENGENI_SIGNATURE_HEADER,
  WorkspaceWebhookEvent,
  verifyOpenGeniSignature,
  type CredentialProviderRequest,
} from "@opengeni/contracts";

export type {
  CreateWorkspaceWebhookRequest,
  CreateWorkspaceWebhookResponse,
  CredentialProviderRequest,
  CredentialProviderResponse,
  GetWorkspaceCredentialProviderResponse,
  ListWorkspaceWebhookDeliveriesResponse,
  ListWorkspaceWebhooksResponse,
  PutWorkspaceCredentialProviderRequest,
  PutWorkspaceCredentialProviderResponse,
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
} from "@opengeni/contracts";

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
    if (key.toLowerCase() === wanted)
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
  }
  return null;
}

async function verifiedJson(input: SignedRequest): Promise<unknown> {
  const valid = await verifyOpenGeniSignature({
    secret: input.secret,
    body: input.body,
    signature: header(input.headers, OPENGENI_SIGNATURE_HEADER),
    ...(input.toleranceSeconds !== undefined ? { toleranceSeconds: input.toleranceSeconds } : {}),
  });
  if (!valid) throw new OpenGeniSignatureError();
  return JSON.parse(input.body);
}

/**
 * Verify and parse one webhook delivery. Delivery is at least once: dedupe on
 * `event.id` (also sent as the `OpenGeni-Event-Id` header).
 */
export async function verifyWebhookEvent(input: SignedRequest): Promise<{
  event: WorkspaceWebhookEvent;
  deliveryId: string | null;
}> {
  const event = WorkspaceWebhookEvent.parse(await verifiedJson(input));
  return {
    event,
    deliveryId: header(input.headers, OPENGENI_DELIVERY_ID_HEADER),
  };
}

/** Verify and parse one credential request sent to a workspace credential provider. */
export async function verifyCredentialProviderRequest(
  input: SignedRequest,
): Promise<CredentialProviderRequest> {
  const parsed = (await verifiedJson(input)) as Partial<CredentialProviderRequest>;
  if (parsed?.type !== "credentials.request" || typeof parsed.workspaceId !== "string") {
    throw new OpenGeniSignatureError();
  }
  return parsed as CredentialProviderRequest;
}

/** Identity header names, re-exported for receivers that log or dedupe. */
export const OPENGENI_WEBHOOK_HEADERS = {
  signature: OPENGENI_SIGNATURE_HEADER,
  eventId: OPENGENI_EVENT_ID_HEADER,
  deliveryId: OPENGENI_DELIVERY_ID_HEADER,
} as const;
