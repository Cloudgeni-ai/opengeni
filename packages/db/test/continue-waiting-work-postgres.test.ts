import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  continueSessionWaitingWork,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  getSessionMachineAccess,
  isSessionEventPersistenceError,
  listSessionSystemUpdatesForTurn,
  sendAgentMessageInTransaction,
  setActiveSandbox,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// Production posture: a non-superuser migration owner, FORCE RLS, a named
// schema, and the restricted runtime login.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("continue-waiting-work");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // The harness preinstalls pgcrypto in public; attachment digests resolve
  // extensions in the dedicated data schema, as deployed.
  await shared.admin.unsafe(`ALTER EXTENSION pgcrypto SET SCHEMA ${shared.schema}`);
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  app = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    connection: { search_path: shared.schema },
    onnotice: () => undefined,
  });
}, 900_000);
afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const ownerUser = `machine-owner-${crypto.randomUUID()}`;
  const memberUser = `machine-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUser}`;
  const member = `user:${memberUser}`;
  await shared.admin`insert into auth_users(id, name, email) values
    (${ownerUser}, 'Alex Owner', ${`${ownerUser}@example.test`}),
    (${memberUser}, 'Sam Member', ${`${memberUser}@example.test`})`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUser,
    email: `${ownerUser}@example.test`,
    name: "Machine owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUser,
    email: `${memberUser}@example.test`,
    name: "Workspace member",
  });
  const grant = access.workspaceGrants.find(
    (value) => value.workspaceId === access.defaultWorkspaceId,
  )!;
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUser}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared.admin`insert into workspace_memberships(account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member', '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`insert into session_tenancy_activations(account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'continue-waiting-work-test')`;
  const [machine] = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true), set_config('opengeni.subject_id', ${owner}, true)`;
    return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(${accountId}::uuid, ${workspaceId}::uuid, 'user',
        ${`ed25519:waiting-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64', 'Alex Mac', false)`;
  });
  await shared.admin`update enrollments set connection_instance_id = 'connection-1',
    connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
    workspace_root = '/workspace' where id = ${machine!.enrollmentId}`;
  return { accountId, workspaceId, owner, member, ...machine! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function newSession(f: Fixture, creator: string) {
  return await createSession(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: creator },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
}

async function prompt(
  f: Fixture,
  sessionId: string,
  subjectId: string,
  text: string,
  personalMachineEpoch?: number,
) {
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
        // The owner's own message attaches their machine for this chat,
        // which is what the composer sends when the chat runs on it.
        ...(personalMachineEpoch !== undefined
          ? {
              personalResourceAttachment: {
                mode: "session" as const,
                expectedAuthorityEpoch: personalMachineEpoch,
                workspaceSharedAcknowledged: true,
                sharedOutputWarningVersion: 1 as const,
              },
            }
          : {}),
      }),
    ),
  );
}

async function claim(f: Fixture, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`turn was not claimed: ${result.reason}`);
  return { turn: result.turn, attemptId };
}

async function settle(f: Fixture, active: Awaited<ReturnType<typeof claim>>, started: boolean) {
  const result = await applySessionTurnSettlement(client.db, f.workspaceId, {
    sessionId: active.turn.sessionId,
    turnId: active.turn.id,
    triggerEventId: active.turn.triggerEventId,
    attemptId: active.attemptId,
    turnStatus: started ? "running" : "completed",
    sessionStatus: started ? "running" : "idle",
    activeTurnId: started ? active.turn.id : null,
    events: started ? [{ type: "turn.started", payload: { turnId: active.turn.id } }] : [],
  });
  expect(result.action).toBe("settled");
}

async function rejectedClaim(f: Fixture, sessionId: string) {
  let rejected: unknown;
  try {
    await claim(f, sessionId);
  } catch (error) {
    rejected = error;
  }
  expect(isSessionEventPersistenceError(rejected)).toBe(true);
  if (!isSessionEventPersistenceError(rejected)) throw new Error("expected claim rejection");
  expect(rejected.details).toMatchObject({ sqlState: "42501" });
}

/**
 * A member's worker reports back to a shared chat that now runs on the
 * owner's personal Mac, where the owner is the one working.
 */
async function waitingResultScenario() {
  const f = await fixture();
  const chat = await newSession(f, f.owner);
  const worker = await newSession(f, f.member);
  await prompt(f, worker.id, f.member, "Fix the importer and report back");
  const sender = await claim(f, worker.id);

  await setActiveSandbox(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: chat.id,
    subjectId: f.owner,
    expectedEpoch: chat.activeEpoch,
    targetSandboxId: f.sandboxId,
  });
  const [epoch] = await shared.admin`select authority_epoch from sessions where id = ${chat.id}`;
  await prompt(f, chat.id, f.owner, "Look on my Mac", Number(epoch!.authority_epoch));
  const ownerTurn = await claim(f, chat.id);
  await settle(f, ownerTurn, true);
  await settle(f, ownerTurn, false);

  const sent = await withWorkspaceSessionActivityRls(client.db, f.workspaceId, (tx) =>
    sendAgentMessageInTransaction(tx, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      targetSessionId: chat.id,
      actor: {
        type: "agent_attempt",
        sessionId: sender.turn.sessionId,
        turnId: sender.turn.id,
        attemptId: sender.attemptId,
        executionGeneration: sender.turn.executionGeneration,
      },
      operationKey: crypto.randomUUID(),
      text: "The importer fix is on main",
    }),
  );
  return { f, chat, ownerTurn, updateId: sent.updateId };
}

describe("continuing other people's waiting work on a personal machine", () => {
  test("both people see whose results wait, and only the owner can let them continue", async () => {
    const { f, chat, updateId } = await waitingResultScenario();
    // The member's result cannot run on the owner's Mac by itself.
    await rejectedClaim(f, chat.id);
    const access = (subjectId: string) =>
      getSessionMachineAccess(client.db, { ...f, sessionId: chat.id, subjectId });
    expect(await access(f.owner)).toMatchObject({
      isOwner: true,
      machineName: "Alex Mac",
      waitingWork: [{ name: "Sam Member", isYou: false, results: 1 }],
    });
    expect(await access(f.member)).toMatchObject({
      isOwner: false,
      ownerName: "Alex Owner",
      waitingWork: [{ name: "Sam Member", isYou: true, results: 1 }],
    });

    // Nobody but the machine's owner can let it continue.
    const refused = await continueSessionWaitingWork(client.db, {
      ...f,
      sessionId: chat.id,
      subjectId: f.member,
    }).catch((error: unknown) => error);
    expect(String((refused as { cause?: unknown })?.cause ?? refused)).toContain(
      "waiting work can only be continued by its machine owner",
    );
    const [untouched] =
      await shared.admin`select continued_by_subject_id from session_system_updates where id = ${updateId}`;
    expect(untouched!.continued_by_subject_id).toBeNull();

    expect(
      await continueSessionWaitingWork(client.db, {
        ...f,
        sessionId: chat.id,
        subjectId: f.owner,
      }),
    ).toBe(1);
    expect((await access(f.owner))?.waitingWork).toEqual([]);
    expect((await access(f.member))?.waitingWork).toEqual([]);
  }, 120_000);

  test("the owner's continue delivers the result in a turn under the owner's authority", async () => {
    const { f, chat, ownerTurn, updateId } = await waitingResultScenario();
    await rejectedClaim(f, chat.id);
    await continueSessionWaitingWork(client.db, { ...f, sessionId: chat.id, subjectId: f.owner });

    const next = await claim(f, chat.id);
    expect(next.turn.source).toBe("system");
    expect(next.turn.initiatingHumanSubjectId).toBe(f.owner);
    const [receipt] =
      await shared.admin`select execution_context_turn_id from session_turns where id = ${next.turn.id}`;
    expect(receipt!.execution_context_turn_id).toBe(ownerTurn.turn.id);
    const delivered = await listSessionSystemUpdatesForTurn(
      client.db,
      f.workspaceId,
      chat.id,
      next.turn.id,
    );
    expect(delivered.map((row) => row.id)).toEqual([updateId]);
    const [row] =
      await shared.admin`select state, continued_by_subject_id, lineage from session_system_updates where id = ${updateId}`;
    // The producer receipt is unchanged; the owner's choice is recorded beside it.
    expect(row).toMatchObject({ state: "delivered", continued_by_subject_id: f.owner });
    expect(JSON.stringify(row!.lineage)).not.toContain(f.owner);
  }, 120_000);

  test("without the owner's continue, the fence still refuses someone else's result", async () => {
    const { f, chat, updateId } = await waitingResultScenario();
    // Marking it for a different person than the receiving context is refused.
    await shared.admin`update session_system_updates set continued_by_subject_id = ${f.member},
      continued_at = now() where id = ${updateId}`;
    await rejectedClaim(f, chat.id);
    const [row] =
      await shared.admin`select state from session_system_updates where id = ${updateId}`;
    expect(row!.state).toBe("pending");
  }, 120_000);
});
