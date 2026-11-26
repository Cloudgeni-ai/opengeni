import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { eventMatchesTrigger } from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimEventTriggerDispatch,
  createDb,
  createEventSource,
  createScheduledTask,
  eventOccurrenceProducerKey,
  listScheduledTaskRuns,
  markEventOccurrenceStarted,
  recordEventDelivery,
  setScheduledTaskEvents,
  type DbClient,
  type StoredEventInput,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

// A person's "This workspace" source reads Opengeni as them, so it hears their
// private meetings and chats too. A shared automation of theirs must not carry
// such an event into a chat the whole workspace can open.

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-owner-only-event-run");
  if (!shared) {
    available = false;
    console.warn("[worker-owner-only-event-run] PostgreSQL unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

function activities() {
  const settings: Settings = testSettings({
    databaseUrl: shared!.appUrl,
    sandboxBackend: "none",
    eventTriggersEnabled: true,
  });
  return createScheduledTaskActivities(
    async () =>
      ({
        settings,
        db: client.db,
        bus: new MemoryEventBus(),
        wakeSessionWorkflow: async () => undefined,
      }) as unknown as ActivityServices,
  );
}

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `owner-only-account-${suffix}`,
    accountName: "Owner-only account",
    workspaceExternalSource: "test",
    workspaceExternalId: `owner-only-workspace-${suffix}`,
    workspaceName: "Owner-only workspace",
    subjectId: `user:owner-only-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!
    .admin`insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal owner-only fixture') returning id`;
  await shared!
    .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return grant;
}

type Grant = Awaited<ReturnType<typeof workspace>>;

/** A shared automation of the owner's: "When a meeting's transcript is ready", on their "This workspace". */
async function transcriptWatcher(
  grant: Grant,
  runMode: "new_session_per_run" | "reusable_session" = "new_session_per_run",
) {
  const { source } = await createEventSource(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBySubjectId: grant.subjectId,
    kind: "workspace",
    name: "This workspace",
    ownerSubjectId: grant.subjectId,
    visibility: "private",
  });
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    ownerSubjectId: grant.subjectId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "Summarize meetings",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `owner-only-${crypto.randomUUID()}`,
    runMode,
    overlapPolicy: "buffer_one",
    agentConfig: { prompt: "Summarize the meeting", resources: [], tools: [], metadata: {} },
    metadata: {},
  } as Parameters<typeof createScheduledTask>[1]);
  expect(task.visibility).toBe("workspace");
  await setScheduledTaskEvents(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    taskId: task.id,
    triggers: [
      {
        sourceId: source.id,
        eventTypes: ["recording.transcript.ready"],
        conditions: [],
        includeOwnEvents: false,
      },
    ],
  });
  return { source, task };
}

function transcriptReady(title: string, visibility: "private" | "workspace"): StoredEventInput {
  const recordingId = crypto.randomUUID();
  return {
    externalId: `recording:${recordingId}:transcript`,
    streamKey: "",
    type: "recording.transcript.ready",
    occurredAt: new Date(Date.now() - 1_000),
    subject: title,
    summary: `Transcript ready: ${title}`,
    url: null,
    actor: { kind: "unknown", name: null },
    data: { visibility, recordingId, title },
    dataTruncated: false,
    gapBefore: false,
  };
}

async function deliver(grant: Grant, sourceId: string, event: StoredEventInput) {
  const body = new TextEncoder().encode(JSON.stringify([event.externalId]));
  const dedupeKey = `webhook-id:${crypto.randomUUID()}`;
  await recordEventDelivery(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sourceId,
    status: "accepted",
    reason: null,
    dedupeKey,
    body,
    bodyBytes: body.byteLength,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    headers: { "webhook-id": dedupeKey },
    events: [event],
    match: eventMatchesTrigger,
    settleMs: 0,
  });
}

async function fire(grant: Grant, sourceId: string, taskId: string, event: StoredEventInput) {
  await deliver(grant, sourceId, event);
  const dispatch = await claimEventTriggerDispatch(client.db, grant.workspaceId, taskId);
  expect(dispatch.start).toHaveLength(1);
  const occurrence = dispatch.start[0]!;
  await markEventOccurrenceStarted(client.db, grant.workspaceId, occurrence.id);
  const result = await activities().dispatchScheduledTaskRun({
    workspaceId: grant.workspaceId,
    taskId,
    triggerType: "event",
    producerKey: eventOccurrenceProducerKey(occurrence.id),
  });
  const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, taskId, 1);
  return { result, run: run! };
}

async function chatOf(sessionId: string) {
  const [row] = await shared!.admin<{ visibility: string; owner_subject_id: string | null }[]>`
    select visibility, owner_subject_id from sessions where id = ${sessionId}`;
  return row!;
}

describe("an event only the automation's owner may see", () => {
  test("a shared automation runs on the owner's private meeting in an Only me chat", async () => {
    if (!available) return;
    const grant = await workspace();
    const { source, task } = await transcriptWatcher(grant);
    const { result, run } = await fire(
      grant,
      source.id,
      task.id,
      transcriptReady("Salary talk", "private"),
    );
    expect(result).toMatchObject({ action: "start" });
    expect(run.sessionId).toBeTruthy();
    expect(await chatOf(run.sessionId!)).toEqual({
      visibility: "user_private",
      owner_subject_id: grant.subjectId,
    });
  });

  test("a meeting the workspace can see still runs in the automation's shared chat", async () => {
    if (!available) return;
    const grant = await workspace();
    const { source, task } = await transcriptWatcher(grant);
    const { result, run } = await fire(
      grant,
      source.id,
      task.id,
      transcriptReady("Standup", "workspace"),
    );
    expect(result).toMatchObject({ action: "start" });
    expect((await chatOf(run.sessionId!)).visibility).toBe("workspace_shared");
  });

  test("an automation that keeps one shared chat leaves the private meeting out", async () => {
    if (!available) return;
    const grant = await workspace();
    const { source, task } = await transcriptWatcher(grant, "reusable_session");
    // Left out when claimed, before it is batched with shared events or counted.
    await deliver(grant, source.id, transcriptReady("Salary talk", "private"));
    await deliver(grant, source.id, transcriptReady("Budget review", "private"));
    const withheld = await claimEventTriggerDispatch(client.db, grant.workspaceId, task.id);
    expect(withheld.start).toHaveLength(0);
    const runs = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 10);
    // One receipt for the streak, naming no meeting.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "skipped",
      sessionId: null,
      error: "owner_only_event",
    });

    // A meeting the workspace can see still runs in the automation's chat.
    const { result, run } = await fire(
      grant,
      source.id,
      task.id,
      transcriptReady("Standup", "workspace"),
    );
    expect(result).toMatchObject({ action: "start" });
    expect((await chatOf(run.sessionId!)).visibility).toBe("workspace_shared");
  });
});
