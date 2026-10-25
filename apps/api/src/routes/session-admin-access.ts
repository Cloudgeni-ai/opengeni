import {
  GrantSessionAdminAccessRequest,
  OrganizationAgentAdminAccess,
  SessionAdminAccess,
  UpdateOrganizationAgentAdminAccessRequest,
  type SessionAuthorizationOperation,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  withResolvedSessionAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getManagedUserProfilesByIds,
  getOrganizationAgentAdminAccess,
  getSessionAdminAccessView,
  grantSessionAdminAccess,
  nestedPostgresSqlState,
  revokeSessionAdminAccess,
  SessionAdminAccessNotAllowedError,
  SessionAdminAccessNotOwnSessionError,
  SessionAdminAccessNotWorkspaceMemberError,
  setOrganizationAgentAdminAccess,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  isAgentActingAsPerson,
  isAgentWithFullAccess,
  requireFullAccessIfAgent,
} from "../http/acting-person";
import { requireOrganizationCodexHuman } from "./codex";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { parseRequestBody } from "../http/request-body";

/* ----------------------------------------------------------------------------
   Full access for agent sessions (named "admin access" in the API).

   An organization allows it (off by default). Any member then gives a
   session they started themselves their access for an hour by default, a
   number of hours they choose, or with no time limit: the agent there gets
   the organization's actions and runs them as that person, with exactly what
   they can do right now (an owner or admin can manage more than a member). It ends by itself when the time is up. Turning the
   organization setting off ends every session's admin access. An agent with
   the person's full access (such as one with admin access) can do all of
   this as them; an agent with less can read the state and end access, never
   start it.
   -------------------------------------------------------------------------- */

const OrganizationId = z.string().uuid();

function parseOrganizationId(value: string | undefined): string {
  const parsed = OrganizationId.safeParse(value);
  if (!parsed.success) throw new HTTPException(404, { message: "organization not found" });
  return parsed.data;
}

function administratorsOnly(error: unknown): never {
  if (nestedPostgresSqlState(error) === "42501") {
    throw new HTTPException(403, {
      message: "Only organization owners and admins can change this setting",
    });
  }
  throw error;
}

async function authorizeSession(
  c: Context,
  deps: ApiRouteDeps,
  operation: SessionAuthorizationOperation,
) {
  const workspaceId = c.req.param("workspaceId")!;
  const sessionId = c.req.param("sessionId")!;
  if (!z.string().uuid().safeParse(sessionId).success) {
    throw new HTTPException(404, { message: "Session not found" });
  }
  const grant = await requireAccessGrant(
    c,
    deps,
    workspaceId,
    operation === "session.read" ? "sessions:read" : "sessions:control",
  );
  try {
    const authorization = await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation,
      surface: "http",
    });
    return { grant, workspaceId, sessionId, authorization };
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw new HTTPException(404, { message: "Session not found" });
    }
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new HTTPException(503, { message: "session authorization is unavailable" });
    }
    throw error;
  }
}

async function personName(deps: ApiRouteDeps, subjectId: string): Promise<string | null> {
  if (!subjectId.startsWith("user:")) return null;
  const [profile] = await getManagedUserProfilesByIds(deps.db, [subjectId.slice("user:".length)]);
  return profile?.name?.trim() || profile?.email || null;
}

export function registerSessionAdminAccessRoutes(app: Hono, deps: ApiRouteDeps): void {
  const organizationPath = "/v1/organizations/:organizationId/agent-admin-access";

  app.get(organizationPath, async (c) => {
    c.header("cache-control", "private, no-store");
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    await requireOrganizationCodexHuman(c, deps, organizationId);
    return c.json(
      OrganizationAgentAdminAccess.parse(
        await getOrganizationAgentAdminAccess(deps.db, organizationId),
      ),
    );
  });

  app.patch(organizationPath, async (c) => {
    requireFullAccessIfAgent(c, "Changing what agents may do for people");
    requireSameOriginBrowserMutation(c, deps);
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const parsed = parseRequestBody(
      UpdateOrganizationAgentAdminAccessRequest,
      await c.req.json().catch(() => null),
      { status: 422, message: "invalid agent access setting" },
    );
    try {
      return c.json(
        OrganizationAgentAdminAccess.parse(
          await setOrganizationAgentAdminAccess(deps.db, {
            organizationId,
            actorSubjectId: human.subjectId,
            sessionAdminAccessAllowed: parsed.sessionAdminAccessAllowed,
            chatActionsAllowed: parsed.chatActionsAllowed,
          }),
        ),
      );
    } catch (error) {
      administratorsOnly(error);
    }
  });

  const sessionPath = "/v1/workspaces/:workspaceId/sessions/:sessionId/admin-access";

  const view = async (
    c: Context,
    target: Awaited<ReturnType<typeof authorizeSession>>,
  ): Promise<SessionAdminAccess> => {
    const read = () =>
      getSessionAdminAccessView(deps.db, {
        accountId: target.grant.accountId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        viewerSubjectId: target.grant.subjectId,
      });
    const state = target.authorization
      ? await withResolvedSessionAuthorization(target.authorization, read)
      : await read();
    const asThePerson =
      (!isAgentActingAsPerson(c) || isAgentWithFullAccess(c)) &&
      (target.grant.principalKind === undefined || target.grant.principalKind === "human_session");
    const grantedBy = state.grant
      ? {
          subjectId: state.grant.grantedBySubjectId,
          name: await personName(deps, state.grant.grantedBySubjectId),
        }
      : null;
    return SessionAdminAccess.parse({
      active: state.active,
      grantedBy: state.active ? grantedBy : null,
      grantedAt: state.active ? (state.grant?.grantedAt ?? null) : null,
      expiresAt: state.active ? (state.grant?.expiresAt ?? null) : null,
      allowed: state.allowed,
      canGrant: state.allowed && asThePerson && state.viewerStartedSession,
      canRevoke:
        state.grant !== null &&
        (state.grant.grantedBySubjectId === target.grant.subjectId || state.viewerIsAdministrator),
    });
  };

  app.get(sessionPath, async (c) => {
    c.header("cache-control", "private, no-store");
    const target = await authorizeSession(c, deps, "session.read");
    return c.json(await view(c, target));
  });

  app.put(sessionPath, async (c) => {
    requireFullAccessIfAgent(c, "Giving a session admin access");
    requireSameOriginBrowserMutation(c, deps);
    const target = await authorizeSession(c, deps, "session.tool_policy.write");
    // Only the person themselves (or an agent with their full access): never
    // an API key or another principal acting on the workspace.
    if (
      target.grant.principalKind !== undefined &&
      target.grant.principalKind !== "human_session"
    ) {
      throw new HTTPException(403, { message: "Give a session your access as yourself" });
    }
    const human = { subjectId: target.grant.subjectId };
    // No body (older clients) means the default: one hour.
    const raw = (await c.req.text().catch(() => "")).trim();
    let input: unknown = null;
    try {
      input = raw ? JSON.parse(raw) : {};
    } catch {
      input = null;
    }
    const body = GrantSessionAdminAccessRequest.safeParse(input);
    if (!body.success) {
      throw new HTTPException(422, {
        message:
          "durationHours must be a whole number of hours from 1 to 720, or null for no time limit",
      });
    }
    const grant = () =>
      grantSessionAdminAccess(deps.db, {
        organizationId: target.grant.accountId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        actorSubjectId: human.subjectId,
        durationHours: body.data.durationHours,
      });
    try {
      if (target.authorization) await withResolvedSessionAuthorization(target.authorization, grant);
      else await grant();
    } catch (error) {
      if (error instanceof SessionAdminAccessNotAllowedError) {
        throw new HTTPException(409, { message: error.message });
      }
      if (
        error instanceof SessionAdminAccessNotOwnSessionError ||
        error instanceof SessionAdminAccessNotWorkspaceMemberError
      ) {
        throw new HTTPException(403, { message: error.message });
      }
      throw error;
    }
    return c.json(await view(c, target));
  });

  app.delete(sessionPath, async (c) => {
    const target = await authorizeSession(c, deps, "session.tool_policy.write");
    const current = await view(c, target);
    if (current.canRevoke) {
      const revoke = () =>
        revokeSessionAdminAccess(deps.db, {
          accountId: target.grant.accountId,
          workspaceId: target.workspaceId,
          sessionId: target.sessionId,
        });
      if (target.authorization)
        await withResolvedSessionAuthorization(target.authorization, revoke);
      else await revoke();
    } else if (current.active) {
      throw new HTTPException(403, {
        message: "Only the person who gave this session access, or an owner or admin, can end it",
      });
    }
    return c.json(await view(c, target));
  });
}
