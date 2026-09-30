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
export const ORGANIZATION_WEBHOOK_LIMIT_PER_ORGANIZATION = 10;

/** Scoping convenience, never authority. Null means all non-personal workspaces. */
export const IntegrationWorkspaceFilter = z
  .object({
    externalSource: z
      .string()
      .min(1)
      .max(200)
      .refine(
        (value) =>
          !value.includes("\0") &&
          !/[\uD800-\uDFFF]/u.test(value) &&
          new TextEncoder().encode(value).byteLength <= 200,
        "External source must be valid PostgreSQL text of at most 200 UTF-8 bytes",
      ),
  })
  .strict();
export type IntegrationWorkspaceFilter = z.infer<typeof IntegrationWorkspaceFilter>;

/** Informational attribution only. It never supplies or changes authorization. */
export const InitiatingHuman = z.object({
  subjectId: z.string(),
  externalIdentity: z.object({ source: z.string(), externalId: z.string() }).nullable(),
});
export type InitiatingHuman = z.infer<typeof InitiatingHuman>;

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

/** Organization webhooks fan out session events only; usage events are per-workspace. */
export const OrganizationWebhookEventType = WorkspaceWebhookEventType.exclude([
  "usage.threshold_reached",
  "usage.exhausted",
  "usage.period_reset",
]);
export type OrganizationWebhookEventType = z.infer<typeof OrganizationWebhookEventType>;
const OrganizationEventTypes = z
  .array(WorkspaceWebhookEventType)
  .min(1)
  .max(WorkspaceWebhookEventType.options.length)
  .refine((types) => types.every((type) => !type.startsWith("usage.")), {
    message:
      "Organization webhooks accept session events only; subscribe to usage events on a workspace webhook.",
  })
  .transform((types) => [...new Set(types)]);

export const OrganizationWebhook = WorkspaceWebhook.omit({ workspaceId: true }).extend({
  organizationId: z.string().uuid(),
  eventTypes: z
    .array(WorkspaceWebhookEventType)
    .refine((types) => types.every((type) => !type.startsWith("usage.")), {
      message:
        "Organization webhooks accept session events only; subscribe to usage events on a workspace webhook.",
    }),
  workspaceFilter: IntegrationWorkspaceFilter.nullable(),
});
export type OrganizationWebhook = z.infer<typeof OrganizationWebhook>;

export const CreateOrganizationWebhookRequest = CreateWorkspaceWebhookRequest.extend({
  eventTypes: OrganizationEventTypes,
  workspaceFilter: IntegrationWorkspaceFilter.nullable(),
});
export type CreateOrganizationWebhookRequest = z.input<typeof CreateOrganizationWebhookRequest>;

export const UpdateOrganizationWebhookRequest = UpdateWorkspaceWebhookRequest.extend({
  eventTypes: OrganizationEventTypes.optional(),
  /** Explicit on every update: null covers all non-personal workspaces. */
  workspaceFilter: IntegrationWorkspaceFilter.nullable(),
});
export type UpdateOrganizationWebhookRequest = z.input<typeof UpdateOrganizationWebhookRequest>;

export const CreateOrganizationWebhookResponse = z
  .object({ webhook: OrganizationWebhook, secret: z.string() })
  .strict();
export type CreateOrganizationWebhookResponse = z.infer<typeof CreateOrganizationWebhookResponse>;

export const ListOrganizationWebhooksResponse = z
  .object({ webhooks: z.array(OrganizationWebhook) })
  .strict();
export type ListOrganizationWebhooksResponse = z.infer<typeof ListOrganizationWebhooksResponse>;

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

export const OrganizationWebhookDelivery = WorkspaceWebhookDelivery;
export type OrganizationWebhookDelivery = z.infer<typeof OrganizationWebhookDelivery>;
export const ListOrganizationWebhookDeliveriesResponse = ListWorkspaceWebhookDeliveriesResponse;
export type ListOrganizationWebhookDeliveriesResponse = z.infer<
  typeof ListOrganizationWebhookDeliveriesResponse
>;

/**
 * The thin body POSTed to a webhook endpoint. It identifies what changed;
 * receivers read details through the authenticated API.
 */
export const SessionWorkspaceWebhookEvent = z.object({
  lane: z.enum(["organization", "workspace"]).default("workspace"),
  id: z.string().uuid(),
  type: z.string(),
  workspaceId: z.string().uuid(),
  /** Present on new deliveries; optional for receivers of pre-upgrade deliveries. */
  workspace: z
    .object({
      id: z.string().uuid(),
      externalSource: z.string().nullable(),
      externalId: z.string().nullable(),
    })
    .optional(),
  sessionId: z.string().uuid(),
  turnId: z.string().uuid().nullable(),
  sequence: z.number().int(),
  occurredAt: z.string(),
  initiatingHuman: InitiatingHuman.nullable().optional(),
  data: z.object({ status: z.string().optional(), reason: z.string().optional() }).passthrough(),
});
export type SessionWorkspaceWebhookEvent = z.infer<typeof SessionWorkspaceWebhookEvent>;
/** Workspace allowance events have no synthetic session or turn identity.
 * Optional null context fields let transport adapters share an envelope. */
export const WorkspaceUsageWebhookEvent = z.object({
  lane: z.literal("workspace").default("workspace"),
  id: z.string().uuid(),
  type: z.enum(["usage.threshold_reached", "usage.exhausted", "usage.period_reset"]),
  workspaceId: z.string().uuid(),
  workspace: z
    .object({
      id: z.string().uuid(),
      externalSource: z.string().nullable(),
      externalId: z.string().nullable(),
    })
    .optional(),
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

export const OrganizationCredentialProvider = WorkspaceCredentialProvider.omit({
  workspaceId: true,
}).extend({
  organizationId: z.string().uuid(),
  workspaceFilter: IntegrationWorkspaceFilter.nullable(),
});
export type OrganizationCredentialProvider = z.infer<typeof OrganizationCredentialProvider>;

export const PutOrganizationCredentialProviderRequest =
  PutWorkspaceCredentialProviderRequest.extend({
    /** Required; null explicitly covers all non-personal workspaces. PUT replaces configuration. */
    workspaceFilter: IntegrationWorkspaceFilter.nullable(),
  });
export type PutOrganizationCredentialProviderRequest = z.input<
  typeof PutOrganizationCredentialProviderRequest
>;

export const PutOrganizationCredentialProviderResponse = z
  .object({ provider: OrganizationCredentialProvider, secret: z.string().optional() })
  .strict();
export type PutOrganizationCredentialProviderResponse = z.infer<
  typeof PutOrganizationCredentialProviderResponse
>;

export const GetOrganizationCredentialProviderResponse = z
  .object({ provider: OrganizationCredentialProvider.nullable() })
  .strict();
export type GetOrganizationCredentialProviderResponse = z.infer<
  typeof GetOrganizationCredentialProviderResponse
>;

/** The body OpenGeni POSTs to a workspace credential provider. */
export type CredentialProviderRequest = {
  type: "credentials.request";
  lane: "organization" | "workspace";
  /** Selected session-attached remote targets; providers must authorize each exact URL. */
  mcpServers: { id: string; url: string }[];
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
  /** Informational, not authority. Optional only for pre-upgrade senders. */
  initiatingHuman?: InitiatingHuman | null;
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

const FORBIDDEN_MCP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "mcp-session-id",
  "mcp-protocol-version",
  "content-type",
  "accept",
]);

/** Exact WHATWG normalization; IDs, URL credentials and fragments are never targets. */
export function normalizeCredentialProviderMcpUrl(value: string): string {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("MCP credential URL must be an HTTP endpoint without credentials or fragment");
  }
  return url.href;
}

const ProviderMcpUrl = z
  .string()
  .min(8)
  .max(2048)
  .refine((value) => {
    try {
      normalizeCredentialProviderMcpUrl(value);
      return true;
    } catch {
      return false;
    }
  }, "MCP credential url must be an HTTP endpoint without credentials or fragment")
  .transform(normalizeCredentialProviderMcpUrl);

/** Secret, turn-local headers for one session-attached remote MCP, by normalized URL only. */
export const CredentialProviderMcpHeaders = z
  .object({
    url: ProviderMcpUrl,
    headers: z.record(z.string(), z.string()),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const headers = Object.entries(entry.headers);
    const seen = new Set<string>();
    let bytes = 0;
    if (headers.length === 0 || headers.length > 32) {
      context.addIssue({ code: "custom", message: "MCP headers must contain 1–32 entries" });
    }
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (
        name.length > 128 ||
        name.length === 0 ||
        /[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name) ||
        FORBIDDEN_MCP_HEADERS.has(lower) ||
        seen.has(lower)
      ) {
        context.addIssue({ code: "custom", message: "Invalid or duplicate MCP header name" });
      }
      seen.add(lower);
      const valueBytes = new TextEncoder().encode(value).byteLength;
      bytes += name.length + valueBytes;
      if (valueBytes > 16384 || /[^\t\u0020-\u007e\u0080-\u00ff]/.test(value)) {
        context.addIssue({ code: "custom", message: "Invalid or oversized MCP header value" });
      }
    }
    if (bytes > 65536) {
      context.addIssue({ code: "custom", message: "MCP header material exceeds 64 KiB" });
    }
  });
export type CredentialProviderMcpHeaders = z.infer<typeof CredentialProviderMcpHeaders>;

export const CredentialProviderMcpMaterial = z
  .array(CredentialProviderMcpHeaders)
  .max(32)
  .superRefine((entries, context) => {
    if (new Set(entries.map((entry) => entry.url)).size !== entries.length) {
      context.addIssue({ code: "custom", message: "Duplicate MCP server target" });
    }
  });
export type CredentialProviderMcpMaterial = z.infer<typeof CredentialProviderMcpMaterial>;

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
    mcp: CredentialProviderMcpMaterial.optional(),
    expiresAt: z.string().nullable().optional(),
    authNeeded: z.array(ProviderAuthNeeded).optional(),
  }),
  z.object({ status: z.literal("not_applicable") }),
  z.object({ status: z.literal("auth_needed"), authNeeded: z.array(ProviderAuthNeeded).min(1) }),
]);
export type CredentialProviderResponse = z.infer<typeof CredentialProviderResponse>;

/** Immediate signing-secret rotation; the new secret is returned once. */
export const RotateWorkspaceCredentialProviderSecretResponse = z
  .object({ provider: WorkspaceCredentialProvider, secret: z.string() })
  .strict();
export type RotateWorkspaceCredentialProviderSecretResponse = z.infer<
  typeof RotateWorkspaceCredentialProviderSecretResponse
>;
export const RotateOrganizationCredentialProviderSecretResponse = z
  .object({ provider: OrganizationCredentialProvider, secret: z.string() })
  .strict();
export type RotateOrganizationCredentialProviderSecretResponse = z.infer<
  typeof RotateOrganizationCredentialProviderSecretResponse
>;
export const RotateWorkspaceWebhookSecretResponse = CreateWorkspaceWebhookResponse;
export type RotateWorkspaceWebhookSecretResponse = z.infer<
  typeof RotateWorkspaceWebhookSecretResponse
>;
export const RotateOrganizationWebhookSecretResponse = CreateOrganizationWebhookResponse;
export type RotateOrganizationWebhookSecretResponse = z.infer<
  typeof RotateOrganizationWebhookSecretResponse
>;
