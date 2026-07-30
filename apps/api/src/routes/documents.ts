import {
  AddDocumentRequest,
  ApplyMemoryMaintenanceRequest,
  CreateMemoryRelationshipRequest,
  CreateKnowledgeDropRequest,
  CreateKnowledgeMemoryRequest,
  CreateDocumentBaseRequest,
  DeleteMemoryResponse,
  Document,
  DocumentBase,
  DocumentSearchRequest,
  KnowledgeMemory,
  KnowledgeMemorySearchRequest,
  MemoryExportResponse,
  MemoryMaintenanceOperation,
  MemoryRelationship,
  MemoryRelationshipType,
  PreviewMemoryMaintenanceRequest,
  MoveDocumentRequest,
  UpdateKnowledgeMemoryRequest,
  WorkspaceMemorySearchRequest,
  WorkspaceMemorySearchResponse,
  type AccessGrant,
  type WritableMemoryScopeSpec,
} from "@opengeni/contracts";
import {
  applyMemoryMaintenance,
  completeFileUpload,
  createFileUpload,
  createKnowledgeMemory,
  createMemoryRelationship,
  deleteMemoryRelationship,
  deleteWorkspaceMemory,
  exportWorkspaceMemories,
  getSessionMemoryContext,
  getKnowledgeMemory,
  listKnowledgeMemories,
  listMemoryRelationships,
  previewMemoryMaintenance,
  revertMemoryMaintenance,
  updateKnowledgeMemory,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
  type MemoryAccessContext,
  type WorkspaceMemoryContext,
} from "@opengeni/db";
import {
  addDocumentToBase,
  createDocumentBase,
  deleteDocumentFromBase,
  ensureDefaultBase,
  getDocument,
  getDocumentBase,
  listDocumentBases,
  listDocuments,
  moveDocumentToBase,
  queueDocumentForReindex,
  searchDocuments,
} from "@opengeni/documents";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requireAccessGrant } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildDocumentsMcpServer } from "../mcp/documents";
import { sanitizeFilename } from "./files";

function trustedMemoryActorSessionId(grant: AccessGrant): string | null {
  return typeof grant.metadata?.sessionId === "string" ? grant.metadata.sessionId : null;
}

type ResolvedMemoryRequestContext = {
  actorSessionId: string | null;
  access: MemoryAccessContext;
  sessionContext: WorkspaceMemoryContext | null;
};

/**
 * Resolve a signed session claim once at the REST trust boundary.
 *
 * A worker bearer identifies the transport principal, not the initiating human
 * whose private memory is applicable. When it carries a session claim, the
 * persisted immutable session creator is accepted only when it is a subject
 * initiator; service and legacy creators fail closed for private memory. The
 * claimed session must belong to the requested workspace before it can be used
 * for either access or provenance. Sessionless human/API grants keep their
 * authenticated subject.
 */
async function resolveMemoryRequestContext(
  db: ApiRouteDeps["db"],
  workspaceId: string,
  grant: AccessGrant,
): Promise<ResolvedMemoryRequestContext> {
  const signedSessionId = trustedMemoryActorSessionId(grant);
  if (!signedSessionId) {
    return {
      actorSessionId: null,
      access: { subjectId: grant.subjectId },
      sessionContext: null,
    };
  }
  const sessionContext = await getSessionMemoryContext(db, workspaceId, signedSessionId);
  if (!sessionContext?.sessionId) {
    throw new HTTPException(403, {
      message: "trusted signed memory session was not found in this workspace",
    });
  }
  return {
    actorSessionId: sessionContext.sessionId,
    access: sessionContext.access ?? {},
    sessionContext,
  };
}

function bindWritableMemoryScope(
  scope: WritableMemoryScopeSpec | undefined,
  context: ResolvedMemoryRequestContext,
): Parameters<typeof saveWorkspaceMemory>[1]["scopeSpec"] | undefined {
  if (!scope) return undefined;
  switch (scope.type) {
    case "workspace":
      return scope;
    case "user": {
      const subjectId = context.access.subjectId;
      if (!subjectId) {
        throw new HTTPException(403, {
          message: "user-scoped memory requires a persisted initiating human",
        });
      }
      return { type: "user", subjectId };
    }
    case "role":
    case "session":
    case "ephemeral": {
      if (!context.sessionContext?.sessionId) {
        throw new HTTPException(403, {
          message: `${scope.type}-scoped memory requires a trusted signed session`,
        });
      }
      if (scope.type === "role") {
        if (!context.sessionContext.roleKey) {
          throw new HTTPException(403, {
            message: "role-scoped memory requires a persisted session role",
          });
        }
        return { type: "role", roleKey: context.sessionContext.roleKey };
      }
      return { type: scope.type, sessionId: context.sessionContext.sessionId };
    }
  }
}

function memoryAccess(context: ResolvedMemoryRequestContext, privateAdmin = false) {
  return { ...context.access, ...(privateAdmin ? { privateAdmin: true } : {}) };
}

function requestedBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new HTTPException(400, { message: `${name} must be true or false` });
}

function requirePrivateMemoryAdmin(grant: AccessGrant): void {
  if (!hasPermission(grant.permissions, "workspace:admin")) {
    throw new HTTPException(403, { message: "workspace:admin is required for private memory" });
  }
}

export function registerDocumentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, objectStorage, documentIndexer, getDocumentServices } = deps;

  app.post("/v1/workspaces/:workspaceId/document-bases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = CreateDocumentBaseRequest.parse(await c.req.json());
    return c.json(
      DocumentBase.parse(
        await createDocumentBase(db, { ...payload, accountId: grant.accountId, workspaceId }),
      ),
      201,
    );
  });

  app.get("/v1/workspaces/:workspaceId/document-bases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json(
      (await listDocumentBases(db, workspaceId)).map((base) => DocumentBase.parse(base)),
    );
  });

  app.get("/v1/workspaces/:workspaceId/document-bases/:baseId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const base = await getDocumentBase(db, workspaceId, c.req.param("baseId"));
    if (!base) {
      throw new HTTPException(404, { message: "document base not found" });
    }
    return c.json(DocumentBase.parse(base));
  });

  app.post("/v1/workspaces/:workspaceId/document-bases/:baseId/documents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "document:index",
      quantity: 0,
    });
    const payload = AddDocumentRequest.parse(await c.req.json());
    try {
      const document = await addDocumentToBase(db, {
        ...payload,
        accountId: grant.accountId,
        workspaceId,
        baseId: c.req.param("baseId"),
        createdBy: grant.subjectId,
        access: { viewerSubjectId: grant.subjectId },
      });
      const wasCreated =
        document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed =
        document.status === "ready"
          ? document
          : ((await documentIndexer.indexDocument({
              accountId: grant.accountId,
              workspaceId,
              documentId: document.id,
            })) ?? document);
      if (indexed.status === "ready") {
        await recordWorkspaceUsage(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          eventType: "document.indexed",
          quantity: indexed.chunkCount,
          unit: "chunk",
          sourceResourceType: "document",
          sourceResourceId: indexed.id,
          idempotencyKey: `document.indexed:${workspaceId}:${indexed.id}:${indexed.updatedAt}`,
        });
      }
      return c.json(Document.parse(indexed), wasCreated ? 201 : 200);
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/document-bases/:baseId/documents", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json(
      (
        await listDocuments(db, workspaceId, c.req.param("baseId"), {
          viewerSubjectId: grant.subjectId,
        })
      ).map((document) => Document.parse(document)),
    );
  });

  app.delete(
    "/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
      try {
        await deleteDocumentFromBase(db, {
          accountId: grant.accountId,
          workspaceId,
          baseId: c.req.param("baseId"),
          documentId: c.req.param("documentId"),
          access: { viewerSubjectId: grant.subjectId },
        });
        return c.body(null, 204);
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw documentHttpException(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId/reindex",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
      if (!objectStorage) {
        throw new HTTPException(503, { message: "object storage is not configured" });
      }
      await requireLimit(deps, {
        accountId: grant.accountId,
        workspaceId,
        action: "document:index",
        quantity: 0,
      });
      try {
        const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
          viewerSubjectId: grant.subjectId,
        });
        if (!document) {
          throw new HTTPException(404, { message: "document not found" });
        }
        if (document.status !== "failed") {
          throw new HTTPException(422, { message: "only failed documents can be retried" });
        }
        if (document.baseId !== c.req.param("baseId")) {
          throw new HTTPException(404, { message: "document not found" });
        }
        const queued = await queueDocumentForReindex(db, workspaceId, document.id, {
          viewerSubjectId: grant.subjectId,
        });
        const indexed =
          (await documentIndexer.indexDocument({
            accountId: grant.accountId,
            workspaceId,
            documentId: document.id,
          })) ?? queued;
        if (indexed.status === "ready") {
          await recordWorkspaceUsage(deps, {
            accountId: grant.accountId,
            workspaceId,
            subjectId: grant.subjectId,
            eventType: "document.indexed",
            quantity: indexed.chunkCount,
            unit: "chunk",
            sourceResourceType: "document",
            sourceResourceId: indexed.id,
            idempotencyKey: `document.indexed:${workspaceId}:${indexed.id}:${indexed.updatedAt}`,
          });
        }
        return c.json(Document.parse(indexed));
      } catch (error) {
        if (error instanceof HTTPException) {
          throw error;
        }
        throw documentHttpException(error);
      }
    },
  );

  app.post("/v1/workspaces/:workspaceId/document-bases/:baseId/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const payload = DocumentSearchRequest.parse(await c.req.json());
    const base = await getDocumentBase(db, workspaceId, c.req.param("baseId"));
    if (!base) {
      throw new HTTPException(404, { message: "document base not found" });
    }
    return c.json({
      results: await searchDocuments(
        db,
        {
          workspaceId,
          baseIds: [base.id],
          query: payload.query,
          limit: payload.limit,
          mode: payload.mode,
          sourceKinds: payload.sourceKinds,
          aclTags: payload.aclTags,
          access: { viewerSubjectId: grant.subjectId },
        },
        getDocumentServices(),
      ),
    });
  });

  app.post("/v1/workspaces/:workspaceId/knowledge/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const payload = DocumentSearchRequest.parse(await c.req.json());
    return c.json({
      results: await searchDocuments(
        db,
        {
          workspaceId,
          query: payload.query,
          baseIds: payload.baseIds,
          limit: payload.limit,
          mode: payload.mode,
          sourceKinds: payload.sourceKinds,
          aclTags: payload.aclTags,
          access: { viewerSubjectId: grant.subjectId },
        },
        getDocumentServices(),
      ),
    });
  });

  // Knowledge drop: raw text or an uploaded file, no metadata required. Lands
  // in the workspace Default base with curationStatus 'pending'; indexing then
  // applies the configured curation provider, or leaves it as 'none' when
  // curation is disabled.
  app.post("/v1/workspaces/:workspaceId/knowledge/drops", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "document:index",
      quantity: 0,
    });
    const payload = CreateKnowledgeDropRequest.parse(await c.req.json());
    try {
      let fileId: string;
      if (payload.text !== undefined) {
        const bytes = new TextEncoder().encode(payload.text);
        await requireLimit(deps, {
          accountId: grant.accountId,
          workspaceId,
          action: "file:upload",
          quantity: bytes.length,
        });
        if (bytes.length > objectStorage.maxSinglePutSizeBytes) {
          throw new HTTPException(413, {
            message: `drop exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
          });
        }
        const filename = dropFilename(payload.filename ?? payload.title);
        const newFileId = crypto.randomUUID();
        const safeFilename = sanitizeFilename(filename);
        const objectKey = `workspaces/${workspaceId}/files/${newFileId}/original/${safeFilename}`;
        const upload = await createFileUpload(db, {
          accountId: grant.accountId,
          workspaceId,
          fileId: newFileId,
          filename,
          safeFilename,
          contentType: "text/plain; charset=utf-8",
          sizeBytes: bytes.length,
          sha256: null,
          bucket: objectStorage.bucket,
          objectKey,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        });
        await objectStorage.putObject({
          key: objectKey,
          contentType: "text/plain; charset=utf-8",
          body: bytes,
        });
        const file = await completeFileUpload(db, workspaceId, upload.uploadId);
        await recordWorkspaceUsage(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          eventType: "file.uploaded",
          quantity: file.sizeBytes,
          unit: "byte",
          sourceResourceType: "file",
          sourceResourceId: file.id,
          idempotencyKey: `file.uploaded:${workspaceId}:${file.id}`,
        });
        fileId = file.id;
      } else {
        fileId = payload.fileId as string;
      }
      const defaultBase = await ensureDefaultBase(db, {
        accountId: grant.accountId,
        workspaceId,
      });
      const document = await addDocumentToBase(db, {
        fileId,
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.visibility ? { visibility: payload.visibility } : {}),
        ...(payload.agentAccess !== undefined ? { agentAccess: payload.agentAccess } : {}),
        accountId: grant.accountId,
        workspaceId,
        baseId: defaultBase.id,
        createdBy: grant.subjectId,
        curationStatus: "pending",
        access: { viewerSubjectId: grant.subjectId },
      });
      const wasCreated =
        document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed =
        document.status === "ready"
          ? document
          : ((await documentIndexer.indexDocument({
              accountId: grant.accountId,
              workspaceId,
              documentId: document.id,
            })) ?? document);
      if (indexed.status === "ready") {
        await recordWorkspaceUsage(deps, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          eventType: "document.indexed",
          quantity: indexed.chunkCount,
          unit: "chunk",
          sourceResourceType: "document",
          sourceResourceId: indexed.id,
          idempotencyKey: `document.indexed:${workspaceId}:${indexed.id}:${indexed.updatedAt}`,
        });
      }
      return c.json(Document.parse(indexed), wasCreated ? 201 : 200);
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      throw documentHttpException(error);
    }
  });

  // Apply a curation suggestion (no body target) or move to an explicit base.
  app.post("/v1/workspaces/:workspaceId/documents/:documentId/move", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = MoveDocumentRequest.parse(await c.req.json().catch(() => ({})));
    try {
      const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
        viewerSubjectId: grant.subjectId,
      });
      if (!document) {
        throw new HTTPException(404, { message: "document not found" });
      }
      return c.json(
        Document.parse(
          await moveDocumentToBase(db, {
            accountId: grant.accountId,
            workspaceId,
            documentId: document.id,
            targetBaseId: payload.targetBaseId ?? null,
            access: { viewerSubjectId: grant.subjectId },
          }),
        ),
      );
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      throw documentHttpException(error);
    }
  });

  app.get("/v1/workspaces/:workspaceId/knowledge/memories", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const parsed = KnowledgeMemorySearchRequest.safeParse({
      query: c.req.query("query") || undefined,
      status: c.req.query("status") || undefined,
      kind: c.req.query("kind") || undefined,
      scope: c.req.query("scope") || undefined,
      scopeType: c.req.query("scopeType") || undefined,
      labels: c.req.queries("labels"),
      includeExpired: c.req.query("includeExpired")
        ? requestedBoolean(c.req.query("includeExpired"), "includeExpired")
        : undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid knowledge memory query parameters" });
    }
    return c.json(
      (
        await listKnowledgeMemories(db, workspaceId, {
          ...parsed.data,
          access: memoryAccess(requestContext),
        })
      ).map((memory) => KnowledgeMemory.parse(memory)),
    );
  });

  app.get("/v1/workspaces/:workspaceId/knowledge/memories/relationships", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const type = c.req.query("type")
      ? MemoryRelationshipType.safeParse(c.req.query("type"))
      : undefined;
    const memoryId = c.req.query("memoryId");
    if (type && !type.success) {
      throw new HTTPException(400, { message: "invalid memory relationship type" });
    }
    return c.json(
      (
        await listMemoryRelationships(db, workspaceId, {
          ...(memoryId ? { memoryId } : {}),
          ...(type?.success ? { type: type.data } : {}),
          access: memoryAccess(requestContext),
        })
      ).map((relationship) => MemoryRelationship.parse(relationship)),
    );
  });

  app.post("/v1/workspaces/:workspaceId/knowledge/memories/relationships", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const parsed = CreateMemoryRelationshipRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid memory relationship request" });
    }
    try {
      return c.json(
        MemoryRelationship.parse(
          await createMemoryRelationship(db, {
            accountId: grant.accountId,
            workspaceId,
            ...parsed.data,
            actorSessionId: requestContext.actorSessionId,
            access: memoryAccess(requestContext),
          }),
        ),
        201,
      );
    } catch (error) {
      throw memoryLifecycleHttpException(error);
    }
  });

  app.delete(
    "/v1/workspaces/:workspaceId/knowledge/memories/relationships/:relationshipId",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
      const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
      const deleted = await deleteMemoryRelationship(
        db,
        workspaceId,
        c.req.param("relationshipId"),
        memoryAccess(requestContext),
      );
      if (!deleted) {
        throw new HTTPException(404, { message: "memory relationship not found" });
      }
      return c.body(null, 204);
    },
  );

  app.get("/v1/workspaces/:workspaceId/knowledge/memories/export", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const includeEphemeral = requestedBoolean(c.req.query("includeEphemeral"), "includeEphemeral");
    const includePrivate = requestedBoolean(c.req.query("includePrivate"), "includePrivate");
    if (includePrivate) {
      requirePrivateMemoryAdmin(grant);
    }
    return c.json(
      MemoryExportResponse.parse(
        await exportWorkspaceMemories(db, workspaceId, {
          accountId: grant.accountId,
          access: memoryAccess(requestContext, includePrivate),
          includeEphemeral,
          actorSessionId: requestContext.actorSessionId,
        }),
      ),
    );
  });

  app.post("/v1/workspaces/:workspaceId/knowledge/memories/maintenance/preview", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const parsed = PreviewMemoryMaintenanceRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid memory maintenance preview request" });
    }
    try {
      return c.json(
        MemoryMaintenanceOperation.parse(
          await previewMemoryMaintenance(db, {
            accountId: grant.accountId,
            workspaceId,
            type: parsed.data.type,
            ...(parsed.data.terminalBefore
              ? { terminalBefore: new Date(parsed.data.terminalBefore) }
              : {}),
            ...(parsed.data.expiredBefore
              ? { expiredBefore: new Date(parsed.data.expiredBefore) }
              : {}),
            ...(parsed.data.memoryIds ? { memoryIds: parsed.data.memoryIds } : {}),
            actorSessionId: requestContext.actorSessionId,
            access: memoryAccess(requestContext, true),
          }),
        ),
        201,
      );
    } catch (error) {
      throw memoryLifecycleHttpException(error);
    }
  });

  app.post(
    "/v1/workspaces/:workspaceId/knowledge/memories/maintenance/:operationId/apply",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
      const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
      const parsed = ApplyMemoryMaintenanceRequest.safeParse(await c.req.json());
      if (!parsed.success) {
        throw new HTTPException(400, { message: "invalid memory maintenance apply request" });
      }
      try {
        return c.json(
          MemoryMaintenanceOperation.parse(
            await applyMemoryMaintenance(
              db,
              workspaceId,
              c.req.param("operationId"),
              parsed.data.planHash,
              memoryAccess(requestContext, true),
              { actorSessionId: requestContext.actorSessionId },
            ),
          ),
        );
      } catch (error) {
        throw memoryLifecycleHttpException(error);
      }
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/knowledge/memories/maintenance/:operationId/revert",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const grant = await requireAccessGrant(c, deps, workspaceId, "workspace:admin");
      const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
      const parsed = ApplyMemoryMaintenanceRequest.safeParse(await c.req.json());
      if (!parsed.success) {
        throw new HTTPException(400, { message: "invalid memory maintenance revert request" });
      }
      try {
        return c.json(
          MemoryMaintenanceOperation.parse(
            await revertMemoryMaintenance(
              db,
              workspaceId,
              c.req.param("operationId"),
              parsed.data.planHash,
              memoryAccess(requestContext, true),
              { actorSessionId: requestContext.actorSessionId },
            ),
          ),
        );
      } catch (error) {
        throw memoryLifecycleHttpException(error);
      }
    },
  );

  app.get("/v1/workspaces/:workspaceId/knowledge/memories/:memoryId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const memory = await getKnowledgeMemory(
      db,
      workspaceId,
      c.req.param("memoryId"),
      memoryAccess(requestContext),
    );
    if (!memory) {
      throw new HTTPException(404, { message: "knowledge memory not found" });
    }
    return c.json(KnowledgeMemory.parse(memory));
  });

  // Hybrid search over the workspace's agent-visible memory (active ∪ approved).
  // Available regardless of the workspace memory setting (human/audit lane).
  app.post("/v1/workspaces/:workspaceId/knowledge/memories/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const parsed = WorkspaceMemorySearchRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid workspace memory search request" });
    }
    const results = await searchWorkspaceMemories(
      db,
      workspaceId,
      {
        ...parsed.data,
        context: requestContext.sessionContext ?? { access: memoryAccess(requestContext) },
      },
      getDocumentServices().embedder,
    );
    return c.json(
      WorkspaceMemorySearchResponse.parse({
        results: results.map((result) => ({
          ...result,
          memory: KnowledgeMemory.parse(result.memory),
        })),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/knowledge/memories", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const parsedBody = CreateKnowledgeMemoryRequest.safeParse(await c.req.json());
    if (!parsedBody.success) {
      throw new HTTPException(400, { message: "invalid knowledge memory request" });
    }
    const payload = parsedBody.data;
    const scopeSpec = bindWritableMemoryScope(payload.scopeSpec, requestContext);
    const access = memoryAccess(requestContext);
    const actorSessionId = requestContext.actorSessionId;
    // status `active` (the default) is a memory write → route through the single
    // gate (sanitize + embed + dedup). Explicit proposed enters the curated
    // review lane; approved/rejected are update-only reviewed states.
    if (payload.status === "active") {
      try {
        const result = await saveWorkspaceMemory(
          db,
          {
            accountId: grant.accountId,
            workspaceId,
            text: payload.text,
            kind: payload.kind,
            confidence: payload.confidence,
            pinned: payload.pinned,
            scopeSpec,
            labels: payload.labels,
            sourceRefs: payload.sourceRefs,
            validFrom: payload.validFrom ? new Date(payload.validFrom) : undefined,
            validUntil:
              payload.validUntil === null
                ? null
                : payload.validUntil
                  ? new Date(payload.validUntil)
                  : undefined,
            replacesId: payload.replacesId ?? null,
            sessionId: actorSessionId,
            metadata: payload.metadata,
            origin: "human",
            access,
          },
          getDocumentServices().embedder,
        );
        return c.json(KnowledgeMemory.parse(result.memory), 201);
      } catch (error) {
        throw documentHttpException(error);
      }
    }
    return c.json(
      KnowledgeMemory.parse(
        await createKnowledgeMemory(db, {
          accountId: grant.accountId,
          workspaceId,
          status: payload.status,
          kind: payload.kind,
          scope: payload.scope,
          scopeSpec,
          labels: payload.labels,
          text: payload.text,
          sourceRefs: payload.sourceRefs,
          confidence: payload.confidence,
          metadata: payload.metadata,
          createdBySessionId: actorSessionId,
          validFrom: payload.validFrom ? new Date(payload.validFrom) : undefined,
          validUntil:
            payload.validUntil === null
              ? null
              : payload.validUntil
                ? new Date(payload.validUntil)
                : undefined,
          access,
        }),
      ),
      201,
    );
  });

  app.patch("/v1/workspaces/:workspaceId/knowledge/memories/:memoryId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const payload = UpdateKnowledgeMemoryRequest.parse(await c.req.json());
    const reviewedBy =
      payload.status === "approved" || payload.status === "rejected"
        ? (grant.subjectLabel ?? grant.subjectId)
        : undefined;
    try {
      return c.json(
        KnowledgeMemory.parse(
          await updateKnowledgeMemory(
            db,
            workspaceId,
            c.req.param("memoryId"),
            {
              status: payload.status,
              kind: payload.kind,
              scope: payload.scope,
              scopeSpec: bindWritableMemoryScope(payload.scopeSpec, requestContext),
              labels: payload.labels,
              text: payload.text,
              sourceRefs: payload.sourceRefs,
              confidence: payload.confidence,
              metadata: payload.metadata,
              pinned: payload.pinned,
              validFrom: payload.validFrom ? new Date(payload.validFrom) : undefined,
              validUntil:
                payload.validUntil === null
                  ? null
                  : payload.validUntil
                    ? new Date(payload.validUntil)
                    : undefined,
              access: memoryAccess(requestContext),
              ...(reviewedBy ? { reviewedBy } : {}),
            },
            getDocumentServices().embedder,
          ),
        ),
      );
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.delete("/v1/workspaces/:workspaceId/knowledge/memories/:memoryId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const includePrivate = requestedBoolean(c.req.query("includePrivate"), "includePrivate");
    if (includePrivate) {
      requirePrivateMemoryAdmin(grant);
    }
    try {
      return c.json(
        DeleteMemoryResponse.parse(
          await deleteWorkspaceMemory(db, {
            accountId: grant.accountId,
            workspaceId,
            memoryId: c.req.param("memoryId"),
            actorSessionId: requestContext.actorSessionId,
            access: memoryAccess(requestContext, includePrivate),
          }),
        ),
      );
    } catch (error) {
      throw memoryLifecycleHttpException(error);
    }
  });

  app.all("/v1/workspaces/:workspaceId/mcp/docs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const requestContext = await resolveMemoryRequestContext(db, workspaceId, grant);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildDocumentsMcpServer(
      db,
      grant.accountId,
      workspaceId,
      getDocumentServices(),
      {
        ...(requestContext.actorSessionId
          ? { createdBySessionId: requestContext.actorSessionId }
          : {}),
        access: memoryAccess(requestContext),
        viewerSubjectId: grant.subjectId,
      },
    );
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });
}

/** Derive a .txt filename for a raw-text drop from its optional title/filename. */
function dropFilename(preferred: string | undefined): string {
  const stem = (preferred ?? "").trim() || `note-${new Date().toISOString().slice(0, 10)}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(stem) ? stem : `${stem}.txt`;
}

function documentHttpException(error: unknown): HTTPException {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) {
    return new HTTPException(404, { message });
  }
  if (message.includes("already exists")) {
    return new HTTPException(409, { message });
  }
  if (message.includes("no suggested base")) {
    return new HTTPException(422, { message });
  }
  if (message.includes("pending") || message.includes("failed") || message.includes("deleted")) {
    return new HTTPException(422, { message });
  }
  // Workspace-memory write-gate rejections are client errors, not server faults.
  if (
    message.includes("too long") ||
    message.includes("visible memory is full") ||
    message.includes("empty after sanitization") ||
    message.includes("does not match") ||
    message.includes("Ambiguous memory id") ||
    message.includes("only reachable from proposed")
  ) {
    return new HTTPException(400, { message });
  }
  return new HTTPException(500, { message });
}

function memoryLifecycleHttpException(error: unknown): HTTPException {
  if (error instanceof HTTPException) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) {
    return new HTTPException(404, { message });
  }
  if (
    message.includes("plan hash") ||
    message.includes("status no longer") ||
    message.includes("precondition changed") ||
    message.includes("integrity validation")
  ) {
    return new HTTPException(409, { message });
  }
  if (
    message.includes("requires") ||
    message.includes("at most") ||
    message.includes("safety bound") ||
    message.includes("visible memories") ||
    message.includes("must be visible") ||
    message.includes("distinct memories")
  ) {
    return new HTTPException(422, { message });
  }
  return documentHttpException(error);
}
