import { getWorkspaceGrant } from "@opengeni/db";
import {
  getManagedSession,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  externalActorContinuationForAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentActingAsPersonBeforeGrantCheck, isAgentActingAsPerson } from "../http/acting-person";
type ManagedCookieHuman = { subjectId: string };
export async function managedCookieHuman(
  c: Context,
  deps: ApiRouteDeps,
): Promise<ManagedCookieHuman | null> {
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !c.req.header("cookie") ||
    c.req.header("authorization")
  ) {
    return null;
  }
  const session = await getManagedSession(c, deps.managedAuth, {
    db: deps.db,
    sessionAdapter: deps.managedAuthSessionAdapter,
    sessionSetMode: deps.settings.managedAuthSessionSetMode,
  });
  return session?.user?.id ? { subjectId: `user:${session.user.id}` } : null;
}

export function requireSameOriginBrowserMutation(c: Context, deps: ApiRouteDeps): void {
  // Built in process for an agent acting as a person: no browser credentials
  // ride along, so there is no cross-site request to guard against.
  if (isAgentActingAsPerson(c)) return;
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HTTPException(403, { message: "JSON browser request required" });
  }
  if (!deps.settings.publicBaseUrl) {
    throw new HTTPException(503, {
      message: "managed browser origin is not configured",
    });
  }
  const expectedOrigin = new URL(deps.settings.publicBaseUrl).origin;
  if (c.req.header("origin") !== expectedOrigin) {
    throw new HTTPException(403, {
      message: "same-origin browser request required",
    });
  }
  if (c.req.header("sec-fetch-site")?.toLowerCase() !== "same-origin") {
    throw new HTTPException(403, {
      message: "same-origin fetch metadata required",
    });
  }
}

export async function requirePrivateSubscriptionHuman(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  displayName: string,
): Promise<{ accountId: string; subjectId: string }> {
  if (c.req.header("authorization")) {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "connections:write",
    );
    const external = externalActorContinuationForAuthorization(authorization);
    if (
      external &&
      authorization.contextIntegrity &&
      external.actor.effectiveSubjectId === authorization.grant.subjectId
    ) {
      // The shared user-pool domain requires an ordinary workspace
      // membership, not just the synthetic Personal-workspace owner grant.
      if (!(await getWorkspaceGrant(deps.db, authorization.grant.subjectId, workspaceId)))
        throw new HTTPException(409, {
          message: `Private ${displayName} accounts require membership in an ordinary workspace`,
        });
      return { accountId: authorization.grant.accountId, subjectId: authorization.grant.subjectId };
    }
    throw new HTTPException(403, {
      message: `Private ${displayName} accounts require a verified owning user`,
    });
  }
  const human = (await managedCookieHuman(c, deps)) ?? agentActingAsPersonBeforeGrantCheck(c);
  if (!human) {
    throw new HTTPException(401, {
      message: "managed browser session required",
    });
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "connections:write");
  if (grant.subjectId !== human.subjectId) {
    throw new HTTPException(403, {
      message: "managed browser identity mismatch",
    });
  }
  if (!(await getWorkspaceGrant(deps.db, grant.subjectId, workspaceId)))
    throw new HTTPException(409, {
      message: `Private ${displayName} accounts require membership in an ordinary workspace`,
    });
  return { accountId: grant.accountId, subjectId: grant.subjectId };
}

export async function requireSubscriptionScopeMutation(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  scope: "workspace" | "user" | "organization",
  displayName: string,
): Promise<{ accountId: string; subjectId: string }> {
  if (scope === "organization")
    throw new HTTPException(409, { message: "Manage this subscription in organization settings" });
  if (scope === "user") {
    // Server-side external-user assertions do not use browser cookies. Ordinary
    // bearers remain rejected by requirePrivateHuman; native CSRF is unchanged.
    if (!c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
    return await requirePrivateSubscriptionHuman(c, deps, workspaceId, displayName);
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
  return { accountId: grant.accountId, subjectId: grant.subjectId };
}
