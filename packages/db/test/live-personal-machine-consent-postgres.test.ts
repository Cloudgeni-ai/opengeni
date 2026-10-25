import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  grantDeferredRuntimeAccess,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  getSandbox,
  getSandboxForAttempt,
  getSessionMachineAccess,
  hasPendingSteerForTurn,
  transitionSessionVisibility,
  initializeSessionStartAtomically,
  isSessionEventPersistenceError,
  issueSelfUserResourceGrant,
  peekSessionWork,
  recoverSessionDispatch,
  resolvePersonalMachineConnectionForAttempt,
  resolvePersonalMachineRouteForAttempt,
  revokeSelfUserResourceGrant,
  setActiveSandbox,
  steerAgentSessionInTransaction,
  steerQueuedTurnInTransaction,
  submitHumanPromptInTransaction,
  WAITED_FOR_MACHINE_OWNER_MODEL_CONTEXT,
  withWorkspaceSubjectSessionActivityRls,
  withWorkspaceSessionActivityRls,
  withRlsContext,
  type DbClient,
} from "../src/index";

// This suite must exercise the production posture: a non-superuser migration
// owner, FORCE RLS, a named schema, and the restricted runtime login.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("live-machine-consent");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // The harness preinstalls pgcrypto in public; attachment digests resolve
  // extensions in the dedicated data schema, as deployed.
  await shared.admin.unsafe(`ALTER EXTENSION pgcrypto SET SCHEMA ${shared.schema}`);
  // Run as the runtime will once the machine-owner lookup 0978 withholds is
  // granted; the last test checks the behaviour while it is still withheld.
  await grantDeferredRuntimeAccess(shared.admin);
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
  await shared.admin`insert into auth_users(id, name, email)
    values (${ownerUser}, 'Alex Owner', ${`${ownerUser}@example.test`})`;
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
    values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'machine-consent-test')`;
  await shared.admin`insert into organization_private_session_settings(account_id, enabled, version)
    values (${accountId}, true, 1) on conflict (account_id) do update set enabled = true`;
  const machines = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true), set_config('opengeni.subject_id', ${owner}, true)`;
    return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(${accountId}::uuid, ${workspaceId}::uuid, 'user',
        ${`ed25519:consent-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64', 'Build machine', false)`;
  });
  const machine = machines[0]!;
  await shared.admin`update enrollments set connection_instance_id = 'connection-1',
    connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
    workspace_root = '/srv/build' where id = ${machine.enrollmentId}`;
  return { accountId, workspaceId, owner, member, ...machine };
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

async function rejectedClaimCause(workspaceId: string, sessionId: string) {
  let rejected: unknown;
  try {
    await claim(workspaceId, sessionId);
  } catch (error) {
    rejected = error;
  }
  if (!isSessionEventPersistenceError(rejected)) throw new Error("expected claim rejection");
  const queryError = rejected.cause as { cause: { message: string; where: string } };
  return { ...rejected.details, message: queryError.cause.message, where: queryError.cause.where };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A shared chat the owner runs on their personal machine. */
async function chatOnOwnersMachine(f: Fixture) {
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: f.owner },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  expect(
    await setActiveSandbox(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: session.id,
      subjectId: f.owner,
      expectedEpoch: session.activeEpoch,
      targetSandboxId: f.sandboxId,
    }),
  ).toMatchObject({ swapped: true });
  return session;
}

/**
 * A person's message, as the composer sends it. The owner's own messages carry
 * the machine the chat runs on, like the composer attaches it.
 */
async function submitAs(
  f: Fixture,
  sessionId: string,
  subjectId: string,
  text: string,
  delivery: "send" | "steer" = "send",
) {
  const [authority] =
    await shared.admin`select authority_epoch from sessions where id = ${sessionId}`;
  return await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId,
        subjectId,
        actor: { type: "human", subjectId },
        operationKey: crypto.randomUUID(),
        delivery,
        text,
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
        ...(subjectId === f.owner
          ? {
              personalResourceAttachment: {
                mode: "session" as const,
                expectedAuthorityEpoch: Number(authority!.authority_epoch),
                workspaceSharedAcknowledged: true,
                sharedOutputWarningVersion: 1 as const,
              },
            }
          : {}),
      }),
    ),
  );
}

async function claimOutcome(workspaceId: string, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  return result.action === "claimed"
    ? { action: result.action, turn: result.turn, attemptId }
    : result;
}

async function claimTurn(workspaceId: string, sessionId: string) {
  const result = await claimOutcome(workspaceId, sessionId);
  if (result.action !== "claimed") throw new Error(`turn was not claimed: ${result.reason}`);
  return result;
}

async function completeTurn(
  workspaceId: string,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claimTurn>>,
) {
  await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [],
  });
}

/** The settlement a worker writes when it finds a waiting Steer at its next model step. */
async function handOverAtModelStep(
  workspaceId: string,
  sessionId: string,
  claimed: Awaited<ReturnType<typeof claimTurn>>,
) {
  return await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId,
    turnId: claimed.turn.id,
    triggerEventId: claimed.turn.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "superseded",
    sessionStatus: "queued",
    activeTurnId: null,
    requirePendingSteer: true,
    events: [
      { type: "turn.superseded", payload: { reason: "steer", atModelStep: true } },
      { type: "session.status.changed", payload: { status: "queued" } },
    ],
  });
}

async function pendingSteer(f: Fixture, sessionId: string, turnId: string) {
  return await hasPendingSteerForTurn(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId,
    turnId,
  });
}

/**
 * The owner's turn starts on one of their personal machines, then the agent
 * moves the chat to the owner's other personal machine, which the owner allows
 * for all chats. The turn is then forced into a replacement attempt.
 */
async function agentMovedTurn() {
  const f = await fixture();
  const [other] = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${f.accountId}, true),
      set_config('opengeni.workspace_id', ${f.workspaceId}, true), set_config('opengeni.subject_id', ${f.owner}, true)`;
    return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(${f.accountId}::uuid, ${f.workspaceId}::uuid, 'user',
        ${`ed25519:other-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64', 'Home server', false)`;
  });
  await shared.admin`update enrollments set connection_instance_id = 'connection-2',
    connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
    workspace_root = '/srv/home' where id = ${other!.enrollmentId}`;
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: f.owner },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await setActiveSandbox(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: session.id,
    subjectId: f.owner,
    expectedEpoch: session.activeEpoch,
    targetSandboxId: f.sandboxId,
  });
  const [authority] = await shared.admin`select authority_epoch, visibility from sessions
    where id = ${session.id}`;
  // The composer attaches the machine the chat runs on to the owner's message.
  await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.owner, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        subjectId: f.owner,
        actor: { type: "human", subjectId: f.owner },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "Set up the home server",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
        personalResourceAttachment: {
          mode: "session",
          expectedAuthorityEpoch: Number(authority!.authority_epoch),
          workspaceSharedAcknowledged: true,
          sharedOutputWarningVersion: 1,
        },
      }),
    ),
  );
  const first = await claim(f.workspaceId, session.id);
  const [otherAuthority] =
    await shared.admin`select authority_id from enrollments where id = ${other!.enrollmentId}`;
  const grant = await issueSelfUserResourceGrant(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    subjectId: f.owner,
    authorityId: otherAuthority!.authority_id,
    resourceKind: "connected_machine",
    mode: "always",
    context: authority!.visibility,
    workspaceSharedAcknowledged: true,
  });
  const runtime = {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    sessionId: session.id,
    subjectId: f.owner,
  };
  return { f, other: other!, session, first, grant, runtime };
}

async function moveAndRecover(scenario: Awaited<ReturnType<typeof agentMovedTurn>>) {
  const { f, other, session, first } = scenario;
  expect(
    await setActiveSandbox(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: session.id,
      subjectId: f.owner,
      expectedEpoch: session.activeEpoch + 1,
      targetSandboxId: other.sandboxId,
      personalMachineAttempt: { ...first, initiatingHumanSubjectId: f.owner },
    }),
  ).toMatchObject({ swapped: true, pointer: { activeSandboxId: other.sandboxId } });
  await recover(f.workspaceId, session.id, first.attemptId);
}

async function recover(workspaceId: string, sessionId: string, attemptId: string) {
  expect(
    (
      await recoverSessionDispatch(client.db, workspaceId, {
        sessionId,
        attemptId,
        timeoutType: "HEARTBEAT",
        maxRedispatches: 3,
      })
    ).action,
  ).toBe("recovering");
}

describe("live personal machine consent under FORCE RLS", () => {
  test("machine explanation follows chat visibility, not machine discovery or a foreign tenant", async () => {
    const f = await fixture();
    const session = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.owner },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await setActiveSandbox(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: session.id,
      subjectId: f.owner,
      expectedEpoch: session.activeEpoch,
      targetSandboxId: f.sandboxId,
    });
    const explanation = (subjectId: string, accountId = f.accountId, sessionId = session.id) =>
      getSessionMachineAccess(client.db, {
        accountId,
        workspaceId: f.workspaceId,
        sessionId,
        subjectId,
      });
    expect(await explanation(f.owner)).toMatchObject({
      sandboxId: f.sandboxId,
      machineName: "Build machine",
      ownerName: "Alex Owner",
      isOwner: true,
      queuedTurnBlocked: false,
    });
    expect(await explanation(f.member)).toMatchObject({ isOwner: false, queuedTurnBlocked: false });
    expect(await getSandbox(client.db, { ...f, subjectId: f.member }, f.sandboxId)).toBeNull();
    expect(await explanation(f.member, crypto.randomUUID())).toBeNull();
    expect(await explanation(f.member, f.accountId, crypto.randomUUID())).toBeNull();
    expect(await explanation(`user:outsider-${crypto.randomUUID()}`)).toBeNull();
    await transitionSessionVisibility(client.db, {
      workspaceId: f.workspaceId,
      sessionId: session.id,
      actorSubjectId: f.owner,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: crypto.randomUUID(),
    });
    expect(await explanation(f.member)).toBeNull();
    expect(await explanation(f.owner)).toMatchObject({ isOwner: true });
    await transitionSessionVisibility(client.db, {
      workspaceId: f.workspaceId,
      sessionId: session.id,
      actorSubjectId: f.owner,
      targetVisibility: "workspace_shared",
      expectedAuthorityEpoch: 2,
      operationKey: crypto.randomUUID(),
    });
    expect(await explanation(f.member)).toMatchObject({ isOwner: false });
    await shared.admin`delete from workspace_memberships where workspace_id = ${f.workspaceId} and subject_id = ${f.member}`;
    expect(await explanation(f.member)).toBeNull();
  });

  test("a member's message waits for the owner instead of inheriting the personal machine", async () => {
    const f = await fixture();
    const session = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.owner },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    expect(
      await setActiveSandbox(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        subjectId: f.owner,
        expectedEpoch: session.activeEpoch,
        targetSandboxId: f.sandboxId,
      }),
    ).toMatchObject({ swapped: true });
    const sent = await submitAs(f, session.id, f.member, "Member follow-up");
    expect(sent).toMatchObject({ waitsForMachineOwner: true, routing: "queued_for_execution" });
    // It never reaches the attempt admission trigger, so it cannot block the chat.
    expect(await claimOutcome(f.workspaceId, session.id)).toEqual({
      action: "unclaimed",
      reason: "no-work",
    });
    expect(
      await shared.admin`select id from session_turn_attempts where session_id = ${session.id}`,
    ).toHaveLength(0);
    const [chat] =
      await shared.admin`select status, admission_block from sessions where id = ${session.id}`;
    expect(chat).toMatchObject({ admission_block: null });
    expect(chat!.status).not.toBe("requires_action");
    const [queued] =
      await shared.admin`select id, status, initiating_human_subject_id from session_turns where session_id = ${session.id}`;
    expect(queued).toMatchObject({ status: "queued", initiating_human_subject_id: f.member });
    for (const subjectId of [f.owner, f.member]) {
      expect(
        await getSessionMachineAccess(client.db, { ...f, sessionId: session.id, subjectId }),
      ).toMatchObject({
        queuedTurnBlocked: true,
        isOwner: subjectId === f.owner,
        waitingMessages: [{ isYou: subjectId === f.member, messages: 1 }],
      });
    }

    // Changing to a workspace machine lets the waiting message run as the
    // member's own turn, and the move wakes the chat to start it; it never
    // borrows the previous owner's identity.
    const [workspaceMachine] = await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${f.accountId}, true),
        set_config('opengeni.workspace_id', ${f.workspaceId}, true), set_config('opengeni.subject_id', ${f.owner}, true)`;
      return await tx`select sandbox_id from finalize_scoped_enrollment(
        ${f.accountId}::uuid, ${f.workspaceId}::uuid, 'workspace',
        ${`ed25519:shared-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64', 'Shared build machine', false)`;
    });
    expect(
      await setActiveSandbox(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        subjectId: f.member,
        expectedEpoch: session.activeEpoch + 1,
        targetSandboxId: workspaceMachine!.sandbox_id,
      }),
    ).toMatchObject({ swapped: true });
    expect(
      await getSessionMachineAccess(client.db, {
        ...f,
        sessionId: session.id,
        subjectId: f.member,
      }),
    ).toBeNull();
    const [wake] = await shared.admin`select reason from session_workflow_wake_outbox
      where session_id = ${session.id}`;
    expect(wake).toMatchObject({ reason: "machine_changed" });
    const started = await claim(f.workspaceId, session.id);
    expect(started.turnId).toBe(queued!.id);
  });
  for (const starter of ["owner", "member", "service"] as const) {
    test(`owner click admits the ${starter} turn and replacement attempt without borrowing identity`, async () => {
      const f = await fixture();
      const subjectId = starter === "service" ? null : f[starter];
      const session = await createSession(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        initialMessage: "Continue on the selected machine",
        resources: [],
        metadata: {},
        createdBy: subjectId
          ? { kind: "subject", subjectId }
          : { kind: "service", subjectId: "service:machine-consent-test" },
        subjectId: subjectId ?? f.owner,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        visibility: "workspace_shared",
      } as never);
      await initializeSessionStartAtomically(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      } as never);
      const first = await claim(f.workspaceId, session.id);
      const move = (clicker: string, expectedEpoch = session.activeEpoch) =>
        setActiveSandbox(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: session.id,
          subjectId: clicker,
          expectedEpoch,
          targetSandboxId: f.sandboxId,
          consentToCurrentTurn: true,
        });
      expect(await move(f.member)).toMatchObject({ swapped: false, refusal: "not_permitted" });
      expect(await move(f.owner, session.activeEpoch + 2)).toMatchObject({
        swapped: false,
        refusal: "epoch_changed",
      });
      expect(
        await shared.admin`select id from session_turn_machine_consents where turn_id = ${first.turnId}`,
      ).toHaveLength(0);
      const moved = await move(f.owner);
      expect(moved).toMatchObject({
        swapped: true,
        pointer: { activeSandboxId: f.sandboxId },
      });
      const runtime = {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        subjectId,
        ...first,
      };
      expect(await getSandboxForAttempt(client.db, runtime, f.sandboxId)).toMatchObject({
        id: f.sandboxId,
        scope: "user",
      });
      const uses = () => shared.admin`select id from audit_events
        where action = 'connected_machine.used' and metadata->>'attemptId' = ${first.attemptId}`;
      expect(await uses()).toHaveLength(0);
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          enrollmentId: f.enrollmentId,
        }),
      ).toMatchObject({ id: f.enrollmentId, connectionInstanceId: "connection-1" });
      expect(await uses()).toHaveLength(1);
      await shared.admin`update enrollments set connection_lease_expires_at = now() - interval '1 second'
        where id = ${f.enrollmentId}`;
      expect(
        await resolvePersonalMachineRouteForAttempt(client.db, {
          ...runtime,
          enrollmentId: f.enrollmentId,
        }),
      ).toMatchObject({
        enrollment: { id: f.enrollmentId, workspaceRoot: "/srv/build" },
        liveConnection: null,
      });
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          enrollmentId: f.enrollmentId,
        }),
      ).toBeNull();
      await shared.admin`update enrollments set connection_lease_expires_at = now() + interval '1 hour'
        where id = ${f.enrollmentId}`;
      await withRlsContext(
        client.db,
        { accountId: f.accountId, workspaceId: f.workspaceId },
        async (tx) => {
          await tx.execute(sql`select
          set_config('opengeni.subject_id', ${subjectId ?? ""}, true),
          set_config('opengeni.initiating_human_subject_id', ${subjectId ?? ""}, true)`);
          await tx.execute(sql`select get_session_attempt_machine(${f.accountId}::uuid, ${f.workspaceId}::uuid,
          ${session.id}::uuid, ${first.turnId}::uuid, ${first.attemptId}::uuid,
          ${first.executionGeneration}::integer, ${f.sandboxId}::uuid, null, false, true)`);
          const [actor] =
            await tx.execute(sql`select current_setting('opengeni.subject_id') as subject,
          current_setting('opengeni.initiating_human_subject_id') as initiator`);
          expect(actor).toEqual({ subject: subjectId ?? "", initiator: subjectId ?? "" });
        },
      );
      expect(await uses()).toHaveLength(3);
      expect(await getSandbox(client.db, { ...f, subjectId: f.member }, f.sandboxId)).toBeNull();
      await expect(
        resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          subjectId: subjectId === f.owner ? f.member : f.owner,
          enrollmentId: f.enrollmentId,
        }),
      ).rejects.toThrow();
      const [identity] =
        await shared.admin`select initiating_human_subject_id from session_turns where id = ${first.turnId}`;
      expect(identity?.initiating_human_subject_id).toBe(subjectId);
      expect(
        (
          await recoverSessionDispatch(client.db, f.workspaceId, {
            sessionId: session.id,
            attemptId: first.attemptId,
            timeoutType: "HEARTBEAT",
            maxRedispatches: 3,
          })
        ).action,
      ).toBe("recovering");
      if (starter === "service") {
        // The owner's click also works between attempts, when active_turn_id is
        // temporarily empty. It must bind to this recovering turn, not future work.
        expect(await move(f.owner, session.activeEpoch + 1)).toMatchObject({ swapped: true });
      }
      const second = await claim(f.workspaceId, session.id);
      expect(second.turnId).toBe(first.turnId);
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(
        await getSandboxForAttempt(client.db, { ...runtime, ...second }, f.sandboxId),
      ).toMatchObject({ id: f.sandboxId });
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          ...second,
          enrollmentId: f.enrollmentId,
        }),
      ).toMatchObject({ id: f.enrollmentId });
      await expect(
        resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          enrollmentId: f.enrollmentId,
        }),
      ).rejects.toThrow();
      const bindings =
        await shared.admin`select binding.attempt_id from session_attempt_machine_consents binding
        join session_turn_machine_consents consent on consent.id = binding.consent_id where consent.turn_id = ${first.turnId}`;
      expect(bindings.map((value) => value.attempt_id).sort()).toEqual(
        [first.attemptId, second.attemptId].sort(),
      );
      await shared.admin`update organization_memberships set authorization_revision = authorization_revision + 1
        where account_id = ${f.accountId} and subject_id = ${f.owner}`;
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          ...second,
          enrollmentId: f.enrollmentId,
        }),
      ).toBeNull();
    }, 120_000);
  }

  test("runtime cannot write consent or execute internal helpers", async () => {
    const [privileges] = await app`select
      has_table_privilege(current_user, 'session_turn_machine_consents', 'INSERT') as turn_insert,
      has_table_privilege(current_user, 'session_attempt_machine_consents', 'INSERT') as attempt_insert,
      has_function_privilege(current_user, 'bind_session_attempt_machine_consent(uuid,uuid,uuid)', 'EXECUTE') as bind,
      has_function_privilege(current_user, 'live_session_turn_machine_consent(uuid)', 'EXECUTE') as validate,
      has_function_privilege(current_user, 'carry_session_attempt_machine_authorization(uuid,uuid,uuid)', 'EXECUTE') as carry`;
    expect(privileges).toEqual({
      turn_insert: false,
      attempt_insert: false,
      bind: false,
      validate: false,
      carry: false,
    });
  });
});

describe("an agent's move between the owner's personal machines", () => {
  test("carries into the turn's replacement attempt", async () => {
    const scenario = await agentMovedTurn();
    const { f, other, session, first, grant, runtime } = scenario;
    await moveAndRecover(scenario);
    const second = await claim(f.workspaceId, session.id);
    expect(second.turnId).toBe(first.turnId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(
      await resolvePersonalMachineConnectionForAttempt(client.db, {
        ...runtime,
        ...second,
        enrollmentId: other.enrollmentId,
      }),
    ).toMatchObject({ id: other.enrollmentId, connectionInstanceId: "connection-2" });
    const carried =
      await shared.admin`select grant_id, initiating_human_subject_id, execution_generation
        from session_attempt_connected_machine_authorizations where attempt_id = ${second.attemptId}`;
    expect([...carried]).toEqual([
      {
        grant_id: grant.grantId,
        initiating_human_subject_id: f.owner,
        execution_generation: second.executionGeneration,
      },
    ]);
    // The carried authorization is still the live grant, not a copy of it.
    await revokeSelfUserResourceGrant(client.db, { ...runtime, grantId: grant.grantId });
    await expect(
      resolvePersonalMachineConnectionForAttempt(client.db, {
        ...runtime,
        ...second,
        enrollmentId: other.enrollmentId,
      }),
    ).rejects.toThrow();
  }, 120_000);

  test("a revoked grant refuses the replacement attempt with the grant-required cause", async () => {
    const scenario = await agentMovedTurn();
    const { f, session, grant, runtime } = scenario;
    await moveAndRecover(scenario);
    await revokeSelfUserResourceGrant(client.db, { ...runtime, grantId: grant.grantId });
    expect(await rejectedClaimCause(f.workspaceId, session.id)).toMatchObject({
      stage: "session_attempts.claim",
      sqlState: "OG002",
      message: "matching personal-resource grant required",
    });
    // The owner allowing the machine again lets the same turn continue.
    await issueSelfUserResourceGrant(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      subjectId: f.owner,
      authorityId: grant.delegation.authorityId,
      resourceKind: "connected_machine",
      mode: "always",
      context: grant.context,
      workspaceSharedAcknowledged: true,
    });
    expect((await claim(f.workspaceId, session.id)).turnId).toBe(scenario.first.turnId);
  }, 120_000);

  test("a machine the turn never held is refused with the grant-required cause", async () => {
    const { f, other, session, first } = await agentMovedTurn();
    // The pointer moved without this turn ever being authorized for it.
    await shared.admin`update sessions set active_sandbox_id = ${other.sandboxId},
      active_epoch = active_epoch + 1 where id = ${session.id}`;
    await recover(f.workspaceId, session.id, first.attemptId);
    const cause = await rejectedClaimCause(f.workspaceId, session.id);
    expect(cause).toMatchObject({ stage: "session_attempts.claim", sqlState: "OG002" });
    expect(cause.where).toContain("carry_session_attempt_machine_authorization");
  }, 120_000);
});

describe("messages from other people on a personal machine", () => {
  test("another member's message and Steer wait for the owner without stopping, blocking or starving the owner's turns", async () => {
    const f = await fixture();
    const session = await chatOnOwnersMachine(f);
    const first = await submitAs(f, session.id, f.owner, "Owner task one");
    expect(first.waitsForMachineOwner).toBe(false);
    const ownerTurn = await claimTurn(f.workspaceId, session.id);
    expect(ownerTurn.turn.id).toBe(first.turnId);

    // Another member writes in, then steers, while the owner's turn runs.
    const message = await submitAs(f, session.id, f.member, "Member: please check the logs");
    const steer = await submitAs(f, session.id, f.member, "Member: also restart it", "steer");
    for (const result of [message, steer]) {
      expect(result).toMatchObject({
        waitsForMachineOwner: true,
        routing: "queued_for_execution",
        interruptionCount: 0,
      });
      expect(result.turn.metadata).not.toMatchObject({ delivery: "steer" });
    }
    // The owner's running turn keeps running: nothing asks it to hand over.
    const [running] = await shared.admin`select session.active_turn_id, turn.status
      from sessions session join session_turns turn on turn.id = ${ownerTurn.turn.id}
      where session.id = ${session.id}`;
    expect(running).toMatchObject({ active_turn_id: ownerTurn.turn.id, status: "running" });
    expect(await pendingSteer(f, session.id, ownerTurn.turn.id)).toBe(false);
    expect(await handOverAtModelStep(f.workspaceId, session.id, ownerTurn)).toMatchObject({
      action: "pending_steer_withdrawn",
    });

    // The owner's turn finishes. The waiting messages are not work, so the
    // chat goes idle rather than claiming and refusing them.
    await completeTurn(f.workspaceId, session.id, ownerTurn);
    const [idle] =
      await shared.admin`select status, admission_block from sessions where id = ${session.id}`;
    expect(idle).toMatchObject({ status: "idle", admission_block: null });
    expect(await peekSessionWork(client.db, f.workspaceId, session.id)).not.toEqual({
      kind: "runnable",
    });
    expect(await claimOutcome(f.workspaceId, session.id)).toEqual({
      action: "unclaimed",
      reason: "no-work",
    });
    expect(
      await getSessionMachineAccess(client.db, { ...f, sessionId: session.id, subjectId: f.owner }),
    ).toMatchObject({ waitingMessages: [{ isYou: false, messages: 2 }] });
    expect(
      await getSessionMachineAccess(client.db, {
        ...f,
        sessionId: session.id,
        subjectId: f.member,
      }),
    ).toMatchObject({ waitingMessages: [{ isYou: true, messages: 2 }] });

    // The owner's next message runs at once and brings both messages to the
    // agent, in the order they were sent, ahead of the owner's own words.
    const followUp = await submitAs(f, session.id, f.owner, "Do what they asked");
    expect(followUp).toMatchObject({
      waitsForMachineOwner: false,
      routing: "accepted_for_execution",
    });
    const ownerFollowUp = await claimTurn(f.workspaceId, session.id);
    expect(ownerFollowUp.turn.id).toBe(followUp.turnId);
    const history = await shared.admin<Array<{ turn_id: string; item: string }>>`
      select turn_id, item::text as item from session_history_items
      where session_id = ${session.id} and turn_id in ${shared.admin([
        message.turnId,
        steer.turnId,
        followUp.turnId,
      ])}
      order by position`;
    expect(history.map((row) => row.turn_id)).toEqual([
      message.turnId,
      steer.turnId,
      followUp.turnId,
    ]);
    expect(history[0]!.item).toContain("Member: please check the logs");
    expect(history[1]!.item).toContain("Member: also restart it");
    for (const row of history.slice(0, 2)) {
      expect(row.item).toContain(WAITED_FOR_MACHINE_OWNER_MODEL_CONTEXT);
    }
    expect(history[2]!.item).not.toContain(WAITED_FOR_MACHINE_OWNER_MODEL_CONTEXT);
    const absorbed = await shared.admin`select id, status from session_turns
      where id in ${shared.admin([message.turnId, steer.turnId])} order by created_at`;
    expect(absorbed.map((row) => row.status)).toEqual(["superseded", "superseded"]);
    const superseded = await shared.admin`select turn_id, payload from session_events
      where session_id = ${session.id} and type = 'turn.superseded'
        and turn_id in ${shared.admin([message.turnId, steer.turnId])}`;
    expect(superseded).toHaveLength(2);
    for (const event of superseded) {
      expect(event.payload).toMatchObject({
        reason: "steer",
        targetTurnId: followUp.turnId,
        beforeAttempt: true,
      });
    }
    expect(
      await shared.admin`select id from session_turn_attempts
        where turn_id in ${shared.admin([message.turnId, steer.turnId])}`,
    ).toHaveLength(0);
    expect(await pendingSteer(f, session.id, ownerFollowUp.turn.id)).toBe(false);
    expect(
      await getSessionMachineAccess(client.db, { ...f, sessionId: session.id, subjectId: f.owner }),
    ).toMatchObject({ waitingMessages: [] });

    // And the owner keeps working normally afterwards.
    await completeTurn(f.workspaceId, session.id, ownerFollowUp);
    const third = await submitAs(f, session.id, f.owner, "Owner task three");
    expect((await claimTurn(f.workspaceId, session.id)).turn.id).toBe(third.turnId);
    const [chat] =
      await shared.admin`select admission_block from sessions where id = ${session.id}`;
    expect(chat).toMatchObject({ admission_block: null });
  }, 120_000);

  test("a waiting message cannot be sent now, and an older queued Steer from it never interrupts the owner", async () => {
    const f = await fixture();
    const session = await chatOnOwnersMachine(f);
    await submitAs(f, session.id, f.owner, "Owner task");
    const ownerTurn = await claimTurn(f.workspaceId, session.id);
    const waiting = await submitAs(f, session.id, f.member, "Member: look at this");
    for (const subjectId of [f.owner, f.member]) {
      await expect(
        withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, subjectId, (db) =>
          db.transaction((tx) =>
            steerQueuedTurnInTransaction(tx as unknown as typeof db, {
              accountId: f.accountId,
              workspaceId: f.workspaceId,
              sessionId: session.id,
              turnId: waiting.turnId,
              expectedTurnVersion: waiting.turn.version,
              actor: { type: "human", subjectId },
              operationKey: crypto.randomUUID(),
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: "WAITING_FOR_MACHINE_OWNER" });
    }
    // A Steer another member queued before messages waited is no longer a
    // pending Steer for the owner's turn either.
    await shared.admin`update session_turns
      set metadata = metadata || '{"delivery":"steer"}'::jsonb where id = ${waiting.turnId}`;
    expect(await pendingSteer(f, session.id, ownerTurn.turn.id)).toBe(false);
    expect(await handOverAtModelStep(f.workspaceId, session.id, ownerTurn)).toMatchObject({
      action: "pending_steer_withdrawn",
    });
    const [turn] =
      await shared.admin`select status from session_turns where id = ${ownerTurn.turn.id}`;
    expect(turn).toMatchObject({ status: "running" });
  }, 120_000);

  test("another member's agent cannot steer a chat on the owner's personal machine", async () => {
    const f = await fixture();
    const session = await chatOnOwnersMachine(f);
    await submitAs(f, session.id, f.owner, "Owner task");
    const ownerTurn = await claimTurn(f.workspaceId, session.id);
    const memberChat = await createSession(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      initialMessage: "",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: f.member },
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await submitAs(f, memberChat.id, f.member, "Coordinate with the build chat");
    const memberAgent = await claimTurn(f.workspaceId, memberChat.id);
    await expect(
      withWorkspaceSessionActivityRls(client.db, f.workspaceId, (db) =>
        db.transaction((tx) =>
          steerAgentSessionInTransaction(tx as unknown as typeof db, {
            accountId: f.accountId,
            workspaceId: f.workspaceId,
            targetSessionId: session.id,
            actor: {
              type: "agent_attempt",
              sessionId: memberChat.id,
              turnId: memberAgent.turn.id,
              attemptId: memberAgent.attemptId,
              executionGeneration: memberAgent.turn.executionGeneration,
            },
            operationKey: crypto.randomUUID(),
            instruction: "Stop and do this instead",
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "PERSONAL_MACHINE_OWNER_REQUIRED" });
    const [turn] =
      await shared.admin`select status from session_turns where id = ${ownerTurn.turn.id}`;
    expect(turn).toMatchObject({ status: "running" });
    expect(
      await shared.admin`select id from session_system_updates
        where session_id = ${session.id} and kind = 'agent_steer_instruction'`,
    ).toHaveLength(0);
    expect(await pendingSteer(f, session.id, ownerTurn.turn.id)).toBe(false);
  }, 120_000);

  test("until the machine-owner lookup is granted, nothing waits and nothing claims it does", async () => {
    const f = await fixture();
    const session = await chatOnOwnersMachine(f);
    const lookup = "opengeni_private.session_machine_owner_subject_v1(uuid, uuid, uuid)";
    await shared.admin.unsafe(`REVOKE EXECUTE ON FUNCTION ${lookup} FROM opengeni_app`);
    try {
      await submitAs(f, session.id, f.owner, "Owner task");
      const ownerTurn = await claimTurn(f.workspaceId, session.id);
      const message = await submitAs(f, session.id, f.member, "Member: please check the logs");
      expect(message.waitsForMachineOwner).toBe(false);
      expect(await pendingSteer(f, session.id, ownerTurn.turn.id)).toBe(false);
      const access = await getSessionMachineAccess(client.db, {
        ...f,
        sessionId: session.id,
        subjectId: f.owner,
      });
      expect(access).not.toBeNull();
      expect(access).not.toHaveProperty("waitingMessages");
    } finally {
      await grantDeferredRuntimeAccess(shared.admin);
    }
  }, 120_000);
});
