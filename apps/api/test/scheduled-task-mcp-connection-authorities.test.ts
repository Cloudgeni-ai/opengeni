import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UpdateScheduledTaskRequest, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import {
  createValidatedScheduledTask,
  updateScheduledTaskForApi,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";
import {
  createDb,
  createConnection,
  createOrganizationApiKey,
  createRig,
  createRigVersion,
  createScheduledTask,
  createSession,
  createVariableSet,
  getScheduledTask,
  getScheduledTaskCreatorPolicy,
  getSession,
  updateScheduledTask,
  updateSessionVariableSets,
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
import { CreateScheduledTaskRequest } from "@opengeni/contracts";
import { scheduledTaskTargetAccessHttpError } from "../src/http/api-error";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-scheduled-task-mcp-connection-authorities");
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Scheduled task authority verification requires PostgreSQL");
    }
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

  async function materializedFixture() {
    const workspace = await workspaceFixture();
    await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${workspace.accountId}, ${workspace.workspaceId}, ${workspace.subjectId})`;
    const dependencies = deps(client.db);
    const currentTool = { kind: "mcp" as const, id: "current-integration" };
    dependencies.settings.mcpServers.push({
      id: currentTool.id,
      url: "https://current.example.test/mcp",
      cacheToolsList: false,
    });
    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: "Current chat",
      resources: [],
      tools: [currentTool],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "Materialized review",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "reusable_session",
      targetSessionId: session.id,
      overlapPolicy: "buffer_one",
      agentConfig: {
        prompt: "  Retained message  ",
        resources: [],
        tools: [{ kind: "mcp", id: "retired-integration" }],
        model: "retired-model",
        maxNestedAgentDepth: 1000,
        machineTarget: { targetSandboxId: crypto.randomUUID() },
        metadata: {},
        connectionAccounts: [],
        connectionAccountsFrozen: true,
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    expect(task.reusableSessionId).toBe(session.id);
    return { workspace, task, session, dependencies, currentTool };
  }

  test("materialized resource edits preserve unused stale creation defaults but validate changes", async () => {
    if (!available) return;
    const { workspace, task, session, dependencies } = await materializedFixture();
    const grant = grantFor(workspace);
    const resources = [
      { kind: "repository" as const, uri: "https://example.test/team/review.git", ref: "main" },
    ];
    const validate = (agentConfig: Record<string, unknown>) =>
      validatedScheduledTaskUpdate({
        ...dependencies,
        grant,
        existing: task,
        toolsProvided: true,
        payload: UpdateScheduledTaskRequest.parse({ agentConfig }),
      });
    for (const [change, status] of [
      [{ model: "another-retired-model" }, 422],
      [{ tools: [{ kind: "mcp", id: "another-retired-integration" }] }, 422],
      [{ maxNestedAgentDepth: 1001 }, 403],
      [{ machineTarget: { targetSandboxId: crypto.randomUUID() } }, 422],
    ] as const)
      await expect(validate({ ...task.agentConfig, resources, ...change })).rejects.toMatchObject({
        status,
      });
    await expect(
      validate({
        ...task.agentConfig,
        resources: [{ kind: "file", fileId: crypto.randomUUID() }],
      }),
    ).rejects.toMatchObject({ status: 503, message: "object storage is not configured" });
    const saved = await updateScheduledTaskForApi(
      client.db,
      grant,
      task.id,
      await validate({ ...task.agentConfig, resources }),
    );
    expect(saved.agentConfig).toMatchObject({
      ...task.agentConfig,
      resources: [{ ...resources[0], mountPath: "repos/example.test/team/review.git" }],
    });
    expect(await getSession(client.db, workspace.workspaceId, session.id)).toEqual(session);
  });

  test("materialized account edits resolve the current chat's connectors without session-control permission", async () => {
    if (!available) return;
    const { workspace, task, session, dependencies, currentTool } = await materializedFixture();
    const connection = await createConnection(client.db, {
      ...workspace,
      subjectId: null,
      providerDomain: "current.example.test",
      kind: "oauth2",
      credentialEncrypted: "unused-synthetic-credential",
    });
    dependencies.settings.mcpServers[0]!.connectionRef = {
      providerDomain: "current.example.test",
      kind: "oauth2",
      subjectScope: "workspace",
    };
    const grant = grantFor(workspace);
    const account = { serverId: currentTool.id, connectionId: connection.id };
    const update = await validatedScheduledTaskUpdate({
      ...dependencies,
      grant,
      existing: task,
      payload: UpdateScheduledTaskRequest.parse({ connectionAccounts: [account] }),
    });
    const saved = await updateScheduledTaskForApi(client.db, grant, task.id, update);
    expect(saved.agentConfig.connectionAccounts).toEqual([account]);
    expect(saved.agentConfig.tools).toEqual(task.agentConfig.tools);
    expect(saved.reusableSessionId).toBe(session.id);
  });

  test("materialized message edits check the chat's current Variable Sets", async () => {
    if (!available) return;
    const { workspace, task, session, dependencies } = await materializedFixture();
    const credentials = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "Current chat credentials",
    });
    expect(
      await updateSessionVariableSets(client.db, {
        ...workspace,
        sessionId: session.id,
        variableSets: [credentials],
      }),
    ).toMatchObject({ status: "updated" });
    const validate = (existing: typeof task, grant: AccessGrant) =>
      validatedScheduledTaskUpdate({
        ...dependencies,
        grant,
        existing,
        payload: UpdateScheduledTaskRequest.parse({ prompt: "Updated message" }),
      });
    await expect(validate(task, grantFor(workspace))).rejects.toMatchObject({ status: 403 });
    const authorized = {
      ...grantFor(workspace),
      permissions: ["scheduled_tasks:manage", "variable-sets:use"] as AccessGrant["permissions"],
    };
    expect((await validate(task, authorized)).agentConfig?.prompt).toBe("Updated message");

    // A retired creation binding must not require secret access once the chat
    // no longer uses it. The task column is retained only as a creation default.
    const staleTask = await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
      variableSetId: credentials.id,
    });
    expect(
      await updateSessionVariableSets(client.db, {
        ...workspace,
        sessionId: session.id,
        variableSets: [],
      }),
    ).toMatchObject({ status: "updated" });
    const saved = await updateScheduledTaskForApi(
      client.db,
      grantFor(workspace),
      task.id,
      await validate(staleTask, grantFor(workspace)),
    );
    expect(saved.agentConfig.prompt).toBe("Updated message");
  });

  test("leaving a materialized reusable chat permits new creation attachments", async () => {
    if (!available) return;
    const { workspace, task, session, dependencies } = await materializedFixture();
    dependencies.settings.environmentsEncryptionKey = Buffer.alloc(32, 9).toString("base64");
    const credentials = await createVariableSet(client.db, {
      ...workspace,
      scope: "workspace",
      name: "Fresh chat credentials",
    });
    const rig = await createRig(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      name: "Fresh chat environment",
      createdBy: workspace.subjectId,
      initialVersion: { changelog: "v1", defaultVariableSetIds: [credentials.id] },
    });
    const grant: AccessGrant = { ...grantFor(workspace), permissions: ["workspace:admin"] };
    const validate = (runMode: "reusable_session" | "new_session_per_run") =>
      validatedScheduledTaskUpdate({
        ...dependencies,
        grant,
        existing: task,
        toolsProvided: true,
        payload: UpdateScheduledTaskRequest.parse({
          runMode,
          variableSetId: credentials.id,
          rigId: rig.id,
          agentConfig: { prompt: "Fresh run", tools: [] },
        }),
      });
    await expect(validate("reusable_session")).rejects.toMatchObject({ status: 409 });
    const saved = await updateScheduledTaskForApi(
      client.db,
      grant,
      task.id,
      await validate("new_session_per_run"),
    );
    expect(saved).toMatchObject({
      runMode: "new_session_per_run",
      reusableSessionId: null,
      targetSessionId: null,
      variableSetId: credentials.id,
      rigId: rig.id,
    });
    expect(await getSession(client.db, workspace.workspaceId, session.id)).toEqual(session);
  });

  test.each([
    ["existing_session", true],
    ["existing_session", false],
    ["reusable_session", true],
    ["reusable_session", false],
  ] as const)(
    "%s message edits check pinned environment defaults (pinned secrets=%s)",
    async (runMode, pinnedSecrets) => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const dependencies = deps(client.db);
      const credentials = await createVariableSet(client.db, {
        ...workspace,
        scope: "workspace",
        name: "Environment-only credentials",
      });
      const rig = await createRig(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        name: "Pinned environment",
        createdBy: workspace.subjectId,
        initialVersion: {
          changelog: "Pinned version",
          defaultVariableSetIds: pinnedSecrets ? [credentials.id] : [],
        },
      });
      const session = await createSession(client.db, {
        ...workspace,
        initialMessage: "Pinned chat",
        resources: [],
        tools: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        rigId: rig.id,
        rigVersionId: rig.activeVersion!.id,
      });
      // The active version is deliberately opposite: existing chats continue
      // riding their pinned version, including its separate default sets.
      await createRigVersion(
        client.db,
        workspace.workspaceId,
        rig.id,
        {
          changelog: "New active version",
          defaultVariableSetIds: pinnedSecrets ? [] : [credentials.id],
        },
        { activate: true },
      );
      const task = await createScheduledTask(client.db, {
        ...workspace,
        name: "Pinned environment message",
        status: "paused",
        schedule: { type: "manual" },
        temporalScheduleId: crypto.randomUUID(),
        runMode,
        targetSessionId: session.id,
        overlapPolicy: "buffer_one",
        agentConfig: { prompt: "Original message", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        metadata: {},
      });
      expect(session.variableSetIds).toEqual([]);
      expect(task.variableSetId).toBeNull();
      const grant: AccessGrant = {
        ...grantFor(workspace),
        permissions: ["scheduled_tasks:manage", "sessions:control"],
      };
      const validate = (usingGrant: AccessGrant) =>
        validatedScheduledTaskUpdate({
          ...dependencies,
          grant: usingGrant,
          existing: task,
          payload: UpdateScheduledTaskRequest.parse({ prompt: "Updated environment message" }),
        });
      if (pinnedSecrets) await expect(validate(grant)).rejects.toMatchObject({ status: 403 });
      else expect((await validate(grant)).agentConfig?.prompt).toBe("Updated environment message");
      const authorized: AccessGrant = {
        ...grant,
        permissions: [...grant.permissions, "variable-sets:use"],
      };
      const saved = await updateScheduledTaskForApi(
        client.db,
        authorized,
        task.id,
        await validate(authorized),
      );
      expect(saved.agentConfig.prompt).toBe("Updated environment message");
      if (runMode === "existing_session") {
        const create = () =>
          createValidatedScheduledTask({
            ...dependencies,
            grant,
            payload: CreateScheduledTaskRequest.parse({
              name: "New pinned message",
              schedule: { type: "manual" },
              prompt: "Use pinned defaults",
              targetSessionId: session.id,
            }),
          });
        if (pinnedSecrets) await expect(create()).rejects.toMatchObject({ status: 403 });
        else expect((await create()).targetSessionId).toBe(session.id);
      }
    },
  );

  test.each(["reusable_session", "new_session_per_run"] as const)(
    "%s generated message edits check active environment defaults",
    async (runMode) => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const dependencies = deps(client.db);
      const credentials = await createVariableSet(client.db, {
        ...workspace,
        scope: "workspace",
        name: "Generated environment credentials",
      });
      const rig = await createRig(client.db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        name: "Generated environment",
        createdBy: workspace.subjectId,
        initialVersion: { changelog: "Initial version", defaultVariableSetIds: [] },
      });
      const task = await createScheduledTask(client.db, {
        ...workspace,
        name: "Generated environment message",
        status: "paused",
        schedule: { type: "manual" },
        temporalScheduleId: crypto.randomUUID(),
        runMode,
        rigId: rig.id,
        overlapPolicy: "buffer_one",
        agentConfig: { prompt: "Original message", resources: [], tools: [], metadata: {} },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        metadata: {},
      });
      await createRigVersion(
        client.db,
        workspace.workspaceId,
        rig.id,
        { changelog: "Uses credentials", defaultVariableSetIds: [credentials.id] },
        { activate: true },
      );
      const grant = grantFor(workspace);
      const validate = (usingGrant: AccessGrant) =>
        validatedScheduledTaskUpdate({
          ...dependencies,
          grant: usingGrant,
          existing: task,
          payload: UpdateScheduledTaskRequest.parse({ prompt: "Updated generated message" }),
        });
      await expect(validate(grant)).rejects.toMatchObject({ status: 403 });
      expect(
        (await validate({ ...grant, permissions: [...grant.permissions, "variable-sets:use"] }))
          .agentConfig?.prompt,
      ).toBe("Updated generated message");
      await createRigVersion(
        client.db,
        workspace.workspaceId,
        rig.id,
        { changelog: "No credentials", defaultVariableSetIds: [] },
        { activate: true },
      );
      expect((await validate(grant)).agentConfig?.prompt).toBe("Updated generated message");
    },
  );

  test.each(["prompt", "agentConfigPatch"] as const)(
    "narrow %s edits reject blank messages before persistence",
    async (surface) => {
      if (!available) return;
      const { workspace, task } = await fixture();
      await expect(
        validatedScheduledTaskUpdate({
          ...deps(client.db),
          grant: grantFor(workspace),
          existing: task,
          payload: UpdateScheduledTaskRequest.parse(
            surface === "prompt"
              ? { prompt: " \n\t " }
              : { agentConfigPatch: { prompt: " \n\t " } },
          ),
        }),
      ).rejects.toMatchObject({ status: 422, message: "scheduled task prompt is required" });
      expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
    },
  );

  test.each([false, true])(
    "narrow message edits preserve explicit whitespace and Unicode (retarget=%s)",
    async (retarget) => {
      if (!available) return;
      const { workspace, task } = await fixture();
      const session = retarget
        ? await createSession(client.db, {
            ...workspace,
            initialMessage: "Target",
            resources: [],
            metadata: {},
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard",
            sandboxBackend: "none",
          })
        : null;
      const prompt = "  Exact message — 👋\n\tIndented content\n  ";
      const grant: AccessGrant = {
        ...grantFor(workspace),
        permissions: ["scheduled_tasks:manage", "sessions:control"],
      };
      const update = await validatedScheduledTaskUpdate({
        ...deps(client.db),
        grant,
        existing: task,
        payload: UpdateScheduledTaskRequest.parse({
          prompt,
          ...(session ? { targetSessionId: session.id } : {}),
        }),
      });
      const saved = await updateScheduledTaskForApi(client.db, grant, task.id, update);
      expect(saved.agentConfig.prompt).toBe(prompt);
      expect(saved.agentConfig.resources).toEqual(task.agentConfig.resources);
      expect(saved.agentConfig.metadata).toEqual(task.agentConfig.metadata);
    },
  );

  test.each(["prompt", "agentConfigPatch"] as const)(
    "combined %s and retarget edits reject oversized escaped occurrence payloads",
    async (surface) => {
      if (!available) return;
      const { workspace, task } = await fixture();
      const session = await createSession(client.db, {
        ...workspace,
        initialMessage: "Target",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
      });
      const prompt = '"'.repeat(33_000);
      const grant: AccessGrant = {
        ...grantFor(workspace),
        permissions: ["scheduled_tasks:manage", "sessions:control"],
      };
      const payload = UpdateScheduledTaskRequest.parse({
        ...(surface === "prompt" ? { prompt } : { agentConfigPatch: { prompt } }),
        targetSessionId: session.id,
      });
      await expect(
        validatedScheduledTaskUpdate({ ...deps(client.db), grant, existing: task, payload }),
      ).rejects.toMatchObject({
        status: 422,
        message:
          "Updated scheduled message and attachments exceed the supported occurrence payload",
      });
      expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);

      // Existing over-limit text remains movable when the caller does not edit it.
      const legacy = await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
        agentConfig: { ...task.agentConfig, prompt },
      });
      const move = await validatedScheduledTaskUpdate({
        ...deps(client.db),
        grant,
        existing: legacy,
        payload: UpdateScheduledTaskRequest.parse({ targetSessionId: session.id }),
      });
      const moved = await updateScheduledTaskForApi(client.db, grant, task.id, move);
      expect(moved.agentConfig.prompt).toBe(prompt);
      expect(moved.targetSessionId).toBe(session.id);
    },
  );

  test("full configuration updates preserve exact prompt bytes while editing other settings", async () => {
    if (!available) return;
    const { workspace, task } = await fixture();
    const grant = grantFor(workspace);
    const dependencies = deps(client.db);
    dependencies.settings.mcpServers.push({
      id: "opengeni",
      url: "https://tools.example.test/mcp",
      cacheToolsList: false,
    });
    const update = await validatedScheduledTaskUpdate({
      ...dependencies,
      grant,
      existing: task,
      toolsProvided: true,
      payload: UpdateScheduledTaskRequest.parse({
        agentConfig: { ...task.agentConfig, reasoningEffort: "high" },
      }),
    });
    const saved = await updateScheduledTaskForApi(client.db, grant, task.id, update);
    expect(saved.agentConfig.prompt).toBe(task.agentConfig.prompt);
    expect(saved.agentConfig.reasoningEffort).toBe("high");
  });

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
      const bound = await updateScheduledTask(client.db, workspace.workspaceId, task.id, {
        runMode,
        ...(runMode === "existing_session"
          ? { targetSessionId: session.id }
          : { reusableSessionId: session.id }),
      });
      expect(runMode === "existing_session" ? bound.targetSessionId : bound.reusableSessionId).toBe(
        session.id,
      );
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
    "removing the last personal GitHub repository drops only an omitted account choice (explicit=%s)",
    async (explicit) => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const [sharedWorkspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${workspace.accountId}, 'Repository task workspace') returning id`;
      workspace.workspaceId = sharedWorkspace!.id;
      await admin`insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace.workspaceId}, ${workspace.accountId})`;
      await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
        values (${workspace.accountId}, ${workspace.workspaceId}, ${workspace.subjectId})`;
      const account = { serverId: "github:personal", connectionId: crypto.randomUUID() };
      const task = await createScheduledTask(client.db, {
        ...workspace,
        name: "Repository review",
        status: "paused",
        schedule: { type: "manual" },
        temporalScheduleId: crypto.randomUUID(),
        runMode: "new_session_per_run",
        overlapPolicy: "buffer_one",
        agentConfig: {
          prompt: "Review selected resources",
          resources: [
            {
              kind: "repository",
              uri: `https://github.com/${crypto.randomUUID()}/${crypto.randomUUID()}`,
              ref: "main",
              provider: "github",
              connectionType: "github_personal",
              credentialBindingId: crypto.randomUUID(),
              repositoryId: "123456789",
              access: "read",
            },
          ],
          tools: [],
          metadata: {},
          connectionAccounts: [account],
          connectionAccountsFrozen: true,
        },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        metadata: {},
      });
      const grant = grantFor(workspace);
      const validate = () =>
        validatedScheduledTaskUpdate({
          ...deps(client.db),
          grant,
          existing: task,
          toolsProvided: true,
          payload: UpdateScheduledTaskRequest.parse({
            agentConfig: { ...task.agentConfig, resources: [] },
            ...(explicit ? { connectionAccounts: [account] } : {}),
          }),
        });
      if (explicit) {
        await expect(validate()).rejects.toThrow("did not match a selected MCP server");
        expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toEqual(task);
        return;
      }
      const saved = await updateScheduledTaskForApi(client.db, grant, task.id, await validate());
      expect(saved.agentConfig.resources).toEqual([]);
      expect(saved.agentConfig.connectionAccounts).toEqual([]);
      expect(saved.agentConfig.connectionAccountsFrozen).toBe(true);
    },
  );

  test.each(["legacy", "cancelled", "deleted"] as const)(
    "moves away from a %s target without duplicating attachment permission",
    async (state) => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const grant: AccessGrant = {
        ...grantFor(workspace),
        permissions: ["scheduled_tasks:manage", "sessions:control", "variable-sets:use"],
      };
      const variables = await createVariableSet(client.db, {
        ...workspace,
        scope: "workspace",
        name: "Review inputs",
      });
      const makeChat = () =>
        createSession(client.db, {
          ...workspace,
          initialMessage: "Review",
          resources: [],
          metadata: {},
          variableSetId: variables.id,
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        });
      const [source, destination] = await Promise.all([makeChat(), makeChat()]);
      let task = await createScheduledTask(client.db, {
        ...workspace,
        name: "Move review",
        status: "paused",
        schedule: { type: "manual" },
        temporalScheduleId: crypto.randomUUID(),
        runMode: "existing_session",
        targetSessionId: source.id,
        variableSetId: state === "legacy" ? variables.id : null,
        overlapPolicy: "buffer_one",
        agentConfig: {
          prompt: "Review inputs",
          resources: [],
          tools: [],
          metadata: {},
          connectionAccounts: [],
          connectionAccountsFrozen: true,
        },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        metadata: {},
      });
      if (state === "cancelled")
        await admin`update sessions set status = 'cancelled' where id = ${source.id}`;
      if (state === "deleted") {
        // The session FK clears this pointer on deletion.
        await admin`update scheduled_tasks set reusable_session_id = null where id = ${task.id}`;
        task = (await getScheduledTask(client.db, workspace.workspaceId, task.id))!;
        expect(task.targetSessionId).toBeNull();
      }
      const change = await validatedScheduledTaskUpdate({
        ...deps(client.db),
        grant,
        existing: task,
        payload: UpdateScheduledTaskRequest.parse({
          targetSessionId: destination.id,
          expectedExecutionDigest: task.executionDigest,
        }),
      });
      const saved = await updateScheduledTaskForApi(client.db, grant, task.id, change);
      expect(saved.targetSessionId).toBe(destination.id);
      expect(saved.variableSetId).toBeNull();
      expect(saved.agentConfig.prompt).toBe(task.agentConfig.prompt);
    },
    60_000,
  );

  test("minimal conversational scheduling targets the signed calling chat and inherits execution", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: "Review activity",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "high",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const connected = await connectedClient(
      buildOpenGeniMcpServer(deps(client.db), {
        ...grantFor(workspace),
        permissions: ["scheduled_tasks:manage", "sessions:control"],
        metadata: {
          sessionId: session.id,
          firstPartyMcpTools: ["scheduled_tasks_create", "scheduled_tasks_get"],
        },
      }),
    );
    try {
      const response = await connected.client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "Morning review",
          schedule: { type: "interval", everySeconds: 3600 },
          prompt: "Review new activity.",
        },
      });
      expect(response.isError).not.toBe(true);
      const receipt = JSON.parse(resultText(response));
      const task = await getScheduledTask(client.db, workspace.workspaceId, receipt.resource.id);
      expect(task).toMatchObject({
        runMode: "existing_session",
        targetSessionId: session.id,
        variableSetId: null,
        rigId: null,
        overlapPolicy: "buffer_one",
      });
      expect(task!.agentConfig.model).toBeUndefined();
      expect(task!.agentConfig.agent).toBeUndefined();
      expect(task!.agentConfig.tools).toEqual([]);
      const read = await connected.client.callTool({
        name: "scheduled_tasks_get",
        arguments: { id: task!.id },
      });
      expect(JSON.parse(resultText(read))).toMatchObject({
        executionDigest: task!.executionDigest,
        configuration: { source: "target_session", model: null },
      });
    } finally {
      await connected.close();
    }
  }, 60_000);

  test("moves a materialized schedule without rebuilding its message and rejects stale edits", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const grant = {
      ...grantFor(workspace),
      permissions: ["scheduled_tasks:manage", "sessions:control"] as const,
    };
    const session = await createSession(client.db, {
      ...workspace,
      initialMessage: "Target",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const original = await createScheduledTask(client.db, {
      ...workspace,
      name: "Retained message",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "reusable_session",
      targetSessionId: session.id,
      overlapPolicy: "buffer_one",
      agentConfig: {
        prompt: "  Exact message\n" + "retained content ".repeat(900) + "  ",
        resources: [],
        tools: [],
        metadata: { exact: { keep: true } },
        model: "scripted-model",
        connectionAccounts: [],
        connectionAccountsFrozen: true,
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: { keep: true },
    });
    expect(original.reusableSessionId).toBe(session.id);
    const update = await validatedScheduledTaskUpdate({
      ...deps(client.db),
      grant: { ...grant, permissions: [...grant.permissions] },
      existing: original,
      payload: UpdateScheduledTaskRequest.parse({
        targetSessionId: session.id,
        expectedExecutionDigest: original.executionDigest,
      }),
    });
    const saved = await updateScheduledTaskForApi(
      client.db,
      { ...grant, permissions: [...grant.permissions] },
      original.id,
      update,
    );
    expect(saved).toMatchObject({
      runMode: "existing_session",
      targetSessionId: session.id,
      status: "paused",
      metadata: original.metadata,
      schedule: original.schedule,
    });
    expect(saved.agentConfig).toEqual({
      prompt: original.agentConfig.prompt,
      resources: [],
      tools: [],
      metadata: original.agentConfig.metadata,
      connectionAccounts: [],
      connectionAccountsFrozen: true,
    });
    await expect(
      validatedScheduledTaskUpdate({
        ...deps(client.db),
        grant: { ...grant, permissions: [...grant.permissions] },
        existing: saved,
        payload: { name: "Stale edit", expectedExecutionDigest: original.executionDigest },
      }),
    ).rejects.toMatchObject({ status: 409 });
  }, 60_000);

  test.each(["existing_session", "reusable_session"] as const)(
    "moving a %s schedule reports the old chat's attachments through HTTP and MCP",
    async (runMode) => {
      if (!available) return;
      const workspace = await workspaceFixture();
      const grant = {
        ...grantFor(workspace),
        permissions: [
          "scheduled_tasks:manage",
          "sessions:control",
          "variable-sets:use",
        ] as import("@opengeni/contracts").Permission[],
      };
      const variableSet = await createVariableSet(client.db, {
        ...workspace,
        scope: "workspace",
        name: "Review inputs",
      });
      const makeChat = (variableSetId: string | null) =>
        createSession(client.db, {
          ...workspace,
          initialMessage: "Review",
          resources: [],
          metadata: {},
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
          variableSetId,
        });
      const [source, target] = await Promise.all([makeChat(variableSet.id), makeChat(null)]);
      const task =
        runMode === "existing_session"
          ? await createValidatedScheduledTask({
              ...deps(client.db),
              grant,
              payload: CreateScheduledTaskRequest.parse({
                name: "Review",
                schedule: { type: "manual" },
                prompt: "Review inputs",
                targetSessionId: source.id,
              }),
            })
          : await createScheduledTask(client.db, {
              ...workspace,
              name: "Review",
              status: "active",
              schedule: { type: "manual" },
              temporalScheduleId: crypto.randomUUID(),
              runMode,
              targetSessionId: source.id,
              overlapPolicy: "buffer_one",
              agentConfig: { prompt: "Review inputs", resources: [], tools: [], metadata: {} },
              createdBy: { kind: "subject", subjectId: workspace.subjectId },
              metadata: {},
            });
      if (runMode === "reusable_session") expect(task.reusableSessionId).toBe(source.id);
      expect(task.variableSetId).toBeNull();
      const payload = { targetSessionId: target.id, expectedExecutionDigest: task.executionDigest };
      let conflict: unknown;
      try {
        await validatedScheduledTaskUpdate({ ...deps(client.db), grant, existing: task, payload });
      } catch (error) {
        conflict = error;
      }
      expect(scheduledTaskTargetAccessHttpError(conflict)?.details).toMatchObject({
        code: "scheduled_target_access_change",
        removedVariableSetCount: 1,
        removedVariableSetIds: [variableSet.id],
        targetSessionId: target.id,
      });
      const connected = await connectedClient(buildOpenGeniMcpServer(deps(client.db), grant));
      try {
        const result = await connected.client.callTool({
          name: "scheduled_tasks_update",
          arguments: { id: task.id, ...payload },
        });
        expect(result.isError).toBe(true);
        expect(JSON.parse(resultText(result)).error.details).toMatchObject({
          code: "scheduled_target_access_change",
          removedVariableSetIds: [variableSet.id],
        });
        const saved = await connected.client.callTool({
          name: "scheduled_tasks_update",
          arguments: { id: task.id, ...payload, adoptSessionSettings: true },
        });
        expect(saved.isError).not.toBe(true);
        expect(await getScheduledTask(client.db, workspace.workspaceId, task.id)).toMatchObject({
          targetSessionId: target.id,
          variableSetId: null,
        });
      } finally {
        await connected.close();
      }
    },
    60_000,
  );

  test("creates an interval task through MCP using the advertised minimal agent input", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const dependencies = deps(client.db);
    const connected = await connectedClient(
      buildOpenGeniMcpServer(dependencies, grantFor(workspace)),
    );
    try {
      const result = await connected.client.callTool({
        name: "scheduled_tasks_create",
        arguments: {
          name: "Interval monitor",
          runMode: "new_session_per_run",
          schedule: { type: "interval", everySeconds: 7_200 },
          agentConfig: { prompt: "Report activity" },
        },
      });
      expect(result.isError).not.toBe(true);
      const receipt = JSON.parse(resultText(result));
      expect(receipt).toMatchObject({ operation: "scheduled_tasks_create", outcome: "created" });
      const task = await getScheduledTask(client.db, workspace.workspaceId, receipt.resource.id);
      expect(task).toMatchObject({
        schedule: { type: "interval", everySeconds: 7_200 },
        action: { kind: "agent_turn" },
        agentConfig: { prompt: "Report activity" },
      });
      expect((dependencies.workflowClient as FakeWorkflowClient).synced).toHaveLength(1);
    } finally {
      await connected.close();
    }
  });

  test.each([
    [false, false, "live"],
    [true, false, "live"],
    [false, true, "live"],
    [true, true, "live"],
    [false, true, "deleted"],
    [true, true, "deleted"],
    [false, true, "changed"],
  ] as const)(
    "removing an MCP tool preserves explicit-account validation (explicit=%s, existing chat=%s, source=%s)",
    async (explicit, existingChat, sourceState) => {
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
      const oldTools = [
        { kind: "mcp" as const, id: "removed-integration", optional: true },
        retainedTool,
      ];
      const makeChat = (tools: typeof oldTools) =>
        createSession(client.db, {
          ...workspace,
          initialMessage: "Review",
          resources: [],
          metadata: {},
          tools,
          model: "scripted-model",
          reasoningEffort: "medium",
          latencyMode: "standard",
          sandboxBackend: "none",
        });
      const source = existingChat ? await makeChat(oldTools) : null;
      const destination = existingChat ? await makeChat([retainedTool]) : null;
      let task = await createScheduledTask(client.db, {
        ...workspace,
        name: "remove selected integration",
        status: "active",
        schedule: { type: "interval", everySeconds: 3_600 },
        temporalScheduleId: `scheduled-task-${crypto.randomUUID()}`,
        runMode: existingChat ? "existing_session" : "new_session_per_run",
        targetSessionId: source?.id ?? null,
        overlapPolicy: "allow_concurrent",
        agentConfig: {
          connectionAccounts: [
            { serverId: "removed-integration", connectionId: crypto.randomUUID() },
            retainedAccount,
          ],
          connectionAccountsFrozen: true,
          prompt: "scheduled prompt",
          resources: [],
          tools: existingChat ? [] : oldTools,
          metadata: {},
        },
        createdBy: { kind: "subject", subjectId: workspace.subjectId },
        metadata: {},
      });
      if (sourceState === "deleted") {
        await admin`update scheduled_tasks set reusable_session_id = null where id = ${task.id}`;
        task = (await getScheduledTask(client.db, workspace.workspaceId, task.id))!;
      }
      if (sourceState === "changed") {
        await admin`update sessions set tools = '[]'::jsonb where id = ${source!.id}`;
      }
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
        buildOpenGeniMcpServer(dependencies, {
          ...grantFor(workspace),
          permissions: ["scheduled_tasks:manage", "sessions:control"],
        }),
      );
      try {
        const result = await connected.client.callTool({
          name: "scheduled_tasks_update",
          arguments: {
            id: task.id,
            ...(destination
              ? { targetSessionId: destination.id }
              : {
                  agentConfig: { prompt: "scheduled prompt", resources: [], tools: [retainedTool] },
                }),
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
      expect(after?.agentConfig.tools).toEqual(existingChat ? [] : [retainedTool]);
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

  test("editing one frozen account keeps another connector's empty selection", async () => {
    if (!available) return;
    const workspace = await workspaceFixture();
    const dependencies = deps(client.db);
    for (const id of ["selected-integration", "empty-integration"])
      dependencies.settings.mcpServers.push({
        id,
        url: `https://${id}.example.test/mcp`,
        cacheToolsList: false,
        connectionRef: {
          providerDomain: `${id}.example.test`,
          kind: "oauth2",
          subjectScope: "workspace",
        },
      });
    const accounts = await Promise.all(
      ["selected-integration", "selected-integration", "empty-integration"].map((id) =>
        createConnection(client.db, {
          ...workspace,
          subjectId: null,
          providerDomain: `${id}.example.test`,
          kind: "oauth2",
          credentialEncrypted: "synthetic-test-credential",
        }),
      ),
    );
    const task = await createScheduledTask(client.db, {
      ...workspace,
      name: "Exact frozen selections",
      status: "paused",
      schedule: { type: "manual" },
      temporalScheduleId: crypto.randomUUID(),
      runMode: "new_session_per_run",
      overlapPolicy: "skip",
      agentConfig: {
        prompt: "Use the selected integration",
        tools: [
          { kind: "mcp", id: "selected-integration" },
          { kind: "mcp", id: "empty-integration" },
        ],
        resources: [],
        metadata: {},
        connectionAccounts: [{ serverId: "selected-integration", connectionId: accounts[0]!.id }],
        connectionAccountsFrozen: true,
      },
      createdBy: { kind: "subject", subjectId: workspace.subjectId },
      metadata: {},
    });
    const requested = [{ serverId: "selected-integration", connectionId: accounts[1]!.id }];
    const grant = grantFor(workspace);
    const saved = await updateScheduledTaskForApi(
      client.db,
      grant,
      task.id,
      await validatedScheduledTaskUpdate({
        ...dependencies,
        grant,
        existing: task,
        payload: UpdateScheduledTaskRequest.parse({ connectionAccounts: requested }),
      }),
    );
    expect(saved.agentConfig.connectionAccounts).toEqual(requested);
    expect(saved.agentConfig.connectionAccountsFrozen).toBe(true);
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
