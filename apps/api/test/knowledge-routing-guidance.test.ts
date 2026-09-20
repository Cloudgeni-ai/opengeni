import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { registerKnowledgeEntryTools } from "../src/mcp/knowledge-entries";

test("discovered save tools route future behavior away from retrieval-only Knowledge", async () => {
  const server = new McpServer({ name: "storage-routing-test", version: "1" });
  const client = new Client({ name: "storage-routing-test", version: "1" });
  const grant: AccessGrant = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: "agent:storage-routing-test",
    principalKind: "agent_attempt",
    permissions: ["documents:search"],
  };
  // Discover actual MCP descriptions without invoking persistence or a live model.
  registerKnowledgeEntryTools(server, {} as ApiRouteDeps, grant, crypto.randomUUID());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const description = (name: string) => tools.find((tool) => tool.name === name)?.description;
    for (const name of [
      "knowledge_prepare_save",
      "knowledge_save",
      "task_note_promote_knowledge",
    ]) {
      expect(description(name), name).toContain("behavior");
      expect(description(name), name).toContain("instruction_policy_save");
      expect(description(name), name).toContain("skill_save");
    }
    expect(description("knowledge_save")).toContain("not a behavioral preference");
    expect(description("instruction_policy_save")).toContain("Keep replies concise");
    expect(description("instruction_policy_save")).toContain("600 characters");
    expect(description("instruction_policy_save")).toContain("pending");
    expect(description("instruction_policy_save")).toContain("not a workaround");
  } finally {
    await client.close();
    await server.close();
  }
});
