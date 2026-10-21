import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdateWithSourceMutation,
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  mutateSessionControlInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import {
  migrateInterruptedTurnRetirement,
  parseInterruptedTurnRetirementManifest,
  type InterruptedTurnRetirementManifest,
} from "../src/interrupted-turn-retirement-migration";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("empty-session-queue");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(existingScope?: {
  accountId: string;
  workspaceId: string;
  subjectId: string;
}) {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "Empty queue",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "Empty queue",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const scope = existingScope ?? {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
  };
  const session = await createSession(client.db, {
    ...scope,
    initialMessage: "Never admitted",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: scope.subjectId },
  });
  // Reproduce a shell left by an older creator before initial admission.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set status = 'queued' where id = ${session.id}`;
  });
  return { ...scope, sessionId: session.id };
}
type Target = Awaited<ReturnType<typeof fixture>>;
async function target(input: Target) {
  const [row] = await shared.admin`select coalesce(c.last_sequence,s.last_sequence) as sequence
    from sessions s left join session_event_cursors c on c.session_id=s.id
    where s.id=${input.sessionId}`;
  return {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    expectedLastSequence: Number(row!.sequence),
  };
}
async function manifest(inputs: Target[]): Promise<InterruptedTurnRetirementManifest> {
  return {
    operationId: crypto.randomUUID(),
    targets: [],
    emptyQueuedSessions: await Promise.all(inputs.map(target)),
  };
}
async function repair(value: InterruptedTurnRetirementManifest) {
  // The migration runner owns this all-target transaction, including nested
  // target savepoints and the later passive parent-notice phase.
  await client.db.transaction((tx) => migrateInterruptedTurnRetirement(tx, value));
}
async function snapshot(input: Target) {
  const [row] = await shared.admin`select s.status,s.direct_control_state,s.active_turn_id,
    (select count(*)::int from session_turns where session_id=s.id) as turns,
    (select count(*)::int from session_turn_attempts where session_id=s.id) as attempts,
    (select count(*)::int from session_history_items where session_id=s.id) as history,
    (select count(*)::int from session_workflow_wake_outbox where session_id=s.id) as wakes,
    (select count(*)::int from session_system_updates where session_id=s.id) as inputs,
    (select count(*)::int from session_system_update_outbox where source_session_id=s.id) as outboxes,
    (select count(*)::int from session_events where session_id=s.id) as events,
    (select count(*)::int from session_events where session_id=s.id
      and payload->>'code'='empty_queue_projection_repaired') as repairs
    from sessions s where s.id=${input.sessionId}`;
  return row!;
}
async function pause(input: Target) {
  await withWorkspaceSubjectSessionActivityRls(
    client.db,
    input.workspaceId,
    input.subjectId,
    (db) =>
      mutateSessionControlInTransaction(db, {
        ...input,
        actor: { type: "human", subjectId: input.subjectId },
        action: "pause",
        operationKey: crypto.randomUUID(),
      }),
  );
}
async function occurrence(input: Target) {
  return addSessionSystemUpdateWithSourceMutation(
    client.db,
    {
      ...input,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      summary: "A fresh occurrence",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    },
    async () => {},
    { requireIdleSession: true },
  );
}

test("operator repair corrects only the empty projection and is idempotent", async () => {
  const input = await fixture();
  const value = await manifest([input]);
  await repair(value);
  expect(await snapshot(input)).toEqual({
    status: "idle",
    direct_control_state: "active",
    active_turn_id: null,
    turns: 0,
    attempts: 0,
    history: 0,
    wakes: 0,
    inputs: 0,
    outboxes: 0,
    events: 1,
    repairs: 1,
  });
  await repair(value);
  expect((await snapshot(input)).repairs).toBe(1);
  await initializeSessionStartAtomically(client.db, {
    ...input,
    createdEventPayload: {},
    reasoningEffortFallback: "medium",
  });
  const beforeReplay = await snapshot(input);
  await repair(value);
  expect(await snapshot(input)).toEqual(beforeReplay);
});

test("operator repair preserves Pause and emits no executable parent notice", async () => {
  const input = await fixture();
  const parent = await fixture(input);
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set parent_session_id=${parent.sessionId} where id=${input.sessionId}`;
  });
  await pause(input);
  // Pause need not rewrite an old projection; reproduce the reviewed state.
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update sessions set status='queued' where id=${input.sessionId}`;
  });
  const parentBefore = await snapshot(parent);
  await repair(await manifest([input]));
  expect(await snapshot(input)).toMatchObject({
    status: "idle",
    direct_control_state: "paused",
    wakes: 0,
    outboxes: 0,
  });
  expect(await snapshot(parent)).toEqual(parentBefore);
});

test("a changed member aborts the entire reviewed batch", async () => {
  const inputs = await Promise.all([fixture(), fixture()]);
  const value = await manifest(inputs);
  const last = value
    .emptyQueuedSessions!.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    .at(-1)!;
  last.expectedLastSequence++;
  await expect(repair(value)).rejects.toThrow("changed or has accepted work");
  for (const input of inputs)
    expect(await snapshot(input)).toMatchObject({ status: "queued", repairs: 0 });
});

test("accepted initial work refuses projection repair and still blocks overlap", async () => {
  const input = await fixture();
  await initializeSessionStartAtomically(client.db, {
    ...input,
    createdEventPayload: {},
    reasoningEffortFallback: "medium",
  });
  await expect(repair(await manifest([input]))).rejects.toThrow("accepted work");
  expect((await occurrence(input)).reason).toBe("session_not_idle");
});

test("pending input serializes concurrent skip-overlap admissions", async () => {
  const input = await fixture();
  const results = await Promise.all([occurrence(input), occurrence(input)]);
  expect(results.map((r) => r.reason).sort()).toEqual(["added", "session_not_idle"]);
  await expect(repair(await manifest([input]))).rejects.toThrow("accepted work");
});

test("a paused empty shell does not admit a schedule", async () => {
  const input = await fixture();
  await pause(input);
  expect((await occurrence(input)).reason).toBe("session_paused");
});

test("manifest validates total size, duplicate scope and explicit operation", async () => {
  const input = await fixture();
  const value = await manifest([input]);
  expect(parseInterruptedTurnRetirementManifest(value)).toEqual(value);
  expect(() =>
    parseInterruptedTurnRetirementManifest({ ...value, emptyQueuedSessions: [] }),
  ).toThrow();
  expect(() =>
    parseInterruptedTurnRetirementManifest({
      ...value,
      emptyQueuedSessions: [value.emptyQueuedSessions![0], value.emptyQueuedSessions![0]],
    }),
  ).toThrow("unique sessions");
});
