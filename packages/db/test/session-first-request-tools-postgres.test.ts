import { afterAll, beforeAll, expect, test } from "bun:test";
import { CURRENT_FIRST_REQUEST_TOOLS_REVISION } from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  sessionsWithSearchableRarelyUsedTools,
  settleSessionFirstRequestToolsRevision,
} from "../src";

// A session's first-request tools revision (migration 1513) is recorded once,
// before its first model request, and never changes after: an existing
// session keeps the tools its earlier requests carried.

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-first-request-tools");
  if (!acquired) throw new Error("First-request tools revision tests require PostgreSQL");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function newSession() {
  const identity = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: identity,
    accountName: "First-request tools",
    workspaceExternalSource: "test",
    workspaceExternalId: identity,
    workspaceName: "First-request tools",
    subjectId: `first-request-tools-${identity}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  return { grant, session, workspaceId: grant.workspaceId, sessionId: session.id };
}
type Fixture = Awaited<ReturnType<typeof newSession>>;

async function storedRevision(ctx: Fixture): Promise<number | null> {
  const [row] = await shared.admin<{ revision: number | null }[]>`
    select first_request_tools_revision as revision from sessions where id = ${ctx.sessionId}`;
  return row!.revision;
}

/** An attempt that already ran, as on a release that did not record the revision. */
async function earlierAttempt(ctx: Fixture): Promise<void> {
  await shared.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`
      with turn as (
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, source, position, prompt, model, reasoning_effort, latency_mode,
          sandbox_backend, resources, tools, metadata, started_at, finished_at
        ) values (
          gen_random_uuid(), ${ctx.grant.accountId}::uuid, ${ctx.workspaceId}::uuid,
          ${ctx.sessionId}::uuid, gen_random_uuid(), ${`session-${ctx.sessionId}`}, 'completed',
          'user', 1, 'earlier turn', 'test-model', 'medium', 'standard', 'none', '[]'::jsonb,
          '[]'::jsonb, '{}'::jsonb, now() - interval '2 minutes', now() - interval '1 minute'
        )
        returning id, started_at, finished_at
      )
      insert into session_turn_attempts (
        id, account_id, workspace_id, session_id, turn_id, execution_generation,
        state, outcome, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
        verified_control_revision, authority_epoch, authority_visibility, mcp_approval_policies,
        started_at, closed_at
      ) select gen_random_uuid(), ${ctx.grant.accountId}::uuid, ${ctx.workspaceId}::uuid,
        ${ctx.sessionId}::uuid, turn.id, 1, 'closed', 'completed',
        ${`session-${ctx.sessionId}`}, gen_random_uuid()::text, gen_random_uuid()::text,
        0, 1, 'workspace_shared', '{}'::jsonb, turn.started_at, turn.finished_at
      from turn`;
  });
}

function settle(ctx: Fixture, attemptId = crypto.randomUUID()) {
  return settleSessionFirstRequestToolsRevision(client.db, {
    workspaceId: ctx.workspaceId,
    sessionId: ctx.sessionId,
    attemptId,
  });
}

test("a new session starts undecided and its first attempt records the current revision", async () => {
  const ctx = await newSession();
  expect(await storedRevision(ctx)).toBeNull();
  expect(CURRENT_FIRST_REQUEST_TOOLS_REVISION).toBe(1);
  expect(await settle(ctx)).toBe(1);
  expect(await storedRevision(ctx)).toBe(1);
  // Every later attempt and turn keeps it.
  await earlierAttempt(ctx);
  expect(await settle(ctx)).toBe(1);
  expect(await storedRevision(ctx)).toBe(1);
});

test("an undecided session that already ran an attempt keeps every request's tools (0)", async () => {
  const ctx = await newSession();
  await earlierAttempt(ctx);
  expect(await settle(ctx)).toBe(0);
  expect(await storedRevision(ctx)).toBe(0);
  expect(await settle(ctx)).toBe(0);
});

test("a session that existed before migration 1513 stays at 0", async () => {
  const ctx = await newSession();
  await shared.admin`
    update sessions set first_request_tools_revision = 0 where id = ${ctx.sessionId}`;
  expect(await settle(ctx)).toBe(0);
  expect(await storedRevision(ctx)).toBe(0);
});

test("the effective-tools projection reads which sessions search for the rarely used tools", async () => {
  const undecided = await newSession();
  const current = await newSession();
  await settle(current);
  const existing = await newSession();
  await shared.admin`
    update sessions set first_request_tools_revision = 0 where id = ${existing.sessionId}`;
  for (const ctx of [undecided, current, existing]) {
    const ids = await sessionsWithSearchableRarelyUsedTools(client.db, ctx.workspaceId, [
      ctx.sessionId,
    ]);
    expect(ids.has(ctx.sessionId)).toBe(ctx !== existing);
  }
});
