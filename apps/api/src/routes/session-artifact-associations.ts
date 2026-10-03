import {
  requireAccessGrant,
  requirePermission,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  hasEditableArtifactSessionLink,
  hasWorkspaceArtifactSessionLink,
  transactionallyAuthorizeEditableArtifactActor,
  withRlsContext,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { withAccessGrantSessionRlsContext } from "../access-grant-rls";
import { editableArtifactActorForGrant } from "./editable-artifacts";

const SessionId = z.string().uuid();
const EditableArtifactId = z.string().regex(/^(?!0{32}$)[0-9a-f]{32}$/u);

/** Exact authorized membership proof, not a paginated artifact discovery API. */
export function registerSessionArtifactAssociationRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.get(
    "/v1/workspaces/:workspaceId/sessions/:sessionId/artifact-associations/:artifactId",
    async (context) => {
      const workspaceId = context.req.param("workspaceId");
      const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
      requirePermission(grant, "sessions:read");
      const sessionId = context.req.param("sessionId");
      const artifactId = context.req.param("artifactId");
      const kind = EditableArtifactId.safeParse(artifactId).success
        ? "editable"
        : SessionId.safeParse(artifactId).success
          ? "site"
          : null;
      const requestedKind = context.req.query("kind");
      if (
        !SessionId.safeParse(sessionId).success ||
        !kind ||
        (requestedKind !== undefined && requestedKind !== kind)
      ) {
        throw new HTTPException(404, { message: "Artifact association not found" });
      }
      try {
        return await withAccessGrantSessionRlsContext(deps, grant, async () => {
          await requireSessionAuthorization(deps, grant, {
            sessionId,
            operation: "session.read",
            surface: "http",
          });
          const scope = { accountId: grant.accountId, workspaceId };
          const linked =
            kind === "editable"
              ? await hasEditableArtifactSessionLink(deps.db, scope, sessionId, artifactId)
              : await hasWorkspaceArtifactSessionLink(deps.db, workspaceId, sessionId, artifactId);
          if (!linked) throw new HTTPException(404, { message: "Artifact association not found" });
          if (kind === "editable") {
            const decision = await withRlsContext(deps.db, scope, (tx) =>
              transactionallyAuthorizeEditableArtifactActor(tx, {
                scope,
                artifactId,
                actor: editableArtifactActorForGrant(grant, "0000000000000001"),
                permission: "read",
              }),
            );
            if (!decision.allowed) {
              throw new HTTPException(404, { message: "Artifact association not found" });
            }
          }
          context.header("cache-control", "private, no-store");
          return context.json({ sessionId, artifactId, kind });
        });
      } catch (error) {
        if (error instanceof SessionAuthorizationDeniedError) {
          throw new HTTPException(404, { message: "Artifact association not found" });
        }
        if (error instanceof SessionAuthorizationUnavailableError) {
          throw new HTTPException(503, { message: "Session authorization is unavailable" });
        }
        throw error;
      }
    },
  );
}
