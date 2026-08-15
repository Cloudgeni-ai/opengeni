import { afterAll, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const fakeDb = {};
const searchInputs: unknown[] = [];
const listInputs: unknown[] = [];
const getInputs: unknown[] = [];
const browseInputs: unknown[] = [];
const realDocuments = await import("@opengeni/documents");
const realSearchEffectiveDocuments = realDocuments.searchEffectiveDocuments;
const realSearchEffectiveKnowledge = realDocuments.searchEffectiveKnowledge;
const realListEffectiveIndexedDocuments = realDocuments.listEffectiveIndexedDocuments;
const realGetEffectiveKnowledgeRecord = realDocuments.getEffectiveKnowledgeRecord;
const realBrowseEffectiveKnowledge = realDocuments.browseEffectiveKnowledge;

mock.module("@opengeni/documents", () => ({
  ...realDocuments,
  searchEffectiveDocuments: mock(
    async (...args: Parameters<typeof realSearchEffectiveDocuments>) => {
      if (args[0] !== fakeDb) return await realSearchEffectiveDocuments(...args);
      searchInputs.push(args[1]);
      return [];
    },
  ),
  searchEffectiveKnowledge: mock(
    async (...args: Parameters<typeof realSearchEffectiveKnowledge>) => {
      if (args[0] !== fakeDb) return await realSearchEffectiveKnowledge(...args);
      searchInputs.push(args[1]);
      return { results: [] };
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
  getEffectiveKnowledgeRecord: mock(
    async (...args: Parameters<typeof realGetEffectiveKnowledgeRecord>) => {
      if (args[0] !== fakeDb) return await realGetEffectiveKnowledgeRecord(...args);
      getInputs.push(args[1]);
      return null;
    },
  ),
  browseEffectiveKnowledge: mock(
    async (...args: Parameters<typeof realBrowseEffectiveKnowledge>) => {
      if (args[0] !== fakeDb) return await realBrowseEffectiveKnowledge(...args);
      browseInputs.push(args[1]);
      return { records: [], nextCursor: null, hasMore: false };
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

test("docs MCP binds personal-document reads to the exact session attempt", async () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const attemptId = "44444444-4444-4444-8444-444444444444";
  const start = searchInputs.length;
  const server = buildDocumentsMcpServer(
    fakeDb as never,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    {} as never,
    { initiatingSubjectId: "user:initiator", createdBySessionId: sessionId, attemptId },
  );
  const client = new Client({ name: "documents-attempt-authority-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({
      name: "knowledge_search",
      arguments: { query: "personal evidence", mode: "keyword" },
    });
    expect(searchInputs.slice(start)).toEqual([
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        query: "personal evidence",
        mode: "keyword",
        initiatingSubjectId: "user:initiator",
        agentAuthority: { sessionId, attemptId },
        surface: "agent",
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("docs MCP rebinds Knowledge fetch and browse to its immutable initiating subject", async () => {
  const server = buildDocumentsMcpServer(
    fakeDb as never,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    {} as never,
    { initiatingSubjectId: "user:initiator" },
  );
  const client = new Client({ name: "knowledge-navigation-scope-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const id = "document:33333333-3333-4333-8333-333333333333";
    const getResult = await client.callTool({
      name: "knowledge_get",
      arguments: { id, initiatingSubjectId: "user:forged" },
    });
    expect(getResult.isError).toBe(true);
    const browseResult = await client.callTool({
      name: "knowledge_browse",
      arguments: {
        parentId: id,
        cursor: "cursor-1",
        limit: 17,
        initiatingSubjectId: "user:forged",
      },
    });
    const text = browseResult.content.find((entry) => entry.type === "text");
    if (!text || text.type !== "text") throw new Error("missing MCP text result");
    expect(JSON.parse(text.text)).toEqual({ records: [], nextCursor: null, hasMore: false });
    expect(getInputs).toEqual([
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        initiatingSubjectId: "user:initiator",
        id,
      },
    ]);
    expect(browseInputs).toEqual([
      {
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        initiatingSubjectId: "user:initiator",
        parentId: id,
        cursor: "cursor-1",
        limit: 17,
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
