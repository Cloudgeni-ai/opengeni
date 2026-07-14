import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import { bootstrapWorkspace, createDb, createRig, getRigChange, type DbClient } from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;
let accountId = "";
let workspaceId = "";

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api_rigs_mcp");
  if (!shared) {
    available = false;
    console.warn("[rigs-mcp] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "opengeni:test",
    accountExternalId: `rigs-mcp-${crypto.randomUUID()}`,
    accountName: "Rigs MCP",
    workspaceExternalSource: "opengeni:test",
    workspaceExternalId: `rigs-mcp-${crypto.randomUUID()}`,
    workspaceName: "Rigs MCP",
    subjectId: "user:mcp",
  });
  accountId = access.defaultAccountId!;
  workspaceId = access.defaultWorkspaceId!;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("rig MCP tools", () => {
  test("rig_list and rig_get are available under rigs:use", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-list-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "true", changelog: "v1" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"]));
    const tools = toolNames(server);
    expect(tools).toContain("rig_list");
    expect(tools).toContain("rig_get");

    const listed = await callMcpTool<{ rigs: Array<{ id: string }> }>(server, "rig_list", {});
    expect(listed.rigs.some((candidate) => candidate.id === rig.id)).toBe(true);
    const got = await callMcpTool<{ rig: { id: string }; versions: unknown[]; changes: unknown[] }>(
      server,
      "rig_get",
      { rigId: rig.id },
    );
    expect(got.rig.id).toBe(rig.id);
    expect(got.versions.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(got.changes)).toBe(true);
  });

  test("rig_propose_change creates a setup_append change and triggers verification", async () => {
    if (!available) return;
    const workflow = new FakeWorkflowClient();
    const sessionId = crypto.randomUUID();
    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `mcp-propose-${crypto.randomUUID()}`,
      createdBy: "user:mcp",
      initialVersion: { setupScript: "mkdir -p /opt/mcp", changelog: "v1" },
    });
    const server = buildOpenGeniMcpServer(deps(workflow), grant(["rigs:use"], { sessionId }));
    const proposed = await callMcpTool<{
      change: { id: string; status: string };
      verificationStarted: boolean;
    }>(server, "rig_propose_change", {
      rigId: rig.id,
      command: "touch /opt/mcp/tool",
      note: "mcp proposal",
    });
    expect(proposed.change.status).toBe("verifying");
    expect(proposed.verificationStarted).toBe(true);
    expect(workflow.rigVerifications).toEqual([
      {
        workspaceId,
        changeId: proposed.change.id,
        workflowId: `rig-verification-change-${proposed.change.id}-attempt-1`,
      },
    ]);
    const stored = await getRigChange(client.db, workspaceId, proposed.change.id);
    expect(stored?.kind).toBe("setup_append");
    expect(stored?.proposedBy).toBe(`session:${sessionId}`);
  });

  test("rig_promote is absent without rigs:manage", async () => {
    if (!available) return;
    const server = buildOpenGeniMcpServer(deps(new FakeWorkflowClient()), grant(["rigs:use"]));
    expect(toolNames(server)).not.toContain("rig_promote");
    await expect(
      callMcpTool(server, "rig_promote", {
        rigId: crypto.randomUUID(),
        changeId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("MCP tool not registered");
  });
});

function deps(workflowClient: SessionWorkflowClient): ApiRouteDeps {
  return {
    settings: testSettings({}),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient,
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as never;
}

function grant(permissions: Permission[], metadata: Record<string, unknown> = {}): AccessGrant {
  return {
    accountId,
    workspaceId,
    subjectId: "user:mcp",
    permissions,
    metadata,
  };
}

function toolNames(server: unknown): string[] {
  return Object.keys(
    (server as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {},
  ).sort();
}

async function callMcpTool<T = unknown>(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const tool = (
    server as {
      _registeredTools?: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools?.[name];
  if (!tool) {
    throw new Error(`MCP tool not registered: ${name}`);
  }
  const result = await tool.handler(args, {});
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) {
    throw new Error(`MCP tool returned no text: ${name}`);
  }
  return JSON.parse(text) as T;
}

class FakeWorkflowClient implements SessionWorkflowClient {
  rigVerifications: unknown[] = [];
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(input: unknown): Promise<void> {
    this.rigVerifications.push(input);
  }
}
