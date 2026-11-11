import {
  getWorkspaceGrant,
  namedSubjectPersonalWorkspaceId,
  resolveNamedManagedPersonalWorkspaceGrant,
} from "@opengeni/db";
import {
  getManagedSession,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  externalActorContinuationForAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { agentActingAsPersonBeforeGrantCheck } from "../http/acting-person";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
type ManagedCookieHuman = { subjectId: string };

/**
 * Where a private (scope `user`) subscription is managed. The legacy pools
 * keep a person's private accounts in an ordinary workspace they are a member
 * of; the shared subscription core keeps a personal connection only in its
 * owner's own Personal workspace (D-03), so on the core the private routes
 * answer there (`personal_workspace`).
 *
 * `own_personal_workspace` is the same core place reached from wherever the
 * person is: any workspace of the organization where they hold
 * `connections:write` connects their own subscription in place. The
 * connection still lives in, and is written through, their own current
 * Personal workspace (SUB-OWN-03); the caller only names where they are.
 */
export type PrivateSubscriptionPlace =
  | "ordinary_workspace"
  | "personal_workspace"
  | "own_personal_workspace";

/** The person who manages a private subscription, and the workspace that keeps it. */
export type PrivateSubscriptionOwner = {
  accountId: string;
  subjectId: string;
  /**
   * Where the subscription lives: the owner's own Personal workspace on the
   * core, else the request's workspace.
   */
  workspaceId: string;
};

async function requirePrivateSubscriptionPlace(
  deps: ApiRouteDeps,
  place: PrivateSubscriptionPlace,
  input: { accountId: string; workspaceId: string; subjectId: string },
  displayName: string,
): Promise<string> {
  if (place === "own_personal_workspace") {
    // The subject's own current Personal workspace in this same organization
    // (the grant's), with a live organization membership. Nobody else's, and
    // never one in another organization.
    const personalWorkspaceId = await namedSubjectPersonalWorkspaceId(deps.db, input);
    if (
      !personalWorkspaceId ||
      !(await resolveNamedManagedPersonalWorkspaceGrant(deps.db, {
        ...input,
        workspaceId: personalWorkspaceId,
      }))
    )
      throw new HTTPException(409, {
        message: `Private ${displayName} accounts need your own Personal workspace in this organization`,
      });
    return personalWorkspaceId;
  }
  if (place === "personal_workspace") {
    // The subject's current Personal workspace pointer with a live
    // organization membership; another person's Personal workspace or a
    // shared workspace never qualifies.
    if (!(await resolveNamedManagedPersonalWorkspaceGrant(deps.db, input)))
      throw new HTTPException(409, {
        message: `Private ${displayName} accounts are connected and managed from your Personal workspace`,
      });
    return input.workspaceId;
  }
  // The shared user-pool domain requires an ordinary workspace membership,
  // not just the synthetic Personal-workspace owner grant.
  if (!(await getWorkspaceGrant(deps.db, input.subjectId, input.workspaceId)))
    throw new HTTPException(409, {
      message: `Private ${displayName} accounts require membership in an ordinary workspace`,
    });
  return input.workspaceId;
}

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

export async function requirePrivateSubscriptionHuman(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  displayName: string,
  place: PrivateSubscriptionPlace = "ordinary_workspace",
): Promise<PrivateSubscriptionOwner> {
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
      const owner = {
        accountId: authorization.grant.accountId,
        subjectId: authorization.grant.subjectId,
      };
      const keptIn = await requirePrivateSubscriptionPlace(
        deps,
        place,
        { ...owner, workspaceId },
        displayName,
      );
      if (keptIn !== workspaceId) {
        // The write lands in the owner's Personal workspace, so this request's
        // authority must reach it too: a delegation limited to the workspace
        // the person is in can't write there.
        const there = await requireAccessGrantAuthorization(c, deps, keptIn, "connections:write");
        if (there.grant.subjectId !== owner.subjectId)
          throw new HTTPException(403, {
            message: `Private ${displayName} accounts require a verified owning user`,
          });
      }
      return { ...owner, workspaceId: keptIn };
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
  const owner = { accountId: grant.accountId, subjectId: grant.subjectId };
  const keptIn = await requirePrivateSubscriptionPlace(
    deps,
    place,
    { ...owner, workspaceId },
    displayName,
  );
  if (keptIn !== workspaceId) {
    // As above: the request must also hold `connections:write` where the
    // subscription is written, the owner's own Personal workspace.
    const there = await requireAccessGrant(c, deps, keptIn, "connections:write");
    if (there.subjectId !== human.subjectId)
      throw new HTTPException(403, {
        message: "managed browser identity mismatch",
      });
  }
  return { ...owner, workspaceId: keptIn };
}

/**
 * Authorize a change at `scope` from this workspace. A `user` scope needs the
 * verified owning person (`requirePrivateSubscriptionHuman`) and answers the
 * workspace that keeps their subscription; a `workspace` scope needs this
 * workspace's administrator and answers this workspace.
 */
export async function requireSubscriptionScopeMutation(
  c: Context,
  deps: ApiRouteDeps,
  workspaceId: string,
  scope: "workspace" | "user" | "organization",
  displayName: string,
  place: PrivateSubscriptionPlace = "ordinary_workspace",
): Promise<PrivateSubscriptionOwner> {
  if (scope === "organization")
    throw new HTTPException(409, { message: "Manage this subscription in organization settings" });
  if (scope === "user") {
    // Server-side external-user assertions do not use browser cookies. Ordinary
    // bearers remain rejected by requirePrivateHuman; native CSRF is unchanged.
    if (!c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
    return await requirePrivateSubscriptionHuman(c, deps, workspaceId, displayName, place);
  }
  const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
  return { accountId: grant.accountId, subjectId: grant.subjectId, workspaceId };
}
