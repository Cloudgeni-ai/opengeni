import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentTools } from "../src/index";

function turnScope() {
  return {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    executionGeneration: 1,
  };
}

function definition(toolName: string) {
  return {
    identity: { serverId: "opengeni", toolName },
    modelName: toolName,
    codemodePath: ["opengeni", toolName],
    inputSchema: { type: "object" as const, additionalProperties: false },
    source: "interaction" as const,
    approval: "none" as const,
    execute: async () => ({ content: [{ type: "text" as const, text: toolName }] }),
  };
}

describe("Codemode-only attempt tools", () => {
  test("stay in the attempt catalog but are not offered to the model", async () => {
    const prepared = await prepareAgentTools(testSettings({ sandboxBackend: "none" }), [], {
      ...turnScope(),
      attemptToolDefinitions: [definition("code_grep"), definition("observe")],
      codemodeOnlyToolNames: ["code_grep"],
    });
    try {
      expect(
        prepared.attemptToolCatalog!.entries.map((entry) => entry.identity.toolName).sort(),
      ).toEqual(["code_grep", "observe"]);
      const local = prepared.mcpServers.find(
        (server) => server.name === "opengeni-attempt-local-tools",
      )!;
      expect((await local.listTools()).map((tool) => tool.name)).toEqual(["observe"]);
    } finally {
      await prepared.close();
    }
  });

  test("leave no model tool server when every attempt tool is Codemode-only", async () => {
    const prepared = await prepareAgentTools(testSettings({ sandboxBackend: "none" }), [], {
      ...turnScope(),
      attemptToolDefinitions: [definition("code_grep")],
      codemodeOnlyToolNames: ["code_grep"],
    });
    try {
      expect(prepared.attemptToolCatalog!.entries).toHaveLength(1);
      expect(
        prepared.mcpServers.some((server) => server.name === "opengeni-attempt-local-tools"),
      ).toBe(false);
    } finally {
      await prepared.close();
    }
  });
});
