import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type { ScheduledOccurrenceEvents } from "@opengeni/contracts";
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
import {
  acquireSharedTestDatabase,
  grantDeferredRuntimeAccess,
  type SharedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createScheduledTaskActivities } from "../src/activities/scheduled-tasks";
import type { ActivityServices } from "../src/activities/types";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-event-run");
  if (!shared) {
    available = false;
    console.warn("[worker-scheduled-event-run] PostgreSQL unavailable, skipping");
    return;
  }
  await grantDeferredRuntimeAccess(shared.admin);
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
    accountExternalId: `event-run-account-${suffix}`,
    accountName: "Event run account",
    workspaceExternalSource: "test",
    workspaceExternalId: `event-run-workspace-${suffix}`,
    workspaceName: "Event run workspace",
    subjectId: `user:event-run-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const [personal] = await shared!
    .admin`insert into workspaces (account_id, name) values (${grant.accountId}, 'Personal event run fixture') returning id`;
  await shared!
    .admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id) values (${grant.accountId}, ${grant.subjectId}, 'active', ${personal!.id})`;
  return grant;
}

type Grant = Awaited<ReturnType<typeof workspace>>;

async function deployWatcher(grant: Grant) {
  const { source } = await createEventSource(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBySubjectId: grant.subjectId,
    kind: "webhook",
    adapter: "standard",
    name: "Deploys",
    ownerSubjectId: grant.subjectId,
    visibility: "workspace",
    secretEncrypted: "encrypted-secret",
  });
  const task = await createScheduledTask(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    name: "When a deploy finishes",
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `event-run-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "buffer_one",
    agentConfig: {
      prompt: "Check the deploy",
      resources: [],
      tools: [],
      metadata: {},
    },
    metadata: {},
  });
  await setScheduledTaskEvents(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    taskId: task.id,
    triggers: [
      {
        sourceId: source.id,
        eventTypes: ["deploy.*"],
        conditions: [],
        includeOwnEvents: false,
      },
    ],
  });
  return { source, task };
}

function deployEvent(id: string, secondsAgo: number): StoredEventInput {
  return {
    externalId: id,
    streamKey: "",
    type: "deploy.finished",
    occurredAt: new Date(Date.now() - secondsAgo * 1_000),
    subject: id,
    summary: `Deploy ${id} finished`,
    url: "https://deploys.example.com/" + id,
    actor: { kind: "person", name: "Ada" },
    data: { id, environment: "production" },
    dataTruncated: false,
    gapBefore: false,
  };
}

async function deliver(grant: Grant, sourceId: string, events: StoredEventInput[]) {
  const body = new TextEncoder().encode(JSON.stringify(events.map((event) => event.externalId)));
  const dedupeKey = `webhook-id:${crypto.randomUUID()}`;
  return recordEventDelivery(client.db, {
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
    events,
    match: eventMatchesTrigger,
    settleMs: 0,
  });
}

describe("event runs", () => {
  test("the run's chat update carries the events that caused it", async () => {
    if (!available) return;
    const grant = await workspace();
    const { source, task } = await deployWatcher(grant);
    await deliver(grant, source.id, [deployEvent("d-2", 1), deployEvent("d-1", 2)]);

    const dispatch = await claimEventTriggerDispatch(client.db, grant.workspaceId, task.id);
    expect(dispatch.start).toHaveLength(1);
    const occurrence = dispatch.start[0]!;
    await markEventOccurrenceStarted(client.db, grant.workspaceId, occurrence.id);

    const result = await activities().dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "event",
      producerKey: eventOccurrenceProducerKey(occurrence.id),
    });
    expect(result).toMatchObject({ action: "start" });
    const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 1);
    expect(run).toMatchObject({ triggerType: "event" });

    const [update] = await shared!.admin<
      { payload: { text: string; events?: ScheduledOccurrenceEvents } }[]
    >`select payload from session_system_updates
      where scheduled_task_run_id = ${run!.id} and kind = 'scheduled_occurrence'`;
    expect(update?.payload.text).toBe("Check the deploy");
    expect(update?.payload.events).toMatchObject({
      occurrenceId: occurrence.id,
      eventCount: 2,
      gapBefore: false,
      events: [
        {
          type: "deploy.finished",
          subject: "d-1",
          summary: "Deploy d-1 finished",
          data: { id: "d-1", environment: "production" },
          dataTruncated: false,
        },
        { subject: "d-2", data: { id: "d-2", environment: "production" } },
      ],
    });

    // The database proves the update against the run's own occurrence: an
    // altered summary, count or occurrence is refused; only data excerpts vary.
    const copy = async (events: unknown) =>
      shared!.admin`insert into session_system_updates
        select (jsonb_populate_record(null::session_system_updates, to_jsonb(update_row)
          || jsonb_build_object('id', gen_random_uuid(),
            'payload', update_row.payload || jsonb_build_object('events', ${shared!.admin.json(events as never)}::jsonb)))).*
        from session_system_updates update_row
        where update_row.scheduled_task_run_id = ${run!.id} and update_row.kind = 'scheduled_occurrence'`;
    const carried = update!.payload.events!;
    const refused = "scheduled occurrence events differ from the run's occurrence";
    await expect(
      copy({
        ...carried,
        events: [{ ...carried.events[0]!, summary: "Deploy d-1 failed" }, carried.events[1]],
      }),
    ).rejects.toThrow(refused);
    await expect(copy({ ...carried, eventCount: 1 })).rejects.toThrow(refused);
    await expect(copy({ ...carried, occurrenceId: crypto.randomUUID() })).rejects.toThrow(refused);
    await expect(copy({ ...carried, events: [...carried.events].reverse() })).rejects.toThrow(
      refused,
    );
    await expect(copy({ ...carried, extra: true })).rejects.toThrow(refused);
    // A different data excerpt passes the guard and stops at the run's single update.
    await expect(
      copy({
        ...carried,
        events: [{ ...carried.events[0]!, data: { trimmed: true } }],
      }),
    ).rejects.not.toThrow(refused);
  });

  test("a scheduled run of the same automation carries no events", async () => {
    if (!available) return;
    const grant = await workspace();
    const { task } = await deployWatcher(grant);
    const result = await activities().dispatchScheduledTaskRun({
      workspaceId: grant.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `event-run-scheduled-${crypto.randomUUID()}`,
    });
    expect(result.action).toBe("start");
    const [run] = await listScheduledTaskRuns(client.db, grant.workspaceId, task.id, 1);
    const [update] = await shared!.admin<{ payload: Record<string, unknown> }[]>`
      select payload from session_system_updates
      where scheduled_task_run_id = ${run!.id} and kind = 'scheduled_occurrence'`;
    expect(update?.payload).toBeDefined();
    expect("events" in update!.payload).toBe(false);
  });
});
