import { createHash } from "node:crypto";
import {
  CreateWorkspaceArtifactRequest,
  PublishWorkspaceArtifactVersionRequest,
  RollbackWorkspaceArtifactRequest,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactDetailResponse,
  WorkspaceArtifactListQuery,
  WorkspaceArtifactListResponse,
  WorkspaceArtifactMutationResponse,
  normalizeWorkspaceArtifactSlug,
} from "@opengeni/contracts";
import { requireAccessGrant, type ApiRouteDeps } from "@opengeni/core";
import {
  createWorkspaceArtifact,
  getWorkspaceArtifact,
  getWorkspaceArtifactContentRef,
  listWorkspaceArtifacts,
  publishWorkspaceArtifactVersion,
  rollbackWorkspaceArtifact,
  WorkspaceArtifactConflictError,
  WorkspaceArtifactNotFoundError,
  WorkspaceArtifactOperationError,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const ArtifactId = z.string().uuid();
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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

function errorResponse(context: Context, error: unknown): Response {
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
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
    return context.json(
      { code: "WORKSPACE_ARTIFACT_CONFLICT", message: "Artifact slug or operation already exists" },
      409,
    );
  }
  throw error;
}

function contentMetadata(workspaceId: string, html: string) {
  const bytes = encoder.encode(html);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    contentSha256: sha256,
    sizeBytes: bytes.byteLength,
    contentKey: `workspaces/${workspaceId}/workspace-artifacts/blobs/${sha256}.html`,
  };
}

function prepareHtml(deps: ApiRouteDeps, workspaceId: string, html: string) {
  if (!deps.objectStorage)
    throw new HTTPException(503, { message: "Object storage is not configured" });
  const content = contentMetadata(workspaceId, html);
  return {
    ...content,
    persistContent: async () => {
      await deps.objectStorage!.putObject({
        key: content.contentKey,
        contentType: "text/html; charset=utf-8",
        body: content.bytes,
        sha256: content.contentSha256,
      });
    },
  };
}

function provenance(subjectId: string, idempotencyKey: string) {
  return {
    operationKey: `subject:${createHash("sha256").update(`${subjectId}:${idempotencyKey}`).digest("hex")}`,
    actorSubjectId: subjectId,
    sourceSessionId: null,
    sourceTurnId: null,
    sourceAttemptId: null,
    sourceExecutionGeneration: null,
  };
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
    });
    if (!query.success) throw new HTTPException(422, { message: "Invalid artifact list query" });
    try {
      return context.json(
        WorkspaceArtifactListResponse.parse(
          await listWorkspaceArtifacts(deps.db, workspaceId, {
            limit: query.data.limit,
            ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
          }),
        ),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post(base, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, CreateWorkspaceArtifactRequest);
    const id = crypto.randomUUID();
    const slugBase = request.slug ?? (normalizeWorkspaceArtifactSlug(request.title) || "artifact");
    const slug = request.slug ?? `${slugBase.slice(0, 87)}-${id.slice(0, 8)}`;
    const content = prepareHtml(deps, workspaceId, request.html);
    try {
      return context.json(
        WorkspaceArtifactMutationResponse.parse(
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
      return errorResponse(context, error);
    }
  });

  app.get(`${base}/:artifactId`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    await requireAccessGrant(context, deps, workspaceId, "artifacts:read");
    try {
      return context.json(
        WorkspaceArtifactDetailResponse.parse(
          await getWorkspaceArtifact(deps.db, workspaceId, artifactId(context)),
        ),
      );
    } catch (error) {
      return errorResponse(context, error);
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
      const object = await deps.objectStorage.getObjectBytes(ref.contentKey);
      if (!object) throw new HTTPException(503, { message: "Artifact content is unavailable" });
      const actualHash = createHash("sha256").update(object.bytes).digest("hex");
      if (actualHash !== ref.version.contentSha256) {
        throw new HTTPException(503, { message: "Artifact content failed integrity verification" });
      }
      let html: string;
      try {
        html = decoder.decode(object.bytes);
      } catch {
        throw new HTTPException(503, { message: "Artifact content is not valid UTF-8" });
      }
      return context.json(
        WorkspaceArtifactContentResponse.parse({
          artifactId: ref.artifactId,
          versionId: ref.version.id,
          contentType: "text/html",
          contentSha256: ref.version.contentSha256,
          html,
        }),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.post(`${base}/:artifactId/versions`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, PublishWorkspaceArtifactVersionRequest);
    const id = artifactId(context);
    const content = prepareHtml(deps, workspaceId, request.html);
    try {
      return context.json(
        WorkspaceArtifactMutationResponse.parse(
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
      return errorResponse(context, error);
    }
  });

  app.post(`${base}/:artifactId/rollback`, async (context) => {
    const workspaceId = context.req.param("workspaceId");
    const grant = await requireAccessGrant(context, deps, workspaceId, "artifacts:publish");
    const request = await body(context, RollbackWorkspaceArtifactRequest);
    try {
      return context.json(
        WorkspaceArtifactMutationResponse.parse(
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
      return errorResponse(context, error);
    }
  });
}
