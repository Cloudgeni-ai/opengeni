import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  getSandbox,
  getSandboxForAttempt,
  getSessionMachineAccess,
  transitionSessionVisibility,
  initializeSessionStartAtomically,
  isSessionEventPersistenceError,
  issueSelfUserResourceGrant,
  recoverSessionDispatch,
  resolvePersonalMachineConnectionForAttempt,
  resolvePersonalMachineRouteForAttempt,
  revokeSelfUserResourceGrant,
  setActiveSandbox,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
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

  test("a member cannot inherit the chat owner's personal machine without consent", async () => {
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
    await withWorkspaceSubjectSessionActivityRls(client.db, f.workspaceId, f.member, (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: session.id,
          subjectId: f.member,
          actor: { type: "human", subjectId: f.member },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Member follow-up",
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
      ),
    );
    let rejected: unknown;
    try {
      await claim(f.workspaceId, session.id);
    } catch (error) {
      rejected = error;
    }
    expect(isSessionEventPersistenceError(rejected)).toBe(true);
    if (!isSessionEventPersistenceError(rejected)) throw new Error("expected claim rejection");
    expect(rejected.details).toMatchObject({ stage: "session_attempts.claim", sqlState: "42501" });
    const queryError = rejected.cause as {
      query: string;
      cause: { message: string; where: string };
    };
    expect(queryError.query).toStartWith('insert into "session_turn_attempts"');
    expect(queryError.cause.message).toBe("only the personal machine owner may attach it");
    expect(queryError.cause.where).toContain("admit_session_attempt_personal_machine()");
    expect(
      await shared.admin`select id from session_turn_attempts where session_id = ${session.id}`,
    ).toHaveLength(0);
    const [queued] =
      await shared.admin`select id, status, initiating_human_subject_id from session_turns where session_id = ${session.id}`;
    expect(queued).toMatchObject({ status: "queued", initiating_human_subject_id: f.member });
    for (const subjectId of [f.owner, f.member]) {
      expect(
        await getSessionMachineAccess(client.db, { ...f, sessionId: session.id, subjectId }),
      ).toMatchObject({ queuedTurnBlocked: true, isOwner: subjectId === f.owner });
    }

    // Changing to a workspace machine fixes the actual permission problem;
    // replaying the claim alone must never borrow the previous owner's identity.
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
