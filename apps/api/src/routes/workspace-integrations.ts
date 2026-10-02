import { randomBytes, randomUUID } from "node:crypto";
import { environmentsEncryptionKeyBytes, sandboxImageAllowlist } from "@opengeni/config";
import {
  CreateWorkspaceWebhookRequest,
  CreateWorkspaceWebhookResponse,
  GetWorkspaceCredentialProviderResponse,
  ListWorkspaceWebhookDeliveriesResponse,
  OPENGENI_EVENT_ID_HEADER,
  OPENGENI_TEST_REQUEST_NIL_ID,
  OPENGENI_WEBHOOK_TEST_EVENT_TYPE,
  TestWorkspaceCredentialProviderResponse,
  TestWorkspaceWebhookResponse,
  WorkspaceInheritedIntegrationsResponse,
  type CredentialProviderRequest,
  ListWorkspaceWebhooksResponse,
  PutWorkspaceCredentialProviderRequest,
  PutWorkspaceCredentialProviderResponse,
  RotateWorkspaceCredentialProviderSecretResponse,
  RotateWorkspaceWebhookSecretResponse,
  resolveWorkspaceDefaultSandboxImage,
  UpdateWorkspaceWebhookRequest,
  WorkspaceCredentialProvider,
  WorkspaceWebhook,
  WorkspaceWebhookDelivery,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireWorkspaceSettingsGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createWorkspaceWebhook,
  decryptEnvironmentValue,
  deleteWorkspaceCredentialProvider,
  deleteWorkspaceWebhook,
  encryptEnvironmentValue,
  getWorkspace,
  getOrganizationCredentialProvider,
  getWorkspaceCredentialProvider,
  getWorkspaceWebhook,
  integrationWorkspaceFilterMatches,
  listOrganizationWebhooks,
  listWorkspaceWebhookDeliveries,
  listWorkspaceWebhooks,
  redeliverWorkspaceWebhookDelivery,
  resolveInitiatingHuman,
  resolveWorkspaceCredentialProvider,
  rotateWorkspaceCredentialProviderSecret,
  rotateWorkspaceWebhookSecret,
  updateWorkspaceWebhook,
  upsertWorkspaceCredentialProvider,
  withCredentialProviderConfigurationLock,
  WorkspaceWebhookLimitError,
  type WorkspaceCredentialProviderRow,
  type WorkspaceWebhookDeliveryRow,
  type WorkspaceWebhookRow,
} from "@opengeni/db";
import { isLocalTestEnvironment, type pinnedFetch } from "@opengeni/network";
import { sendIntegrationEndpointTest } from "../integration-endpoint-test";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

export function newIntegrationSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function integrationWebhookFields(row: Omit<WorkspaceWebhookRow, "workspaceId">) {
  return {
    id: row.id,
    url: row.url,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function webhookProjection(row: WorkspaceWebhookRow): WorkspaceWebhook {
  return WorkspaceWebhook.parse({ ...integrationWebhookFields(row), workspaceId: row.workspaceId });
}

export function integrationDeliveryProjection(
  row: WorkspaceWebhookDeliveryRow,
): WorkspaceWebhookDelivery {
  return WorkspaceWebhookDelivery.parse({
    id: row.id,
    webhookId: row.webhookId,
    eventId: row.eventId,
    eventType: row.eventType,
    status: row.deliveredAt ? "delivered" : row.failedAt ? "failed" : "pending",
    attempts: row.attempts,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    nextAttemptAt: row.deliveredAt || row.failedAt ? null : iso(row.nextAttemptAt),
    deliveredAt: iso(row.deliveredAt),
    failedAt: iso(row.failedAt),
    createdAt: row.createdAt.toISOString(),
  });
}

export function integrationProviderFields(
  row: Omit<WorkspaceCredentialProviderRow, "workspaceId">,
) {
  return {
    url: row.url,
    enabled: row.enabled,
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function providerProjection(row: WorkspaceCredentialProviderRow): WorkspaceCredentialProvider {
  return WorkspaceCredentialProvider.parse({
    ...integrationProviderFields(row),
    workspaceId: row.workspaceId,
  });
}

export async function integrationBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  invalidStatus: 400 | 422 = 400,
): Promise<z.output<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(invalidStatus, {
      message: parsed.error.issues[0]?.message ?? "Invalid request",
    });
  }
  return parsed.data;
}

export function integrationRouteConfiguration(
  deps: ApiRouteDeps,
  scope: "workspace" | "organization",
) {
  return {
    requireKey(): Uint8Array {
      const key = environmentsEncryptionKeyBytes(deps.settings);
      if (!key) {
        throw new HTTPException(503, {
          message: `OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for ${scope} integrations`,
        });
      }
      return key;
    },
    requireDeployableUrl(url: string): void {
      if (!isLocalTestEnvironment(deps.settings.environment) && !url.startsWith("https://")) {
        throw new HTTPException(422, { message: "URL must use https" });
      }
    },
  };
}

export function isIntegrationAgent(
  grant: Pick<AccessGrant, "principalKind" | "metadata">,
): boolean {
  return (
    grant.principalKind === "agent_attempt" ||
    grant.metadata?.["turnId"] !== undefined ||
    grant.metadata?.["attemptId"] !== undefined
  );
}

/** A test request waits at most this long, whatever the provider's run timeout. */
const TEST_TIMEOUT_MS = 10_000;

export type WorkspaceIntegrationRouteOptions = {
  /** Tests inject a fetch; production uses the pinned outbound client. */
  fetch?: typeof pinnedFetch;
};

export function registerWorkspaceIntegrationRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: WorkspaceIntegrationRouteOptions = {},
): void {
  // Configuring where credentials come from or where events go is a human or
  // host decision; an agent may never redirect its own credential source.
  const requireIntegrationAdmin = async (c: Context, workspaceId: string): Promise<AccessGrant> => {
    const grant = await requireWorkspaceSettingsGrant(c, deps, workspaceId);
    if (isIntegrationAgent(grant)) {
      throw new HTTPException(403, {
        message: "Agent attempts cannot manage workspace integrations",
      });
    }
    return grant;
  };
  const { requireKey, requireDeployableUrl } = integrationRouteConfiguration(deps, "workspace");

  app.get("/v1/workspaces/:workspaceId/credential-provider", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const row = await getWorkspaceCredentialProvider(deps.db, {
      accountId: grant.accountId,
      workspaceId,
    });
    c.header("cache-control", "private, no-store");
    return c.json(
      GetWorkspaceCredentialProviderResponse.parse({
        provider: row ? providerProjection(row) : null,
      }),
    );
  });

  app.put("/v1/workspaces/:workspaceId/credential-provider", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const request = await integrationBody(c, PutWorkspaceCredentialProviderRequest);
    requireDeployableUrl(request.url);
    const scope = { accountId: grant.accountId, workspaceId };
    const {
      row: providerRow,
      secret: signingSecret,
      created,
    } = await withCredentialProviderConfigurationLock(deps.db, scope, async (tx) => {
      const existing = await getWorkspaceCredentialProvider(tx, scope);
      const secret = existing ? undefined : newIntegrationSecret("ogcp");
      const row = await upsertWorkspaceCredentialProvider(tx, {
        ...scope,
        url: request.url,
        enabled: request.enabled ?? true,
        timeoutMs: request.timeoutMs ?? 10_000,
        createdBySubjectId: grant.subjectId,
        ...(secret ? { secretEncrypted: encryptEnvironmentValue(requireKey(), secret) } : {}),
      });
      return { row, secret, created: !existing };
    });
    c.header("cache-control", "private, no-store");
    return c.json(
      PutWorkspaceCredentialProviderResponse.parse({
        provider: providerProjection(providerRow),
        ...(signingSecret ? { secret: signingSecret } : {}),
      }),
      created ? 201 : 200,
    );
  });

  app.delete("/v1/workspaces/:workspaceId/credential-provider", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    await deleteWorkspaceCredentialProvider(deps.db, { accountId: grant.accountId, workspaceId });
    return c.body(null, 204);
  });
  app.post("/v1/workspaces/:workspaceId/credential-provider/rotate-secret", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const secret = newIntegrationSecret("ogcp");
    const row = await rotateWorkspaceCredentialProviderSecret(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      secretEncrypted: encryptEnvironmentValue(requireKey(), secret),
    });
    if (!row) throw new HTTPException(404, { message: "Credential provider not found" });
    c.header("cache-control", "private, no-store");
    return c.json(
      RotateWorkspaceCredentialProviderSecretResponse.parse({
        provider: providerProjection(row),
        secret,
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/webhooks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const rows = await listWorkspaceWebhooks(deps.db, { accountId: grant.accountId, workspaceId });
    c.header("cache-control", "private, no-store");
    return c.json(ListWorkspaceWebhooksResponse.parse({ webhooks: rows.map(webhookProjection) }));
  });

  app.post("/v1/workspaces/:workspaceId/webhooks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const request = await integrationBody(c, CreateWorkspaceWebhookRequest);
    requireDeployableUrl(request.url);
    const secret = newIntegrationSecret("whsec");
    try {
      const row = await createWorkspaceWebhook(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        url: request.url,
        secretEncrypted: encryptEnvironmentValue(requireKey(), secret),
        eventTypes: request.eventTypes,
        enabled: request.enabled ?? true,
        description: request.description ?? null,
        createdBySubjectId: grant.subjectId,
      });
      c.header("cache-control", "private, no-store");
      return c.json(
        CreateWorkspaceWebhookResponse.parse({ webhook: webhookProjection(row), secret }),
        201,
      );
    } catch (error) {
      if (error instanceof WorkspaceWebhookLimitError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/workspaces/:workspaceId/webhooks/:webhookId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const webhookId = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!webhookId.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const row = await getWorkspaceWebhook(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      webhookId: webhookId.data,
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    c.header("cache-control", "private, no-store");
    return c.json(webhookProjection(row));
  });

  app.patch("/v1/workspaces/:workspaceId/webhooks/:webhookId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const webhookId = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!webhookId.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const request = await integrationBody(c, UpdateWorkspaceWebhookRequest);
    if (request.url) requireDeployableUrl(request.url);
    const row = await updateWorkspaceWebhook(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      webhookId: webhookId.data,
      ...(request.url !== undefined ? { url: request.url } : {}),
      ...(request.eventTypes !== undefined ? { eventTypes: request.eventTypes } : {}),
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    return c.json(webhookProjection(row));
  });

  app.delete("/v1/workspaces/:workspaceId/webhooks/:webhookId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const webhookId = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!webhookId.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const deleted = await deleteWorkspaceWebhook(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      webhookId: webhookId.data,
    });
    if (!deleted) throw new HTTPException(404, { message: "Webhook not found" });
    return c.body(null, 204);
  });
  app.post("/v1/workspaces/:workspaceId/webhooks/:webhookId/rotate-secret", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const id = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!id.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const secret = newIntegrationSecret("whsec");
    const row = await rotateWorkspaceWebhookSecret(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      webhookId: id.data,
      secretEncrypted: encryptEnvironmentValue(requireKey(), secret),
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    c.header("cache-control", "private, no-store");
    return c.json(
      RotateWorkspaceWebhookSecretResponse.parse({
        webhook: webhookProjection(row),
        secret,
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/webhooks/:webhookId/deliveries", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const webhookId = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!webhookId.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const scope = { accountId: grant.accountId, workspaceId, webhookId: webhookId.data };
    if (!(await getWorkspaceWebhook(deps.db, scope))) {
      throw new HTTPException(404, { message: "Webhook not found" });
    }
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(c.req.query("limit"));
    const rows = await listWorkspaceWebhookDeliveries(deps.db, { ...scope, limit });
    c.header("cache-control", "private, no-store");
    return c.json(
      ListWorkspaceWebhookDeliveriesResponse.parse({
        deliveries: rows.map(integrationDeliveryProjection),
      }),
    );
  });

  app.post(
    "/v1/workspaces/:workspaceId/webhooks/:webhookId/deliveries/:deliveryId/redeliver",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const ids = z
        .object({ webhookId: z.string().uuid(), deliveryId: z.string().uuid() })
        .safeParse({ webhookId: c.req.param("webhookId"), deliveryId: c.req.param("deliveryId") });
      if (!ids.success) throw new HTTPException(404, { message: "Delivery not found" });
      const grant = await requireIntegrationAdmin(c, workspaceId);
      const row = await redeliverWorkspaceWebhookDelivery(deps.db, {
        accountId: grant.accountId,
        workspaceId,
        ...ids.data,
      });
      if (!row) {
        throw new HTTPException(409, {
          message: "Only a delivered or failed delivery can be redelivered",
        });
      }
      return c.json(integrationDeliveryProjection(row));
    },
  );

  // Organization registrations that reach this workspace, so its administrators
  // can see where its events go and which credential provider runs inherit.
  app.get("/v1/workspaces/:workspaceId/inherited-integrations", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const workspace = await getWorkspace(deps.db, workspaceId);
    c.header("cache-control", "private, no-store");
    // Organization registrations never cover a Personal workspace.
    if (!workspace || workspace.accountId !== grant.accountId || workspace.kind !== "shared") {
      return c.json(
        WorkspaceInheritedIntegrationsResponse.parse({ credentialProvider: null, webhooks: [] }),
      );
    }
    // Matched like the runtime resolver, but shown even while this workspace
    // overrides it, so the page can say what its own provider replaces.
    const organizationProvider = await getOrganizationCredentialProvider(deps.db, {
      accountId: grant.accountId,
    });
    const inheritedProvider =
      organizationProvider?.enabled &&
      integrationWorkspaceFilterMatches(organizationProvider.workspaceFilter, workspace)
        ? organizationProvider
        : null;
    const organizationWebhooks = await listOrganizationWebhooks(deps.db, {
      accountId: grant.accountId,
    });
    return c.json(
      WorkspaceInheritedIntegrationsResponse.parse({
        credentialProvider: inheritedProvider
          ? {
              url: inheritedProvider.url,
              timeoutMs: inheritedProvider.timeoutMs,
              updatedAt: inheritedProvider.updatedAt.toISOString(),
            }
          : null,
        webhooks: organizationWebhooks
          .filter(
            (webhook) =>
              webhook.enabled &&
              integrationWorkspaceFilterMatches(webhook.workspaceFilter, workspace),
          )
          .map((webhook) => ({
            id: webhook.id,
            url: webhook.url,
            eventTypes: webhook.eventTypes,
            description: webhook.description,
          })),
      }),
    );
  });

  // "Send test event": one signed `webhook.test` POST, sent now, never queued.
  app.post("/v1/workspaces/:workspaceId/webhooks/:webhookId/test", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const webhookId = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!webhookId.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const row = await getWorkspaceWebhook(deps.db, {
      accountId: grant.accountId,
      workspaceId,
      webhookId: webhookId.data,
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    const workspace = await getWorkspace(deps.db, workspaceId);
    const eventId = randomUUID();
    const body = JSON.stringify({
      id: eventId,
      type: OPENGENI_WEBHOOK_TEST_EVENT_TYPE,
      lane: "workspace",
      workspaceId,
      workspace: {
        id: workspaceId,
        externalSource: workspace?.externalSource ?? null,
        externalId: workspace?.externalId ?? null,
      },
      sessionId: null,
      turnId: null,
      occurredAt: new Date().toISOString(),
      data: { webhookId: row.id },
    });
    const result = await sendIntegrationEndpointTest({
      kind: "webhook",
      url: row.url,
      secret: decryptEnvironmentValue(requireKey(), row.secretEncrypted),
      body,
      headers: { [OPENGENI_EVENT_ID_HEADER]: eventId },
      timeoutMs: TEST_TIMEOUT_MS,
      settings: deps.settings,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    c.header("cache-control", "private, no-store");
    return c.json(TestWorkspaceWebhookResponse.parse({ result }));
  });

  // "Test connection": a signed `purpose: "test"` request to the provider this
  // workspace's runs use. A paused workspace provider is still tested, so it
  // can be checked before it is turned back on.
  app.post("/v1/workspaces/:workspaceId/credential-provider/test", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const scope = { accountId: grant.accountId, workspaceId };
    const own = await getWorkspaceCredentialProvider(deps.db, scope);
    const provider = own ?? (await resolveWorkspaceCredentialProvider(deps.db, scope));
    if (!provider) throw new HTTPException(404, { message: "Credential provider not found" });
    const lane = "workspaceId" in provider ? ("workspace" as const) : ("organization" as const);
    const initiatingHuman = await resolveInitiatingHuman(deps.db, scope, grant.subjectId);
    const initiator = { kind: "subject" as const, subjectId: grant.subjectId };
    const request: CredentialProviderRequest = {
      type: "credentials.request",
      lane,
      mcpServers: [],
      purpose: "test",
      forceRefresh: true,
      accountId: grant.accountId,
      workspaceId,
      sessionId: OPENGENI_TEST_REQUEST_NIL_ID,
      rootSessionId: OPENGENI_TEST_REQUEST_NIL_ID,
      parentSessionId: null,
      turnId: OPENGENI_TEST_REQUEST_NIL_ID,
      attemptId: OPENGENI_TEST_REQUEST_NIL_ID,
      initiator,
      initiatorContext: { kind: "human", initiator, context: {} },
      initiatingHumanSubjectId: grant.subjectId,
      initiatingHuman,
      sandboxBackend: deps.settings.sandboxBackend,
      sandboxOs: "linux",
    };
    const result = await sendIntegrationEndpointTest({
      kind: "credential-provider",
      url: provider.url,
      secret: decryptEnvironmentValue(requireKey(), provider.secretEncrypted),
      body: JSON.stringify(request),
      timeoutMs: Math.min(provider.timeoutMs, TEST_TIMEOUT_MS),
      settings: deps.settings,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    c.header("cache-control", "private, no-store");
    return c.json(
      TestWorkspaceCredentialProviderResponse.parse({ lane, url: provider.url, result }),
    );
  });

  // The images a workspace may choose as its default sandbox image.
  app.get("/v1/workspaces/:workspaceId/sandbox-images", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "workspace:read");
    const workspace = await getWorkspace(deps.db, workspaceId);
    const images = sandboxImageAllowlist(deps.settings);
    const selected = resolveWorkspaceDefaultSandboxImage(workspace?.settings);
    return c.json({
      images,
      selected: selected && images.includes(selected) ? selected : null,
    });
  });
}
