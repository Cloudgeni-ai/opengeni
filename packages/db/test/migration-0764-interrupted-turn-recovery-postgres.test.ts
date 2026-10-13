import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { acquireOwnerMigratedTestDatabase } from "@opengeni/testing";
import {
  addSessionSystemUpdate, bootstrapWorkspace, claimSessionWorkForAttempt, createDb, createSession,
  getSessionHistoryItems, initializeSessionStartAtomically, markSessionAttemptQuiesced,
  mutateSessionControlInTransaction, requestSessionTurnRecovery, withWorkspaceSubjectSessionActivityRls,
} from "../src/index";
import { executeMigrationFile, migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import { INTERRUPTED_TURN_RETIREMENT_MIGRATION as MIGRATION,
  parseInterruptedTurnRetirementManifest, type InterruptedTurnRetirementManifest } from "../src/interrupted-turn-retirement-migration";

let shared: NonNullable<Awaited<ReturnType<typeof acquireOwnerMigratedTestDatabase>>>;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireOwnerMigratedTestDatabase("interrupted-turn-retirement");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  shared = acquired;
  const owner = postgres(shared.ownerUrl, {max: 1, onnotice: () => undefined});
  try {
    await owner`create table schema_migrations(name text primary key, applied_at timestamptz not null default now())`;
    for (const name of await readdir(join(import.meta.dir, "../drizzle"))) {
      if (name.endsWith(".sql") && name >= MIGRATION)
        await owner`insert into schema_migrations(name) values (${name})`;
    }
    await migrate(shared.ownerUrl);
    await provisionRoles(shared.adminUrl, {appPassword: shared.appPassword});
  } finally {await owner.end();}
  const url = new URL(shared.ownerUrl); url.username = "opengeni_app"; url.password = shared.appPassword;
  client = createDb(url.toString());
}, 180_000);
afterAll(async () => {await client?.close(); await shared?.release();}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test", accountExternalId: suffix, accountName: "Retirement fixture",
    workspaceExternalSource: "test", workspaceExternalId: suffix, workspaceName: "Retirement fixture",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  return {accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId: grant.subjectId};
}
type Scope = Awaited<ReturnType<typeof fixture>>;
async function start(scope: Scope, parent?: Awaited<ReturnType<typeof start>>) {
  const session = await createSession(client.db, {
    ...scope, initialMessage: "Accepted work", resources: [], metadata: {}, sandboxBackend: "none",
    model: "scripted-model", reasoningEffort: "medium", latencyMode: "standard",
    createdBy: {kind: "subject", subjectId: scope.subjectId},
    ...(parent ? {parentSessionId: parent.session.id, createdByActor: {
      type: "agent_attempt" as const, sessionId: parent.session.id, turnId: parent.turn.id,
      attemptId: parent.attemptId, executionGeneration: parent.turn.executionGeneration,
    }} : {}),
  });
  await initializeSessionStartAtomically(client.db, {
    ...scope, sessionId: session.id, reasoningEffortFallback: "medium", createdEventPayload: {},
    goal: {text: "Complete accepted work"},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, scope.workspaceId, {
    sessionId: session.id, workflowId: `session-${session.id}`, workflowRunId: crypto.randomUUID(),
    attemptId, dispatchId: crypto.randomUUID(), trigger: {kind: "next"},
  });
  if (claim.action !== "claimed") throw new Error("Fixture claim failed");
  return {session, turn: claim.turn, attemptId};
}
async function interrupt(scope: Scope, started: Awaited<ReturnType<typeof start>>) {
  expect((await requestSessionTurnRecovery(client.db, scope.workspaceId, {
    sessionId: started.session.id, turnId: started.turn.id, triggerEventId: started.turn.triggerEventId,
    attemptId: started.attemptId, reason: "worker_shutdown",
  })).action).toBe("recovering");
  await markSessionAttemptQuiesced(client.db, {...scope, sessionId: started.session.id,
    attemptId: started.attemptId, temporalWorkflowId: `session-${started.session.id}`});
  await withWorkspaceSubjectSessionActivityRls(client.db, scope.workspaceId, scope.subjectId, db =>
    mutateSessionControlInTransaction(db, {...scope, sessionId: started.session.id,
      actor: {type: "human", subjectId: scope.subjectId}, action: "pause", operationKey: crypto.randomUUID()}));
  await markSessionAttemptQuiesced(client.db, {...scope, sessionId: started.session.id,
    attemptId: started.attemptId, temporalWorkflowId: `session-${started.session.id}`});
}
async function target(scope: Scope, started: Awaited<ReturnType<typeof start>>) {
  const [row] = await shared.admin`select t.version, s.last_sequence from session_turns t
    join sessions s on s.id = t.session_id where t.id = ${started.turn.id}`;
  return {accountId: scope.accountId, workspaceId: scope.workspaceId, sessionId: started.session.id,
    turnId: started.turn.id, workflowId: `session-${started.session.id}`,
    expectedVersion: Number(row!.version), expectedLastSequence: Number(row!.last_sequence)};
}
async function repair(manifest?: InterruptedTurnRetirementManifest) {
  const owner = postgres(shared.ownerUrl, {max: 1, onnotice: () => undefined});
  try {await executeMigrationFile(owner, MIGRATION,
    await readFile(join(import.meta.dir, "../drizzle", MIGRATION), "utf8"), {interruptedTurnRetirement: manifest});
  } finally {await owner.end();}
}

test("the owner repair is opt-in, settles exact interrupted work and delivers one existing-format child result", async () => {
  const scope = await fixture(); const parent = await start(scope); const child = await start(scope, parent);
  await interrupt(scope, child);
  const unrelatedScope = await fixture(); const unrelated = await start(unrelatedScope);
  await interrupt(unrelatedScope, unrelated);
  await addSessionSystemUpdate(client.db, {...scope, sessionId: child.session.id,
    kind: "child_terminal_result", classification: "info", sourceId: "fixture",
    dedupeKey: crypto.randomUUID(), summary: "Accepted old input",
    payload: {type: "child_terminal_result", childSessionId: crypto.randomUUID(), status: "idle"}});
  const manifest = {operationId: crypto.randomUUID(), targets: [await target(scope, child)]};
  const history = await getSessionHistoryItems(client.db, scope.workspaceId, child.session.id);
  const attempts = [...await shared.admin`select * from session_turn_attempts where session_id = ${child.session.id}`];
  await repair();
  const [before] = await shared.admin`select status from session_turns where id = ${child.turn.id}`;
  expect(before!.status).toBe("recovering");
  await repair(manifest);
  const [settled] = await shared.admin`select s.status, s.active_turn_id, s.direct_control_state,
    t.status as turn_status, t.finished_at, g.continuation_suppressed_turn_id
    from sessions s join session_turns t on t.session_id = s.id join session_goals g on g.session_id = s.id
    where t.id = ${child.turn.id}`;
  expect(settled).toMatchObject({status: "failed", active_turn_id: null, direct_control_state: "paused",
    turn_status: "failed", continuation_suppressed_turn_id: child.turn.id});
  expect(settled!.finished_at).not.toBeNull();
  expect([...await shared.admin`select * from session_turn_attempts where session_id = ${child.session.id}`]).toEqual(attempts);
  expect(await getSessionHistoryItems(client.db, scope.workspaceId, child.session.id)).toEqual(history);
  const notices = [...await shared.admin`select payload, dedupe_key from session_system_update_outbox
    where session_id = ${parent.session.id} and kind = 'child_terminal_result'`];
  expect(notices).toHaveLength(1);
  expect(notices[0]!.payload).toMatchObject({status: "failed", turnId: child.turn.id});
  const [pending] = await shared.admin`select count(*)::int as count from session_system_updates
    where session_id = ${child.session.id} and state = 'pending'`;
  expect(pending!.count).toBe(0);
  const [other] = await shared.admin`select status from session_turns where id = ${unrelated.turn.id}`;
  expect(other!.status).toBe("recovering");
  const count = [...await shared.admin`select id from session_events where session_id = ${child.session.id}`].length;
  await repair(manifest);
  expect([...await shared.admin`select id from session_events where session_id = ${child.session.id}`]).toHaveLength(count);
  expect([...await shared.admin`select id from session_system_update_outbox where session_id = ${parent.session.id}
    and kind = 'child_terminal_result'`]).toHaveLength(1);
  const [posture] = await shared.admin`select bool_and(relrowsecurity and relforcerowsecurity) as forced
    from pg_class where oid in ('sessions'::regclass, 'session_turns'::regclass, 'session_turn_attempts'::regclass)`;
  expect(posture!.forced).toBe(true);
}, 60_000);

test("a stale manifest rolls back every target, and a live writer cannot be retired", async () => {
  const scope = await fixture(); const first = await start(scope); const second = await start(scope);
  await interrupt(scope, first); await interrupt(scope, second);
  const valid = await target(scope, first); const stale = await target(scope, second);
  await expect(repair({operationId: crypto.randomUUID(), targets: [valid, {...stale, expectedVersion: stale.expectedVersion + 1}]}))
    .rejects.toThrow("target changed or is unsafe");
  const rows = [...await shared.admin`select status from session_turns where id in (${first.turn.id}, ${second.turn.id})`];
  expect(rows.map(row => row.status)).toEqual(["recovering", "recovering"]);
  const live = await start(scope);
  await expect(repair({operationId: crypto.randomUUID(), targets: [await target(scope, live)]})).rejects.toThrow("target changed or is unsafe");
}, 60_000);

test("retirement manifests fail closed on unbounded or duplicate operator scope", () => {
  expect(() => parseInterruptedTurnRetirementManifest({operationId: crypto.randomUUID(), targets: []})).toThrow("Invalid");
  expect(() => parseInterruptedTurnRetirementManifest({operationId: crypto.randomUUID(), targets: [], unknown: true})).toThrow("Invalid");
});
