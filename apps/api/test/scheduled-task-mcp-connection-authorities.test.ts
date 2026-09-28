import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { scheduledTaskToolsProvided } from "@opengeni/core";
import {
  createDb,
  createConnection,
  createOrganizationApiKey,
  createScheduledTask,
  getScheduledTask,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createWorkspaceToolGateway,
  ToolGatewayInputValidationError,
} from "@opengeni/tool-gateway";
import postgres from "postgres";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";
import { buildOpenGeniMcpServer, SCHEDULED_TASK_MCP_AGENT_CONFIG } from "../src/mcp/server";

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

/** Storage must never be reached: every case here fails, or is checked, before it. */
function storageFreeDeps() {
  const touches = { count: 0 };
  const db = new Proxy(
    {},
    {
      get() {
        touches.count += 1;
        throw new Error("invalid model request reached storage");
      },
    },
  ) as ApiRouteDeps["db"];
  const workspace = {
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    subjectId: `subject-${crypto.randomUUID()}`,
  };
  return { touches, server: buildOpenGeniMcpServer(deps(db), grantFor(workspace)) };
}

describe("first-party MCP scheduled task tool shapes", () => {
  test("ask for a short prompt and declare the schedule and agentConfig shapes", async () => {
    const { server } = storageFreeDeps();
    const connected = await connectedClient(server);
    try {
      const tools = (await connected.client.listTools()).tools;
      const create = tools.find((tool) => tool.name === "scheduled_tasks_create")!;
      const update = tools.find((tool) => tool.name === "scheduled_tasks_update")!;
      // Agent-written prompts ran 6-10x their request and baked in one-time
      // context; a long prompt also produced long run output.
      expect(create.description).toStartWith(
        'Create a scheduled task. agentConfig.prompt is what a fresh agent reads on every run, so write it short and plain (usually under 800 characters): what to do, where the result goes, who reads it, and only the constraints the user gave. Name the Skills to follow instead of restating their steps, and leave out one-time context such as current PRs, dates, or conversation history unless every run needs it. When a run posts to people, say how long the post should be, for example "two or three short lines". ',
      );
      expect(create.description).toContain(
        "Sessions generated for a task created from this session inherit this session's effective first-party tool selection",
      );
      expect(update.description).toBe(
        "Update a scheduled task. When changing agentConfig.prompt, keep it short and plain as described for scheduled_tasks_create, and change only what the request is about.",
      );
      // Two production create attempts failed while the model guessed these
      // shapes from an untyped schema.
      for (const tool of [create, update]) {
        const properties = tool.inputSchema.properties as Record<
          string,
          {
            anyOf?: Array<{ properties: { type: { const: string } } }>;
            oneOf?: Array<{ properties: { type: { const: string } } }>;
            properties?: Record<string, { type?: string }>;
            required?: string[];
          }
        >;
        const variants = properties.schedule!.anyOf ?? properties.schedule!.oneOf ?? [];
        expect(variants.map((variant) => variant.properties.type.const).sort(), tool.name).toEqual([
          "calendar",
          "interval",
          "manual",
          "once",
        ]);
        expect(properties.agentConfig!.properties?.prompt?.type, tool.name).toBe("string");
        expect(properties.agentConfig!.required, tool.name).toEqual(["prompt"]);
      }
      expect(create.inputSchema.required).toEqual(
        expect.arrayContaining(["name", "schedule", "agentConfig"]),
      );

      // The declared shape compiles in the tool gateway, accepts a real daily
      // schedule with fields it does not declare, and refuses a guessed one.
      const { gateway } = createWorkspaceToolGateway({
        accountId: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        generation: 1,
        definitions: [
          {
            identity: { serverId: "opengeni", toolName: "scheduled_tasks_create" },
            modelName: "scheduled_tasks_create",
            inputSchema: create.inputSchema as Record<string, unknown> & { type: "object" },
            source: "opengeni",
            approval: "none",
            execute: () => ({ isError: false, content: [] }),
          },
        ],
      });
      const call = (arguments_: Record<string, unknown>) =>
        gateway.callModel({
          modelName: "scheduled_tasks_create",
          arguments: arguments_,
          subjectId: "agent:test",
        });
      await expect(
        call({
          name: "Daily new users",
          schedule: { type: "calendar", hour: 8, minute: 0, timeZone: "Europe/Oslo" },
          agentConfig: {
            prompt: "List yesterday's new users in two or three short lines.",
            reasoningEffort: "low",
            goal: { objective: "Post the list" },
          },
        }),
      ).resolves.toMatchObject({ isError: false });
      await expect(
        call({ name: "Daily", schedule: "0 8 * * *", agentConfig: { prompt: "p" } }),
      ).rejects.toBeInstanceOf(ToolGatewayInputValidationError);
      await expect(
        call({ name: "Daily", schedule: { type: "manual" }, agentConfig: "p" }),
      ).rejects.toBeInstanceOf(ToolGatewayInputValidationError);
    } finally {
      await connected.close();
    }
  });

  test("the declared agentConfig adds no defaults and keeps undeclared fields", () => {
    // Whether agentConfig.tools is present at all selects explicit tools over
    // the workspace defaults, so the model-facing shape must not add it.
    const bare = SCHEDULED_TASK_MCP_AGENT_CONFIG.parse({ prompt: "p" });
    expect(bare).toEqual({ prompt: "p" });
    expect(scheduledTaskToolsProvided({ agentConfig: bare })).toBe(false);
    const explicit = SCHEDULED_TASK_MCP_AGENT_CONFIG.parse({ prompt: "p", tools: [] });
    expect(scheduledTaskToolsProvided({ agentConfig: explicit })).toBe(true);
    const undeclared = {
      prompt: "p",
      goal: { objective: "Post the list" },
      machineTarget: { targetSandboxId: crypto.randomUUID() },
      bundledSkillIds: ["builtin:opengeni-skills"],
    };
    expect(SCHEDULED_TASK_MCP_AGENT_CONFIG.parse(undeclared)).toEqual(undeclared);
  });

  test("a guessed schedule is refused before storage and undeclared fields reach the contract parse", async () => {
    const { server, touches } = storageFreeDeps();
    const connected = await connectedClient(server);
    try {
      const guessed = await connected.client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "Daily new users",
          schedule: { cron: "0 8 * * *" },
          agentConfig: { prompt: "List yesterday's new users." },
        },
      });
      expect(guessed).toMatchObject({ isError: true });
      expect(resultText(guessed)).toContain("schedule");
      // An undeclared agentConfig field is not stripped by the MCP layer: the
      // contract parse still sees it and applies its own rule.
      const undeclared = await connected.client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "Daily new users",
          schedule: { type: "manual" },
          agentConfig: { prompt: "List yesterday's new users.", sandboxBackend: "selfhosted" },
        },
      });
      expect(undeclared).toMatchObject({ isError: true });
      expect(resultText(undeclared)).toContain("selfhosted scheduled tasks require machineTarget");
      expect(touches.count).toBe(0);
    } finally {
      await connected.close();
    }
  });
});

describe("first-party MCP scheduled task connectionAccounts", () => {
  test.each([false, true])(
    "removing an MCP tool preserves explicit-account validation (%s)",
    async (explicit) => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const [sharedWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${workspace.accountId}, 'Shared tool selection workspace') returning id`;
      workspace.workspaceId = sharedWorkspace!.id;
      await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace.workspaceId}, ${workspace.accountId})`;
      await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${workspace.accountId}, ${workspace.workspaceId}, ${workspace.subjectId})`;
      const retained = await createConnection(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        subjectId: null,
        providerDomain: "retained.example.com",
        kind: "oauth2",
        credentialEncrypted: "not-read-by-metadata-selection",
      });
      const retainedTool = { kind: "mcp" as const, id: "retained-integration", optional: true };
      const retainedAccount = { serverId: retainedTool.id, connectionId: retained.id };
      const task = await createScheduledTask(client.db, {
        ...workspace,
        name: "remove selected integration",
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode: "new_session_per_run",
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          connectionAccounts: [
            { serverId: "removed-integration", connectionId: crypto.randomUUID() },
            retainedAccount,
          ],
          connectionAccountsFrozen: true,
          prompt: "scheduled prompt",
          resources: [],
          tools: [{ kind: "mcp", id: "removed-integration", optional: true }, retainedTool],
          metadata: {},
        },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        metadata: {},
      });
      const dependencies = deps(client.db);
      dependencies.settings.mcpServers.push({
        id: retainedTool.id,
        url: "https://retained.example.com/mcp",
        cacheToolsList: false,
        connectionRef: {
          providerDomain: "retained.example.com",
          kind: "oauth2",
          subjectScope: "workspace",
        },
      });
      const connected = await connectedClient(
        buildOpenGeniMcpServer(dependencies, grantFor(workspace)),
      );
      try {
        const result = await connected.client.callTool({
          name: "scheduled_tasks_update",
          arguments: {
            id: task.id,
            agentConfig: { prompt: "scheduled prompt", resources: [], tools: [retainedTool] },
            ...(explicit ? { connectionAccounts: task.agentConfig.connectionAccounts } : {}),
          },
        });
        if (explicit) {
          expect(result).toMatchObject({ isError: true });
          expect(resultText(result)).toContain("did not match a selected MCP server");
          expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
          return;
        }
        expect(resultText(result)).not.toContain("did not match a selected MCP server");
        expect(result, resultText(result)).not.toMatchObject({ isError: true });
      } finally {
        await connected.close();
      }
      const after = await getScheduledTask(client.db, workspace.workspaceId, task.id);
      expect(after?.agentConfig.tools).toEqual([retainedTool]);
      expect(after?.agentConfig.connectionAccounts).toEqual([retainedAccount]);
      expect(after?.agentConfig.connectionAccountsFrozen).toBe(true);
      expect(after?.ownerSubjectId).toBe(workspace.subjectId);
    },
  );

  test("declares connectionAccounts on create/update and rejects a malformed selection before storage", async () => {
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
        expect(tool?.inputSchema.properties, name).toHaveProperty("connectionAccounts");
      }

      // A selection missing connectionId must reach the contract
      // parse and fail there. If the MCP input schema stripped the field, the
      // request would parse as connectionAccounts=[] and proceed to storage.
      const malformed = await connected.client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "malformed selection",
          schedule: { type: "interval", everySeconds: 3_600 },
          agentConfig: { prompt: "run with a bogus selection" },
          connectionAccounts: [{ serverId: "linear" }],
        },
      });
      expect(malformed).toMatchObject({ isError: true });
      expect(resultText(malformed)).toContain("connectionAccounts");
      expect(databaseTouches).toBe(0);
    } finally {
      await connected.close();
    }
  });

  test("scheduled_tasks_update accepts connectionAccounts: [] and resets explicit account choices", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const connectionAccounts = [
      {
        serverId: "linear",
        connectionId: crypto.randomUUID(),
      },
    ];
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "reset account choice",
      status: "active",
      schedule: { type: "interval", everySeconds: 3_600 },
      temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        connectionAccounts,
        prompt: "scheduled prompt",
        resources: [],
        tools: [],
        metadata: {},
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    expect(task.agentConfig.connectionAccounts).toEqual(connectionAccounts);

    const server = buildOpenGeniMcpServer(deps(client.db), grantFor(workspace));
    const connected = await connectedClient(server);
    try {
      const updated = await connected.client.callTool({
        name: "scheduled_tasks_update",
        arguments: { id: task.id, connectionAccounts: [] },
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
    const after = await getScheduledTask(client.db, workspace.workspaceId, task.id);
    expect(after?.agentConfig.connectionAccounts).toEqual([]);
    expect(after?.ownerSubjectId).toBe(workspace.subjectId);
    expect(after?.authorityRevision).toBeGreaterThan(task.authorityRevision);
  });
});

test.each([
  "scheduled_tasks_update",
  "scheduled_tasks_pause",
  "scheduled_tasks_resume",
  "scheduled_tasks_trigger",
  "scheduled_tasks_delete",
] as const)(
  "%s refuses another participant even with empty connection selections",
  async (name) => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "Owned schedule",
      status: name === "scheduled_tasks_resume" ? "paused" : "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Use my connections",
        resources: [],
        tools: [],
        metadata: {},
        connectionAccounts: [],
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const other: AccessGrant = {
      ...grantFor(workspace),
      subjectId: "user:other-participant",
      permissions: ["scheduled_tasks:manage", "scheduled_tasks:run"],
    };
    for (const caller of [
      other,
      { ...other, subjectId: workspace.subjectId, principalKind: "service" as const },
    ]) {
      const server = buildOpenGeniMcpServer(deps(client.db), caller);
      const connected = await connectedClient(server);
      try {
        const result = await connected.client.callTool({
          name,
          arguments: {
            id: task.id,
            ...(name === "scheduled_tasks_update"
              ? { connectionAccounts: [], name: "Taken over" }
              : {}),
          },
        });
        expect(result).toMatchObject({ isError: true });
        expect(resultText(result)).toContain("Only the schedule owner");
        expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
      } finally {
        await connected.close();
      }
    }
  },
);

test.each(["update", "pause", "resume", "trigger", "delete"] as const)(
  "HTTP %s refuses service credentials acting on a personal schedule",
  async (operation) => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const [sharedWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${workspace.accountId}, 'Shared schedule workspace') returning id`;
    workspace.workspaceId = sharedWorkspace!.id;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace.workspaceId}, ${workspace.accountId})`;
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${workspace.accountId}, ${workspace.workspaceId}, ${workspace.subjectId})`;
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "Personal schedule",
      status: operation === "resume" ? "paused" : "active",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Use my connections",
        resources: [],
        tools: [],
        metadata: {},
        connectionAccounts: [],
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const token = randomBytes(24).toString("hex");
    await createOrganizationApiKey(client.db, {
      accountId: workspace.accountId,
      name: "Schedule fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:read", "scheduled_tasks:manage", "scheduled_tasks:run"],
    });
    const app = new Hono();
    registerScheduledTaskRoutes(app, {
      ...deps(client.db),
      settings: testSettings({ productAccessMode: "managed", sandboxBackend: "none" }),
    });
    const suffix = operation === "update" || operation === "delete" ? "" : "/" + operation;
    const response = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/scheduled-tasks/${task.id}${suffix}`,
      {
        method: operation === "update" ? "PATCH" : operation === "delete" ? "DELETE" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(operation === "update"
          ? { body: JSON.stringify({ connectionAccounts: [], name: "Taken over" }) }
          : {}),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Only the schedule owner");
    expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
  },
);
