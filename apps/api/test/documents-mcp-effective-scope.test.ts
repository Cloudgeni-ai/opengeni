import { afterAll, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fakeDb = {};
const searchInputs: unknown[] = [];
const listInputs: unknown[] = [];
const realDocuments = await import("@opengeni/documents");
const realSearchEffectiveDocuments = realDocuments.searchEffectiveDocuments;
const realListEffectiveIndexedDocuments = realDocuments.listEffectiveIndexedDocuments;

mock.module("@opengeni/documents", () => ({
  ...realDocuments,
  searchEffectiveDocuments: mock(
    async (...args: Parameters<typeof realSearchEffectiveDocuments>) => {
      if (args[0] !== fakeDb) return await realSearchEffectiveDocuments(...args);
      searchInputs.push(args[1]);
      return [];
    },
  ),
  listEffectiveIndexedDocuments: mock(
    async (...args: Parameters<typeof realListEffectiveIndexedDocuments>) => {
      if (args[0] !== fakeDb) return await realListEffectiveIndexedDocuments(...args);
      listInputs.push(args[1]);
      return {
        documents: [],
        nextCheckpoint: "checkpoint-2",
        hasMore: false,
      };
    },
  ),
}));

const { buildDocumentsMcpServer } = await import("../src/mcp/documents");

afterAll(() => {
  mock.restore();
});

test("docs MCP binds checkpointed document listing to its immutable initiating subject", async () => {
  const server = buildDocumentsMcpServer(
    fakeDb as never,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    {} as never,
    { initiatingSubjectId: "user:initiator" },
  );
  const client = new Client({ name: "documents-index-checkpoint-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "list_indexed_documents",
      arguments: {
        checkpoint: "checkpoint-1",
        limit: 17,
        initiatingSubjectId: "user:forged",
        viewerSubjectId: "user:forged",
      },
    });
    const text = result.content.find((entry) => entry.type === "text");
    if (!text || text.type !== "text") throw new Error("missing MCP text result");
    expect(JSON.parse(text.text)).toEqual({
      documents: [],
      nextCheckpoint: "checkpoint-2",
      hasMore: false,
    });
    expect(listInputs).toEqual([
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        initiatingSubjectId: "user:initiator",
        checkpoint: "checkpoint-1",
        limit: 17,
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("docs MCP binds effective retrieval to its immutable initiating subject", async () => {
  const server = buildDocumentsMcpServer(
    fakeDb as never,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    {} as never,
    { initiatingSubjectId: "user:initiator" },
  );
  const client = new Client({ name: "documents-effective-scope-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "knowledge_search",
      arguments: {
        query: "network policy",
        mode: "keyword",
        initiatingSubjectId: "user:forged",
        viewerSubjectId: "user:forged",
        access: { viewerSubjectId: "user:forged", agentOnly: false },
      },
    });
    const text = result.content.find((entry) => entry.type === "text");
    if (!text || text.type !== "text") throw new Error("missing MCP text result");
    expect(JSON.parse(text.text)).toEqual({ results: [] });
    expect(searchInputs).toEqual([
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        query: "network policy",
        mode: "keyword",
        initiatingSubjectId: "user:initiator",
        surface: "agent",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
