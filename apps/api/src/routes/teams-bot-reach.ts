import {
  holdsOrganizationAdministration,
  MissingPermissionRefusal,
  requireAccessContext,
  requireAccessGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import { getTeamsReach, getWorkspaceTeamsInstallation, setTeamsReach } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requestValidationError } from "../http/request-body";
import { requireWorkspaceIntegrationAdministration } from "./connections";
import { authorizeOrganizationIntegrationAdministration } from "./organization-integration-policy";

/**
 * Where in the organization people's Teams 1:1 chats can start work: every
 * workspace (null) or the selected ones, and whether members' own Personal
 * workspaces count. The connected workspace is always included. Read by
 * anyone who can see the workspace's connections; changed only by an
 * organization owner or admin who also manages this workspace's
 * integrations, the same people who can share a Slack bot.
 */
const TeamsReachBody = z
  .object({
    workspaceIds: z.array(z.string().uuid()).max(1000).nullable(),
    personalWorkspaces: z.boolean(),
    expectedVersion: z.number().int().nonnegative().optional(),
  })
  .strict();

function reachResponse(reach: Awaited<ReturnType<typeof getTeamsReach>>) {
  return {
    workspaceIds: reach.workspaceIds,
    personalWorkspaces: reach.personalWorkspaces,
    version: reach.version,
  };
}

export function registerTeamsBotReachRoutes(app: Hono, deps: ApiRouteDeps): void {
  const path = "/v1/workspaces/:workspaceId/integrations/teams/reach";
  app.get(path, async (context) => {
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId"),
      "connections:read",
    );
    const installation = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
    if (!installation?.active) throw new HTTPException(404, { message: "Teams is not connected" });
    context.header("cache-control", "private, no-store");
    return context.json(reachResponse(await getTeamsReach(deps.db, installation)));
  });
  app.put(path, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "connections:write");
    // Changing where the bot works is a settings action here, and an
    // organization administration action everywhere else.
    requireWorkspaceIntegrationAdministration(grant);
    // Slack's rule for sharing its bot: a signed-in organization owner or
    // admin (read live), or an organization key with workspace:admin.
    const actor = await authorizeOrganizationIntegrationAdministration(
      context,
      deps,
      grant.accountId,
      true,
    );
    if (
      !actor.subjectId.startsWith("api_key:") &&
      !holdsOrganizationAdministration(await requireAccessContext(context, deps), grant.accountId)
    )
      throw new MissingPermissionRefusal("account:admin");
    const request = TeamsReachBody.safeParse(await context.req.json().catch(() => null));
    if (!request.success)
      throw requestValidationError(request.error, "body", {
        status: 422,
        message: "Invalid Teams access setting",
      });
    const installation = await getWorkspaceTeamsInstallation(deps.db, grant.workspaceId);
    if (!installation?.active) throw new HTTPException(404, { message: "Teams is not connected" });
    context.header("cache-control", "private, no-store");
    try {
      return context.json(
        reachResponse(
          await setTeamsReach(deps.db, installation, {
            workspaceIds: request.data.workspaceIds,
            personalWorkspaces: request.data.personalWorkspaces,
            ...(request.data.expectedVersion !== undefined
              ? { expectedVersion: request.data.expectedVersion }
              : {}),
          }),
        ),
      );
    } catch (error) {
      const message = (error as { message?: unknown } | null)?.message;
      if (message === "teams_reach_invalid")
        throw new HTTPException(422, {
          message: "Choose shared workspaces in this organization.",
        });
      if (message === "teams_reach_version_conflict")
        throw new HTTPException(409, {
          message: "Where Teams works changed. Refresh and try again.",
        });
      throw error;
    }
  });
}
