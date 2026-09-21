import { UpdateOrganizationIntegrationPolicyRequest } from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  organizationIntegrationCatalog,
  requireAccessContext,
  requireCanonicalLocalAccountAdministrator,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getOrganizationIntegrationPolicy,
  updateOrganizationIntegrationPolicy,
} from "@opengeni/db/organization-integration-policy";
import { nestedPostgresSqlState } from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requireSameOriginBrowserMutation } from "./codex";
import { managedCookieHuman } from "./supergrok";

/** The database rechecks current organization membership/key authority at commit. */
async function authorizeAdministration(
  context: Context,
  deps: ApiRouteDeps,
  accountId: string,
  mutation: boolean,
): Promise<{ accountId: string; subjectId: string }> {
  const access = await requireAccessContext(context, deps);
  const service = accountScopedApiKeyWorkspaceAuthority(access);
  if (service) {
    if (service.accountId !== accountId || !service.permissions.includes("workspace:admin")) {
      throw new HTTPException(403, { message: "Organization administration required" });
    }
    return { accountId, subjectId: access.subjectId };
  }
  if (deps.settings.productAccessMode === "local") {
    const local = await requireCanonicalLocalAccountAdministrator(context, deps, accountId);
    if (mutation) requireSameOriginBrowserMutation(context, deps);
    return { accountId, subjectId: local.subjectId };
  }
  const human = await managedCookieHuman(context, deps);
  if (!human || human.subjectId !== access.subjectId) {
    throw new HTTPException(403, { message: "Organization administration required" });
  }
  if (mutation) requireSameOriginBrowserMutation(context, deps);
  return { accountId, subjectId: human.subjectId };
}

async function policyResponse<T>(readOrWrite: () => Promise<T>): Promise<T> {
  try {
    return await readOrWrite();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    const state = nestedPostgresSqlState(error);
    if (state === "42501") {
      throw new HTTPException(403, { message: "Organization administration required" });
    }
    if (state === "40001" || state === "23505") {
      throw new HTTPException(409, {
        message: "Integration policy changed; refresh before saving",
      });
    }
    if (state === "22023") {
      throw new HTTPException(422, { message: "Invalid integration policy" });
    }
    throw new HTTPException(503, { message: "Integration policy is temporarily unavailable" });
  }
}

export function registerOrganizationIntegrationPolicyRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/integration-policy";
  const organizationId = (context: Context) => {
    const parsed = z.string().uuid().safeParse(context.req.param("organizationId"));
    if (!parsed.success) throw new HTTPException(422, { message: "Invalid organization identity" });
    return parsed.data.toLowerCase();
  };
  app.get(`${path}/catalog`, async (context) => {
    const accountId = organizationId(context);
    // The same live administration check as policy reads, including workspace-free service access.
    await policyResponse(() =>
      getOrganizationIntegrationPolicy(deps.db, { accountId }, () =>
        authorizeAdministration(context, deps, accountId, false),
      ),
    );
    context.header("cache-control", "private, no-store");
    return context.json(organizationIntegrationCatalog());
  });
  app.get(path, async (context) => {
    context.header("cache-control", "private, no-store");
    const accountId = organizationId(context);
    return context.json(
      await policyResponse(() =>
        getOrganizationIntegrationPolicy(deps.db, { accountId }, () =>
          authorizeAdministration(context, deps, accountId, false),
        ),
      ),
    );
  });
  app.put(path, async (context) => {
    context.header("cache-control", "private, no-store");
    const accountId = organizationId(context);
    const parsed = UpdateOrganizationIntegrationPolicyRequest.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) throw new HTTPException(422, { message: "Invalid integration policy" });
    return context.json(
      await policyResponse(() =>
        updateOrganizationIntegrationPolicy(deps.db, { accountId }, parsed.data, () =>
          authorizeAdministration(context, deps, accountId, true),
        ),
      ),
    );
  });
}
