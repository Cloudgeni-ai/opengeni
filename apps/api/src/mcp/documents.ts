import {
  getDocumentChunk,
  listDocumentBases,
  searchDocuments,
  type DocumentServices,
} from "@infra-agents/documents";
import type { Database } from "@infra-agents/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

export function buildDocumentsMcpServer(db: Database, documentServices: DocumentServices): McpServer {
  const server = new McpServer({
    name: "infra-agents-documents",
    version: "1.0.0",
  });

  server.registerTool("list_document_bases", {
    description: "List document bases available for retrieval.",
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify(await listDocumentBases(db)) }],
  }));

  server.registerTool("search_documents", {
    description: "Search indexed documents.",
    inputSchema: {
      query: z.string(),
      baseIds: z.array(z.string()).optional(),
      limit: z.number().optional(),
    },
  }, async ({ query, baseIds, limit }) => ({
    content: [{
      type: "text",
      text: JSON.stringify(await searchDocuments(db, {
        query,
        ...(baseIds ? { baseIds } : {}),
        ...(limit ? { limit } : {}),
      }, documentServices)),
    }],
  }));

  server.registerTool("fetch_document_chunk", {
    description: "Fetch one indexed document chunk by id.",
    inputSchema: {
      chunkId: z.string(),
    },
  }, async ({ chunkId }) => {
    const found = await getDocumentChunk(db, chunkId);
    return {
      content: [{ type: "text", text: found ? JSON.stringify(found) : `chunk not found: ${chunkId}` }],
      isError: !found,
    };
  });

  return server;
}
