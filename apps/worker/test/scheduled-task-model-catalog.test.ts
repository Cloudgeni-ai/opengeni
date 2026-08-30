import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  createWorkspaceGatewayCustomModel,
  deleteWorkspaceGatewayCustomModel,
  getScheduledTaskRunAcceptedExecution,
  listScheduledTaskRuns,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

async function acquireDatabase(): Promise<SharedTestDatabase | null> {
  const adminUrl = process.env.OPENGENI_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_TEST_POSTGRES_APP_URL;
  if (!adminUrl && !appUrl) {
    return await acquireSharedTestDatabase("worker-scheduled-model-catalog");
  }
  if (!adminUrl || !appUrl) {
    throw new Error(
      "OPENGENI_TEST_POSTGRES_ADMIN_URL and OPENGENI_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  const admin = postgres(adminUrl, { max: 4 });
  return {
    admin,
    adminUrl,
    appUrl,
    release: async () => await admin.end().catch(() => undefined),
  };
}

beforeAll(async () => {
  shared = await acquireDatabase();
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-model-catalog] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("scheduled-task model catalog retention (real PostgreSQL)", () => {
  test("keeps a retired custom Gateway model for an existing target session", async () => {
    if (!available) return;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `scheduled-model-account-${crypto.randomUUID()}`,
      accountName: "Scheduled model catalog account",
      workspaceExternalSource: "test",
      workspaceExternalId: `scheduled-model-workspace-${crypto.randomUUID()}`,
      workspaceName: "Scheduled model catalog workspace",
      subjectId: "user:scheduled-model-owner",
    });
    const grant = access.workspaceGrants[0]!;
    const upstreamModelId = "anthropic/claude-sonnet-4.6";
    const productModelId = `workspace-gateway/${upstreamModelId}`;
    const customModel = await createWorkspaceGatewayCustomModel(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      upstreamModelId,
      operationId: crypto.randomUUID(),
      requestHash: "1".repeat(64),
      createdBySubjectId: grant.subjectId,
    });
    if (!customModel) throw new Error("custom model create unexpectedly conflicted");
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Retired scheduled target model",
      resources: [],
      metadata: {},
      model: productModelId,
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const task = await createScheduledTask(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      name: "Continue retired scheduled target",
      status: "active",
      schedule: { type: "manual" },
      temporalScheduleId: `scheduled-model-${crypto.randomUUID()}`,
      runMode: "existing_session",
      targetSessionId: session.id,
      overlapPolicy: "allow_concurrent",
      agentConfig: {
        prompt: "Continue with the session's already accepted model",
        resources: [],
        tools: [],
        metadata: {},
      },
      metadata: {},
    });
    expect(
      await deleteWorkspaceGatewayCustomModel(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        customModelId: customModel.id,
        expectedVersion: customModel.version,
        operationId: crypto.randomUUID(),
        requestHash: "2".repeat(64),
      }),
    ).toMatchObject({ outcome: "success" });

    const activities = createScheduledTaskActivities(
      async () =>
        ({
          settings: testSettings({
            databaseUrl: shared!.appUrl,
            sandboxBackend: "none",
          }),
          db: client.db,
          bus: new MemoryEventBus(),
          wakeSessionWorkflow: async () => undefined,
        }) as unknown as ActivityServices,
    );
    const result = await activities.dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `scheduled-model-${crypto.randomUUID()}`,
    });

    expect(result.action).toBe("signal");
    const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10);
    const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
      workspaceId: grant.workspaceId,
      runId: run!.id,
    });
    expect(accepted?.targetSessionExecution?.model).toBe(productModelId);
    expect(TurnExecutionPolicyV1.parse(accepted?.turnExecutionPolicy)).toMatchObject({
      productModelId,
      modelSource: "session",
    });
  }, 60_000);
});
