import {
  getDocumentChunk,
  listDocumentBases,
  searchDocuments,
  type DocumentServices,
} from "@opengeni/documents";
import {
  createKnowledgeMemory,
  listKnowledgeMemories,
  type Database,
} from "@opengeni/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

const SearchInputSchema = {
  query: z.string().min(1),
  baseIds: z.array(z.string().uuid()).optional(),
  limit: z.number().int().positive().max(50).optional(),
  mode: z.enum(["hybrid", "vector", "keyword"]).optional(),
  sourceKinds: z.array(z.enum(["manual_upload", "meeting_transcript", "repository", "email", "chat", "document", "web", "other"])).optional(),
  aclTags: z.array(z.string().min(1)).optional(),
};

const MemoryKindSchema = z.enum(["semantic", "episodic", "procedural", "decision", "preference"]);
const SourceRefSchema = z.object({
  kind: z.enum(["document_chunk", "document", "session_event", "memory", "external"]),
  id: z.string().min(1),
  uri: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export function buildDocumentsMcpServer(
  db: Database,
  accountId: string,
  workspaceId: string,
  documentServices: DocumentServices,
  options: { createdBySessionId?: string | undefined } = {},
): McpServer {
  const server = new McpServer({
    name: "opengeni-documents",
    version: "1.0.0",
  });

  server.registerTool("list_document_bases", {
    description: "List document bases available for retrieval.",
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(await listDocumentBases(db, workspaceId)) }],
  }));

  server.registerTool("search_documents", {
    description: "Search indexed documents with hybrid, vector, or keyword retrieval.",
    inputSchema: SearchInputSchema,
  }, async (input) => searchContent(db, workspaceId, documentServices, input));

  server.registerTool("knowledge_search", {
    description: "Search company knowledge sources with optional base, source-kind, ACL, and retrieval-mode filters.",
    inputSchema: SearchInputSchema,
  }, async (input) => searchContent(db, workspaceId, documentServices, input));

  server.registerTool("fetch_document_chunk", {
    description: "Fetch one indexed document chunk by id.",
    inputSchema: {
      chunkId: z.string().uuid(),
    },
  }, async ({ chunkId }) => {
    const found = await getDocumentChunk(db, workspaceId, chunkId);
    return {
      content: [{ type: "text", text: found ? JSON.stringify(found) : `chunk not found: ${chunkId}` }],
      isError: !found,
    };
  });

  server.registerTool("knowledge_fetch", {
    description: "Fetch one knowledge source chunk by id.",
    inputSchema: {
      chunkId: z.string().uuid(),
    },
  }, async ({ chunkId }) => {
    const found = await getDocumentChunk(db, workspaceId, chunkId);
    return {
      content: [{ type: "text", text: found ? JSON.stringify(found) : `chunk not found: ${chunkId}` }],
      isError: !found,
    };
  });

  server.registerTool("memory_search", {
    description: "Search approved company memory records.",
    inputSchema: {
      query: z.string().min(1).optional(),
      kind: MemoryKindSchema.optional(),
      scope: z.string().min(1).optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
  }, async ({ query, kind, scope, limit }) => ({
    content: [{ type: "text", text: JSON.stringify(await listKnowledgeMemories(db, workspaceId, {
      ...(query ? { query } : {}),
      status: ["active", "approved"],
      ...(kind ? { kind } : {}),
      ...(scope ? { scope } : {}),
      ...(limit ? { limit } : {}),
    })) }],
  }));

  server.registerTool("memory_propose", {
    description: "Propose a company memory record for human review.",
    inputSchema: {
      text: z.string().min(1),
      kind: MemoryKindSchema.optional(),
      scope: z.string().min(1).optional(),
      sourceRefs: z.array(SourceRefSchema).optional(),
      confidence: z.number().min(0).max(1).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
  }, async ({ text, kind, scope, sourceRefs, confidence, metadata }) => ({
    content: [{ type: "text", text: JSON.stringify(await createKnowledgeMemory(db, {
      accountId,
      workspaceId,
      status: "proposed",
      kind: kind ?? "semantic",
      scope: scope ?? "workspace",
      text,
      sourceRefs: sourceRefs?.map((sourceRef) => ({ ...sourceRef, metadata: sourceRef.metadata ?? {} })) ?? [],
      confidence: confidence ?? 0.5,
      metadata: metadata ?? {},
      createdBySessionId: options.createdBySessionId,
    })) }],
  }));

  return server;
}

async function searchContent(
  db: Database,
  workspaceId: string,
  documentServices: DocumentServices,
  input: {
    query: string;
    baseIds?: string[] | undefined;
    limit?: number | undefined;
    mode?: "hybrid" | "vector" | "keyword" | undefined;
    sourceKinds?: Array<"manual_upload" | "meeting_transcript" | "repository" | "email" | "chat" | "document" | "web" | "other"> | undefined;
    aclTags?: string[] | undefined;
  },
) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(await searchDocuments(db, {
        workspaceId,
        query: input.query,
        ...(input.baseIds ? { baseIds: input.baseIds } : {}),
        ...(input.limit ? { limit: input.limit } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.sourceKinds ? { sourceKinds: input.sourceKinds } : {}),
        ...(input.aclTags ? { aclTags: input.aclTags } : {}),
      }, documentServices)),
    }],
  };
}
