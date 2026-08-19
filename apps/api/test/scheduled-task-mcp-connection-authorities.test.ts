import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant, McpPersonalConnectionDelegation } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createDb,
  createScheduledTask,
  getScheduledTask,
  getScheduledTaskPersonalConnectionDelegations,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-scheduled-task-mcp-connection-authorities");
  if (!shared) {
    available = false;
    console.warn("[scheduled-task-mcp-connection-authorities] PostgreSQL unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

class FakeWorkflowClient implements SessionWorkflowClient {
  synced: unknown[] = [];
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(input: unknown): Promise<void> {
    this.synced.push(input);
  }
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
  async startRigVerification(): Promise<void> {}
}

function deps(db: ApiRouteDeps["db"]): ApiRouteDeps {
  return {
    settings: testSettings({ sandboxBackend: "none" }),
    db,
    bus: new MemoryEventBus(),
    workflowClient: new FakeWorkflowClient(),
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as unknown as ApiRouteDeps;
}

async function workspaceFixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('scheduled mcp connection authorities') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'scheduled mcp connection authorities') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const fixture = {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId: `subject-${crypto.randomUUID()}`,
  };
  await admin`
    insert into organization_memberships (
      account_id, subject_id, status, personal_workspace_id
    ) values (
      ${fixture.accountId}, ${fixture.subjectId}, 'active', ${fixture.workspaceId}
    )`;
  return fixture;
}

function grantFor(workspace: Awaited<ReturnType<typeof workspaceFixture>>): AccessGrant {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    subjectId: workspace.subjectId,
    permissions: ["scheduled_tasks:manage"],
    metadata: {},
  };
}

async function connectedClient(server: ReturnType<typeof buildOpenGeniMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "scheduled-connection-authorities-test", version: "1" });
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  return {
    client: mcpClient,
    close: async () => {
      await Promise.all([mcpClient.close(), server.close()]);
    },
  };
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? "").join("\n");
}

describe("first-party MCP scheduled task connectionAuthorities", () => {
  test("declares connectionAuthorities on create/update and rejects a malformed selection before storage", async () => {
    if (!available) return;
    let databaseTouches = 0;
    const throwingDb = new Proxy(
      {},
      {
        get() {
          databaseTouches += 1;
          throw new Error("invalid model request reached storage");
        },
      },
    ) as ApiRouteDeps["db"];
    const workspace = {
      accountId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      subjectId: `subject-${crypto.randomUUID()}`,
    };
    const server = buildOpenGeniMcpServer(deps(throwingDb), grantFor(workspace));
    const connected = await connectedClient(server);
    try {
      const tools = (await connected.client.listTools()).tools;
      for (const name of ["scheduled_tasks_create", "scheduled_tasks_update"]) {
        const tool = tools.find((candidate) => candidate.name === name);
        expect(tool, name).toBeTruthy();
        expect(tool?.inputSchema.properties, name).toHaveProperty("connectionAuthorities");
      }

      // A selection missing connectionId/userDelegation must reach the contract
      // parse and fail there. If the MCP input schema stripped the field, the
      // request would parse as connectionAuthorities=[] and proceed to storage.
      const malformed = await connected.client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "malformed selection",
          schedule: { type: "interval", everySeconds: 3_600 },
          agentConfig: { prompt: "run with a bogus selection" },
          connectionAuthorities: [{ serverId: "linear" }],
        },
      });
      expect(malformed).toMatchObject({ isError: true });
      expect(resultText(malformed)).toContain("connectionAuthorities");
      expect(databaseTouches).toBe(0);
    } finally {
      await connected.close();
    }
  });

  test("scheduled_tasks_update accepts connectionAuthorities: [] and clears frozen delegations", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const delegations: McpPersonalConnectionDelegation[] = [
      {
        serverId: "linear",
        connectionId: crypto.randomUUID(),
        ownerSubjectId: workspace.subjectId,
        providerDomain: "linear.app",
        kind: "oauth2",
      },
    ];
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "clear connection authority",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "connection authorized prompt",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      personalConnectionDelegations: delegations,
      metadata: {},
    });
    expect(
      await getScheduledTaskPersonalConnectionDelegations(
        client.db,
        workspace.workspaceId,
        task.id,
      ),
    ).toEqual(delegations);

    const server = buildOpenGeniMcpServer(deps(client.db), grantFor(workspace));
    const connected = await connectedClient(server);
    try {
      const updated = await connected.client.callTool({
        name: "scheduled_tasks_update",
        arguments: { id: task.id, connectionAuthorities: [] },
      });
      expect(updated).not.toMatchObject({ isError: true });
      const receipt = JSON.parse(resultText(updated)) as {
        operation: string;
        outcome: string;
        changed: boolean;
      };
      expect(receipt).toMatchObject({
        operation: "scheduled_tasks_update",
        outcome: "updated",
        changed: true,
      });
    } finally {
      await connected.close();
    }
    expect(
      await getScheduledTaskPersonalConnectionDelegations(
        client.db,
        workspace.workspaceId,
        task.id,
      ),
    ).toEqual([]);
    const after = await getScheduledTask(client.db, workspace.workspaceId, task.id);
    expect(after?.authorityRevision).toBeGreaterThan(task.authorityRevision);
  });
});
