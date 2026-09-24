import { z } from "zod";

/**
 * Workspace integration primitives for embedding hosts: signed outbound
 * webhooks and one signed HTTP credential provider per workspace. Both
 * directions share one signature scheme so a host verifies every OpenGeni
 * request with the same helper.
 */

export const WORKSPACE_WEBHOOK_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "session.status.changed",
  "session.requiresAction",
  "session.humanInput.requested",
] as const;
export const WorkspaceWebhookEventType = z.enum(WORKSPACE_WEBHOOK_EVENT_TYPES);
export type WorkspaceWebhookEventType = z.infer<typeof WorkspaceWebhookEventType>;

export const WORKSPACE_WEBHOOK_LIMIT_PER_WORKSPACE = 10;

const HttpUrl = z
  .string()
  .trim()
  .min(8)
  .max(2048)
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "URL must use http or https");

const EventTypes = z
  .array(WorkspaceWebhookEventType)
  .min(1)
  .max(WORKSPACE_WEBHOOK_EVENT_TYPES.length)
  .transform((types) => [...new Set(types)]);

export const WorkspaceWebhook = z
  .object({
    id: z.string().uuid(),
    workspaceId: z.string().uuid(),
    url: z.string(),
    eventTypes: z.array(WorkspaceWebhookEventType),
    enabled: z.boolean(),
    description: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type WorkspaceWebhook = z.infer<typeof WorkspaceWebhook>;

export const CreateWorkspaceWebhookRequest = z
  .object({
    url: HttpUrl,
    eventTypes: EventTypes,
    enabled: z.boolean().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type CreateWorkspaceWebhookRequest = z.input<typeof CreateWorkspaceWebhookRequest>;

/** The signing secret is returned exactly once, at creation. */
export const CreateWorkspaceWebhookResponse = z
  .object({ webhook: WorkspaceWebhook, secret: z.string() })
  .strict();
export type CreateWorkspaceWebhookResponse = z.infer<typeof CreateWorkspaceWebhookResponse>;

export const UpdateWorkspaceWebhookRequest = z
  .object({
    url: HttpUrl.optional(),
    eventTypes: EventTypes.optional(),
    enabled: z.boolean().optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();
export type UpdateWorkspaceWebhookRequest = z.input<typeof UpdateWorkspaceWebhookRequest>;

export const ListWorkspaceWebhooksResponse = z
  .object({ webhooks: z.array(WorkspaceWebhook) })
  .strict();
export type ListWorkspaceWebhooksResponse = z.infer<typeof ListWorkspaceWebhooksResponse>;

export const WorkspaceWebhookDeliveryStatus = z.enum(["pending", "delivered", "failed"]);
export type WorkspaceWebhookDeliveryStatus = z.infer<typeof WorkspaceWebhookDeliveryStatus>;

export const WorkspaceWebhookDelivery = z
  .object({
    id: z.string().uuid(),
    webhookId: z.string().uuid(),
    eventId: z.string().uuid(),
    eventType: z.string(),
    status: WorkspaceWebhookDeliveryStatus,
    attempts: z.number().int(),
    lastStatus: z.number().int().nullable(),
    lastError: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    failedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type WorkspaceWebhookDelivery = z.infer<typeof WorkspaceWebhookDelivery>;

export const ListWorkspaceWebhookDeliveriesResponse = z
  .object({ deliveries: z.array(WorkspaceWebhookDelivery) })
  .strict();
export type ListWorkspaceWebhookDeliveriesResponse = z.infer<
  typeof ListWorkspaceWebhookDeliveriesResponse
>;

/**
 * The thin body POSTed to a webhook endpoint. It identifies what changed;
 * receivers read details through the authenticated API.
 */
export const WorkspaceWebhookEvent = z.object({
  id: z.string().uuid(),
  type: z.string(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  sequence: z.number().int(),
  occurredAt: z.string(),
  data: z.object({ status: z.string().optional(), reason: z.string().optional() }).passthrough(),
});
export type WorkspaceWebhookEvent = z.infer<typeof WorkspaceWebhookEvent>;

export const WorkspaceCredentialProvider = z
  .object({
    workspaceId: z.string().uuid(),
    url: z.string(),
    enabled: z.boolean(),
    timeoutMs: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type WorkspaceCredentialProvider = z.infer<typeof WorkspaceCredentialProvider>;

export const PutWorkspaceCredentialProviderRequest = z
  .object({
    url: HttpUrl,
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(30000).optional(),
  })
  .strict();
export type PutWorkspaceCredentialProviderRequest = z.input<
  typeof PutWorkspaceCredentialProviderRequest
>;

/** `secret` is present only when the provider was first created. */
export const PutWorkspaceCredentialProviderResponse = z
  .object({ provider: WorkspaceCredentialProvider, secret: z.string().optional() })
  .strict();
export type PutWorkspaceCredentialProviderResponse = z.infer<
  typeof PutWorkspaceCredentialProviderResponse
>;

export const GetWorkspaceCredentialProviderResponse = z
  .object({ provider: WorkspaceCredentialProvider.nullable() })
  .strict();
export type GetWorkspaceCredentialProviderResponse = z.infer<
  typeof GetWorkspaceCredentialProviderResponse
>;

/** The body OpenGeni POSTs to a workspace credential provider. */
export type CredentialProviderRequest = {
  type: "credentials.request";
  purpose: "provision" | "renewal";
  forceRefresh: boolean;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  turnId: string;
  attemptId: string;
  initiator: { kind: string; subjectId?: string };
  initiatingHumanSubjectId: string | null;
  sandboxBackend: string;
  sandboxOs: string;
};

const ProviderAuthNeeded = z.object({
  reason: z.enum(["missing_connection", "expired", "insufficient_scope", "refresh_failed"]),
  providerDomain: z.string().optional(),
  connectionId: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  resource: z.string().optional(),
  authorizationUrl: z.string().optional(),
  message: z.string().optional(),
});

/**
 * HTTPS Git credentials the host wants available to `git` in the sandbox.
 * OpenGeni stores them in a renewable file and points a credential helper at
 * it, so a refreshed token applies to the next git command.
 */
const ProviderGitCredential = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/, "host must be a bare hostname"),
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(16384),
});

/** What a credential provider returns. Scope echoes are added by OpenGeni. */
export const CredentialProviderResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    environment: z.record(z.string(), z.string()).optional(),
    files: z
      .array(
        z.object({
          path: z.string(),
          content: z.string(),
          mode: z.enum(["0400", "0600"]).optional(),
        }),
      )
      .optional(),
    fileEnvironment: z.record(z.string(), z.string()).optional(),
    git: z.array(ProviderGitCredential).max(16).optional(),
    expiresAt: z.string().nullable().optional(),
    authNeeded: z.array(ProviderAuthNeeded).optional(),
  }),
  z.object({ status: z.literal("not_applicable") }),
  z.object({ status: z.literal("auth_needed"), authNeeded: z.array(ProviderAuthNeeded).min(1) }),
]);
export type CredentialProviderResponse = z.infer<typeof CredentialProviderResponse>;

export const OPENGENI_SIGNATURE_HEADER = "OpenGeni-Signature";
export const OPENGENI_EVENT_ID_HEADER = "OpenGeni-Event-Id";
export const OPENGENI_DELIVERY_ID_HEADER = "OpenGeni-Delivery-Id";
export const OPENGENI_SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * `OpenGeni-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
 * The timestamp is signed so a captured request cannot be replayed later.
 */
export async function signOpenGeniPayload(
  secret: string,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `t=${timestampSeconds},v1=${await hmacSha256Hex(secret, `${timestampSeconds}.${body}`)}`;
}

export type VerifyOpenGeniSignatureInput = {
  secret: string;
  /** The exact raw request body, before JSON parsing. */
  body: string;
  /** The `OpenGeni-Signature` header value. */
  signature: string | null | undefined;
  toleranceSeconds?: number;
  nowSeconds?: number;
};

export async function verifyOpenGeniSignature(
  input: VerifyOpenGeniSignatureInput,
): Promise<boolean> {
  if (!input.signature) return false;
  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of input.signature.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value && /^[0-9a-f]{64}$/.test(value)) candidates.push(value);
  }
  if (timestamp === null || candidates.length === 0) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? OPENGENI_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;
  const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.body}`);
  return candidates.some((candidate) => constantTimeEqualHex(candidate, expected));
}
