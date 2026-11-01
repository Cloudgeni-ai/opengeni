import {
  createPinnedIntegrationTransport,
  type IntegrationCredentialResolver,
} from "@opengeni/capabilities";
import {
  ApiIntegrationPreview,
  CreateOrganizationConnectorRequest,
  ListOrganizationConnectorsResponse,
  OrganizationConnector,
  PreviewOrganizationApiIntegrationRequest,
  UpdateOrganizationConnectorRequest,
  type OrganizationApiKeyPlacement,
} from "@opengeni/contracts";
import {
  accountScopedApiKeyWorkspaceAuthority,
  createOrganizationConnector,
  listOrganizationConnectorsForAdministration,
  previewOrganizationApiIntegration,
  removeOrganizationConnector,
  requireAccessContext,
  updateOrganizationConnectorSettings,
  type ApiRouteDeps,
  type ResolveOrganizationApiIntegration,
} from "@opengeni/core";
import {
  nestedPostgresSqlState,
  OrganizationConnectorWorkspaceNotInOrganizationError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseRequestBody } from "../http/request-body";
import { resolveApiIntegrationPreview } from "../integrations/api-integrations";
import { authorizeOrganizationIntegrationAdministration } from "./organization-integration-policy";

/**
 * Organization connectors (docs/design/ownership-and-reach.md, OR-11): an
 * organization owner or admin adds a connector (a remote MCP server or an API
 * integration) once and chooses which workspaces it reaches. Signed-in owners and admins, and agents acting for
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

/**
 * An organization key, sent only while reading an API that needs one even to
 * describe itself (such as GraphQL introspection), and only to the request's
 * own destination.
 */
function previewKeyResolver(
  apiKey: readonly OrganizationApiKeyPlacement[],
): IntegrationCredentialResolver {
  return {
    resolve: async (request) => {
      if (request.forceRefresh) return null;
      const destination = new URL(request.destinationUrl);
      return {
        audience: { origin: destination.origin, pathPrefix: "/" },
        placements: apiKey.map((placement) => ({
          carrier: placement.carrier,
          name: placement.name,
          value: placement.value,
          ...(placement.prefix ? { prefix: placement.prefix } : {}),
        })),
      };
    },
  };
}

export function registerOrganizationConnectorRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/organizations/:organizationId/connectors";
  // API integration sources are read through the same pinned transport a
  // workspace preview uses.
  const transport = createPinnedIntegrationTransport({
    network: deps.settings,
    ...(deps.apiIntegrationSourceFetch ? { fetchImpl: deps.apiIntegrationSourceFetch } : {}),
  });
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
    const resolveApiIntegration: ResolveOrganizationApiIntegration = async ({ source, apiKey }) =>
      await resolveApiIntegrationPreview({
        source,
        connection: null,
        transport,
        authority: {
          accountId,
          // No workspace yet: the organization's setup is compiled once for
          // every workspace it will reach.
          workspaceId: accountId,
          initiatingSubjectId: actor.subjectId,
          ...(apiKey ? { connectionRef: "organization-key-preview" } : {}),
        },
        ...(apiKey ? { credentialResolver: previewKeyResolver(apiKey) } : {}),
      });
    return {
      db: deps.db,
      settings: deps.settings,
      accountId,
      authorize: async () => actor,
      resolveApiIntegration,
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

  app.post(`${path}/api-integrations/preview`, async (context) => {
    context.header("cache-control", "private, no-store");
    const input = await administration(context, true);
    const payload = parseRequestBody(
      PreviewOrganizationApiIntegrationRequest,
      await context.req.json().catch(() => null),
      { status: 422, message: "Invalid API integration preview" },
    );
    const preview = await connectorResponse(() =>
      previewOrganizationApiIntegration({ ...input, payload }),
    );
    return context.json(ApiIntegrationPreview.parse(preview));
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
