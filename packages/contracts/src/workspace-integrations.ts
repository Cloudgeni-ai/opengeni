import { z } from "zod";

import { WORKSPACE_WEBHOOK_EVENT_TYPES } from "./workspace-integration-wire";
import {
  UsageAllowancePeriod,
  UsageAllowanceStatus,
  UsageAllowanceWindow,
} from "./usage-allowances";

export * from "./workspace-integration-wire";

/**
 * Workspace integration primitives for embedding hosts: signed outbound
 * webhooks and one signed HTTP credential provider per workspace. Both
 * directions share one signature scheme so a host verifies every OpenGeni
 * request with the same helper.
 */

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
export const SessionWorkspaceWebhookEvent = z.object({
  id: z.string().uuid(),
  type: z.string(),
  workspaceId: z.string().uuid(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  sequence: z.number().int(),
  occurredAt: z.string(),
  data: z.object({ status: z.string().optional(), reason: z.string().optional() }).passthrough(),
});
export type SessionWorkspaceWebhookEvent = z.infer<typeof SessionWorkspaceWebhookEvent>;
/** Workspace allowance events have no synthetic session or turn identity.
 * Optional null context fields let transport adapters share an envelope. */
export const WorkspaceUsageWebhookEvent = z.object({
  id: z.string().uuid(),
  type: z.enum(["usage.threshold_reached", "usage.exhausted", "usage.period_reset"]),
  workspaceId: z.string().uuid(),
  sessionId: z.null().optional(),
  turnId: z.null().optional(),
  sequence: z.number().int().nonnegative().optional(),
  occurredAt: z.string(),
  data: z
    .object({
      scope: z.enum(["workspace", "member"]).optional(),
      subjectId: z.string().nullable().optional(),
      threshold: z.number().finite().optional(),
      fraction: z.number().finite().nullable().optional(),
      resetsAt: z.string().nullable().optional(),
      status: UsageAllowanceStatus.optional(),
      period: z.union([UsageAllowanceWindow, UsageAllowancePeriod, z.literal("*")]).optional(),
    })
    .passthrough(),
});
export type WorkspaceUsageWebhookEvent = z.infer<typeof WorkspaceUsageWebhookEvent>;
export const WorkspaceWebhookEvent = z.union([
  SessionWorkspaceWebhookEvent,
  WorkspaceUsageWebhookEvent,
]);
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
