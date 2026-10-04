import {
  AvailableOpenGeniSlackBots,
  OpenGeniSlackBotOrganizationAccess,
  UpdateOpenGeniSlackBotOrganizationAccess,
} from "@opengeni/contracts";
import {
  isOpenGeniSlackBotConnection,
  requireAccessGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  availableSlackBotConnectionMetadata,
  nestedPostgresSqlState,
  readOrganizationSlackBotAccess,
  setOrganizationSlackBotAccess,
  sharedOrganizationSlackBots,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authorizeOrganizationIntegrationAdministration } from "./organization-integration-policy";

export function registerSlackBotAccessRoutes(app: Hono, deps: ApiRouteDeps): void {
  const base = "/v1/workspaces/:workspaceId/connections";
  app.get(`${base}/:connectionId/slack-bot/organization-access`, async (context) => {
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId"),
      "connections:read",
    );
    const connectionId = z.string().uuid().safeParse(context.req.param("connectionId"));
    if (!connectionId.success) throw new HTTPException(422, { message: "Invalid bot connection" });
    context.header("cache-control", "private, no-store");
    try {
      return context.json(
        OpenGeniSlackBotOrganizationAccess.parse(
          await readOrganizationSlackBotAccess(deps.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            connectionId: connectionId.data,
          }),
        ),
      );
    } catch (error) {
      if (nestedPostgresSqlState(error) === "42501")
        throw new HTTPException(404, { message: "Local bot installation unavailable" });
      throw error;
    }
  });
  app.get(`${base}/slack-bot/available`, async (context) => {
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId"),
      "connections:read",
    );
    context.header("cache-control", "private, no-store");
    const [connections, shares] = await Promise.all([
      availableSlackBotConnectionMetadata(deps.db, grant),
      sharedOrganizationSlackBots(deps.db, grant),
    ]);
    return context.json(
      AvailableOpenGeniSlackBots.parse({
        connections: connections.filter(
          (connection) =>
            connection.status === "active" && isOpenGeniSlackBotConnection(connection),
        ),
        organizationSharedConnectionIds: shares.map((share) => share.connectionId),
      }),
    );
  });
  app.put(`${base}/:connectionId/slack-bot/organization-access`, async (context) => {
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId"),
      "connections:write",
    );
    const connectionId = z.string().uuid().safeParse(context.req.param("connectionId"));
    const request = UpdateOpenGeniSlackBotOrganizationAccess.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!connectionId.success || !request.success)
      throw new HTTPException(422, { message: "Invalid bot access setting" });
    context.header("cache-control", "private, no-store");
    try {
      const result = await setOrganizationSlackBotAccess(
        deps.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          connectionId: connectionId.data,
          enabled: request.data.enabled,
        },
        () => authorizeOrganizationIntegrationAdministration(context, deps, grant.accountId, true),
      );
      return context.json(OpenGeniSlackBotOrganizationAccess.parse(result));
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      if (nestedPostgresSqlState(error) === "42501")
        throw new HTTPException(403, {
          message: "Organization administrator and a verified local bot installation required",
        });
      throw error;
    }
  });
}
