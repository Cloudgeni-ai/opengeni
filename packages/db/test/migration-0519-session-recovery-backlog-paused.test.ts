import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  countSessionRecoveryBacklog,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  markSessionAttemptQuiesced,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  requestSessionTurnRecovery,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";

// The recovery backlog is a global, cross-workspace aggregate. This file owns
// its database, so every assertion below is an exact absolute count.
let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("migration-0519-recovery-backlog");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Recovery backlog",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Recovery backlog",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const sessionInput = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  };
  const root = await createSession(client.db, { ...sessionInput, initialMessage: "root" });
  const child = await createSession(client.db, {
    ...sessionInput,
    parentSessionId: root.id,
    initialMessage: "child",
  });
  return { grant, workspaceId: grant.workspaceId!, root, child };
}

async function claim(value: Fixture, sessionId: string, initialize = true) {
  if (initialize) {
    await initializeSessionStartAtomically(client.db, {
      accountId: value.grant.accountId,
      workspaceId: value.workspaceId,
      sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
  }
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, value.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`could not claim fixture: ${claimed.reason}`);
  return { attemptId, turn: claimed.turn };
}

async function sessionControl(value: Fixture, sessionId: string, action: "pause" | "resume") {
  return await withWorkspaceRls(client.db, value.workspaceId, (db) =>
    mutateSessionControlInTransaction(db, {
      accountId: value.grant.accountId,
      workspaceId: value.workspaceId,
      sessionId,
      actor: { type: "human", subjectId: value.grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

async function workspaceControl(value: Fixture, action: "pause" | "resume") {
  return await withWorkspaceRls(client.db, value.workspaceId, (db) =>
    mutateWorkspaceControlInTransaction(db, {
      accountId: value.grant.accountId,
      workspaceId: value.workspaceId,
      actor: { type: "human", subjectId: value.grant.subjectId },
      operationKey: crypto.randomUUID(),
      action,
    }),
  );
}

/**
 * Close the exact attempt recoverably as a lost worker does, then prove the
 * physical quiescence receipt. The session is left recovering with no active
 * attempt and effectively active: a genuine stale projection.
 */
async function recoverAndQuiesce(value: Fixture, sessionId: string) {
  const { attemptId, turn } = await claim(value, sessionId);
  const recovery = await requestSessionTurnRecovery(client.db, value.workspaceId, {
    sessionId,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    reason: "worker_shutdown",
  });
  expect(recovery.action).toBe("recovering");
  await quiesce(value, sessionId, attemptId);
  const [session] = await withWorkspaceRls(client.db, value.workspaceId, (db) =>
    db
      .select({ status: schema.sessions.status, activeTurnId: schema.sessions.activeTurnId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId)),
  );
  expect(session).toEqual({ status: "recovering", activeTurnId: turn.id });
}

async function quiesce(value: Fixture, sessionId: string, attemptId: string) {
  await markSessionAttemptQuiesced(client.db, {
    workspaceId: value.workspaceId,
    sessionId,
    attemptId,
    temporalWorkflowId: `session-${sessionId}`,
  });
}

async function backlog() {
  return await countSessionRecoveryBacklog(client.db);
}

describe("session recovery backlog excludes effectively paused sessions (migration 0519)", () => {
  test("a Pause applied to an already quiesced recovery is not stale until Resume", async () => {
    expect(await backlog()).toEqual({ quiescence_missing: 0, projection_stale: 0 });

    // Physical quiescence is still an obligation for a paused session.
    const unquiesced = await fixture();
    const lost = await claim(unquiesced, unquiesced.root.id);
    await requestSessionTurnRecovery(client.db, unquiesced.workspaceId, {
      sessionId: unquiesced.root.id,
      turnId: lost.turn.id,
      triggerEventId: lost.turn.triggerEventId,
      attemptId: lost.attemptId,
      reason: "worker_shutdown",
    });
    await sessionControl(unquiesced, unquiesced.root.id, "pause");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 0 });

    // Direct session Pause.
    const direct = await fixture();
    await recoverAndQuiesce(direct, direct.root.id);
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 1 });
    await sessionControl(direct, direct.root.id, "pause");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 0 });

    // Ancestor Pause: the child inherits the root's pause.
    const ancestor = await fixture();
    await recoverAndQuiesce(ancestor, ancestor.child.id);
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 1 });
    await sessionControl(ancestor, ancestor.root.id, "pause");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 0 });

    // Workspace Pause.
    const workspace = await fixture();
    await recoverAndQuiesce(workspace, workspace.root.id);
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 1 });
    await workspaceControl(workspace, "pause");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 0 });

    // Resume makes each unclaimed recovering turn stale again.
    await sessionControl(direct, direct.root.id, "resume");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 1 });
    // A selected Resume of the child defeats the older ancestor pause while
    // the root itself stays paused.
    await sessionControl(ancestor, ancestor.child.id, "resume");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 2 });
    await workspaceControl(workspace, "resume");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 3 });

    // A newer Pause on the root hides the child again (the child's override is
    // now older than the root pause revision).
    await sessionControl(ancestor, ancestor.root.id, "resume");
    await sessionControl(ancestor, ancestor.root.id, "pause");
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 2 });

    // A real re-claim clears the obligation.
    await claim(direct, direct.root.id, false);
    expect(await backlog()).toEqual({ quiescence_missing: 1, projection_stale: 1 });
  }, 180_000);

  test("keeps the least-privilege content-free function contract", async () => {
    const [definition] = await shared.admin<
      { security_definer: boolean; config: string[] | null; public_execute: boolean }[]
    >`
      select p.prosecdef as security_definer,
             p.proconfig as config,
             has_function_privilege('public', p.oid, 'EXECUTE') as public_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'opengeni_private' and p.proname = 'count_session_recovery_backlog'
    `;
    expect(definition?.security_definer).toBe(true);
    expect(definition?.config?.some((setting) => setting.startsWith("search_path="))).toBe(true);
    expect(definition?.public_execute).toBe(false);
    const rows = await shared.admin<{ state: string }[]>`
      select state from opengeni_private.count_session_recovery_backlog()
    `;
    expect(rows.map((row) => row.state)).toEqual(["projection_stale", "quiescence_missing"]);
  }, 60_000);
});
