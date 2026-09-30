import {
  OPENGENI_DELIVERY_ID_HEADER,
  OPENGENI_EVENT_ID_HEADER,
  OPENGENI_SIGNATURE_HEADER,
  verifyOpenGeniSignature,
} from "@opengeni/contracts/workspace-integration-wire";
import type { CredentialProviderRequest, WorkspaceWebhookEvent } from "@opengeni/contracts";

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
  SessionWorkspaceWebhookEvent,
  WorkspaceUsageWebhookEvent,
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
    !(
      typeof event.sessionId === "string" ||
      ((event.sessionId === null || event.sessionId === undefined) &&
        ["usage.threshold_reached", "usage.exhausted", "usage.period_reset"].includes(event.type))
    )
  ) {
    throw new OpenGeniSignatureError();
  }
  return {
    event: event as WorkspaceWebhookEvent,
    deliveryId: header(input.headers, OPENGENI_DELIVERY_ID_HEADER),
  };
}

/** Verify and parse one credential request sent to a workspace credential provider. */
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
