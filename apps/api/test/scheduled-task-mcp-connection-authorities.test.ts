import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UpdateScheduledTaskRequest, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { updateScheduledTaskForApi, validatedScheduledTaskUpdate } from "@opengeni/core";
import {
  createDb,
  createConnection,
  createOrganizationApiKey,
  createScheduledTask,
  createSession,
  getScheduledTask,
  getScheduledTaskCreatorPolicy,
  getSession,
  updateScheduledTask,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { registerScheduledTaskRoutes } from "../src/routes/scheduled-tasks";
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

describe("lossless scheduled-task model updates", () => {
  async function fixture(status: "active" | "paused" = "paused", frozen = true) {
    const workspace = await workspaceFixture();
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "Retained task configuration",
      status,
      schedule: { type: "interval", everySeconds: 7_200 },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "buffer_one",
      agentConfig: {
        prompt: `  Preserve every byte.\n${"long retained instructions ".repeat(500)}\n  `,
        resources: [
          { kind: "repository", uri: "https://example.test/team/repository.git", ref: "main" },
        ],
        tools: [{ kind: "mcp", id: "opengeni", eager: true }],
        metadata: { nested: { retained: ["complete", "values"] } },
        ...(frozen ? { connectionAccounts: [], connectionAccountsFrozen: true as const } : {}),
        approvalTimeoutSeconds: 300,
        maxNestedAgentDepth: 0,
        model: "scripted-model",
        reasoningEffort: "low",
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      creatorPolicy: {
        firstPartyMcpTools: ["sessions_list"],
        firstPartyMcpPermissions: ["sessions:read"],
        sessionPolicy: { agentAccess: "session", scopeSubjectId: null, memoryScope: null },
      },
      metadata: { retain: { taskMetadata: true } },
    });
    return { workspace, task };
  }

  test.each([
    ["active", true],
    ["paused", true],
    ["active", false],
    ["paused", false],
  ] as const)(
    "MCP changes only model settings: status=%s frozen=%s, including beyond the read projection",
    async (status, frozen) => {
      if (!available) return;
      const { workspace, task } = await fixture(status, frozen);
      const creatorPolicy = await getScheduledTaskCreatorPolicy(
        client.db,
        workspace.workspaceId,
        task.id,
      );
      const connected = await connectedClient(
        buildOpenGeniMcpServer(deps(client.db), grantFor(workspace)),
      );
      try {
        const result = await connected.client.callTool({
          name: "scheduled_tasks_update",
          arguments: {
            id: task.id,
            agentConfigPatch: { model: "gpt-5.6-sol", reasoningEffort: "high" },
          },
        });
        expect(result).not.toMatchObject({ isError: true });
        expect(JSON.parse(resultText(result))).toMatchObject({ outcome: "updated", changed: true });
        const after = await getScheduledTask(client.db, workspace.workspaceId, task.id);
        expect(
          await getScheduledTaskCreatorPolicy(client.db, workspace.workspaceId, task.id),
        ).toEqual(creatorPolicy);
        expect(after?.agentConfig).toEqual({
          ...task.agentConfig,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        });
        for (const key of [
          "name",
          "schedule",
          "status",
          "runMode",
          "overlapPolicy",
          "metadata",
          "variableSetId",
          "rigId",
          "targetSessionId",
          "reusableSessionId",
          "ownerSubjectId",
        ] as const) {
          expect(after?.[key]).toEqual(task[key]);
        }
      } finally {
        await connected.close();
      }
    },
  );

  test("HTTP accepts the same narrow patch under existing service-task authority", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const [sharedWorkspace] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${workspace.accountId}, 'Service task fixture') returning id`;
    workspace.workspaceId = sharedWorkspace!.id;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace.workspaceId}, ${workspace.accountId})`;
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "Service task",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: {
        prompt: "  Keep this byte exact  ",
        tools: [],
        resources: [],
        metadata: { keep: true },
        model: "scripted-model",
      },
      createdBy: { kind: "service", subjectId: "scheduler" },
      metadata: {},
    });
    const token = randomBytes(24).toString("hex");
    await createOrganizationApiKey(client.db, {
      accountId: workspace.accountId,
      name: "Model patch fixture",
      prefix: "test",
      keyHash: createHash("sha256").update(token).digest("hex"),
      permissions: ["workspace:read", "scheduled_tasks:manage"],
    });
    const app = new Hono();
    registerScheduledTaskRoutes(app, {
      ...deps(client.db),
      settings: testSettings({ productAccessMode: "managed", sandboxBackend: "none" }),
    });
    const response = await app.request(
      `/v1/workspaces/${workspace.workspaceId}/scheduled-tasks/${task.id}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ agentConfigPatch: { reasoningEffort: "high" } }),
      },
    );
    expect(response.status).toBe(200);
    expect(
      (await getScheduledTask(client.db, workspace.workspaceId, task.id))?.agentConfig,
    ).toEqual({
      ...task.agentConfig,
      reasoningEffort: "high",
    });
  });

  test.each(["existing_session", "reusable_session"] as const)(
    "%s retains the current session model and warns rather than retargeting it",
    async (runMode) => {
      if (!available) return;
      const { workspace, task } = await fixture();
      const session = await createSession(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        initialMessage: "Keep the already selected model",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      const previousSession = await getSession(client.db, workspace.workspaceId, session.id);
      await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
        runMode,
        ...(runMode === "existing_session"
          ? { targetSessionId: session.id }
          : { reusableSessionId: session.id }),
      });
      const connected = await connectedClient(
        buildOpenGeniMcpServer(deps(client.db), {
          ...grantFor(workspace),
          permissions: ["scheduled_tasks:manage", "sessions:control"],
        }),
      );
      try {
        const result = await connected.client.callTool({
          name: "scheduled_tasks_update",
          arguments: {
            id: task.id,
            agentConfigPatch: { model: "gpt-5.6-sol", reasoningEffort: "high" },
          },
        });
        expect(result).not.toMatchObject({ isError: true });
        expect(JSON.parse(resultText(result)).warnings).toEqual([
          "The task uses an existing session, whose model and reasoning are unchanged. Change that session separately if intended.",
        ]);
        expect(await getSession(client.db, workspace.workspaceId, session.id)).toEqual(
          previousSession,
        );
        expect(
          (await getScheduledTask(client.db, workspace.workspaceId, task.id))?.agentConfig,
        ).toEqual({
          ...task.agentConfig,
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        });
      } finally {
        await connected.close();
      }
    },
  );

  test("model patches retain the Variable Set permission boundary", async () => {
    if (!available) return;
    const { workspace, task } = await fixture();
    await expect(
      validatedScheduledTaskUpdate({
        settings: deps(client.db).settings,
        db: client.db,
        objectStorage: null,
        grant: grantFor(workspace),
        existing: { ...task, variableSetId: crypto.randomUUID() },
        payload: UpdateScheduledTaskRequest.parse({
          agentConfigPatch: { reasoningEffort: "high" },
        }),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
  });

  test("a concurrent config edit is not overwritten by the validated model patch", async () => {
    if (!available) return;
    const { workspace, task } = await fixture();
    const grant = grantFor(workspace);
    const update = await validatedScheduledTaskUpdate({
      settings: deps(client.db).settings,
      db: client.db,
      objectStorage: null,
      grant,
      existing: task,
      payload: UpdateScheduledTaskRequest.parse({ agentConfigPatch: { reasoningEffort: "high" } }),
      toolsProvided: false,
    });
    expect(update.expectedExecutionDigest).toBe(task.executionDigest);
    const concurrent = await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      agentConfig: { ...task.agentConfig, prompt: "New instructions from another editor" },
    });
    await expect(
      updateScheduledTaskForApi(client.db, grant, task.id, update),
    ).rejects.toMatchObject({ status: 409 });
    expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(concurrent);
  });

  test("model patches cannot bypass model allowlists or schedule ownership", async () => {
    if (!available) return;
    const { workspace, task } = await fixture();
    for (const [grant, model] of [
      [grantFor(workspace), "forbidden-model"],
      [{ ...grantFor(workspace), subjectId: "user:other-participant" }, "gpt-5.6-sol"],
    ] as const) {
      const connected = await connectedClient(buildOpenGeniMcpServer(deps(client.db), grant));
      try {
        expect(
          await connected.client.callTool({
            name: "scheduled_tasks_update",
            arguments: { id: task.id, agentConfigPatch: { model } },
          }),
        ).toMatchObject({ isError: true });
        expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
      } finally {
        await connected.close();
      }
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
