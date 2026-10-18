import { createHash } from "node:crypto";
import {
  CreateWorkspaceArtifactRequest,
  PublishWorkspaceArtifactVersionRequest,
  RollbackWorkspaceArtifactRequest,
  SetWorkspaceArtifactStatusRequest,
  UpdateWorkspaceArtifactVisibilityRequest,
  UpdateWorkspaceArtifactVisibilityResponse,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListQuery,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
  normalizeWorkspaceArtifactSlug,
  type AccessGrant,
} from "@opengeni/contracts";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requireSessionAuthorization,
  resolveNewSiteAudience,
  resolveSiteAudienceChange,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
  siteViewerForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  createWorkspaceArtifact,
  getWorkspaceArtifact,
  getWorkspaceArtifactContentRef,
  listWorkspaceArtifacts,
  nestedPostgresSqlState,
  publishWorkspaceArtifactVersion,
  rollbackWorkspaceArtifact,
  setWorkspaceArtifactStatus,
  updateWorkspaceArtifactVisibility,
  WorkspaceArtifactConflictError,
  WorkspaceArtifactNotFoundError,
  WorkspaceArtifactOperationError,
  WorkspaceArtifactOwnerRequiredError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { readWorkspaceArtifactContent } from "../workspace-artifact-content";
import { userContentDispositionHeaders } from "../http/user-content";
import {
  afterSiteArtifactMutation,
  notifySitePublicationChanged,
  requireSiteVersionPublishOpen,
} from "../site-publishing/service";
import {
  projectWorkspaceArtifactDetailProvenance,
  projectWorkspaceArtifactMutationProvenance,
  redactWorkspaceArtifactListProvenance,
} from "../workspace-artifact-provenance";

import {
  prepareWorkspaceArtifactPublication,
  prepareWorkspaceArtifactUpload,
  workspaceArtifactDownloads,
  readArtifactObject,
} from "../site-uploads";

const ArtifactId = z.string().uuid();

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid artifact request" });
  return parsed.data;
}

function parseVersionId(value: string | undefined): string | undefined {
  if (value !== undefined && !ArtifactId.safeParse(value).success) {
    throw new HTTPException(422, { message: "Invalid artifact version id" });
  }
  return value;
}

function artifactId(context: Context): string {
  const parsed = ArtifactId.safeParse(context.req.param("artifactId"));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid artifact id" });
  return parsed.data;
}

export function workspaceArtifactErrorResponse(context: Context, error: unknown): Response {
  if (error instanceof WorkspaceArtifactNotFoundError) {
    return context.json({ code: "WORKSPACE_ARTIFACT_NOT_FOUND", message: error.message }, 404);
  }
  if (error instanceof WorkspaceArtifactConflictError) {
    return context.json(
      {
        code: "WORKSPACE_ARTIFACT_CONFLICT",
        message: error.message,
        currentVersionId: error.currentVersionId,
      },
      409,
    );
  }
  if (error instanceof WorkspaceArtifactOwnerRequiredError) {
    return context.json({ code: "WORKSPACE_ARTIFACT_OWNER_REQUIRED", message: error.message }, 403);
  }
  if (error instanceof WorkspaceArtifactOperationError) {
    return context.json(
      { code: "INVALID_WORKSPACE_ARTIFACT_OPERATION", message: error.message },
      422,
    );
  }
  if (nestedPostgresSqlState(error) === "23505") {
    return context.json(
      {
        code: "WORKSPACE_ARTIFACT_CONFLICT",
        message: "Artifact slug or operation already exists",
      },
      409,
    );
  }
  throw error;
}

function prepareContent(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  input: Parameters<typeof prepareWorkspaceArtifactPublication>[2],
) {
  if (!deps.objectStorage)
    throw new HTTPException(503, {
      message: "Object storage is not configured",
    });
  return prepareWorkspaceArtifactPublication(deps, grant, input);
}

function provenance(subjectId: string, idempotencyKey: string) {
  return {
    operationKey: `subject:${createHash("sha256").update(`${subjectId}:${idempotencyKey}`).digest("hex")}`,
    actorSubjectId: subjectId,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
    sourceToolName: null,
  };
}

async function canReadProvenanceSession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
): Promise<boolean> {
  try {
    await requireSessionAuthorization(deps, grant, {
      sessionId,
      operation: "session.read",
      surface: "http",
    });
    return true;
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) return false;
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new HTTPException(503, {
        message: "Session authorization is unavailable",
      });
    }
    throw error;
  }
}

async function mutationResponse(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  response: WorkspaceArtifactMutationResponse,
): Promise<WorkspaceArtifactMutationResponse> {
  return WorkspaceArtifactMutationResponse.parse(
    await projectWorkspaceArtifactMutationProvenance(response, (sessionId) =>
      canReadProvenanceSession(deps, grant, sessionId),
    ),
  );
}

export function registerWorkspaceArtifactRoutes(app: Hono, deps: ApiRouteDeps): void {
  // `published-artifacts` deliberately avoids the existing `/artifacts/:id`
  // retained-output API. The product route remains simply `/artifacts`.
  const base = "/v1/workspaces/:workspaceId/published-artifacts";
  // A published Site follows its Site: a new version, rollback, archive or
  // restore advances its host map (after commit, never blocking the change),
  // through the same hook the agent artifact tools run. Recorded before the
  // response so the next host lookup sees the change; publish and rollback
  // scan the version that became current.
  const publishedSiteChanged = async <T extends WorkspaceArtifactMutationResponse>(
    result: T,
    scan = false,
  ): Promise<T> => await afterSiteArtifactMutation(deps, result, { scan });

  app.post(`${base}/uploads`, async (context) => {
    const grant = await requireAccessGrant(
      context,
      deps,
      context.req.param("workspaceId"),
      "artifacts:publish",
    );
    return context.json(await prepareWorkspaceArtifactUpload(deps, grant));
  });

  app.get(`${base}/:artifactId/downloads`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    if (!deps.objectStorage)
      throw new HTTPException(503, {
        message: "Object storage is not configured",
      });
    try {
      const ref = await getWorkspaceArtifactContentRef(
        deps.db,
        workspaceId,
        await siteViewerForGrant(deps.db, grant),
        artifactId(context),
        parseVersionId(context.req.query("versionId")),
      );
      return context.json(await workspaceArtifactDownloads(deps.objectStorage, ref, "public"));
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const query = WorkspaceArtifactListQuery.safeParse({
      limit: context.req.query("limit"),
      cursor: context.req.query("cursor"),
      status: context.req.query("status"),
      sourceSessionId: context.req.query("sourceSessionId"),
    });
    if (!query.success) throw new HTTPException(422, { message: "Invalid artifact list query" });
    if (
      query.data.sourceSessionId &&
      !(await canReadProvenanceSession(deps, grant, query.data.sourceSessionId))
    ) {
      throw new HTTPException(404, { message: "Session not found" });
    }
    try {
      return context.json(
        WorkspaceArtifactListResponse.parse(
          redactWorkspaceArtifactListProvenance(
            await listWorkspaceArtifacts(
              deps.db,
              workspaceId,
              await siteViewerForGrant(deps.db, grant),
              {
                limit: query.data.limit,
                ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
                ...(query.data.status ? { status: query.data.status } : {}),
                ...(query.data.sourceSessionId
                  ? { sourceSessionId: query.data.sourceSessionId }
                  : {}),
              },
            ),
          ),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.post(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "artifacts:publish",
    );
    const grant = authorization.grant;
    const request = await body(context, CreateWorkspaceArtifactRequest);
    const id = crypto.randomUUID();
    const slugBase = request.slug ?? (normalizeWorkspaceArtifactSlug(request.title) || "artifact");
    const slug = request.slug ?? `${slugBase.slice(0, 87)}-${id.slice(0, 8)}`;
    try {
      const audience = await resolveNewSiteAudience({
        db: deps.db,
        settings: deps.settings,
        grant,
        viewer: await siteViewerForGrant(deps.db, grant),
        requested: request.visibility,
        sourceSessionId: null,
      });
      const content = await prepareContent(deps, grant, {
        ...(request.html !== undefined ? { html: request.html } : {}),
        ...(request.uploadId ? { uploadId: request.uploadId } : {}),
        ...(request.source ? { source: request.source } : {}),
        ...(request.requestedTools ? { requestedTools: request.requestedTools } : {}),
      });
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await createWorkspaceArtifact(deps.db, {
            ...audience,
            accountId: grant.accountId,
            workspaceId,
            artifactId: id,
            slug,
            requestedSlug: request.slug ?? null,
            title: request.title,
            description: request.description ?? null,
            ...content,
            ...provenance(grant.subjectId, request.idempotencyKey),
          }),
        ),
        201,
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.get(`${base}/:artifactId`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    try {
      const detail = await getWorkspaceArtifact(
        deps.db,
        workspaceId,
        await siteViewerForGrant(deps.db, grant),
        artifactId(context),
      );
      return context.json(
        WorkspaceArtifactDetailResponse.parse(
          await projectWorkspaceArtifactDetailProvenance(detail, (sessionId) =>
            canReadProvenanceSession(deps, grant, sessionId),
          ),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.get(`${base}/:artifactId/html`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    if (!deps.objectStorage)
      throw new HTTPException(503, {
        message: "Object storage is not configured",
      });
    let ref: Awaited<ReturnType<typeof getWorkspaceArtifactContentRef>>;
    try {
      ref = await getWorkspaceArtifactContentRef(
        deps.db,
        workspaceId,
        await siteViewerForGrant(deps.db, grant),
        artifactId(context),
        parseVersionId(context.req.query("versionId")),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
    const iterator = readArtifactObject(deps.objectStorage, ref.contentKey);
    return new Response(
      new ReadableStream({
        async pull(controller) {
          try {
            const item = await iterator.next();
            if (item.done) controller.close();
            else controller.enqueue(item.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return();
        },
      }),
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "private, no-store",
          // A Site runs its own scripts, but only inside an opaque origin: no
          // same-origin access to the console, and no cross-site embedding.
          "Content-Security-Policy": "sandbox allow-scripts",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
          // Clients read this HTML with fetch and render it in their own frame
          // (the console uses srcdoc). Opening the raw URL downloads it rather
          // than running a publisher-authored page at an app-origin URL.
          ...userContentDispositionHeaders("text/html", "site.html"),
        },
      },
    );
  });

  app.get(`${base}/:artifactId/content`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    if (!deps.objectStorage)
      throw new HTTPException(503, {
        message: "Object storage is not configured",
      });
    const parsedVersion = parseVersionId(context.req.query("versionId"));
    try {
      const ref = await getWorkspaceArtifactContentRef(
        deps.db,
        workspaceId,
        await siteViewerForGrant(deps.db, grant),
        artifactId(context),
        parsedVersion,
      );
      let content: Awaited<ReturnType<typeof readWorkspaceArtifactContent>>;
      try {
        content = await readWorkspaceArtifactContent(deps.objectStorage, ref);
      } catch (error) {
        throw new HTTPException(503, {
          message: error instanceof Error ? error.message : "Artifact content is unavailable",
          cause: error,
        });
      }
      return context.json(
        WorkspaceArtifactContentResponse.parse({
          artifactId: ref.artifactId,
          versionId: ref.version.id,
          contentType: "text/html",
          contentSha256: ref.version.contentSha256,
          ...content,
        }),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.post(`${base}/:artifactId/versions`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "artifacts:publish",
    );
    const grant = authorization.grant;
    const request = await body(context, PublishWorkspaceArtifactVersionRequest);
    const id = artifactId(context);
    // A published Site gets no new versions while the platform brake is engaged.
    await requireSiteVersionPublishOpen(deps, { accountId: grant.accountId, workspaceId }, id);
    try {
      const content = await prepareContent(deps, grant, {
        ...(request.html !== undefined ? { html: request.html } : {}),
        ...(request.uploadId ? { uploadId: request.uploadId } : {}),
        ...(request.source ? { source: request.source } : {}),
        ...(request.requestedTools ? { requestedTools: request.requestedTools } : {}),
      });
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await publishedSiteChanged(
            await publishWorkspaceArtifactVersion(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              artifactId: id,
              viewer: await siteViewerForGrant(deps.db, grant),
              expectedCurrentVersionId: request.expectedCurrentVersionId,
              ...(request.title !== undefined ? { title: request.title } : {}),
              ...(request.description !== undefined ? { description: request.description } : {}),
              ...content,
              ...provenance(grant.subjectId, request.idempotencyKey),
            }),
            true,
          ),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.post(`${base}/:artifactId/rollback`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "artifacts:publish",
    );
    const grant = authorization.grant;
    const request = await body(context, RollbackWorkspaceArtifactRequest);
    const id = artifactId(context);
    try {
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await publishedSiteChanged(
            await rollbackWorkspaceArtifact(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              artifactId: id,
              viewer: await siteViewerForGrant(deps.db, grant),
              versionId: request.versionId,
              expectedCurrentVersionId: request.expectedCurrentVersionId,
              reason: request.reason,
              ...provenance(grant.subjectId, request.idempotencyKey),
            }),
            true,
          ),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.patch(`${base}/:artifactId/status`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      context,
      deps,
      workspaceId,
      "artifacts:publish",
    );
    const grant = authorization.grant;
    const request = await body(context, SetWorkspaceArtifactStatusRequest);
    const id = artifactId(context);
    try {
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await publishedSiteChanged(
            await setWorkspaceArtifactStatus(deps.db, {
              accountId: grant.accountId,
              workspaceId,
              artifactId: id,
              viewer: await siteViewerForGrant(deps.db, grant),
              status: request.status,
              expectedCurrentVersionId: request.expectedCurrentVersionId,
              reason: request.reason,
              ...provenance(grant.subjectId, request.idempotencyKey),
            }),
          ),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  // Who can see the Site: the whole workspace, or only its owner. Only the
  // owner changes it, like a chat's or a schedule's audience.
  app.put(`${base}/:artifactId/visibility`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, UpdateWorkspaceArtifactVisibilityRequest);
    const id = artifactId(context);
    try {
      const viewer = await siteViewerForGrant(deps.db, grant);
      const visibility = await resolveSiteAudienceChange({
        db: deps.db,
        settings: deps.settings,
        grant,
        viewer,
        requested: request.visibility,
      });
      const artifact = await updateWorkspaceArtifactVisibility(deps.db, {
        workspaceId,
        artifactId: id,
        viewer,
        visibility,
      });
      await notifySitePublicationChanged(deps, { accountId: grant.accountId, workspaceId }, id);
      const projected = await projectWorkspaceArtifactDetailProvenance(
        { artifact, versions: [], events: [], versionsTruncated: false, eventsTruncated: false },
        (sessionId) => canReadProvenanceSession(deps, grant, sessionId),
      );
      return context.json(
        UpdateWorkspaceArtifactVisibilityResponse.parse({ artifact: projected.artifact }),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });
}
