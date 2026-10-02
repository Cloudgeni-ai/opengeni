import {
  CreateOrganizationWebhookRequest,
  CreateOrganizationWebhookResponse,
  GetOrganizationCredentialProviderResponse,
  ListOrganizationWebhookDeliveriesResponse,
  ListOrganizationWebhooksResponse,
  OrganizationCredentialProvider,
  OrganizationWebhook,
  PutOrganizationCredentialProviderRequest,
  PutOrganizationCredentialProviderResponse,
  RotateOrganizationCredentialProviderSecretResponse,
  RotateOrganizationWebhookSecretResponse,
  UpdateOrganizationWebhookRequest,
  type AccessContext,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  accessGrantAuthorizationFromContext,
  requireAccountAdminAuthorizationStamp,
  requireAccessContext,
  requireCanonicalLocalAccountAdministrator,
  isVerifiedDelegatedHumanAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createOrganizationWebhook,
  deleteOrganizationCredentialProvider,
  deleteOrganizationWebhook,
  encryptEnvironmentValue,
  getOrganizationCredentialProvider,
  getOrganizationWebhook,
  listOrganizationWebhookDeliveries,
  listOrganizationWebhooks,
  OrganizationWebhookLimitError,
  redeliverOrganizationWebhookDelivery,
  rotateOrganizationCredentialProviderSecret,
  rotateOrganizationWebhookSecret,
  updateOrganizationWebhook,
  upsertOrganizationCredentialProvider,
  withCredentialProviderConfigurationLock,
  type OrganizationCredentialProviderRow,
  type OrganizationWebhookRow,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { organizationApiKeyAccess, requireOrganizationApiKeyControlPermission } from "./api-keys";
import { requireNonCookieOrSameOriginMutation } from "./codex";
import {
  integrationBody as body,
  integrationDeliveryProjection as deliveryProjection,
  integrationProviderFields,
  integrationRouteConfiguration,
  integrationWebhookFields,
  isIntegrationAgent,
  newIntegrationSecret,
} from "./workspace-integrations";

/** Account administrators or verified full-access organization keys; never workspace keys. */
export function requireOrganizationIntegrationAdmin(
  context: AccessContext,
  organizationId: string,
  authorization?: AccessGrantAuthorization,
): string {
  if (context.workspaceGrants.some(isIntegrationAgent)) {
    throw new HTTPException(403, {
      message: "Agent attempts cannot manage organization integrations",
    });
  }
  const grant = context.accountGrants.find(
    (candidate) =>
      candidate.accountId === organizationId && candidate.subjectId === context.subjectId,
  );
  if (!grant) {
    throw new HTTPException(403, { message: "missing permission: account:admin" });
  }
  if (context.subjectId.startsWith("api_key:")) {
    requireOrganizationApiKeyControlPermission(context, organizationId);
    const authority = accountScopedApiKeyWorkspaceAuthority(context);
    if (
      !authority ||
      authority.accountId !== organizationId ||
      organizationApiKeyAccess(authority.permissions) !== "full"
    ) {
      throw new HTTPException(403, { message: "organization API key authority required" });
    }
  } else {
    if (!grant.permissions.includes("account:admin"))
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    if (
      !authorization ||
      !(
        authorization.canonicalManagedHumanSession ||
        authorization.canonicalLocalHumanSession ||
        isVerifiedDelegatedHumanAuthorization(authorization)
      ) ||
      authorization.grant.accountId !== organizationId ||
      authorization.authenticatedSubjectId !== context.subjectId ||
      (context.workspaceGrants.some((candidate) => candidate.metadata?.delegated === true) &&
        !isVerifiedDelegatedHumanAuthorization(authorization))
    ) {
      throw new HTTPException(403, { message: "Canonical organization administrator required" });
    }
    requireAccountAdminAuthorizationStamp(authorization);
  }
  return grant.subjectId;
}

function providerProjection(
  row: OrganizationCredentialProviderRow,
): OrganizationCredentialProvider {
  return OrganizationCredentialProvider.parse({
    ...integrationProviderFields(row),
    organizationId: row.accountId,
    workspaceFilter: row.workspaceFilter,
  });
}
function webhookProjection(row: OrganizationWebhookRow): OrganizationWebhook {
  return OrganizationWebhook.parse({
    ...integrationWebhookFields(row),
    organizationId: row.accountId,
    workspaceFilter: row.workspaceFilter,
  });
}

export function registerOrganizationIntegrationRoutes(app: Hono, deps: ApiRouteDeps): void {
  const scope = async (c: Context) => {
    const id = z.string().uuid().safeParse(c.req.param("organizationId"));
    if (!id.success) throw new HTTPException(422, { message: "invalid organization id" });
    const context = await requireAccessContext(c, deps);
    const accountId = id.data.toLowerCase();
    let authorization: AccessGrantAuthorization | undefined;
    if (!accountScopedApiKeyWorkspaceAuthority(context)) {
      if (deps.settings.productAccessMode === "local") {
        authorization = (await requireCanonicalLocalAccountAdministrator(c, deps, accountId))
          .authorization;
      } else {
        const grant = context.workspaceGrants.find(
          (candidate) => candidate.accountId === accountId,
        );
        if (grant) authorization = accessGrantAuthorizationFromContext(context, grant);
      }
    }
    const subjectId = requireOrganizationIntegrationAdmin(context, accountId, authorization);
    if (!accountScopedApiKeyWorkspaceAuthority(context) && !["GET", "HEAD"].includes(c.req.method))
      await requireNonCookieOrSameOriginMutation(c, deps);
    c.header("cache-control", "private, no-store");
    return { accountId, subjectId };
  };
  const { requireKey, requireDeployableUrl: requireUrl } = integrationRouteConfiguration(
    deps,
    "organization",
  );
  const encrypted = (secret: string): string => encryptEnvironmentValue(requireKey(), secret);
  const webhookId = (c: Context): string => {
    const id = z.string().uuid().safeParse(c.req.param("webhookId"));
    if (!id.success) throw new HTTPException(404, { message: "Webhook not found" });
    return id.data;
  };
  const base = "/v1/organizations/:organizationId";
  app.get(`${base}/credential-provider`, async (c) => {
    const target = await scope(c);
    const row = await getOrganizationCredentialProvider(deps.db, target);
    return c.json(
      GetOrganizationCredentialProviderResponse.parse({
        provider: row ? providerProjection(row) : null,
      }),
    );
  });
  app.put(`${base}/credential-provider`, async (c) => {
    const target = await scope(c);
    const request = await body(c, PutOrganizationCredentialProviderRequest, 422);
    requireUrl(request.url);
    const {
      row: providerRow,
      secret: signingSecret,
      created,
    } = await withCredentialProviderConfigurationLock(deps.db, target, async (tx) => {
      const existing = await getOrganizationCredentialProvider(tx, target);
      const secret = existing ? undefined : newIntegrationSecret("ogcp");
      const row = await upsertOrganizationCredentialProvider(tx, {
        accountId: target.accountId,
        url: request.url,
        enabled: request.enabled ?? true,
        timeoutMs: request.timeoutMs ?? 10_000,
        workspaceFilter: request.workspaceFilter,
        createdBySubjectId: target.subjectId,
        ...(secret ? { secretEncrypted: encrypted(secret) } : {}),
      });
      return { row, secret, created: !existing };
    });
    return c.json(
      PutOrganizationCredentialProviderResponse.parse({
        provider: providerProjection(providerRow),
        ...(signingSecret ? { secret: signingSecret } : {}),
      }),
      created ? 201 : 200,
    );
  });
  app.delete(`${base}/credential-provider`, async (c) => {
    await deleteOrganizationCredentialProvider(deps.db, await scope(c));
    return c.body(null, 204);
  });
  app.post(`${base}/credential-provider/rotate-secret`, async (c) => {
    const target = await scope(c);
    const secret = newIntegrationSecret("ogcp");
    const row = await rotateOrganizationCredentialProviderSecret(deps.db, {
      ...target,
      secretEncrypted: encrypted(secret),
    });
    if (!row) throw new HTTPException(404, { message: "Credential provider not found" });
    return c.json(
      RotateOrganizationCredentialProviderSecretResponse.parse({
        provider: providerProjection(row),
        secret,
      }),
    );
  });
  app.get(`${base}/webhooks`, async (c) => {
    const rows = await listOrganizationWebhooks(deps.db, await scope(c));
    return c.json(
      ListOrganizationWebhooksResponse.parse({ webhooks: rows.map(webhookProjection) }),
    );
  });
  app.post(`${base}/webhooks`, async (c) => {
    const target = await scope(c);
    const request = await body(c, CreateOrganizationWebhookRequest, 422);
    requireUrl(request.url);
    const secret = newIntegrationSecret("whsec");
    try {
      const row = await createOrganizationWebhook(deps.db, {
        accountId: target.accountId,
        url: request.url,
        secretEncrypted: encrypted(secret),
        eventTypes: request.eventTypes,
        enabled: request.enabled ?? true,
        description: request.description ?? null,
        workspaceFilter: request.workspaceFilter,
        createdBySubjectId: target.subjectId,
      });
      return c.json(
        CreateOrganizationWebhookResponse.parse({ webhook: webhookProjection(row), secret }),
        201,
      );
    } catch (error) {
      if (error instanceof OrganizationWebhookLimitError)
        throw new HTTPException(409, { message: error.message });
      throw error;
    }
  });
  app.get(`${base}/webhooks/:webhookId`, async (c) => {
    const target = await scope(c);
    const row = await getOrganizationWebhook(deps.db, {
      accountId: target.accountId,
      webhookId: webhookId(c),
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    return c.json(webhookProjection(row));
  });
  app.patch(`${base}/webhooks/:webhookId`, async (c) => {
    const target = await scope(c);
    const request = await body(c, UpdateOrganizationWebhookRequest, 422);
    if (request.url) requireUrl(request.url);
    const row = await updateOrganizationWebhook(deps.db, {
      accountId: target.accountId,
      webhookId: webhookId(c),
      ...(request.url !== undefined ? { url: request.url } : {}),
      ...(request.eventTypes !== undefined ? { eventTypes: request.eventTypes } : {}),
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.description !== undefined ? { description: request.description } : {}),
      ...(request.workspaceFilter !== undefined
        ? { workspaceFilter: request.workspaceFilter }
        : {}),
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    return c.json(webhookProjection(row));
  });
  app.delete(`${base}/webhooks/:webhookId`, async (c) => {
    const target = await scope(c);
    if (!(await deleteOrganizationWebhook(deps.db, { ...target, webhookId: webhookId(c) }))) {
      throw new HTTPException(404, { message: "Webhook not found" });
    }
    return c.body(null, 204);
  });
  app.post(`${base}/webhooks/:webhookId/rotate-secret`, async (c) => {
    const target = await scope(c);
    const secret = newIntegrationSecret("whsec");
    const row = await rotateOrganizationWebhookSecret(deps.db, {
      ...target,
      webhookId: webhookId(c),
      secretEncrypted: encrypted(secret),
    });
    if (!row) throw new HTTPException(404, { message: "Webhook not found" });
    return c.json(
      RotateOrganizationWebhookSecretResponse.parse({
        webhook: webhookProjection(row),
        secret,
      }),
    );
  });
  app.get(`${base}/webhooks/:webhookId/deliveries`, async (c) => {
    const target = { ...(await scope(c)), webhookId: webhookId(c) };
    if (!(await getOrganizationWebhook(deps.db, target)))
      throw new HTTPException(404, { message: "Webhook not found" });
    const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(c.req.query("limit"));
    const rows = await listOrganizationWebhookDeliveries(deps.db, { ...target, limit });
    return c.json(
      ListOrganizationWebhookDeliveriesResponse.parse({ deliveries: rows.map(deliveryProjection) }),
    );
  });
  app.post(`${base}/webhooks/:webhookId/deliveries/:deliveryId/redeliver`, async (c) => {
    const target = await scope(c);
    const id = z.string().uuid().safeParse(c.req.param("deliveryId"));
    if (!id.success) throw new HTTPException(404, { message: "Delivery not found" });
    const row = await redeliverOrganizationWebhookDelivery(deps.db, {
      ...target,
      webhookId: webhookId(c),
      deliveryId: id.data,
    });
    if (!row)
      throw new HTTPException(409, {
        message: "Only a delivered or failed delivery can be redelivered",
      });
    return c.json(deliveryProjection(row));
  });
}
