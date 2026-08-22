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
      // Memory V1 writes are retired from the default retrieval-only surface;
      // explicit user-directed knowledge goes through `remember`.
      expect(tools.find((tool) => tool.name === "memory_save")).toBeUndefined();
      expect(tools.find((tool) => tool.name === "memory_search")?.description).toContain(
        "use `remember`",
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("Memory V1 writes are not registered even when explicitly selected", async () => {
    // memory_save/memory_correct are retired. Selecting them by name must not
    // resurrect them: the retirement is a property of the surface, not of what
    // a caller happens to ask for.
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], [
        "memory_search",
        "memory_save",
        "memory_correct",
      ] as unknown as FirstPartyMcpToolName[]),
      { workspaceMemoryEnabled: true, workspaceMemoryPromptMode: "retrieval_only" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "memory-retired-writes-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["memory_search"]);
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

  test("company_profile_propose requires exact agent-attempt authority plus its own permissions", () => {
    const selected: FirstPartyMcpToolName[] = ["company_profile_propose"];
    expect(
      registeredToolNames(buildOpenGeniMcpServer(deps(), grant(["workspace:read"], selected))),
    ).toEqual([]);
    expect(
      registeredToolNames(
        buildOpenGeniMcpServer(deps(), grant(["workspace:read", "sessions:control"], selected)),
      ),
    ).toEqual(["company_profile_propose"]);
    const humanGrant = grant(["workspace:read", "sessions:control"], selected);
    humanGrant.principalKind = "human";
    expect(registeredToolNames(buildOpenGeniMcpServer(deps(), humanGrant))).toEqual([]);
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
