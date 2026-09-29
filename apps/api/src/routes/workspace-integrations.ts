import { randomBytes } from "node:crypto";
import { environmentsEncryptionKeyBytes, sandboxImageAllowlist } from "@opengeni/config";
import {
  CreateWorkspaceWebhookRequest,
  CreateWorkspaceWebhookResponse,
  GetWorkspaceCredentialProviderResponse,
  ListWorkspaceWebhookDeliveriesResponse,
  ListWorkspaceWebhooksResponse,
  PutWorkspaceCredentialProviderRequest,
  PutWorkspaceCredentialProviderResponse,
  resolveWorkspaceDefaultSandboxImage,
  UpdateWorkspaceWebhookRequest,
  WorkspaceCredentialProvider,
  WorkspaceWebhook,
  WorkspaceWebhookDelivery,
  type AccessGrant,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  createWorkspaceWebhook,
  deleteWorkspaceCredentialProvider,
  deleteWorkspaceWebhook,
  encryptEnvironmentValue,
  getWorkspace,
  getWorkspaceCredentialProvider,
  getWorkspaceWebhook,
  listWorkspaceWebhookDeliveries,
  listWorkspaceWebhooks,
  redeliverWorkspaceWebhookDelivery,
  updateWorkspaceWebhook,
  upsertWorkspaceCredentialProvider,
  WorkspaceWebhookLimitError,
  type WorkspaceCredentialProviderRow,
  type WorkspaceWebhookDeliveryRow,
  type WorkspaceWebhookRow,
} from "@opengeni/db";
import { isLocalTestEnvironment } from "@opengeni/network";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function webhookProjection(row: WorkspaceWebhookRow): WorkspaceWebhook {
  return WorkspaceWebhook.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    url: row.url,
    eventTypes: row.eventTypes,
    enabled: row.enabled,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function deliveryProjection(row: WorkspaceWebhookDeliveryRow): WorkspaceWebhookDelivery {
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

function providerProjection(row: WorkspaceCredentialProviderRow): WorkspaceCredentialProvider {
  return WorkspaceCredentialProvider.parse({
    workspaceId: row.workspaceId,
    url: row.url,
    enabled: row.enabled,
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.output<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(400, { message: parsed.error.issues[0]?.message ?? "Invalid request" });
  }
  return parsed.data;
}

export function registerWorkspaceIntegrationRoutes(app: Hono, deps: ApiRouteDeps): void {
  // Configuring where credentials come from or where events go is a human or
  // host decision; an agent may never redirect its own credential source.
  const requireIntegrationAdmin = async (c: Context, workspaceId: string): Promise<AccessGrant> => {
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    if (
      grant.principalKind === "agent_attempt" ||
      grant.metadata?.["turnId"] !== undefined ||
      grant.metadata?.["attemptId"] !== undefined
    ) {
      throw new HTTPException(403, {
        message: "Agent attempts cannot manage workspace integrations",
      });
    }
    return grant;
  };
  const requireKey = (): Uint8Array => {
    const key = environmentsEncryptionKeyBytes(deps.settings);
    if (!key) {
      throw new HTTPException(503, {
        message: "OPENGENI_ENVIRONMENTS_ENCRYPTION_KEY is required for workspace integrations",
      });
    }
    return key;
  };
  const requireDeployableUrl = (url: string): void => {
    if (!isLocalTestEnvironment(deps.settings.environment) && !url.startsWith("https://")) {
      throw new HTTPException(422, { message: "URL must use https" });
    }
  };

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
    const request = await body(c, PutWorkspaceCredentialProviderRequest);
    requireDeployableUrl(request.url);
    const scope = { accountId: grant.accountId, workspaceId };
    const existing = await getWorkspaceCredentialProvider(deps.db, scope);
    const secret = existing ? undefined : newSecret("ogcp");
    const row = await upsertWorkspaceCredentialProvider(deps.db, {
      ...scope,
      url: request.url,
      enabled: request.enabled ?? existing?.enabled ?? true,
      timeoutMs: request.timeoutMs ?? existing?.timeoutMs ?? 10_000,
      createdBySubjectId: grant.subjectId,
      ...(secret ? { secretEncrypted: encryptEnvironmentValue(requireKey(), secret) } : {}),
    });
    c.header("cache-control", "private, no-store");
    return c.json(
      PutWorkspaceCredentialProviderResponse.parse({
        provider: providerProjection(row),
        ...(secret ? { secret } : {}),
      }),
      existing ? 200 : 201,
    );
  });

  app.delete("/v1/workspaces/:workspaceId/credential-provider", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireIntegrationAdmin(c, workspaceId);
    await deleteWorkspaceCredentialProvider(deps.db, { accountId: grant.accountId, workspaceId });
    return c.body(null, 204);
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
    const request = await body(c, CreateWorkspaceWebhookRequest);
    requireDeployableUrl(request.url);
    const secret = newSecret("whsec");
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

  app.patch("/v1/workspaces/:workspaceId/webhooks/:webhookId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const webhookId = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!webhookId.success) throw new HTTPException(404, { message: "Webhook not found" });
    const grant = await requireIntegrationAdmin(c, workspaceId);
    const request = await body(c, UpdateWorkspaceWebhookRequest);
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
      ListWorkspaceWebhookDeliveriesResponse.parse({ deliveries: rows.map(deliveryProjection) }),
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
      return c.json(deliveryProjection(row));
    },
  );

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
