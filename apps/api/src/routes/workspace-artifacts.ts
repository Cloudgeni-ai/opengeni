import { createHash } from "node:crypto";
import {
  CreateWorkspaceArtifactRequest,
  PublishWorkspaceArtifactVersionRequest,
  RollbackWorkspaceArtifactRequest,
  SetWorkspaceArtifactStatusRequest,
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
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
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
  WorkspaceArtifactConflictError,
  WorkspaceArtifactNotFoundError,
  WorkspaceArtifactOperationError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  prepareWorkspaceArtifactContent,
  readWorkspaceArtifactContent,
} from "../workspace-artifact-content";
import {
  projectWorkspaceArtifactDetailProvenance,
  projectWorkspaceArtifactMutationProvenance,
  redactWorkspaceArtifactListProvenance,
} from "../workspace-artifact-provenance";

const ArtifactId = z.string().uuid();

async function body<S extends z.ZodType>(context: Context, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(422, { message: "Invalid artifact request" });
  return parsed.data;
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
  if (error instanceof WorkspaceArtifactOperationError) {
    return context.json(
      { code: "INVALID_WORKSPACE_ARTIFACT_OPERATION", message: error.message },
      422,
    );
  }
  if (nestedPostgresSqlState(error) === "23505") {
    return context.json(
      { code: "WORKSPACE_ARTIFACT_CONFLICT", message: "Artifact slug or operation already exists" },
      409,
    );
  }
  throw error;
}

function prepareContent(
  deps: ApiRouteDeps,
  workspaceId: string,
  input: Parameters<typeof prepareWorkspaceArtifactContent>[2],
) {
  if (!deps.objectStorage)
    throw new HTTPException(503, { message: "Object storage is not configured" });
  return prepareWorkspaceArtifactContent(deps.objectStorage, workspaceId, input);
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
      throw new HTTPException(503, { message: "Session authorization is unavailable" });
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

  app.get(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    const query = WorkspaceArtifactListQuery.safeParse({
      limit: context.req.query("limit"),
      cursor: context.req.query("cursor"),
      status: context.req.query("status"),
    });
    if (!query.success) throw new HTTPException(422, { message: "Invalid artifact list query" });
    try {
      return context.json(
        WorkspaceArtifactListResponse.parse(
          redactWorkspaceArtifactListProvenance(
            await listWorkspaceArtifacts(deps.db, workspaceId, {
              limit: query.data.limit,
              ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
              ...(query.data.status ? { status: query.data.status } : {}),
            }),
          ),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.post(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, CreateWorkspaceArtifactRequest);
    const id = crypto.randomUUID();
    const slugBase = request.slug ?? (normalizeWorkspaceArtifactSlug(request.title) || "artifact");
    const slug = request.slug ?? `${slugBase.slice(0, 87)}-${id.slice(0, 8)}`;
    const content = prepareContent(deps, workspaceId, {
      html: request.html,
      ...(request.source ? { source: request.source } : {}),
      ...(request.requestedTools ? { requestedTools: request.requestedTools } : {}),
    });
    try {
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await createWorkspaceArtifact(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            artifactId: id,
            slug,
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
      const detail = await getWorkspaceArtifact(deps.db, workspaceId, artifactId(context));
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

  app.get(`${base}/:artifactId/content`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    if (!deps.objectStorage)
      throw new HTTPException(503, { message: "Object storage is not configured" });
    const parsedVersion = context.req.query("versionId");
    if (parsedVersion && !ArtifactId.safeParse(parsedVersion).success) {
      throw new HTTPException(422, { message: "Invalid artifact version id" });
    }
    try {
      const ref = await getWorkspaceArtifactContentRef(
        deps.db,
        workspaceId,
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
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, PublishWorkspaceArtifactVersionRequest);
    const id = artifactId(context);
    const content = prepareContent(deps, workspaceId, {
      html: request.html,
      ...(request.source ? { source: request.source } : {}),
      ...(request.requestedTools ? { requestedTools: request.requestedTools } : {}),
    });
    try {
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await publishWorkspaceArtifactVersion(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            artifactId: id,
            expectedCurrentVersionId: request.expectedCurrentVersionId,
            ...(request.title !== undefined ? { title: request.title } : {}),
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...content,
            ...provenance(grant.subjectId, request.idempotencyKey),
          }),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.post(`${base}/:artifactId/rollback`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, RollbackWorkspaceArtifactRequest);
    try {
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await rollbackWorkspaceArtifact(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            artifactId: artifactId(context),
            versionId: request.versionId,
            expectedCurrentVersionId: request.expectedCurrentVersionId,
            reason: request.reason,
            ...provenance(grant.subjectId, request.idempotencyKey),
          }),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });

  app.patch(`${base}/:artifactId/status`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, SetWorkspaceArtifactStatusRequest);
    try {
      return context.json(
        await mutationResponse(
          deps,
          grant,
          await setWorkspaceArtifactStatus(deps.db, {
            accountId: grant.accountId,
            workspaceId,
            artifactId: artifactId(context),
            status: request.status,
            expectedCurrentVersionId: request.expectedCurrentVersionId,
            reason: request.reason,
            ...provenance(grant.subjectId, request.idempotencyKey),
          }),
        ),
      );
    } catch (error) {
      return workspaceArtifactErrorResponse(context, error);
    }
  });
}
