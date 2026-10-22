import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  ensureManagedAccessForUser,
  forkSessionContent,
  submitHumanPromptInTransaction,
  waitForSessionInputWithEvent,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// A fork is a session of its own: like every created session it has its own
// workflow identity, so its first turn, waits for input and deadline wakes all
// address the fork's workflow, never a missing one or its source's.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("session-fork-workflow-identity");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `fork-workflow-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  await shared.admin`insert into auth_users(id, name, email)
    values (${userId}, 'Alex Owner', ${`${userId}@example.test`})`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Fork owner",
  });
  const grant = access.workspaceGrants.find(
    (value) => value.workspaceId === access.defaultWorkspaceId,
  )!;
  const { accountId, workspaceId } = grant;
  await shared.admin`insert into session_tenancy_activations(account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"7".repeat(64)}, ${"8".repeat(64)}, 'fork-workflow-test')`;
  await shared.admin`insert into organization_private_session_settings(account_id, enabled, version)
    values (${accountId}, true, 1) on conflict (account_id) do update set enabled = true`;
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    visibility: "workspace_shared",
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    subjectId,
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { accountId, workspaceId, subjectId, sourceId: session.id };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Appends one completed exchange so a message-boundary fork has a point to fork at. */
async function completedExchange(f: Fixture) {
  const [next] = await shared.admin<Array<{ sequence: number; position: number }>>`
    select session_row.last_sequence + 1 as sequence,
      (select coalesce(max(turn_row.position), 0)::int + 1 from session_turns turn_row
        where turn_row.session_id = session_row.id) as position
    from sessions session_row where session_row.id = ${f.sourceId}`;
  if (!next) throw new Error(`session ${f.sourceId} is missing`);
  const turnId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await shared.admin.begin(async (tx) => {
    // Direct fixture writes speak the current runtime protocol.
    await tx`select set_config('opengeni.session_variable_set_attachments_v1', '1', true),
      set_config('opengeni.account_id', ${f.accountId}, true),
      set_config('opengeni.workspace_id', ${f.workspaceId}, true)`;
    await tx`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend
    ) values (${turnId}, ${f.accountId}, ${f.workspaceId}, ${f.sourceId}, ${eventId},
      ${`session-${f.sourceId}`}, 'completed', ${next.position}, 'Build it', 'test-model',
      'medium', 'none')`;
    await tx`insert into session_events (
      id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
    ) values (${eventId}, ${f.accountId}, ${f.workspaceId}, ${f.sourceId}, ${turnId},
      ${next.sequence}, 'user.message', '{"text":"Build it"}')`;
    await tx`update sessions set last_sequence = ${next.sequence} where id = ${f.sourceId}`;
    await tx`insert into session_history_items (
      account_id, workspace_id, session_id, turn_id, position, item
    ) values (${f.accountId}, ${f.workspaceId}, ${f.sourceId}, ${turnId}, ${next.position},
      ${tx.json({ type: "message", role: "user", content: "Build it" })})`;
  });
  return eventId;
}

async function fork(f: Fixture, sourceEventId?: string) {
  const forked = await forkSessionContent(client.db, {
    sourceWorkspaceId: f.workspaceId,
    sourceSessionId: f.sourceId,
    actorSubjectId: f.subjectId,
    destinationWorkspaceId: f.workspaceId,
    destinationVisibility: "user_private",
    workspaceSharedAcknowledged: false,
    operationKey: `fork-${crypto.randomUUID()}`,
    ...(sourceEventId ? { sourceEventId } : {}),
  });
  return forked.sessionId;
}

/** The fork's first message runs, its agent waits for input, and the deadline wake targets the fork. */
async function firstTurnWaitsAndWakes(f: Fixture, forkId: string) {
  const workflowId = `session-${forkId}`;
  const [row] = await shared.admin<Array<{ temporal_workflow_id: string | null }>>`
    select temporal_workflow_id from sessions where id = ${forkId}`;
  expect(row?.temporal_workflow_id).toBe(workflowId);

  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: forkId,
        subjectId: f.subjectId,
        actor: { type: "human", subjectId: f.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Carry on",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId: forkId,
    workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`fork turn was ${claimed.action}`);

  const waited = await waitForSessionInputWithEvent(client.db, f.workspaceId, forkId, {
    reason: "Waiting for the build to finish",
    timeoutSeconds: 900,
    command: {
      accountId: f.accountId,
      actor: {
        type: "agent_attempt",
        sessionId: forkId,
        turnId: claimed.turn.id,
        attemptId,
        executionGeneration: claimed.turn.executionGeneration,
      },
      operationKey: crypto.randomUUID(),
    },
  });
  expect(waited.waitTurnId).toBe(claimed.turn.id);
  const wakes = await shared.admin<Array<{ temporal_workflow_id: string }>>`
    select temporal_workflow_id from session_workflow_wake_outbox where session_id = ${forkId}`;
  expect(wakes.length).toBeGreaterThan(0);
  expect(new Set(wakes.map((wake) => wake.temporal_workflow_id))).toEqual(new Set([workflowId]));
}

describe("a fork has its own workflow identity", () => {
  test("a whole-session fork's first turn can wait for input and be woken", async () => {
    const f = await fixture();
    await completedExchange(f);
    await firstTurnWaitsAndWakes(f, await fork(f));
  }, 180_000);

  test("a message-boundary fork's first turn can wait for input and be woken", async () => {
    const f = await fixture();
    const firstEventId = await completedExchange(f);
    await completedExchange(f);
    await firstTurnWaitsAndWakes(f, await fork(f, firstEventId));
  }, 180_000);
});
