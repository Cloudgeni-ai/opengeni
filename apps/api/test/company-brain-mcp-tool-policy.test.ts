import { describe, expect, test } from "bun:test";
import { Permission, type AccessGrant, type FirstPartyMcpToolName } from "@opengeni/contracts";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiRouteDeps } from "@opengeni/core";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const sessionId = crypto.randomUUID();
const turnId = crypto.randomUUID();
const attemptId = crypto.randomUUID();

function deps(): ApiRouteDeps {
  return {
    settings: testSettings({ sandboxSelfhostedEnabled: true }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as ApiRouteDeps;
}

function grant(
  permissions: AccessGrant["permissions"],
  firstPartyMcpTools?: FirstPartyMcpToolName[],
): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "worker:company-brain-mcp",
    permissions,
    principalKind: "agent_attempt",
    metadata: {
      sessionId,
      turnId,
      attemptId,
      executionGeneration: 1,
      ...(firstPartyMcpTools !== undefined ? { firstPartyMcpTools } : {}),
    },
  };
}

function registeredToolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  )
    .filter((name) => !name.startsWith("__opengeni_empty_"))
    .sort();
}

describe("Company Brain first-party MCP policy", () => {
  test("retrieval-only memory tools disclose the preference authority boundary", async () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], ["memory_search", "memory_save"]),
      { workspaceMemoryEnabled: true, workspaceMemoryPromptMode: "retrieval_only" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "memory-containment-description-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === "memory_search")?.description).toContain(
        "structured preferences are the only behavioral authority",
      );
      expect(tools.find((tool) => tool.name === "memory_save")?.description).toContain(
        "cannot become behavioral authority",
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("task-tree note tools require exact agent-attempt authority and their own permissions", () => {
    const selected: FirstPartyMcpToolName[] = [
      "task_notes_list",
      "task_note_save",
      "task_note_archive",
      "task_note_replace",
    ];
    const readOnly = buildOpenGeniMcpServer(deps(), grant(["sessions:read"], selected));
    expect(registeredToolNames(readOnly)).toEqual(["task_notes_list"]);

    const admitted = buildOpenGeniMcpServer(
      deps(),
      grant(["sessions:read", "sessions:control"], selected),
    );
    expect(registeredToolNames(admitted)).toEqual([...selected].sort());

    const humanGrant = grant(["sessions:read", "sessions:control"], selected);
    humanGrant.principalKind = "human";
    const denied = buildOpenGeniMcpServer(deps(), humanGrant);
    expect(registeredToolNames(denied)).toEqual([]);
  });

  test("governed write tools are production-registered and permission filtered", () => {
    const selected: FirstPartyMcpToolName[] = [
      "knowledge_propose",
      "knowledge_correct",
      "task_note_promote_knowledge",
      "task_note_promote_instruction_policy",
      "task_note_promote_preference",
      "instruction_policy_propose",
      "preference_propose",
    ];
    const readOnly = buildOpenGeniMcpServer(
      deps(),
      grant(["documents:search", "workspace:read"], selected),
    );
    expect(registeredToolNames(readOnly)).toEqual(
      selected.filter((name) => !name.startsWith("task_note_promote_")).sort(),
    );

    const admitted = buildOpenGeniMcpServer(
      deps(),
      grant(["documents:search", "workspace:read", "sessions:control"], selected),
    );
    expect(registeredToolNames(admitted)).toEqual([...selected].sort());

    const humanGrant = grant(["documents:search", "workspace:read", "sessions:control"], selected);
    humanGrant.principalKind = "human";
    expect(registeredToolNames(buildOpenGeniMcpServer(deps(), humanGrant))).toEqual([]);
  });
});
