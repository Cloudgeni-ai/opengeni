import {
  fileOwnerContextForAccess,
  requireAccessGrantAuthorization,
  requirePermission,
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getGeneratedImageArtifact,
  getGeneratedVideoArtifact,
  getRetainedFileArtifact,
  hasEditableArtifactSessionLink,
  hasWorkspaceArtifactSessionLink,
  listArtifactCatalogCandidates,
  transactionallyAuthorizeEditableArtifactActor,
  withRlsContext,
  withSessionRlsActorContext,
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
      const sessionId = context.req.param("sessionId");
      const artifactId = context.req.param("artifactId");
      const requestedKind = context.req.query("kind");
      // A UUID names a Site unless the caller asks for a retained artifact
      // (generated image or video, or a published sandbox file) explicitly.
      const kind = EditableArtifactId.safeParse(artifactId).success
        ? "editable"
        : SessionId.safeParse(artifactId).success
          ? requestedKind === "retained"
            ? "retained"
            : "site"
          : null;
      const authorization = await requireAccessGrantAuthorization(
        context,
        deps,
        workspaceId,
        kind === "retained" ? "files:read" : "artifacts:read",
      );
      const grant = authorization.grant;
      requirePermission(grant, "sessions:read");
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
              : kind === "retained"
                ? await hasRetainedArtifactSessionLink(
                    deps,
                    authorization,
                    workspaceId,
                    sessionId,
                    artifactId.toLowerCase(),
                  )
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

/**
 * Whether a retained artifact originated in this exact session: a generated
 * image or video the session produced, or a sandbox file it published. Never
 * inferred from an artifact id appearing in a message.
 */
async function hasRetainedArtifactSessionLink(
  deps: ApiRouteDeps,
  authorization: Awaited<ReturnType<typeof requireAccessGrantAuthorization>>,
  workspaceId: string,
  sessionId: string,
  artifactId: string,
): Promise<boolean> {
  const image = await getGeneratedImageArtifact(deps.db, workspaceId, artifactId);
  if (image) return image.sessionId === sessionId;
  const video = await getGeneratedVideoArtifact(deps.db, workspaceId, artifactId);
  if (video) return !video.artifact.deletedAt && video.artifact.sessionId === sessionId;
  const file = await getRetainedFileArtifact(deps.db, workspaceId, artifactId);
  if (!file) return false;
  // Publication receipts are private; the bounded catalog seam filters them
  // by source session and this file's name, then the exact id must match.
  const grant = authorization.grant;
  const actor = await fileOwnerContextForAccess(deps, authorization, "files:read");
  const candidates = await withSessionRlsActorContext(actor, () =>
    listArtifactCatalogCandidates(
      deps.db,
      { accountId: grant.accountId, workspaceId },
      {
        query: {
          sourceSessionId: sessionId,
          q: file.file.filename.slice(0, 200),
          sort: "newest",
          status: "active",
          limit: 100,
        },
        kinds: ["file", "image"],
        snapshotAt: new Date().toISOString(),
        limit: 201,
      },
    ),
  );
  return candidates.some(
    (candidate) => candidate.origin === "sandbox_file" && candidate.id === artifactId,
  );
}
