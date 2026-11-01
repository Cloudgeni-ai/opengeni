import {
  CreateOrganizationConnectorRequest,
  ListOrganizationConnectorsResponse,
  OrganizationConnector,
  UpdateOrganizationConnectorRequest,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  createOrganizationConnector,
  listOrganizationConnectorsForAdministration,
  removeOrganizationConnector,
  requireAccessContext,
  updateOrganizationConnectorSettings,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  nestedPostgresSqlState,
  OrganizationConnectorWorkspaceNotInOrganizationError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestBody } from "../http/request-body";
import { authorizeOrganizationIntegrationAdministration } from "./organization-integration-policy";

/**
 * Organization connectors (docs/design/ownership-and-reach.md, OR-11): an
 * organization owner or admin adds an MCP connector once and chooses which
 * workspaces it reaches. Signed-in owners and admins, and agents acting for
 * one, manage them; organization API keys don't (the database checks a
 * person's live organization role on every change).
 */
async function authorizeConnectorAdministration(
  context: Context,
  deps: ApiRouteDeps,
  accountId: string,
  mutation: boolean,
): Promise<{ accountId: string; subjectId: string }> {
  if (accountScopedApiKeyWorkspaceAuthority(await requireAccessContext(context, deps)))
    throw new HTTPException(403, {
      message: "Organization connectors are managed by organization owners and admins",
    });
  return await authorizeOrganizationIntegrationAdministration(context, deps, accountId, mutation);
}

/**
 * Integration-policy and EU-only refusals keep the app's central mapping
 * (403, and 403 region_restricted), as for a workspace's own MCP setup.
 */
async function connectorResponse<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    if (error instanceof OrganizationConnectorWorkspaceNotInOrganizationError)
      throw new HTTPException(422, { message: error.message });
    const state = nestedPostgresSqlState(error);
    if (state === "42501")
      throw new HTTPException(403, { message: "Organization administration required" });
    if (state === "23505")
      throw new HTTPException(409, {
        message: "Your organization already has this connector; change that one instead",
      });
    if (state === "40001")
      throw new HTTPException(409, {
        message: "This connector changed since it was loaded; reload before saving",
      });
    throw error;
  }
}

export function registerOrganizationConnectorRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/connectors";
  const organizationId = (context: Context) => {
    const parsed = z.string().uuid().safeParse(context.req.param("organizationId"));
    if (!parsed.success) throw new HTTPException(422, { message: "Invalid organization identity" });
    return parsed.data.toLowerCase();
  };
  const connectorId = (context: Context) => {
    const parsed = z.string().uuid().safeParse(context.req.param("connectorId"));
    if (!parsed.success)
      throw new HTTPException(404, { message: "Organization connector not found" });
    return parsed.data.toLowerCase();
  };
  // One authorization per request: the database repeats the role check in
  // every transaction, so the callback only returns the resolved person.
  const administration = async (context: Context, mutation: boolean) => {
    const accountId = organizationId(context);
    const actor = await authorizeConnectorAdministration(context, deps, accountId, mutation);
    return {
      db: deps.db,
      settings: deps.settings,
      accountId,
      authorize: async () => actor,
    };
  };

  app.get(path, async (context) => {
    context.header("cache-control", "private, no-store");
    const input = await administration(context, false);
    const connectors = await connectorResponse(() =>
      listOrganizationConnectorsForAdministration(input),
    );
    return context.json(ListOrganizationConnectorsResponse.parse({ connectors }));
  });

  app.post(path, async (context) => {
    context.header("cache-control", "private, no-store");
    const input = await administration(context, true);
    const payload = parseRequestBody(
      CreateOrganizationConnectorRequest,
      await context.req.json().catch(() => null),
      { status: 422, message: "Invalid organization connector" },
    );
    const connector = await connectorResponse(() =>
      createOrganizationConnector({ ...input, payload }),
    );
    return context.json(OrganizationConnector.parse(connector), 201);
  });

  app.patch(`${path}/:connectorId`, async (context) => {
    context.header("cache-control", "private, no-store");
    const input = await administration(context, true);
    const id = connectorId(context);
    const payload = parseRequestBody(
      UpdateOrganizationConnectorRequest,
      await context.req.json().catch(() => null),
      { status: 422, message: "Invalid organization connector change" },
    );
    const connector = await connectorResponse(() =>
      updateOrganizationConnectorSettings({ ...input, connectorId: id, payload }),
    );
    return context.json(OrganizationConnector.parse(connector));
  });

  app.delete(`${path}/:connectorId`, async (context) => {
    context.header("cache-control", "private, no-store");
    const input = await administration(context, true);
    const id = connectorId(context);
    await connectorResponse(() => removeOrganizationConnector({ ...input, connectorId: id }));
    return context.body(null, 204);
  });
}
