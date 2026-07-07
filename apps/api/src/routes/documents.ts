import {
  AddDocumentRequest,
  CreateKnowledgeMemoryRequest,
  CreateDocumentBaseRequest,
  Document,
  DocumentBase,
  DocumentSearchRequest,
  KnowledgeMemory,
  KnowledgeMemorySearchRequest,
  UpdateKnowledgeMemoryRequest,
  WorkspaceMemorySearchRequest,
  WorkspaceMemorySearchResponse,
} from "@opengeni/contracts";
import {
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
  getDocument,
  getDocumentBase,
  listDocumentBases,
  listDocuments,
  queueDocumentForReindex,
  searchDocuments,
} from "@opengeni/documents";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildDocumentsMcpServer } from "../mcp/documents";

export function registerDocumentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, objectStorage, documentIndexer, getDocumentServices } = deps;

  app.post("/v1/workspaces/:workspaceId/document-bases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = CreateDocumentBaseRequest.parse(await c.req.json());
    return c.json(DocumentBase.parse(await createDocumentBase(db, { ...payload, accountId: grant.accountId, workspaceId })), 201);
  });

  app.get("/v1/workspaces/:workspaceId/document-bases", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json((await listDocumentBases(db, workspaceId)).map((base) => DocumentBase.parse(base)));
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
    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "document:index", quantity: 0 });
    const payload = AddDocumentRequest.parse(await c.req.json());
    try {
      const document = await addDocumentToBase(db, { ...payload, accountId: grant.accountId, workspaceId, baseId: c.req.param("baseId") });
      const wasCreated = document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed = document.status === "ready" ? document : (await documentIndexer.indexDocument({ accountId: grant.accountId, workspaceId, documentId: document.id }) ?? document);
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
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    return c.json((await listDocuments(db, workspaceId, c.req.param("baseId"))).map((document) => Document.parse(document)));
  });

  app.delete("/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    try {
      await deleteDocumentFromBase(db, {
        accountId: grant.accountId,
        workspaceId,
        baseId: c.req.param("baseId"),
        documentId: c.req.param("documentId"),
      });
      return c.body(null, 204);
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.post("/v1/workspaces/:workspaceId/document-bases/:baseId/documents/:documentId/reindex", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "document:index", quantity: 0 });
    try {
      const document = await getDocument(db, workspaceId, c.req.param("documentId"));
      if (!document) {
        throw new HTTPException(404, { message: "document not found" });
      }
      if (document.status !== "failed") {
        throw new HTTPException(422, { message: "only failed documents can be retried" });
      }
      if (document.baseId !== c.req.param("baseId")) {
        throw new HTTPException(404, { message: "document not found" });
      }
      const queued = await queueDocumentForReindex(db, workspaceId, document.id);
      const indexed = await documentIndexer.indexDocument({ accountId: grant.accountId, workspaceId, documentId: document.id }) ?? queued;
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
  });

  app.post("/v1/workspaces/:workspaceId/document-bases/:baseId/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const payload = DocumentSearchRequest.parse(await c.req.json());
    const base = await getDocumentBase(db, workspaceId, c.req.param("baseId"));
    if (!base) {
      throw new HTTPException(404, { message: "document base not found" });
    }
    return c.json({
      results: await searchDocuments(db, {
        workspaceId,
        baseIds: [base.id],
        query: payload.query,
        limit: payload.limit,
        mode: payload.mode,
        sourceKinds: payload.sourceKinds,
        aclTags: payload.aclTags,
      }, getDocumentServices()),
    });
  });

  app.post("/v1/workspaces/:workspaceId/knowledge/search", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const payload = DocumentSearchRequest.parse(await c.req.json());
    return c.json({
      results: await searchDocuments(db, {
        workspaceId,
        query: payload.query,
        baseIds: payload.baseIds,
        limit: payload.limit,
        mode: payload.mode,
        sourceKinds: payload.sourceKinds,
        aclTags: payload.aclTags,
      }, getDocumentServices()),
    });
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
    return c.json((await listKnowledgeMemories(db, workspaceId, parsed.data)).map((memory) => KnowledgeMemory.parse(memory)));
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
    const results = await searchWorkspaceMemories(db, workspaceId, parsed.data, getDocumentServices().embedder);
    return c.json(WorkspaceMemorySearchResponse.parse({
      results: results.map((result) => ({ ...result, memory: KnowledgeMemory.parse(result.memory) })),
    }));
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
        const result = await saveWorkspaceMemory(db, {
          accountId: grant.accountId,
          workspaceId,
          text: payload.text,
          kind: payload.kind,
          confidence: payload.confidence,
          pinned: payload.pinned,
          replacesId: payload.replacesId ?? null,
          origin: "human",
        }, getDocumentServices().embedder);
        return c.json(KnowledgeMemory.parse(result.memory), 201);
      } catch (error) {
        throw documentHttpException(error);
      }
    }
    return c.json(KnowledgeMemory.parse(await createKnowledgeMemory(db, {
      ...payload,
      accountId: grant.accountId,
      workspaceId,
    })), 201);
  });

  app.patch("/v1/workspaces/:workspaceId/knowledge/memories/:memoryId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:manage");
    const payload = UpdateKnowledgeMemoryRequest.parse(await c.req.json());
    const reviewedBy = payload.reviewedBy
      ?? (payload.status === "approved" || payload.status === "rejected" ? grant.subjectLabel ?? grant.subjectId : undefined);
    try {
      return c.json(KnowledgeMemory.parse(await updateKnowledgeMemory(db, workspaceId, c.req.param("memoryId"), {
        ...payload,
        ...(reviewedBy ? { reviewedBy } : {}),
      }, getDocumentServices().embedder)));
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.all("/v1/workspaces/:workspaceId/mcp/docs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "documents:search");
    const sessionId = typeof grant.metadata?.sessionId === "string" ? grant.metadata.sessionId : undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildDocumentsMcpServer(db, grant.accountId, workspaceId, getDocumentServices(), { createdBySessionId: sessionId });
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  });
}

function documentHttpException(error: unknown): HTTPException {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not found")) {
    return new HTTPException(404, { message });
  }
  if (message.includes("pending") || message.includes("failed") || message.includes("deleted")) {
    return new HTTPException(422, { message });
  }
  // Workspace-memory write-gate rejections are client errors, not server faults.
  if (
    message.includes("too long")
    || message.includes("visible memory is full")
    || message.includes("empty after sanitization")
    || message.includes("does not match")
    || message.includes("Ambiguous memory id")
  ) {
    return new HTTPException(400, { message });
  }
  return new HTTPException(500, { message });
}
