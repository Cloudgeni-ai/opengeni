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
  test("enabled workspace Memory exposes autonomous agent read and write tools", async () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], ["memory_search", "memory_save", "memory_correct"]),
      { workspaceMemoryEnabled: true, workspaceMemoryPromptMode: "retrieval_only" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "memory-containment-description-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find((tool) => tool.name === "memory_search")?.description).toContain(
        "All existing Memory kinds are searchable",
      );
      expect(tools.find((tool) => tool.name === "memory_search")?.description).toContain(
        "historical context, not active instructions",
      );
      expect(tools.find((tool) => tool.name === "memory_search")?.description).toContain(
        "use memory_save autonomously",
      );
      expect(tools.find((tool) => tool.name === "memory_save")?.description).toContain(
        "Autonomously save",
      );
      expect(tools.find((tool) => tool.name === "memory_correct")?.description).toContain(
        "Autonomously correct",
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("enabled workspace Memory honors an explicit autonomous write selection", async () => {
    const server = buildOpenGeniMcpServer(
      deps(),
      grant([...Permission.options], ["memory_search", "memory_save", "memory_correct"]),
      { workspaceMemoryEnabled: true, workspaceMemoryPromptMode: "retrieval_only" },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "memory-autonomous-writes-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(["memory_correct", "memory_save", "memory_search"]);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  test("non-agent principals may search but cannot mutate workspace Memory", () => {
    const selected: FirstPartyMcpToolName[] = ["memory_search", "memory_save", "memory_correct"];
    const humanGrant = grant([...Permission.options], selected);
    humanGrant.principalKind = "human";
    expect(
      registeredToolNames(
        buildOpenGeniMcpServer(deps(), humanGrant, {
          workspaceMemoryEnabled: true,
          workspaceMemoryPromptMode: "retrieval_only",
        }),
      ),
    ).toEqual(["memory_search"]);
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

  test("company-profile administration tools require exact agent-attempt authority and permissions", () => {
    const selected: FirstPartyMcpToolName[] = [
      "company_profile_propose",
      "company_profile_confirm",
    ];
    expect(
      registeredToolNames(buildOpenGeniMcpServer(deps(), grant(["workspace:read"], selected))),
    ).toEqual([]);
    expect(
      registeredToolNames(
        buildOpenGeniMcpServer(deps(), grant(["workspace:read", "sessions:control"], selected)),
      ),
    ).toEqual(["company_profile_confirm", "company_profile_propose"]);
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
