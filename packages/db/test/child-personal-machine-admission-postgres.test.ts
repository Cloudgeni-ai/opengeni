import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  claimSessionWorkForAttempt,
  completeSelfServiceOrganizationSetup,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  isSessionEventPersistenceError,
  setActiveSandbox,
  type DbClient,
} from "../src/index";

let shared: SharedTestDatabase;
let client: DbClient;
let app: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("child-personal-machine");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  app = postgres(shared.appUrl, { max: 2, prepare: false, onnotice: () => undefined });
}, 900_000);
afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const userId = `child-machine-owner-${crypto.randomUUID()}`;
  const owner = `user:${userId}`;
  await shared.admin`insert into auth_users(id, name, email, email_verified)
    values (${userId}, 'Owner', ${`${userId}@example.test`}, true)`;
  const setup = await completeSelfServiceOrganizationSetup(client.db, {
    authUserId: userId,
    actorSubjectId: owner,
    organizationName: "Fresh self-service organization",
    operationId: crypto.randomUUID(),
    requestFingerprint: "b".repeat(64),
  });
  const accountId = setup.organizationId;
  const workspaceId = setup.personalWorkspaceId;
  const [machine] = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true), set_config('opengeni.subject_id', ${owner}, true)`;
    return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(${accountId}::uuid, ${workspaceId}::uuid, 'user',
        ${`ed25519:child-${crypto.randomUUID()}`}, true, false, 'macos', 'x86_64', 'Laptop', false)`;
  });
  await shared.admin`update enrollments set connection_instance_id = 'connection-1',
    connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
    workspace_root = '/' where id = ${machine!.enrollmentId}`;
  return { accountId, workspaceId, owner, ...machine! };
}

async function claim(workspaceId: string, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`turn was not claimed: ${result.reason}`);
  return {
    turnId: result.turn.id,
    attemptId,
    executionGeneration: result.turn.executionGeneration,
  };
}

// A personal (Only me) Connected Machine is approved per chat. The parent's
// session-mode approval must not admit an agent-spawned child chat on the same
// machine, even for the same owner and initiating human: that is why session
// creation no longer copies the parent's personal route into a child (see
// apps/api/test/child-personal-machine-placement.test.ts).
describe("personal machine approval does not extend to a child chat", () => {
  test("the parent's turn is admitted and the child's first claim is refused", async () => {
    const f = await fixture();
    // The parent's human turn attaches the machine for this chat ("session").
    const parent = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      visibility: "workspace_shared",
      initialMessage: "Use my machine",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.owner },
      subjectId: f.owner,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
      initialPersonalResourceAttachmentIntent: {
        mode: "session",
        workspaceSharedAcknowledged: true,
        sharedOutputWarningVersion: 1,
      },
    } as never);
    expect(
      await setActiveSandbox(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: parent.id,
        subjectId: f.owner,
        expectedEpoch: parent.activeEpoch,
        targetSandboxId: f.sandboxId,
      }),
    ).toMatchObject({ swapped: true });
    await initializeSessionStartAtomically(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: parent.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    } as never);
    const parentTurn = await claim(f.workspaceId, parent.id);

    const child = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      visibility: "workspace_shared",
      initialMessage: "Research official sources",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.owner },
      createdByActor: {
        type: "agent_attempt",
        sessionId: parent.id,
        turnId: parentTurn.turnId,
        attemptId: parentTurn.attemptId,
        executionGeneration: parentTurn.executionGeneration,
      },
      parentSessionId: parent.id,
      sandboxGroupId: parent.sandboxGroupId,
      subjectId: f.owner,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "modal",
    } as never);
    expect(
      await setActiveSandbox(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: child.id,
        subjectId: f.owner,
        expectedEpoch: child.activeEpoch,
        targetSandboxId: f.sandboxId,
        workingDir: "/",
      }),
    ).toMatchObject({ swapped: true });
    await initializeSessionStartAtomically(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: child.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
    } as never);
    let rejected: unknown;
    try {
      await claim(f.workspaceId, child.id);
    } catch (error) {
      rejected = error;
    }
    expect(isSessionEventPersistenceError(rejected)).toBe(true);
    if (!isSessionEventPersistenceError(rejected)) throw new Error("expected claim rejection");
    expect(rejected.details).toMatchObject({
      stage: "session_attempts.claim",
      sqlState: "42501",
      retryOutcome: "not_retryable",
    });
    const queryError = rejected.cause as {
      query: string;
      cause: { message: string; where: string };
    };
    expect(queryError.query).toStartWith('insert into "session_turn_attempts"');
    expect(queryError.cause.message).toBe("personal machine use requires explicit grant");
    expect(queryError.cause.where).toContain("admit_session_attempt_personal_machine()");
    expect(
      await shared.admin`select id from session_turn_attempts where session_id = ${child.id}`,
    ).toHaveLength(0);
  }, 180_000);
});
