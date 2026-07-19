import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import type { AccessGrant, Permission } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  claimPendingSessionWorkflowWakes,
  createDb,
  createVariableSet,
  deleteVariableSet,
  listSessionEvents,
  listSessionTurns,
  upsertWorkspaceModelPolicy,
  type Database,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps, SessionWorkflowClient } from "../src/dependencies";
import { createSessionForRequest } from "../src/domain/sessions";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("core-session-create-request");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

class RecordingWorkflowClient implements SessionWorkflowClient {
  wakeups: Parameters<SessionWorkflowClient["wakeSessionWorkflow"]>[0][] = [];
  wakeError: Error | null = null;

  async signalUserMessage(): Promise<void> {}

  async wakeSessionWorkflow(
    input: Parameters<SessionWorkflowClient["wakeSessionWorkflow"]>[0],
  ): Promise<void> {
    this.wakeups.push(input);
    if (this.wakeError) throw this.wakeError;
  }

  async requestSessionWorkflowWakeDispatch(): Promise<void> {}

  async signalApprovalDecision(): Promise<void> {}

  async syncScheduledTask(): Promise<void> {}

  async deleteScheduledTaskSchedule(): Promise<void> {}

  async triggerScheduledTask(): Promise<void> {}

  async startRigVerification(): Promise<void> {}
}

function deps(
  db: Database,
  settings: Settings,
  workflowClient = new RecordingWorkflowClient(),
  bus = new MemoryEventBus(),
): ApiRouteDeps {
  return {
    settings,
    db,
    bus,
    workflowClient,
    objectStorage: null as never,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are unused by session create tests");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is unused by session create tests");
    },
  };
}

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "core-create-test",
    accountExternalId: `account-${suffix}`,
    accountName: "Core session create test",
    workspaceExternalSource: "core-create-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Core session create test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant?.workspaceId) throw new Error("workspace bootstrap did not return a grant");
  return { grant };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  });
}

async function expectHttpStatus(promise: Promise<unknown>, status: number): Promise<HTTPException> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException);
    expect((error as HTTPException).status).toBe(status);
    return error as HTTPException;
  }
  throw new Error(`expected HTTP ${status}`);
}

function withoutPermission(grant: AccessGrant, permission: Permission): AccessGrant {
  return {
    ...grant,
    permissions: grant.permissions.filter((candidate) => candidate !== permission),
  };
}

describe("canonical session create request boundary", () => {
  test("identical retries return one complete receipt and redeliver its exact wake", async () => {
    const { grant } = await fixture();
    const workflow = new RecordingWorkflowClient();
    const bus = new MemoryEventBus();
    const dependencies = deps(client.db, settings(), workflow, bus);
    const request = {
      initialMessage: "Create exactly once",
      goal: { text: "Finish the boundary proof" },
      idempotencyKey: `core-identical:${crypto.randomUUID()}`,
    };

    const [first, second] = await Promise.all([
      createSessionForRequest(dependencies, grant, grant.workspaceId, request),
      createSessionForRequest(dependencies, grant, grant.workspaceId, request),
    ]);

    expect(second.id).toBe(first.id);
    expect(workflow.wakeups).toHaveLength(2);
    expect(workflow.wakeups[0]).toEqual(workflow.wakeups[1]);
    expect(workflow.wakeups[0]).toMatchObject({
      sessionId: first.id,
      workflowId: `session-${first.id}`,
      wakeRevision: 1,
    });
    expect(bus.published.flat()).toHaveLength(5);
    const events = await listSessionEvents(client.db, grant.workspaceId, first.id);
    expect(events.map((event) => [event.sequence, event.type])).toEqual([
      [1, "session.created"],
      [2, "goal.set"],
      [3, "user.message"],
      [4, "session.status.changed"],
      [5, "turn.queued"],
    ]);
    expect(await listSessionTurns(client.db, grant.workspaceId, first.id)).toHaveLength(1);
  });

  test("changed payloads conflict, including omitted versus explicitly empty tools", async () => {
    const { grant } = await fixture();
    const dependencies = deps(client.db, settings());
    const idempotencyKey = `core-conflict:${crypto.randomUUID()}`;
    const first = await createSessionForRequest(dependencies, grant, grant.workspaceId, {
      initialMessage: "Stable request",
      idempotencyKey,
    });

    await expectHttpStatus(
      createSessionForRequest(dependencies, grant, grant.workspaceId, {
        initialMessage: "Changed request",
        idempotencyKey,
      }),
      409,
    );
    await expectHttpStatus(
      createSessionForRequest(dependencies, grant, grant.workspaceId, {
        initialMessage: "Stable request",
        tools: [],
        idempotencyKey,
      }),
      409,
    );
    expect(await listSessionTurns(client.db, grant.workspaceId, first.id)).toHaveLength(1);
  });

  test("environmentId and variableSetId aliases share one request identity", async () => {
    const { grant } = await fixture();
    const variableSet = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `alias-${crypto.randomUUID()}`,
    });
    const workflow = new RecordingWorkflowClient();
    const dependencies = deps(client.db, settings(), workflow);
    const idempotencyKey = `core-alias:${crypto.randomUUID()}`;

    const first = await createSessionForRequest(dependencies, grant, grant.workspaceId, {
      initialMessage: "Alias identity",
      environmentId: variableSet.id,
      idempotencyKey,
    });
    const replay = await createSessionForRequest(dependencies, grant, grant.workspaceId, {
      initialMessage: "Alias identity",
      variableSetId: variableSet.id,
      idempotencyKey,
    });

    expect(replay.id).toBe(first.id);
    expect(workflow.wakeups.map((wake) => wake.wakeRevision)).toEqual([1, 1]);
  });

  test("replay preserves current authorization but bypasses deleted mutable dependencies", async () => {
    const { grant } = await fixture();
    const variableSet = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: `deleted-${crypto.randomUUID()}`,
    });
    const idempotencyKey = `core-deleted-variable-set:${crypto.randomUUID()}`;
    const request = {
      initialMessage: "Replay after dependency deletion",
      variableSetId: variableSet.id,
      idempotencyKey,
    };
    const first = await createSessionForRequest(
      deps(client.db, settings()),
      grant,
      grant.workspaceId,
      request,
    );
    expect(await deleteVariableSet(client.db, grant.workspaceId, variableSet.id)).toBe(true);

    await expectHttpStatus(
      createSessionForRequest(
        deps(client.db, settings()),
        withoutPermission(grant, "variable-sets:use"),
        grant.workspaceId,
        request,
      ),
      403,
    );
    const replay = await createSessionForRequest(
      deps(
        client.db,
        settings({
          openaiModel: "deployment-default-changed-after-commit",
          openaiAllowedModels: "deployment-default-changed-after-commit",
        }),
      ),
      grant,
      grant.workspaceId,
      request,
    );
    expect(replay.id).toBe(first.id);
  });

  test("MCP replay rechecks attach permission but precedes deployment id collisions", async () => {
    const { grant } = await fixture();
    const idempotencyKey = `core-mcp:${crypto.randomUUID()}`;
    const request = {
      initialMessage: "Attached private MCP",
      idempotencyKey,
      mcpServers: [
        {
          id: "private_crm",
          name: "Private CRM",
          url: "https://crm.example.test/mcp",
          headers: { Authorization: "Bearer write-only-secret" },
        },
      ],
    };
    const first = await createSessionForRequest(
      deps(client.db, settings()),
      grant,
      grant.workspaceId,
      request,
    );

    await expectHttpStatus(
      createSessionForRequest(
        deps(client.db, settings()),
        withoutPermission(grant, "mcp_servers:attach"),
        grant.workspaceId,
        request,
      ),
      403,
    );
    const replay = await createSessionForRequest(
      deps(
        client.db,
        settings({
          mcpServers: [
            {
              id: "private_crm",
              url: "https://deployment.example.test/mcp",
              cacheToolsList: false,
            },
          ],
        }),
      ),
      grant,
      grant.workspaceId,
      request,
    );
    expect(replay.id).toBe(first.id);
    expect(JSON.stringify(replay)).not.toContain("write-only-secret");
  });

  test("post-commit wake failure leaves a repairable outbox and response retry is stable", async () => {
    const { grant } = await fixture();
    const failedWorkflow = new RecordingWorkflowClient();
    failedWorkflow.wakeError = new Error("simulated Temporal outage");
    const request = {
      initialMessage: "Commit before delivery",
      idempotencyKey: `core-wake-gap:${crypto.randomUUID()}`,
    };

    const first = await createSessionForRequest(
      deps(client.db, settings(), failedWorkflow),
      grant,
      grant.workspaceId,
      request,
    );
    expect(failedWorkflow.wakeups).toHaveLength(1);
    expect(await listSessionTurns(client.db, grant.workspaceId, first.id)).toHaveLength(1);
    const pending = await claimPendingSessionWorkflowWakes(client.db, 100);
    expect(pending).toContainEqual(
      expect.objectContaining({
        sessionId: first.id,
        temporalWorkflowId: `session-${first.id}`,
        wakeRevision: 1,
      }),
    );

    const healthyWorkflow = new RecordingWorkflowClient();
    const replay = await createSessionForRequest(
      deps(client.db, settings(), healthyWorkflow),
      grant,
      grant.workspaceId,
      request,
    );
    expect(replay.id).toBe(first.id);
    expect(healthyWorkflow.wakeups).toEqual([
      expect.objectContaining({ sessionId: first.id, wakeRevision: 1 }),
    ]);
  });

  test("legacy receipts and newly-blocked mutable policy fail closed or replay in the right order", async () => {
    const { grant } = await fixture();
    const dependencies = deps(client.db, settings());
    const legacyRequest = {
      initialMessage: "Legacy receipt",
      idempotencyKey: `core-legacy:${crypto.randomUUID()}`,
    };
    const legacy = await createSessionForRequest(
      dependencies,
      grant,
      grant.workspaceId,
      legacyRequest,
    );
    await shared.admin`
      update sessions
      set initialization_version = 0
      where id = ${legacy.id}
    `;
    await expectHttpStatus(
      createSessionForRequest(dependencies, grant, grant.workspaceId, legacyRequest),
      409,
    );

    const replayRequest = {
      initialMessage: "Policy changes cannot invalidate a receipt",
      idempotencyKey: `core-policy:${crypto.randomUUID()}`,
    };
    const first = await createSessionForRequest(
      dependencies,
      grant,
      grant.workspaceId,
      replayRequest,
    );
    await upsertWorkspaceModelPolicy(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      allowedProviders: [],
      allowedModels: [],
    });
    const replay = await createSessionForRequest(
      dependencies,
      grant,
      grant.workspaceId,
      replayRequest,
    );
    expect(replay.id).toBe(first.id);

    await expectHttpStatus(
      createSessionForRequest(dependencies, grant, grant.workspaceId, {
        initialMessage: "A genuinely new request remains policy-checked",
        idempotencyKey: `core-policy-new:${crypto.randomUUID()}`,
      }),
      422,
    );
  });

  test("goal-free create has the canonical four-event prefix and one admitted turn", async () => {
    const { grant } = await fixture();
    const workflow = new RecordingWorkflowClient();
    const session = await createSessionForRequest(
      deps(client.db, settings(), workflow),
      grant,
      grant.workspaceId,
      {
        initialMessage: "No goal",
        idempotencyKey: `core-no-goal:${crypto.randomUUID()}`,
      },
    );
    const events = await listSessionEvents(client.db, grant.workspaceId, session.id);
    expect(events.map((event) => event.type)).toEqual([
      "session.created",
      "user.message",
      "session.status.changed",
      "turn.queued",
    ]);
    expect(await listSessionTurns(client.db, grant.workspaceId, session.id)).toHaveLength(1);
    expect(workflow.wakeups).toEqual([
      expect.objectContaining({ sessionId: session.id, wakeRevision: 1 }),
    ]);
  });
});
