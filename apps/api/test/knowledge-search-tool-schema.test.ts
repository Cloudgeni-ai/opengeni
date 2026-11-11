import { expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { KnowledgeEntryListRequest } from "@opengeni/contracts";
import { z } from "zod";
import { withFirstPartyToolClient, withMcpClient } from "./helpers/first-party-tool-client";

test("listed Knowledge search schema is compact and still validates before storage", async () => {
  await withFirstPartyToolClient(async (client) => {
    const tool = (await client.listTools()).tools.find(
      (candidate) => candidate.name === "knowledge_search",
    )!;
    expect(tool).toBeDefined();
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.limit.default).toBe(5);
    expect(properties.groupId.format).toBe("uuid");
    expect(properties.createdSince.format).toBe("date-time");
    expect(JSON.stringify(tool.inputSchema)).not.toContain('"pattern"');
    for (const args of [
      { groupId: "invalid" },
      { fileId: "invalid" },
      { createdSince: "yesterday" },
      { limit: 51 },
    ]) {
      const result = await client.callTool({ name: "knowledge_search", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("invalid input reached storage");
      expect(JSON.stringify(result)).toMatch(/validation|Invalid|invalid|maximum/i);
    }

    // Compare actual MCP input-schema emission, not Zod's output-schema mode.
    const old = new McpServer({ name: "prior-search-schema", version: "1" });
    old.registerTool(
      "knowledge_search",
      {
        inputSchema: KnowledgeEntryListRequest.omit({
          view: true,
          sessionId: true,
          reviewBatchId: true,
          rootOnly: true,
        }).extend({ view: z.enum(["published", "needs_review"]).default("published") }).shape,
      },
      async () => ({ content: [] }),
    );
    await withMcpClient(old, async (beforeClient) => {
      const previous = (await beforeClient.listTools()).tools[0]!.inputSchema;
      const before = JSON.stringify(previous),
        after = JSON.stringify(tool.inputSchema);
      expect(after.length).toBeLessThan(before.length * 0.7);
      if (process.env.OPENGENI_BENCH_KNOWLEDGE_TOOLS)
        console.log(
          JSON.stringify({
            inputSchema: {
              beforeBytes: Buffer.byteLength(before),
              afterBytes: Buffer.byteLength(after),
              beforeEstimatedTokens: Math.ceil(before.length / 4),
              afterEstimatedTokens: Math.ceil(after.length / 4),
            },
            description: {
              bytes: Buffer.byteLength(tool.description!),
              estimatedTokens: Math.ceil(tool.description!.length / 4),
            },
            eagerDescriptor: {
              bytes: Buffer.byteLength(JSON.stringify(tool)),
              estimatedTokens: Math.ceil(JSON.stringify(tool).length / 4),
            },
          }),
        );
    });
  });
});
