import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_OPENROUTER_MODEL_ID, type Settings } from "@opengeni/config";
import { TurnExecutionPolicyV1 } from "@opengeni/contracts";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  getScheduledTaskRunAcceptedExecution,
  listScheduledTaskRuns,
  updateCodexRotationSettings,
  upsertCodexSubscriptionCredential,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-default-model");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-default-model] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

// Hosted-like deployment: free OpenRouter default, OpenGeni credits billing,
// and the ChatGPT/Codex subscription rail enabled.
function settings(): Settings {
  return testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    openrouterApiKey: "openrouter-test-key",
    openaiModel: DEFAULT_OPENROUTER_MODEL_ID,
    openaiAllowedModels: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
    billingMode: "stripe",
    codexSubscriptionEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  });
}

function activities() {
  const current = settings();
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: current,
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
}

async function workspace() {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `scheduled-default-account-${crypto.randomUUID()}`,
    accountName: "Scheduled default model account",
    workspaceExternalSource: "test",
    workspaceExternalId: `scheduled-default-workspace-${crypto.randomUUID()}`,
    workspaceName: "Scheduled default model workspace",
    subjectId: `user:scheduled-default-${crypto.randomUUID()}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!
    .admin`insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal default model fixture') returning id`;
  await shared!
    .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return grant;
}

async function dailyReport(
  grant: Awaited<ReturnType<typeof workspace>>,
  model?: string,
): Promise<string> {
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Daily report",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-default-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Write the daily report",
      ...(model ? { model } : {}),
      resources: [],
      tools: [],
      metadata: {},
    },
    metadata: {},
  });
  return task.id;
}

async function occurrence(grant: Awaited<ReturnType<typeof workspace>>, taskId: string) {
  const result = await activities().dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: `scheduled-default-${crypto.randomUUID()}`,
  });
  expect(result.action).toBe("start");
  const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 1);
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: grant.workspaceId,
    runId: run!.id,
  });
  return {
    model: accepted!.resolvedModel,
    reasoningEffort: accepted!.resolvedReasoningEffort,
    policy: TurnExecutionPolicyV1.parse(accepted!.turnExecutionPolicy),
  };
}

describe("scheduled occurrences without a model use the resolved default", () => {
  test("free default, then credits, then a connected subscription; explicit models stay", async () => {
    if (!available) return;
    const grant = await workspace();
    const report = await dailyReport(grant);
    const pinned = await dailyReport(grant, DEFAULT_OPENROUTER_MODEL_ID);

    expect(await occurrence(grant, report)).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      policy: { modelSource: "deployment" },
    });

    await applyCreditLedgerEntry(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      type: "test_credit",
      amountMicros: 5_000_000,
      sourceType: "test",
      sourceId: grant.workspaceId,
      idempotencyKey: `test:scheduled-default-credit:${grant.workspaceId}`,
    });
    expect(await occurrence(grant, report)).toMatchObject({
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      policy: { productModelId: "gpt-6-luna", modelSource: "deployment" },
    });
    expect(await occurrence(grant, pinned)).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      policy: { modelSource: "explicit" },
    });

    const key = Buffer.from(settings().environmentsEncryptionKey!, "base64");
    await upsertCodexSubscriptionCredential(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      credentialEncrypted: encryptEnvironmentValue(
        key,
        JSON.stringify({ access_token: "test", refresh_token: "test", id_token: "test" }),
      ),
      chatgptAccountId: `scheduled-default-${grant.workspaceId}`,
      scopes: null,
      planType: "pro",
      isFedramp: false,
      expiresAt: new Date(Date.now() + 60_000),
      lastRefreshAt: new Date(),
    });
    await ensureCodexRotationSettings(client.db, grant.accountId, grant.workspaceId);
    await updateCodexRotationSettings(client.db, grant.workspaceId, { rotationEnabled: true });
    expect(await occurrence(grant, report)).toMatchObject({
      model: "codex/gpt-6-astra",
      reasoningEffort: "high",
    });
  }, 120_000);
});
