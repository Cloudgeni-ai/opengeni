import { searchKnowledgeEntries } from "@opengeni/core";
import { KnowledgeEntryListRequest } from "@opengeni/contracts";
import type { DocumentServices } from "@opengeni/documents";
import {
  getKnowledgeEntry,
  listKnowledgeEntries,
  type KnowledgeContext,
  type Database,
} from "@opengeni/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

/** The docs endpoint is a transport for canonical Knowledge retrieval. Legacy
 * chunk/base retrieval is retired: it cannot bypass pending Knowledge review. */
export function buildDocumentsMcpServer(
  db: Database,
  accountId: string,
  workspaceId: string,
  documentServices: DocumentServices,
  options: { knowledge: KnowledgeContext },
): McpServer {
  const context = options.knowledge;
  if (context.accountId !== accountId || context.workspaceId !== workspaceId)
    throw new Error("Knowledge gateway authority mismatch");
  const server = new McpServer({ name: "opengeni-knowledge", version: "2.0.0" });
  server.registerTool(
    "knowledge_search",
    {
      description:
        "Search published structured Knowledge and retained source text in the current authorized scope.",
      inputSchema: KnowledgeEntryListRequest.omit({
        view: true,
        sessionId: true,
        reviewBatchId: true,
      }).shape,
    },
    async (input) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await searchKnowledgeEntries(db, context, input, () => documentServices.embedder),
          ),
        },
      ],
    }),
  );
  server.registerTool(
    "knowledge_browse",
    {
      description: "Browse Knowledge groups or entries in one group, across sources.",
      inputSchema: {
        groupId: z.uuid().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async (input) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await listKnowledgeEntries(db, context, {
              ...input,
              ...(input.groupId ? {} : { kind: "group" }),
            }),
          ),
        },
      ],
    }),
  );
  server.registerTool(
    "knowledge_get",
    {
      description:
        "Read an exact published Knowledge revision and its evidence. Long source text is paginated.",
      inputSchema: {
        entryId: z.uuid(),
        revisionId: z.uuid().optional(),
        offset: z.number().int().nonnegative().default(0),
        maxChars: z.number().int().positive().max(16000).default(8000),
      },
    },
    async (input) => {
      const record = await getKnowledgeEntry(db, context, input.entryId, {
        revisionId: input.revisionId,
      });
      if (!record) return { content: [{ type: "text", text: JSON.stringify({ found: false }) }] };
      const text = record.revision.entry.content;
      const end = Math.min(text.length, input.offset + input.maxChars);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...record,
              revision: {
                ...record.revision,
                entry: { ...record.revision.entry, content: text.slice(input.offset, end) },
              },
              contentRange: {
                start: input.offset,
                end,
                total: text.length,
                nextOffset: end < text.length ? end : null,
              },
            }),
          },
        ],
      };
    },
  );
  return server;
}
