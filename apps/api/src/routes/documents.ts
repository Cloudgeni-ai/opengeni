import {
  AddDocumentRequest,
  CreateKnowledgeDropRequest,
  CreateKnowledgeMemoryRequest,
  CreateDocumentBaseRequest,
  Document,
  DocumentAuthorityReclassification,
  DocumentBase,
  DocumentSearchRequest,
  DocumentSearchResponse,
  KnowledgeMemory,
  KnowledgeMemorySearchRequest,
  MoveDocumentRequest,
  ReclassifyDocumentAuthorityRequest,
  UpdateKnowledgeMemoryRequest,
  WorkspaceMemorySearchRequest,
  WorkspaceMemorySearchResponse,
} from "@opengeni/contracts";
import {
  completeFileUpload,
  createFileUpload,
  createKnowledgeMemory,
  getKnowledgeMemory,
  listKnowledgeMemories,
  updateKnowledgeMemory,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
} from "@opengeni/db";
import {
  addDocumentToBase,
  createDocumentBase,
  deleteDocumentFromBase,
  ensureDefaultBase,
  getDocument,
  getDocumentBase,
  listDocumentBasesEnsuringDefault,
  listDocuments,
  moveDocumentToBase,
  queueDocumentForReindex,
  reclassifyDocumentAuthority,
  searchEffectiveDocuments,
} from "@opengeni/documents";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant, requireAccessGrantAuthorization } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildDocumentsMcpServer } from "../mcp/documents";
import { sanitizeFilename } from "./files";

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
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json(
      (
        await listDocumentBasesEnsuringDefault(db, {
          accountId: grant.accountId,
          workspaceId,
        })
      ).map((base) => DocumentBase.parse(base)),
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
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "documents:manage");
    const { grant } = access;
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
    const organizationAuthorityGranted =
      access.accountGrant?.permissions.includes("account:admin") === true;
    if (payload.authorityKind === "organization" && !organizationAuthorityGranted) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
    try {
      const document = await addDocumentToBase(db, {
        ...payload,
        accountId: grant.accountId,
        workspaceId,
        baseId: c.req.param("baseId"),
        createdBy: grant.subjectId,
        initiatingSubjectId: grant.subjectId,
        organizationAuthorityGranted,
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
              authorityKind: document.authorityKind,
              authorityWorkspaceId: document.authorityWorkspaceId,
              authoritySubjectId: document.authoritySubjectId,
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

  app.post(
    "/v1/workspaces/:workspaceId/documents/:documentId/authority-reclassifications",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const access = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "documents:manage",
      );
      const payload = ReclassifyDocumentAuthorityRequest.parse(await c.req.json());
      try {
        return c.json(
          DocumentAuthorityReclassification.parse(
            await reclassifyDocumentAuthority(db, {
              ...payload,
              accountId: access.grant.accountId,
              workspaceId,
              documentId: c.req.param("documentId"),
              actorSubjectId: access.grant.subjectId,
              organizationAuthorityGranted: hasAccountAdminAuthority(access),
            }),
          ),
        );
      } catch (error) {
        throw documentHttpException(error);
      }
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId",
    async (c) => {
      const workspaceId = c.req.param("workspaceId");
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "documents:manage",
      );
      const { grant } = authorization;
      const organizationAuthorityGranted = hasAccountAdminAuthority(authorization);
      try {
        const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
          viewerSubjectId: grant.subjectId,
        });
        if (!document || document.baseId !== c.req.param("baseId")) {
          throw new HTTPException(404, { message: "document not found" });
        }
        requireOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
        await deleteDocumentFromBase(db, {
          accountId: grant.accountId,
          workspaceId,
          baseId: c.req.param("baseId"),
          documentId: c.req.param("documentId"),
          organizationAuthorityGranted,
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
      const authorization = await requireAccessGrantAuthorization(
        c,
        deps,
        workspaceId,
        "documents:manage",
      );
      const { grant } = authorization;
      const organizationAuthorityGranted = hasAccountAdminAuthority(authorization);
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
        requireOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
        if (document.status !== "failed") {
          throw new HTTPException(422, { message: "only failed documents can be retried" });
        }
        if (document.baseId !== c.req.param("baseId")) {
          throw new HTTPException(404, { message: "document not found" });
        }
        const queued = await queueDocumentForReindex(
          db,
          workspaceId,
          document.id,
          {
            viewerSubjectId: grant.subjectId,
          },
          organizationAuthorityGranted,
        );
        const indexed =
          (await documentIndexer.indexDocument({
            accountId: grant.accountId,
            workspaceId,
            documentId: document.id,
            authorityKind: document.authorityKind,
            authorityWorkspaceId: document.authorityWorkspaceId,
            authoritySubjectId: document.authoritySubjectId,
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
    return c.json(
      DocumentSearchResponse.parse({
        results: await searchEffectiveDocuments(
          db,
          {
            accountId: grant.accountId,
            workspaceId,
            baseIds: [base.id],
            query: payload.query,
            limit: payload.limit,
            mode: payload.mode,
            sourceKinds: payload.sourceKinds,
            aclTags: payload.aclTags,
            initiatingSubjectId: grant.subjectId,
            surface: "human",
          },
          getDocumentServices(),
        ),
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/knowledge/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const payload = await parseDocumentSearchRequest(c, "invalid knowledge search request");
    return c.json(
      DocumentSearchResponse.parse({
        results: await searchEffectiveDocuments(
          db,
          {
            accountId: grant.accountId,
            workspaceId,
            query: payload.query,
            baseIds: payload.baseIds,
            limit: payload.limit,
            mode: payload.mode,
            sourceKinds: payload.sourceKinds,
            aclTags: payload.aclTags,
            initiatingSubjectId: grant.subjectId,
            surface: "human",
          },
          getDocumentServices(),
        ),
      }),
    );
  });

  // Knowledge drop: raw text or an uploaded file, no metadata required. Lands
  // in the workspace Default base with curationStatus 'pending'; indexing then
  // applies the configured curation provider, or leaves it as 'none' when
  // curation is disabled.
  app.post("/v1/workspaces/:workspaceId/knowledge/drops", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const access = await requireAccessGrantAuthorization(c, deps, workspaceId, "documents:manage");
    const { grant } = access;
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
    const organizationAuthorityGranted =
      access.accountGrant?.permissions.includes("account:admin") === true;
    if (payload.authorityKind === "organization" && !organizationAuthorityGranted) {
      throw new HTTPException(403, { message: "missing permission: account:admin" });
    }
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
        ...(payload.authorityKind ? { authorityKind: payload.authorityKind } : {}),
        ...(payload.visibility ? { visibility: payload.visibility } : {}),
        ...(payload.agentAccess !== undefined ? { agentAccess: payload.agentAccess } : {}),
        accountId: grant.accountId,
        workspaceId,
        baseId: defaultBase.id,
        createdBy: grant.subjectId,
        initiatingSubjectId: grant.subjectId,
        organizationAuthorityGranted,
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
              authorityKind: document.authorityKind,
              authorityWorkspaceId: document.authorityWorkspaceId,
              authoritySubjectId: document.authoritySubjectId,
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
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "documents:manage",
    );
    const { grant } = authorization;
    const organizationAuthorityGranted = hasAccountAdminAuthority(authorization);
    const payload = MoveDocumentRequest.parse(await c.req.json().catch(() => ({})));
    try {
      const document = await getDocument(db, workspaceId, c.req.param("documentId"), {
        viewerSubjectId: grant.subjectId,
      });
      if (!document) {
        throw new HTTPException(404, { message: "document not found" });
      }
      requireOrganizationDocumentAuthority(document.authorityKind, organizationAuthorityGranted);
      return c.json(
        Document.parse(
          await moveDocumentToBase(db, {
            accountId: grant.accountId,
            workspaceId,
            documentId: document.id,
            targetBaseId: payload.targetBaseId ?? null,
            organizationAuthorityGranted,
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
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const parsed = KnowledgeMemorySearchRequest.safeParse({
      query: c.req.query("query") || undefined,
      status: c.req.query("status") || undefined,
      kind: c.req.query("kind") || undefined,
      scope: c.req.query("scope") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid knowledge memory query parameters" });
    }
    return c.json(
      (await listKnowledgeMemories(db, workspaceId, parsed.data)).map((memory) =>
        KnowledgeMemory.parse(memory),
      ),
    );
  });

  app.get("/v1/workspaces/:workspaceId/knowledge/memories/:memoryId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const memory = await getKnowledgeMemory(db, workspaceId, c.req.param("memoryId"));
    if (!memory) {
      throw new HTTPException(404, { message: "knowledge memory not found" });
    }
    return c.json(KnowledgeMemory.parse(memory));
  });

  // Hybrid search over the workspace's agent-visible memory (active ∪ approved).
  // Available regardless of the workspace memory setting (human/audit lane).
  app.post("/v1/workspaces/:workspaceId/knowledge/memories/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const parsed = WorkspaceMemorySearchRequest.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid workspace memory search request" });
    }
    const results = await searchWorkspaceMemories(
      db,
      workspaceId,
      parsed.data,
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
    const parsedBody = CreateKnowledgeMemoryRequest.safeParse(await c.req.json());
    if (!parsedBody.success) {
      throw new HTTPException(400, { message: "invalid knowledge memory request" });
    }
    const payload = parsedBody.data;
    // status `active` (the default) is a memory write → route through the single
    // gate (sanitize + embed + dedup). Explicit proposed/approved/rejected keeps
    // the legacy curated create.
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
            replacesId: payload.replacesId ?? null,
            metadata: payload.metadata,
            origin: "human",
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
          ...payload,
          accountId: grant.accountId,
          workspaceId,
        }),
      ),
      201,
    );
  });

  app.patch("/v1/workspaces/:workspaceId/knowledge/memories/:memoryId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = UpdateKnowledgeMemoryRequest.parse(await c.req.json());
    const reviewedBy =
      payload.reviewedBy ??
      (payload.status === "approved" || payload.status === "rejected"
        ? (grant.subjectLabel ?? grant.subjectId)
        : undefined);
    try {
      return c.json(
        KnowledgeMemory.parse(
          await updateKnowledgeMemory(
            db,
            workspaceId,
            c.req.param("memoryId"),
            {
              ...payload,
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

  app.all("/v1/workspaces/:workspaceId/mcp/docs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const sessionId =
      typeof grant.metadata?.sessionId === "string" ? grant.metadata.sessionId : undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildDocumentsMcpServer(
      db,
      grant.accountId,
      workspaceId,
      getDocumentServices(),
      { createdBySessionId: sessionId, initiatingSubjectId: grant.subjectId },
    );
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });
}

async function parseDocumentSearchRequest(
  context: Context,
  message: string,
): Promise<DocumentSearchRequest> {
  const parsed = DocumentSearchRequest.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    throw new HTTPException(422, { message });
  }
  return parsed.data;
}

/** Derive a .txt filename for a raw-text drop from its optional title/filename. */
function dropFilename(preferred: string | undefined): string {
  const stem = (preferred ?? "").trim() || `note-${new Date().toISOString().slice(0, 10)}`;
  return /\.[A-Za-z0-9]{1,8}$/.test(stem) ? stem : `${stem}.txt`;
}

function documentHttpException(error: unknown): HTTPException {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("organization document") && message.includes("exact account authority")) {
    return new HTTPException(403, { message: "missing permission: account:admin" });
  }
  if (message.includes("not found")) {
    return new HTTPException(404, { message });
  }
  if (message.includes("already exists")) {
    return new HTTPException(409, { message });
  }
  if (
    message.includes("operationId was reused") ||
    message.includes("no longer matches expectedAuthority") ||
    message.includes("changed before reclassification")
  ) {
    return new HTTPException(409, { message });
  }
  if (
    message.includes("authority tuple is ambiguous") ||
    message.includes("authority must remain in the originating workspace") ||
    message.includes("requires a canonical actor subject") ||
    message.includes("requires a UUID operationId")
  ) {
    return new HTTPException(422, { message });
  }
  if (message.includes("original creating subject")) {
    return new HTTPException(403, { message });
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
    message.includes("Ambiguous memory id")
  ) {
    return new HTTPException(400, { message });
  }
  return new HTTPException(500, { message });
}

function hasAccountAdminAuthority(
  authorization: Awaited<ReturnType<typeof requireAccessGrantAuthorization>>,
): boolean {
  return authorization.accountGrant?.permissions.includes("account:admin") === true;
}

function requireOrganizationDocumentAuthority(
  authorityKind: string,
  organizationAuthorityGranted: boolean,
): void {
  if (authorityKind === "organization" && !organizationAuthorityGranted) {
    throw new HTTPException(403, { message: "missing permission: account:admin" });
  }
}
