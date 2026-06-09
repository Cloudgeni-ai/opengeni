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
} from "@opengeni/contracts";
import {
  createKnowledgeMemory,
  getKnowledgeMemory,
  listKnowledgeMemories,
  updateKnowledgeMemory,
} from "@opengeni/db";
import {
  addDocumentToBase,
  createDocumentBase,
  getDocument,
  getDocumentBase,
  listDocumentBases,
  listDocuments,
  searchDocuments,
} from "@opengeni/documents";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "../dependencies";
import { buildDocumentsMcpServer } from "../mcp/documents";

export function registerDocumentRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, objectStorage, documentIndexer, getDocumentServices } = deps;

  app.post("/v1/document-bases", async (c) => {
    const payload = CreateDocumentBaseRequest.parse(await c.req.json());
    return c.json(DocumentBase.parse(await createDocumentBase(db, payload)), 201);
  });

  app.get("/v1/document-bases", async (c) => {
    return c.json((await listDocumentBases(db)).map((base) => DocumentBase.parse(base)));
  });

  app.get("/v1/document-bases/:baseId", async (c) => {
    const base = await getDocumentBase(db, c.req.param("baseId"));
    if (!base) {
      throw new HTTPException(404, { message: "document base not found" });
    }
    return c.json(DocumentBase.parse(base));
  });

  app.post("/v1/document-bases/:baseId/documents", async (c) => {
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const payload = AddDocumentRequest.parse(await c.req.json());
    try {
      const document = await addDocumentToBase(db, { ...payload, baseId: c.req.param("baseId") });
      const wasCreated = document.status === "queued" && document.chunkCount === 0 && document.error === null;
      const indexed = document.status === "ready" ? document : (await documentIndexer.indexDocument({ documentId: document.id }) ?? document);
      return c.json(Document.parse(indexed), wasCreated ? 201 : 200);
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.get("/v1/document-bases/:baseId/documents", async (c) => {
    return c.json((await listDocuments(db, c.req.param("baseId"))).map((document) => Document.parse(document)));
  });

  app.post("/v1/documents/:documentId/reindex", async (c) => {
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    try {
      const document = await getDocument(db, c.req.param("documentId"));
      if (!document) {
        throw new HTTPException(404, { message: "document not found" });
      }
      if (document.status !== "failed") {
        throw new HTTPException(422, { message: "only failed documents can be retried" });
      }
      return c.json(Document.parse(await documentIndexer.indexDocument({ documentId: document.id }) ?? document));
    } catch (error) {
      if (error instanceof HTTPException) {
        throw error;
      }
      throw documentHttpException(error);
    }
  });

  app.post("/v1/document-bases/:baseId/search", async (c) => {
    const payload = DocumentSearchRequest.parse(await c.req.json());
    const base = await getDocumentBase(db, c.req.param("baseId"));
    if (!base) {
      throw new HTTPException(404, { message: "document base not found" });
    }
    return c.json({
      results: await searchDocuments(db, {
        baseIds: [base.id],
        query: payload.query,
        limit: payload.limit,
        mode: payload.mode,
        sourceKinds: payload.sourceKinds,
        aclTags: payload.aclTags,
      }, getDocumentServices()),
    });
  });

  app.post("/v1/knowledge/search", async (c) => {
    const payload = DocumentSearchRequest.parse(await c.req.json());
    return c.json({
      results: await searchDocuments(db, {
        query: payload.query,
        baseIds: payload.baseIds,
        limit: payload.limit,
        mode: payload.mode,
        sourceKinds: payload.sourceKinds,
        aclTags: payload.aclTags,
      }, getDocumentServices()),
    });
  });

  app.get("/v1/knowledge/memories", async (c) => {
    const payload = KnowledgeMemorySearchRequest.parse({
      query: c.req.query("query") || undefined,
      status: c.req.query("status") || undefined,
      kind: c.req.query("kind") || undefined,
      scope: c.req.query("scope") || undefined,
      limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
    });
    return c.json((await listKnowledgeMemories(db, payload)).map((memory) => KnowledgeMemory.parse(memory)));
  });

  app.get("/v1/knowledge/memories/:memoryId", async (c) => {
    const memory = await getKnowledgeMemory(db, c.req.param("memoryId"));
    if (!memory) {
      throw new HTTPException(404, { message: "knowledge memory not found" });
    }
    return c.json(KnowledgeMemory.parse(memory));
  });

  app.post("/v1/knowledge/memories", async (c) => {
    const payload = CreateKnowledgeMemoryRequest.parse(await c.req.json());
    return c.json(KnowledgeMemory.parse(await createKnowledgeMemory(db, payload)), 201);
  });

  app.patch("/v1/knowledge/memories/:memoryId", async (c) => {
    const payload = UpdateKnowledgeMemoryRequest.parse(await c.req.json());
    const reviewedBy = payload.reviewedBy ?? (payload.status === "approved" || payload.status === "rejected" ? "api" : undefined);
    try {
      return c.json(KnowledgeMemory.parse(await updateKnowledgeMemory(db, c.req.param("memoryId"), {
        ...payload,
        ...(reviewedBy ? { reviewedBy } : {}),
      })));
    } catch (error) {
      throw documentHttpException(error);
    }
  });

  app.all("/v1/mcp/docs", async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = buildDocumentsMcpServer(db, getDocumentServices());
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
  return new HTTPException(500, { message });
}
