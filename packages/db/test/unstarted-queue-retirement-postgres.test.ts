import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  peekSessionWork,
  blockSessionWorkBeforeAttemptClaim,
  claimSessionWorkForAttempt,
  mutateSessionControlInTransaction,
} from "../src";
import {
  migrateInterruptedTurnRetirement,
  type InterruptedTurnRetirementManifest,
} from "../src/interrupted-turn-retirement-migration";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("unstarted-queue-retirement");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: suffix,
      accountName: "Unstarted queue",
      workspaceExternalSource: "test",
      workspaceExternalId: suffix,
      workspaceName: "Unstarted queue",
      subjectId: `subject-${suffix}`,
    })
  ).workspaceGrants[0]!;
  const scope = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "Old input",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const s = { ...scope, sessionId: session.id };
  await initializeSessionStartAtomically(client.db, {
    ...s,
    createdEventPayload: {},
    reasoningEffortFallback: "medium",
  });
  const submit = () =>
    withWorkspaceSubjectSessionActivityRls(client.db, s.workspaceId, s.subjectId, (tx) =>
      submitHumanPromptInTransaction(tx, {
        ...s,
        actor: { type: "human", subjectId: s.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Another input",
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    );
  await submit();
  const peek = await peekSessionWork(client.db, s.workspaceId, s.sessionId, true);
  if (peek.kind !== "runnable" || !peek.admissionFence) throw new Error("Expected runnable queue");
  await blockSessionWorkBeforeAttemptClaim(client.db, s.workspaceId, {
    ...s,
    workflowId: `session-${s.sessionId}`,
    attemptId: crypto.randomUUID(),
    fence: peek.admissionFence,
    reason: "database_claim_rejected",
    sqlState: "42501",
  });
  const getManifest = async (): Promise<InterruptedTurnRetirementManifest> => {
    const [row] =
      await shared.admin`select coalesce(c.last_sequence,s.last_sequence) as sequence from sessions s
      left join session_event_cursors c on c.session_id=s.id where s.id=${s.sessionId}`;
    const turns =
      await shared.admin`select id,version from session_turns where session_id=${s.sessionId} and status='queued' order by id`;
    return {
      operationId: crypto.randomUUID(),
      targets: [],
      unstartedQueues: [
        {
          accountId: s.accountId,
          workspaceId: s.workspaceId,
          sessionId: s.sessionId,
          expectedLastSequence: Number(row!.sequence),
          turns: turns.map((t) => ({ turnId: t.id as string, expectedVersion: Number(t.version) })),
        },
      ],
    };
  };
  return { ...s, submit, getManifest };
}
async function repair(manifest: InterruptedTurnRetirementManifest) {
  await client.db.transaction((tx) => migrateInterruptedTurnRetirement(tx, manifest));
}
async function snapshot(s: { sessionId: string }) {
  const [row] = await shared.admin`select s.status,s.admission_block,s.active_turn_id,
    (select count(*)::int from session_turns where session_id=s.id and status='queued') as queued,
    (select count(*)::int from session_turns where session_id=s.id and status='cancelled' and cancel_reason='operator_not_run') as not_run,
    (select count(*)::int from session_turn_attempts where session_id=s.id) as attempts,
    (select count(*)::int from session_history_items where session_id=s.id) as history,
    (select count(*)::int from session_events where session_id=s.id) as events,
    (select count(*)::int from session_system_update_outbox where source_session_id=s.id) as outboxes,
    (select wake_revision from session_workflow_wake_outbox where session_id=s.id) as wake_revision
    from sessions s where s.id=${s.sessionId}`;
  return row!;
}
test("explicit repair withdraws two unstarted prompts without replay or wake and is epoch-idempotent", async () => {
  const s = await fixture();
  const manifest = await s.getManifest();
  const before = await snapshot(s);
  await repair(manifest);
  const after = await snapshot(s);
  expect(after).toMatchObject({
    status: "idle",
    admission_block: null,
    active_turn_id: null,
    queued: 0,
    not_run: 2,
    attempts: 0,
    history: before.history,
    outboxes: 0,
    wake_revision: before.wake_revision,
  });
  await repair(manifest);
  expect(await snapshot(s)).toEqual(after);
  expect(
    (
      await claimSessionWorkForAttempt(client.db, s.workspaceId, {
        sessionId: s.sessionId,
        workflowId: `session-${s.sessionId}`,
        workflowRunId: crypto.randomUUID(),
        dispatchId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      })
    ).action,
  ).toBe("unclaimed");
  await s.submit();
  const newer = await snapshot(s);
  await repair(manifest);
  expect(await snapshot(s)).toEqual(newer);
});
test("an omitted sibling aborts cancellation and retains the admission block", async () => {
  const s = await fixture();
  const manifest = await s.getManifest();
  manifest.unstartedQueues![0]!.turns.pop();
  const before = await snapshot(s);
  await expect(repair(manifest)).rejects.toThrow("other accepted work");
  expect(await snapshot(s)).toEqual(before);
});
test("a version change aborts the complete reviewed batch", async () => {
  const a = await fixture();
  const b = await fixture();
  const manifest = await a.getManifest();
  manifest.unstartedQueues!.push(...(await b.getManifest()).unstartedQueues!);
  manifest
    .unstartedQueues!.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
    .at(-1)!.turns[0]!.expectedVersion++;
  const before = await Promise.all([snapshot(a), snapshot(b)]);
  await expect(repair(manifest)).rejects.toThrow("exact never-run prompts");
  expect(await Promise.all([snapshot(a), snapshot(b)])).toEqual(before);
});
test("a paused chat is never changed by unstarted-queue retirement", async () => {
  const s = await fixture();
  await withWorkspaceSubjectSessionActivityRls(client.db, s.workspaceId, s.subjectId, (tx) =>
    mutateSessionControlInTransaction(tx, {
      ...s,
      actor: { type: "human", subjectId: s.subjectId },
      action: "pause",
      operationKey: crypto.randomUUID(),
    }),
  );
  const manifest = await s.getManifest();
  const before = await snapshot(s);
  await expect(repair(manifest)).rejects.toThrow("paused");
  expect(await snapshot(s)).toEqual(before);
});
