import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_OPENROUTER_MODEL_ID, type Settings } from "@opengeni/config";
import {
  TurnExecutionPolicyV1,
  type XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { resolveScheduledTaskPreflightModel } from "@opengeni/core";
import {
  applyCreditLedgerEntry,
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  getScheduledTask,
  createXaiSubscriptionCredential,
  disconnectXaiSubscriptionCredential,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  ensureXaiRotationSettings,
  setInitialActiveXaiCredential,
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
function settings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    openrouterApiKey: "openrouter-test-key",
    openaiModel: DEFAULT_OPENROUTER_MODEL_ID,
    openaiAllowedModels: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
    billingMode: "stripe",
    codexSubscriptionEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  });
}

function activities(overrides: Partial<Settings> = {}) {
  const current = settings(overrides);
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
  xaiProviderAccountAuthoritySnapshot?: XaiProviderAccountAuthoritySnapshotV1,
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
    ...(xaiProviderAccountAuthoritySnapshot ? { xaiProviderAccountAuthoritySnapshot } : {}),
    metadata: {},
  });
  return task.id;
}

async function occurrence(
  grant: Awaited<ReturnType<typeof workspace>>,
  taskId: string,
  options: { producerKey?: string; settings?: Partial<Settings> } = {},
) {
  const result = await activities(options.settings).dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "scheduled",
    producerKey: options.producerKey ?? `scheduled-default-${crypto.randomUUID()}`,
  });
  expect(result.action).toBe("start");
  const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 1);
  const accepted = await getScheduledTaskRunAcceptedExecution(client.db, {
    workspaceId: grant.workspaceId,
    runId: run!.id,
  });
  return {
    runId: run!.id,
    sessionId: result.action === "start" ? result.sessionId : null,
    model: accepted!.resolvedModel,
    reasoningEffort: accepted!.resolvedReasoningEffort,
    policy: TurnExecutionPolicyV1.parse(accepted!.turnExecutionPolicy),
  };
}

async function addCredits(grant: Awaited<ReturnType<typeof workspace>>) {
  await applyCreditLedgerEntry(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    type: "test_credit",
    amountMicros: 5_000_000,
    sourceType: "test",
    sourceId: grant.workspaceId,
    idempotencyKey: `test:scheduled-default-credit:${grant.workspaceId}`,
  });
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

    await addCredits(grant);
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

  test("a retried occurrence keeps its accepted model after credits arrive", async () => {
    if (!available) return;
    const grant = await workspace();
    const report = await dailyReport(grant);
    const producerKey = `scheduled-default-${crypto.randomUUID()}`;
    const first = await occurrence(grant, report, { producerKey });
    expect(first).toMatchObject({ model: DEFAULT_OPENROUTER_MODEL_ID });

    await addCredits(grant);
    // The same occurrence replays its accepted execution; it never resolves again.
    const replayed = await occurrence(grant, report, { producerKey });
    expect(replayed).toMatchObject({
      runId: first.runId,
      sessionId: first.sessionId,
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: first.reasoningEffort,
    });
    const [session] = await shared!.admin<{ model: string }[]>`
      select model from sessions where id = ${first.sessionId}`;
    expect(session?.model).toBe(DEFAULT_OPENROUTER_MODEL_ID);
    // The next fresh occurrence uses the credits default.
    expect(await occurrence(grant, report)).toMatchObject({ model: "gpt-6-luna" });
  }, 120_000);

  test("a stale frozen SuperGrok snapshot still dispatches on the next default", async () => {
    if (!available) return;
    const supergrok = { supergrokSubscriptionEnabled: true };
    const grant = await workspace();
    const personal = await createXaiSubscriptionCredential(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      scope: "user",
      encryptionKey: Buffer.from(settings().environmentsEncryptionKey!, "base64"),
      secret: { version: 1, accessToken: `scheduled-default-${crypto.randomUUID()}` },
      providerAccountId: `scheduled-default-${crypto.randomUUID()}`,
      label: "personal SuperGrok",
    });
    const authority = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      authoritySnapshot: personal.authoritySnapshot,
    };
    const rotation = await ensureXaiRotationSettings(client.db, authority);
    if (rotation.activeCredentialId === null) {
      await setInitialActiveXaiCredential(client.db, {
        ...authority,
        credentialId: personal.account.id,
      });
    }
    const report = await dailyReport(grant, undefined, personal.authoritySnapshot);
    expect(await occurrence(grant, report, { settings: supergrok })).toMatchObject({
      model: "supergrok/grok-4.7",
    });

    await disconnectXaiSubscriptionCredential(client.db, {
      ...grant,
      credentialId: personal.account.id,
      authoritySnapshot: personal.authoritySnapshot,
    });
    expect(await occurrence(grant, report, { settings: supergrok })).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      policy: { modelSource: "deployment" },
    });
    // Also with the SuperGrok rail switched off entirely.
    expect(await occurrence(grant, report)).toMatchObject({ model: DEFAULT_OPENROUTER_MODEL_ID });
    await addCredits(grant);
    expect(await occurrence(grant, report, { settings: supergrok })).toMatchObject({
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
    });
  }, 120_000);

  test("a manual trigger's limit pre-check uses the model the occurrence will run", async () => {
    if (!available) return;
    const grant = await workspace();
    const report = await getScheduledTask(client.db, grant.workspaceId, await dailyReport(grant));
    const pinned = await getScheduledTask(
      client.db,
      grant.workspaceId,
      await dailyReport(grant, DEFAULT_OPENROUTER_MODEL_ID),
    );
    expect(await resolveScheduledTaskPreflightModel(client.db, settings(), report!)).toBe(
      DEFAULT_OPENROUTER_MODEL_ID,
    );
    await addCredits(grant);
    expect(await resolveScheduledTaskPreflightModel(client.db, settings(), report!)).toBe(
      "gpt-6-luna",
    );
    expect(await resolveScheduledTaskPreflightModel(client.db, settings(), pinned!)).toBe(
      DEFAULT_OPENROUTER_MODEL_ID,
    );
    // The pre-check agrees with the occurrence the worker then resolves.
    expect(await occurrence(grant, report!.id)).toMatchObject({ model: "gpt-6-luna" });
  }, 120_000);
});
