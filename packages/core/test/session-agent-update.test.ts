import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveAgentConfig, type ResolvedAgentConfig } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createSession } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { updateSessionAgent } from "../src/domain/sessions";

const settings = testSettings({
  agentConfigAdmissionEnabled: true,
  mcpServers: [
    { id: "opengeni", url: "https://opengeni.example/mcp", cacheToolsList: false },
    { id: "docs", url: "https://docs.example/mcp", cacheToolsList: false },
    { id: "files", url: "https://files.example/mcp", cacheToolsList: false },
  ],
});

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-agent-update");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

function config(enabled: boolean): ResolvedAgentConfig {
  return resolveAgentConfig({
    creator: "api",
    request: {
      capabilities: {
        from: "none",
        subagents: enabled,
        knowledge: enabled,
        workspaceFiles: enabled,
      },
    },
    workspace: { defaults: null, humanInputEnabled: true },
    deployment: { unavailable: {}, admissionEnabled: true, defaultForNewSessions: false },
    goal: false,
  }).config!;
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Agent update",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Agent update",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    grant,
    input: {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "initial",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    },
  };
}

describe("child agent updates retain the locked parent's exact tool ceiling", () => {
  for (const configuredParent of [false, true]) {
    test(`${configuredParent ? "configured" : "legacy"} parent cannot grant unselected subagent tools`, async () => {
      const { grant, input } = await fixture();
      const parent = await createSession(client.db, {
        ...input,
        firstPartyMcpTools: ["session_create", "sessions_list"],
        ...(configuredParent ? { agentConfig: config(true) } : {}),
      });
      const child = await createSession(client.db, {
        ...input,
        parentSessionId: parent.id,
        firstPartyMcpTools: [],
        agentConfig: config(false),
      });
      const updated = await updateSessionAgent(
        { db: client.db, bus: new MemoryEventBus(), settings },
        grant,
        child.id,
        { expectedVersion: 1, agent: { capabilities: { from: "none", subagents: true } } },
      );
      expect(updated.agent?.capabilities.subagents).toBe(true);
      expect(updated.firstPartyMcpTools?.toSorted()).toEqual(["session_create", "sessions_list"]);
      expect(updated.firstPartyMcpTools).not.toContain("session_steer");
    }, 60_000);
  }

  for (const workspaceDefaultParent of [false, true]) {
    test(`${workspaceDefaultParent ? "workspace-default" : "explicit"} parent fences re-enabled MCP servers`, async () => {
      const { grant, input } = await fixture();
      const parent = await createSession(client.db, {
        ...input,
        agentConfig: {
          ...config(true),
          capabilities: { ...config(true).capabilities, workspaceConnectors: true },
        },
        firstPartyMcpTools: ["session_create", "sessions_list"],
        tools: [
          { kind: "mcp", id: "opengeni" },
          { kind: "mcp", id: "docs", optional: true },
        ],
        toolPolicy: workspaceDefaultParent
          ? {
              mode: "workspace_default",
              inheritedFromSessionId: null,
              excludedMcpServerIds: ["files"],
            }
          : { mode: "explicit", inheritedFromSessionId: null },
      });
      const child = await createSession(client.db, {
        ...input,
        parentSessionId: parent.id,
        agentConfig: {
          ...config(false),
          capabilities: { ...config(false).capabilities, workspaceConnectors: true },
        },
        firstPartyMcpTools: [],
        tools: [{ kind: "mcp", id: "opengeni" }],
        toolPolicy: {
          mode: "workspace_default",
          inheritedFromSessionId: parent.id,
          excludedMcpServerIds: ["docs", "files"],
        },
      });
      const updated = await updateSessionAgent(
        { db: client.db, bus: new MemoryEventBus(), settings },
        grant,
        child.id,
        {
          expectedVersion: 1,
          agent: {
            capabilities: {
              from: "none",
              knowledge: true,
              workspaceFiles: true,
              workspaceConnectors: true,
            },
          },
        },
      );
      expect(updated.tools.map((tool) => tool.id).toSorted()).toEqual(["docs", "opengeni"]);
      expect(updated.firstPartyMcpTools).toEqual([]);
      if (workspaceDefaultParent) {
        expect(updated.toolPolicy.mode).toBe("workspace_default");
        expect(updated.toolPolicy.excludedMcpServerIds).toContain("files");
      } else {
        expect(updated.toolPolicy.mode).not.toBe("workspace_default");
      }
    }, 60_000);
  }
});
