import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createScheduledTask,
  createSession,
  getScheduledTask,
  scheduledTaskMutationOwnerMatches,
  scheduledTaskPreviousRunSessionBusy,
} from "../src/index";

// Contract: a creator-locked schedule can be changed only by the principal
// that created it, and a `skip` schedule that starts a new chat per run sees
// whether the chat of its previous run is still working.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("scheduled-task-creator-lock-and-skip");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function workspace() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Creator lock",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Creator lock",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: `subject-${suffix}`,
  };
}

function task(
  scope: Awaited<ReturnType<typeof workspace>>,
  createdBy: { kind: "service" | "subject"; subjectId: string },
  creatorLocked?: boolean,
) {
  return createScheduledTask(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    name: "Managed schedule",
    status: "paused",
    schedule: { type: "manual" },
    temporalScheduleId: crypto.randomUUID(),
    runMode: "new_session_per_run",
    overlapPolicy: "skip",
    createdBy,
    agentConfig: { prompt: "Check", resources: [], tools: [], metadata: {} },
    metadata: {},
    ...(creatorLocked !== undefined ? { creatorLocked } : {}),
  });
}

test("a creator-locked schedule matches only its creator principal", async () => {
  const scope = await workspace();
  const creator = { kind: "service" as const, subjectId: "service:managing-app" };
  const locked = await task(scope, creator, true);
  expect(locked.creatorLocked).toBe(true);
  expect((await getScheduledTask(client.db, scope.workspaceId, locked.id))?.creatorLocked).toBe(
    true,
  );
  const matches = (createdBy: { kind: "service" | "subject"; subjectId: string }) =>
    scheduledTaskMutationOwnerMatches(client.db, {
      workspaceId: scope.workspaceId,
      taskId: locked.id,
      createdBy,
    });
  expect(await matches(creator)).toBe(true);
  expect(await matches({ kind: "service", subjectId: "service:other-key" })).toBe(false);
  expect(await matches({ kind: "subject", subjectId: scope.subjectId })).toBe(false);

  // An unlocked ownerless schedule keeps its shape and its manage rule.
  const open = await task(scope, creator);
  expect("creatorLocked" in open).toBe(false);
  expect(
    await scheduledTaskMutationOwnerMatches(client.db, {
      workspaceId: scope.workspaceId,
      taskId: open.id,
      createdBy: { kind: "service", subjectId: "service:other-key" },
    }),
  ).toBe(true);
});

test("the previous new-chat run holds a skip schedule only while its chat works", async () => {
  const scope = await workspace();
  const created = await task(scope, { kind: "subject", subjectId: scope.subjectId });
  // Run rows are fixtured directly: only their order and chat matter here.
  const run = async (sessionId: string | null, createdAt: string) =>
    await shared.admin.begin(async (tx) => {
      // The paused fixture task would refuse a live admission.
      await tx`set local session_replication_role = replica`;
      const [row] = await tx<Array<{ id: string }>>`
        insert into scheduled_task_runs (account_id, workspace_id, task_id, trigger_type,
          status, session_id, created_at)
        values (${scope.accountId}::uuid, ${scope.workspaceId}::uuid, ${created.id}::uuid,
          'manual', 'running', ${sessionId}::uuid, ${createdAt}::timestamptz)
        returning id`;
      return row!;
    });
  const busy = (runId: string) =>
    scheduledTaskPreviousRunSessionBusy(client.db, {
      workspaceId: scope.workspaceId,
      taskId: created.id,
      runId,
    });
  const session = await createSession(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    initialMessage: "Scheduled check",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: scope.subjectId },
  });
  const first = await run(session.id, "2026-01-01T00:00:00Z");
  // No earlier run with a chat.
  expect(await busy(first.id)).toBe(false);
  const second = await run(null, "2026-01-02T00:00:00Z");
  const settle = async (status: string, activeTurn: boolean) =>
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sessions set status = ${status},
        active_turn_id = ${activeTurn ? crypto.randomUUID() : null}
        where id = ${session.id}::uuid`;
    });

  await settle("running", true);
  expect(await busy(second.id)).toBe(true);
  await settle("idle", false);
  expect(await busy(second.id)).toBe(false);
  await settle("failed", false);
  expect(await busy(second.id)).toBe(false);
  await settle("cancelled", false);
  expect(await busy(second.id)).toBe(false);
  await settle("requires_action", false);
  expect(await busy(second.id)).toBe(true);
});
