import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createDb,
  createScheduledTask,
  getSession,
  listSessionEvents,
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
import { scheduledAlertOccurrenceIdentity } from "../src/scheduled-alert-occurrence";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql | null = null;
let client: DbClient | null = null;

function alertMetadata(
  input: {
    status?: "firing" | "resolved";
    startsAt?: string;
    fingerprint?: string;
    labels?: Record<string, string>;
    provider?: string;
  } = {},
): Record<string, unknown> {
  return {
    purpose: "incident-response",
    alert: {
      status: input.status ?? "firing",
      startsAt: input.startsAt ?? "2026-08-13T15:10:29Z",
      fingerprint: input.fingerprint ?? "provider-fingerprint-1",
      labels: input.labels ?? {
        alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
        severity: "warning",
        service: "worker-turn",
      },
      provider: input.provider ?? "alertmanager",
    },
  };
}

describe("scheduled alert occurrence identity", () => {
  test("canonicalizes simultaneous/redelivered forms without hashing prompt text", () => {
    const workspaceId = crypto.randomUUID();
    const first = scheduledAlertOccurrenceIdentity({
      workspaceId,
      metadata: alertMetadata(),
    });
    const reordered = scheduledAlertOccurrenceIdentity({
      workspaceId,
      metadata: alertMetadata({
        labels: {
          service: "worker-turn",
          severity: "warning",
          alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
        },
      }),
    });
    const resolved = scheduledAlertOccurrenceIdentity({
      workspaceId,
      metadata: alertMetadata({ status: "resolved" }),
    });

    expect(first?.sessionCreateIdempotencyKey).toBe(reordered?.sessionCreateIdempotencyKey);
    expect(resolved?.sessionCreateIdempotencyKey).toBe(first?.sessionCreateIdempotencyKey);
    expect(first?.sessionCreateIdempotencyKey).toMatch(
      /^scheduled-alert-occurrence:v1:[0-9a-f]{64}$/,
    );
    expect(first?.sessionCreateIdempotencyKey).not.toContain(
      "OpenGeniTurnWorkerMemoryConsumesReserve",
    );
  });

  test("separates starts, provider fingerprints, labels, providers, workspaces, and reopenings", () => {
    const workspaceId = crypto.randomUUID();
    const key = (metadata: Record<string, unknown>, selectedWorkspaceId = workspaceId) =>
      scheduledAlertOccurrenceIdentity({
        workspaceId: selectedWorkspaceId,
        metadata,
      })?.sessionCreateIdempotencyKey;
    const original = key(alertMetadata());

    expect(key(alertMetadata({ startsAt: "2026-08-13T16:10:29Z" }))).not.toBe(original);
    expect(key(alertMetadata({ fingerprint: "provider-fingerprint-2" }))).not.toBe(original);
    expect(
      key(
        alertMetadata({
          labels: {
            alertname: "OpenGeniTurnWorkerMemoryConsumesReserve",
            severity: "critical",
            service: "worker-turn",
          },
        }),
      ),
    ).not.toBe(original);
    expect(key(alertMetadata({ provider: "other-alert-provider" }))).not.toBe(original);
    expect(key(alertMetadata(), crypto.randomUUID())).not.toBe(original);

    const resolved = key(alertMetadata({ status: "resolved" }));
    const reopened = key(
      alertMetadata({
        status: "firing",
        startsAt: "2026-08-13T17:10:29Z",
      }),
    );
    expect(resolved).toBe(original);
    expect(reopened).not.toBe(original);
  });

  test("fails open to ordinary per-run sessions for incomplete or malformed declarations", () => {
    const workspaceId = crypto.randomUUID();
    for (const metadata of [
      {},
      { alert: "not-an-object" },
      {
        alert: {
          status: "firing",
          startsAt: "invalid",
          fingerprint: "fp",
          labels: {},
        },
      },
      {
        alert: {
          status: "unknown",
          startsAt: new Date().toISOString(),
          fingerprint: "fp",
          labels: { alertname: "A" },
        },
      },
      {
        alert: {
          status: "firing",
          startsAt: new Date().toISOString(),
          fingerprint: "fp",
          labels: { alertname: 7 },
        },
      },
    ]) {
      expect(scheduledAlertOccurrenceIdentity({ workspaceId, metadata })).toBeNull();
    }
  });
});

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("worker-scheduled-alert-occurrence");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[worker-scheduled-alert-occurrence] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    console.warn(
      "[worker-scheduled-alert-occurrence] PostgreSQL unavailable, skipping live assertions",
    );
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function workspaceFixture() {
  const [account] = await admin!<{ id: string }[]>`
    insert into managed_accounts (name)
    values (${`scheduled-alert-${crypto.randomUUID()}`})
    returning id`;
  const [workspace] = await admin!<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`scheduled-alert-${crypto.randomUUID()}`})
    returning id`;
  await admin!`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function taskFixture(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
  metadata = alertMetadata(),
) {
  return await createScheduledTask(client!.db, {
    ...workspace,
    name: `scheduled alert ${crypto.randomUUID()}`,
    status: "active",
    schedule: { type: "manual" },
    temporalScheduleId: `scheduled-alert-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Handle the exact structured alert occurrence without parsing this prompt.",
      resources: [],
      tools: [],
      metadata: { purpose: "incident-response" },
      goal: {
        text: "Resolve the exact alert occurrence.",
        successCriteria: "The alert is resolved or an exact blocker is recorded.",
        maxAutoContinuations: 2,
      },
    },
    metadata,
  });
}

function activities() {
  return createScheduledTaskActivities(
    async () =>
      ({
        settings: testSettings({
          databaseUrl: shared!.appUrl,
          sandboxBackend: "none",
        }),
        db: client!.db,
        bus: new MemoryEventBus(),
      }) as unknown as ActivityServices,
  );
}

describe("scheduled alert canonical responder session (real PostgreSQL)", () => {
  test("redelivery reuses one canonical session and preserves the exact prompt", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const worker = activities();

    const first = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `redelivery-first-${crypto.randomUUID()}`,
    });
    const second = await worker.dispatchScheduledTaskRun({
      workspaceId: workspace.workspaceId,
      taskId: task.id,
      triggerType: "scheduled",
      producerKey: `redelivery-second-${crypto.randomUUID()}`,
    });

    expect(first.action).toBe("start");
    expect(second.action).toBe("signal");
    expect(second.sessionId).toBe(first.sessionId);
    expect(
      (await getSession(client.db, workspace.workspaceId, first.sessionId))?.initialMessage,
    ).toBe(task.agentConfig.prompt);
    expect(
      (await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10)).map(
        (run) => run.sessionId,
      ),
    ).toEqual([first.sessionId, first.sessionId]);
  });

  test("simultaneous delivery through distinct tasks converges on one canonical session", async () => {
    if (!shared || !client) return;
    const workspace = await workspaceFixture();
    const firstTask = await taskFixture(workspace);
    const secondTask = await taskFixture(workspace);
    const worker = activities();

    const results = await Promise.all(
      [firstTask, secondTask].map(
        async (task) =>
          await worker.dispatchScheduledTaskRun({
            workspaceId: workspace.workspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: `simultaneous-${task.id}`,
          }),
      ),
    );

    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(results.map((result) => result.action).sort()).toEqual(["signal", "start"]);

    const sessionId = results[0]!.sessionId;
    const events = await listSessionEvents(client.db, workspace.workspaceId, sessionId, 0, 30);
    expect(events[0]?.type).toBe("session.created");
    expect(events[0]?.sequence).toBe(1);
    expect(events.filter((event) => event.type === "session.created")).toHaveLength(1);

    const goal = events.find((event) => event.type === "goal.set");
    expect(goal?.sequence).toBe(2);
    expect(goal?.payload).toMatchObject({ actor: "scheduled_task" });

    const updates = events.filter((event) => event.type === "system.update.pending");
    expect(updates).toHaveLength(2);
    const updatePayloads = updates.map((event) => event.payload as Record<string, unknown>);
    expect(new Set(updatePayloads.map((payload) => payload.updateId)).size).toBe(2);
    const taskRuns = (
      await Promise.all(
        [firstTask, secondTask].map(
          async (task) =>
            await listScheduledTaskRuns(client.db, workspace.workspaceId, task.id, 10),
        ),
      )
    ).flat();
    expect(new Set(updatePayloads.map((payload) => payload.sourceId))).toEqual(
      new Set(taskRuns.map((run) => run.id)),
    );
    expect(updates.every((event) => event.sequence > (goal?.sequence ?? 1))).toBe(true);
  });

  test("an atomic multi-dispatch race creates exactly one responder root", async () => {
    if (!shared || !client || !admin) return;
    const workspace = await workspaceFixture();
    const task = await taskFixture(workspace);
    const worker = activities();
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async (_, index) =>
          await worker.dispatchScheduledTaskRun({
            workspaceId: workspace.workspaceId,
            taskId: task.id,
            triggerType: "scheduled",
            producerKey: `atomic-race-${index}-${crypto.randomUUID()}`,
          }),
      ),
    );
    const sessionIds = new Set(results.map((result) => result.sessionId));
    expect(sessionIds.size).toBe(1);
    expect(results.filter((result) => result.action === "start")).toHaveLength(1);
    expect(results.filter((result) => result.action === "signal")).toHaveLength(11);
    const [count] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from sessions
      where workspace_id = ${workspace.workspaceId}
        and create_idempotency_key like 'scheduled-alert-occurrence:v1:%'`;
    expect(count?.count).toBe(1);
  });
});
