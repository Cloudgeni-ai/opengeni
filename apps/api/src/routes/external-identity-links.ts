import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  BeginExternalIdentityLinkRequest,
  ConfirmExternalIdentityLinkRequest,
} from "@opengeni/contracts/external-identities";
import {
  beginExternalIdentityLink,
  confirmExternalIdentityLink,
  getExternalIdentityLink,
  listExternalIdentityLinks,
  previewExternalIdentityLink,
  revokeExternalIdentityLink,
  ensureExternalIdentity,
  ExternalIdentityLinkConflictError,
  withWorkspaceSubjectRls,
  lockExternalWorkspaceMembershipLifecycle,
  getWorkspaceGrant,
  namedSubjectPersonalWorkspaceId,
  managedPersonalWorkspacePermissions,
} from "@opengeni/db";
import {
  requireAccessGrantAuthorization,
  externalActorContinuationForAuthorization,
  externalContinuationCommitAuthorizer,
  hasPermission,
  hasVerifiedOwningUserAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import { parseRequestBody, parseRequestJson, readRequestJson } from "../http/request-body";

function nativeConfirmation(authorization: AccessGrantAuthorization, personPresent = true) {
  if (
    !authorization.contextIntegrity ||
    !(personPresent
      ? authorization.canonicalManagedHumanSession
      : hasVerifiedOwningUserAuthorization(authorization)) ||
    authorization.authenticatedSubjectId !== authorization.grant.subjectId ||
    !authorization.grant.subjectId.startsWith("user:")
  )
    throw new HTTPException(403, { message: "Confirm using your authenticated OpenGeni account" });
}

/** Both products address the link through a workspace they already own. The
 * link itself is organization-local; the host's Personal workspace need not be
 * exposed to the native human, and neither side names the other's subject. */
export function registerExternalIdentityLinkRoutes(app: Hono, deps: ApiRouteDeps) {
  const base = "/v1/workspaces/:workspaceId/identity-links";
  app.get(base, async (c) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      c.req.param("workspaceId"),
      "workspace:read",
    );
    if (!externalActorContinuationForAuthorization(authorization))
      nativeConfirmation(authorization, false);
    const parsedCursor = z.string().uuid().optional().safeParse(c.req.query("cursor"));
    if (!parsedCursor.success) throw new HTTPException(400, { message: "Invalid link cursor" });
    const cursor = parsedCursor.data;
    const grant = authorization.grant;
    return c.json(
      await withWorkspaceSubjectRls(deps.db, grant.workspaceId, grant.subjectId, async (tx) => {
        await externalContinuationCommitAuthorizer(authorization)?.(tx);
        return listExternalIdentityLinks(tx, {
          accountId: grant.accountId,
          subjectId: grant.subjectId,
          ...(cursor ? { cursor } : {}),
        });
      }),
    );
  });
  app.post(base, async (c) => {
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      c.req.param("workspaceId"),
      "workspace:read",
    );
    const continuation = externalActorContinuationForAuthorization(authorization);
    if (!continuation || continuation.actor.actingMode !== "external")
      throw new HTTPException(403, { message: "Start linking as the external product user" });
    const input = await parseRequestJson(c, BeginExternalIdentityLinkRequest);
    if (input.expiresAt !== null && Date.parse(input.expiresAt) <= Date.now())
      throw new HTTPException(422, { message: "Link expiry must be in the future" });
    const commit = externalContinuationCommitAuthorizer(authorization)!;
    try {
      const result = await withWorkspaceSubjectRls(
        deps.db,
        authorization.grant.workspaceId,
        authorization.grant.subjectId,
        async (tx) => {
          await commit(tx);
          const identity = await ensureExternalIdentity(tx, {
            accountId: authorization.grant.accountId,
            ...continuation.identity,
          });
          return beginExternalIdentityLink(tx, identity, input);
        },
      );
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof ExternalIdentityLinkConflictError)
        throw new HTTPException(409, { message: error.message });
      throw error;
    }
  });
  app.on(["GET", "POST"], [base + "/:linkId", base + "/:linkId/:operation"], async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const linkId = z.string().uuid().parse(c.req.param("linkId"));
    const operation = c.req.param("operation");
    if (
      !(
        (c.req.method === "GET" && !operation) ||
        (c.req.method === "POST" && ["preview", "confirm", "revoke"].includes(operation ?? ""))
      )
    )
      throw new HTTPException(404, { message: "Not found" });
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "workspace:read",
    );
    const external = externalActorContinuationForAuthorization(authorization);
    if (operation === "confirm") nativeConfirmation(authorization);
    else if (operation === "preview") nativeConfirmation(authorization, false);
    else if (!external) nativeConfirmation(authorization, false);
    const grant = authorization.grant;
    const input = c.req.method === "POST" ? await readRequestJson(c) : null;
    try {
      const result = await withWorkspaceSubjectRls(
        deps.db,
        workspaceId,
        grant.subjectId,
        async (tx) => {
          await externalContinuationCommitAuthorizer(authorization)?.(tx);
          if (operation === "preview") {
            const request = parseRequestBody(
              z.object({ challenge: ConfirmExternalIdentityLinkRequest.shape.challenge }).strict(),
              input,
            );
            const preview = await previewExternalIdentityLink(tx, {
              accountId: grant.accountId,
              linkId,
              ...request,
            });
            return preview
              ? { ...preview, nativeSubjectId: grant.subjectId, organizationId: grant.accountId }
              : null;
          }
          if (operation === "confirm") {
            const request = parseRequestBody(ConfirmExternalIdentityLinkRequest, input);
            await lockExternalWorkspaceMembershipLifecycle(tx, grant.accountId);
            const personalWorkspaceId = await namedSubjectPersonalWorkspaceId(tx, {
              accountId: grant.accountId,
              subjectId: grant.subjectId,
            });
            const current =
              personalWorkspaceId === workspaceId
                ? { accountId: grant.accountId, permissions: managedPersonalWorkspacePermissions }
                : await getWorkspaceGrant(tx, grant.subjectId, workspaceId, {
                    principalKind: "human_session",
                  });
            if (
              !current ||
              current.accountId !== grant.accountId ||
              request.permissions.some(
                (permission) =>
                  !hasPermission(grant.permissions, permission) ||
                  !hasPermission(current.permissions, permission),
              )
            )
              throw new HTTPException(403, {
                message: "Link permissions exceed your authority in this workspace",
              });
            return confirmExternalIdentityLink(tx, {
              accountId: grant.accountId,
              linkId,
              nativeSubjectId: grant.subjectId,
              request,
            });
          }
          const scope = { accountId: grant.accountId, linkId, subjectId: grant.subjectId };
          if (operation === "revoke") {
            const request = parseRequestBody(
              z.object({ expectedRevision: z.number().int().positive().safe() }).strict(),
              input,
            );
            return revokeExternalIdentityLink(tx, { ...scope, ...request });
          }
          return getExternalIdentityLink(tx, scope);
        },
      );
      if (!result) throw new HTTPException(404, { message: "Identity link not found or expired" });
      return c.json(result);
    } catch (error) {
      if (error instanceof ExternalIdentityLinkConflictError)
        throw new HTTPException(409, { message: error.message });
      throw error;
    }
  });
}
