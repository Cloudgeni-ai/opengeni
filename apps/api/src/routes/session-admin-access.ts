import {
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
  setOrganizationAgentAdminAccess,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { isAgentActingAsPerson, requireNotAgent } from "../http/acting-person";
import { requireOrganizationCodexHuman, requireSameOriginBrowserMutation } from "./codex";

/* ----------------------------------------------------------------------------
   Admin access for agent sessions.

   An organization allows it (off by default). An owner or admin then gives
   one of their own sessions admin access, in person in the app: the agent
   there gets the organization's actions and runs them as that person, with
   what they can manage right now. Turning the organization setting off ends
   every session's admin access. Giving access and allowing it are browser
   steps; an agent can read the state and can end access, never start it.
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
      message: "Only organization owners and admins can manage admin access for sessions",
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
    requireNotAgent(c, "Allowing admin access for sessions");
    requireSameOriginBrowserMutation(c, deps);
    const organizationId = parseOrganizationId(c.req.param("organizationId"));
    const human = await requireOrganizationCodexHuman(c, deps, organizationId);
    const parsed = UpdateOrganizationAgentAdminAccessRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) throw new HTTPException(422, { message: "invalid admin access setting" });
    try {
      return c.json(
        OrganizationAgentAdminAccess.parse(
          await setOrganizationAgentAdminAccess(deps.db, {
            organizationId,
            actorSubjectId: human.subjectId,
            sessionAdminAccessAllowed: parsed.data.sessionAdminAccessAllowed,
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
    const inPerson =
      !isAgentActingAsPerson(c) &&
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
      allowed: state.allowed,
      canGrant:
        state.allowed &&
        !state.active &&
        inPerson &&
        state.viewerIsAdministrator &&
        state.viewerStartedSession,
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
    requireNotAgent(c, "Giving a session admin access");
    requireSameOriginBrowserMutation(c, deps);
    const target = await authorizeSession(c, deps, "session.tool_policy.write");
    const human = await requireOrganizationCodexHuman(c, deps, target.grant.accountId);
    if (human.subjectId !== target.grant.subjectId) {
      throw new HTTPException(403, { message: "Give admin access as yourself, in the app" });
    }
    const grant = () =>
      grantSessionAdminAccess(deps.db, {
        organizationId: target.grant.accountId,
        workspaceId: target.workspaceId,
        sessionId: target.sessionId,
        actorSubjectId: human.subjectId,
      });
    try {
      if (target.authorization) await withResolvedSessionAuthorization(target.authorization, grant);
      else await grant();
    } catch (error) {
      if (error instanceof SessionAdminAccessNotAllowedError) {
        throw new HTTPException(409, { message: error.message });
      }
      if (error instanceof SessionAdminAccessNotOwnSessionError) {
        throw new HTTPException(403, { message: error.message });
      }
      administratorsOnly(error);
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
        message: "Only the person who gave admin access, or an owner or admin, can end it",
      });
    }
    return c.json(await view(c, target));
  });
}
