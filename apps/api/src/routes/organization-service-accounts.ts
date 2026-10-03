import { zValidator } from "@hono/zod-validator";
import {
  CreateOrganizationServiceAccountRequest,
  ListOrganizationServiceAccountsResponse,
  OrganizationServiceAccount,
  UpdateOrganizationServiceAccountRequest,
  type AccessContext,
} from "@opengeni/contracts";
import { requireAccessContext, type ApiRouteDeps } from "@opengeni/core";
import {
  createOrganizationServiceAccount,
  deleteOrganizationServiceAccount,
  getOrganizationServiceAccount,
  listOrganizationServiceAccounts,
  updateOrganizationServiceAccount,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { requireOrganizationApiKeyControlPermission, throwServiceAccountError } from "./api-keys";

/* ----------------------------------------------------------------------------
   Service accounts: organization identities with no person behind them. They
   hold organization API keys. Whoever may manage the organization's keys may
   manage service accounts; only an organization administrator can make one an
   admin. Deleting one revokes its keys at once.
   -------------------------------------------------------------------------- */

const Id = z.string().uuid();

export function registerOrganizationServiceAccountRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/service-accounts";

  app.get(path, async (c) => {
    const { organizationId } = await requireControl(c, deps);
    c.header("cache-control", "no-store");
    return c.json(
      ListOrganizationServiceAccountsResponse.parse({
        serviceAccounts: await listOrganizationServiceAccounts(deps.db, organizationId),
      }),
    );
  });

  app.post(path, zValidator("json", CreateOrganizationServiceAccountRequest), async (c) => {
    const { organizationId, context } = await requireControl(c, deps);
    const body = c.req.valid("json");
    if (body.role === "admin") requireOrganizationAdmin(context, organizationId);
    const created = await createOrganizationServiceAccount(deps.db, {
      accountId: organizationId,
      name: body.name,
      description: body.description ?? null,
      role: body.role,
      createdBySubjectId: context.subjectId,
    });
    return c.json(OrganizationServiceAccount.parse(created), 201);
  });

  app.get(`${path}/:serviceAccountId`, async (c) => {
    const { organizationId } = await requireControl(c, deps);
    const found = await getOrganizationServiceAccount(deps.db, organizationId, serviceAccountId(c));
    if (!found) throw new HTTPException(404, { message: "Service account not found" });
    return c.json(OrganizationServiceAccount.parse(found));
  });

  app.patch(
    `${path}/:serviceAccountId`,
    zValidator("json", UpdateOrganizationServiceAccountRequest),
    async (c) => {
      const { organizationId, context } = await requireControl(c, deps);
      const body = c.req.valid("json");
      if (body.role === "admin") requireOrganizationAdmin(context, organizationId);
      try {
        return c.json(
          OrganizationServiceAccount.parse(
            await updateOrganizationServiceAccount(
              deps.db,
              organizationId,
              serviceAccountId(c),
              body,
            ),
          ),
        );
      } catch (error) {
        throwServiceAccountError(error);
        throw error;
      }
    },
  );

  app.delete(`${path}/:serviceAccountId`, async (c) => {
    const { organizationId } = await requireControl(c, deps);
    try {
      await deleteOrganizationServiceAccount(deps.db, organizationId, serviceAccountId(c));
    } catch (error) {
      throwServiceAccountError(error);
      throw error;
    }
    return c.body(null, 204);
  });
}

async function requireControl(
  c: Context,
  deps: ApiRouteDeps,
): Promise<{ organizationId: string; context: AccessContext }> {
  const parsed = Id.safeParse(c.req.param("organizationId"));
  if (!parsed.success) throw new HTTPException(404, { message: "organization not found" });
  const organizationId = parsed.data.toLowerCase();
  const context = await requireAccessContext(c, deps);
  requireOrganizationApiKeyControlPermission(context, organizationId);
  return { organizationId, context };
}

function serviceAccountId(c: Context): string {
  const parsed = Id.safeParse(c.req.param("serviceAccountId"));
  if (!parsed.success) throw new HTTPException(404, { message: "Service account not found" });
  return parsed.data.toLowerCase();
}

/** Only an organization administrator can make a service account an admin. */
function requireOrganizationAdmin(context: AccessContext, organizationId: string): void {
  const grant = context.accountGrants.find((candidate) => candidate.accountId === organizationId);
  if (!grant?.permissions.includes("account:admin"))
    throw new HTTPException(403, {
      message: "Only an organization administrator can make a service account an admin.",
    });
}
