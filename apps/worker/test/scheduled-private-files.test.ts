import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, type AccessGrant } from "@opengeni/contracts";
import { createValidatedScheduledTask, type AccessGrantAuthorization } from "@opengeni/core";
import {
  bootstrapWorkspace,
  completeFileUpload,
  createDb,
  createFileUpload,
  createSession,
  withSessionRlsActorContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-private-files");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

test("a private scheduled target can retain its owner's attachment; shared targets and unverified owners cannot", async () => {
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Scheduled files",
    workspaceExternalSource: "test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Shared workspace",
    subjectId: `user:${crypto.randomUUID()}`,
  });
  const grant: AccessGrant = { ...access.workspaceGrants[0]!, principalKind: "human_session" };
  const authorization: AccessGrantAuthorization = {
    grant,
    accountGrant: null,
    authenticatedSubjectId: grant.subjectId,
    contextIntegrity: true,
    canonicalManagedHumanSession: false,
    canonicalLocalHumanSession: false,
  };
  const fileActor = { subjectId: grant.subjectId, privateFileOwnerSubjectId: grant.subjectId };
  const fileId = crypto.randomUUID();
  await withSessionRlsActorContext(fileActor, async () => {
    const upload = await createFileUpload(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      fileId,
      filename: "Customer notes.txt",
      safeFilename: "customer-notes.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      bucket: "test",
      objectKey: `private/${fileId}`,
      expiresAt: new Date(Date.now() + 60_000),
      privateOwnerSubjectId: grant.subjectId,
    });
    await completeFileUpload(client.db, grant.workspaceId, upload.uploadId);
  });
  const session = await withSessionRlsActorContext(fileActor, () =>
    createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Review customer notes",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      memoryScope: "user",
      scopeSubjectId: grant.subjectId,
      createdBy: { kind: "subject", subjectId: grant.subjectId },
      createdByContext: {},
    }),
  );
  const payload = CreateScheduledTaskRequest.parse({
    name: "Review feedback",
    schedule: { type: "manual" },
    runMode: "existing_session",
    targetSessionId: session.id,
    agentConfig: {
      prompt: "Read the attached customer notes",
      resources: [{ kind: "file", fileId }],
      tools: [],
    },
    agentLearning: { scope: "personal", settings: { knowledge: "review_first" } },
  });
  const input = {
    settings: testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" }),
    db: client.db,
    grant,
    authorization,
    payload,
    toolsProvided: true,
    objectStorage: {} as NonNullable<
      Parameters<typeof createValidatedScheduledTask>[0]["objectStorage"]
    >,
  };
  const task = await withSessionRlsActorContext(fileActor, () =>
    createValidatedScheduledTask(input),
  );
  expect(task.agentConfig.resources).toMatchObject([{ kind: "file", fileId }]);
  expect(task.targetSessionId).toBe(session.id);
  const activities = createScheduledTaskActivities(
    async () =>
      ({
        settings: input.settings,
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
  const run = await activities.dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId: task.id,
    triggerType: "scheduled",
    producerKey: `private-files-${crypto.randomUUID()}`,
  });
  expect(["start", "signal"]).toContain(run.action);
  if (run.action === "start" || run.action === "signal") expect(run.sessionId).toBe(session.id);

  await expect(
    createValidatedScheduledTask({
      ...input,
      authorization: { ...authorization, contextIntegrity: false },
    }),
  ).rejects.toThrow();
  const sharedPayload = CreateScheduledTaskRequest.parse({
    ...payload,
    runMode: "new_session_per_run",
    targetSessionId: undefined,
    agentLearning: undefined,
  });
  await expect(createValidatedScheduledTask({ ...input, payload: sharedPayload })).rejects.toThrow(
    `unknown file resource: ${fileId}`,
  );
});
