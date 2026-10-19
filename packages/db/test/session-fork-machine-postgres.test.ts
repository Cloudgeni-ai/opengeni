import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  forkSessionContent,
  getSessionMachineAccess,
  readActiveSandbox,
  setActiveSandbox,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

// A fork runs where its source runs. A chat on a Connected Machine forks onto
// the same machine and working directory, when the forking person may attach
// that machine, so the fork's first message is admitted on it. Otherwise the
// fork keeps the default route and its machine card offers the normal choice.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("session-fork-machine");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
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
  const ownerUser = `fork-machine-owner-${crypto.randomUUID()}`;
  const memberUser = `fork-machine-member-${crypto.randomUUID()}`;
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
    values (${accountId}, ${workspaceId}, ${member}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`insert into session_tenancy_activations(account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"7".repeat(64)}, ${"8".repeat(64)}, 'fork-machine-test')`;
  await shared.admin`insert into organization_private_session_settings(account_id, enabled, version)
    values (${accountId}, true, 1) on conflict (account_id) do update set enabled = true`;
  const enroll = async (scope: "user" | "workspace", name: string) => {
    const [machine] = await app.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${workspaceId}, true),
        set_config('opengeni.subject_id', ${owner}, true)`;
      return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(${accountId}::uuid, ${workspaceId}::uuid, ${scope},
          ${`ed25519:fork-${crypto.randomUUID()}`}, true, false, 'macos', 'arm64', ${name}, false)`;
    });
    await shared.admin`update enrollments set connection_instance_id = 'connection-1',
      connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
      workspace_root = '/Users/alex' where id = ${machine!.enrollmentId}`;
    return machine!;
  };
  return {
    accountId,
    workspaceId,
    owner,
    member,
    personal: await enroll("user", "Alex's laptop"),
    team: await enroll("workspace", "Team build machine"),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** The owner's chat running on one machine, in a project directory on it. */
async function chatOnMachine(f: Fixture, sandboxId: string) {
  const session = await createSession(client.db, {
    accountId: f.accountId,
    workspaceId: f.workspaceId,
    visibility: "workspace_shared",
    initialMessage: "",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: f.owner },
    subjectId: f.owner,
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "selfhosted",
    sandboxOs: "macos",
  });
  expect(
    await setActiveSandbox(client.db, {
      accountId: f.accountId,
      workspaceId: f.workspaceId,
      sessionId: session.id,
      subjectId: f.owner,
      expectedEpoch: session.activeEpoch,
      targetSandboxId: sandboxId,
      workingDir: "/Users/alex/project",
    }),
  ).toMatchObject({ swapped: true });
  return session.id;
}

/** Appends one completed exchange so a message-boundary fork has a point to fork at. */
async function completedExchange(f: Fixture, sessionId: string) {
  const [next] = await shared.admin<Array<{ sequence: number; position: number }>>`
    select session_row.last_sequence + 1 as sequence,
      (select coalesce(max(turn_row.position), 0)::int + 1 from session_turns turn_row
        where turn_row.session_id = session_row.id) as position
    from sessions session_row where session_row.id = ${sessionId}`;
  if (!next) throw new Error(`session ${sessionId} is missing`);
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
    ) values (${turnId}, ${f.accountId}, ${f.workspaceId}, ${sessionId}, ${eventId},
      'fork-machine-test', 'completed', ${next.position}, 'Build it', 'test-model', 'medium',
      'selfhosted')`;
    await tx`insert into session_events (
      id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
    ) values (${eventId}, ${f.accountId}, ${f.workspaceId}, ${sessionId}, ${turnId},
      ${next.sequence}, 'user.message', '{"text":"Build it"}')`;
    await tx`update sessions set last_sequence = ${next.sequence} where id = ${sessionId}`;
    await tx`insert into session_history_items (
      account_id, workspace_id, session_id, turn_id, position, item
    ) values (${f.accountId}, ${f.workspaceId}, ${sessionId}, ${turnId}, ${next.position},
      ${tx.json({ type: "message", role: "user", content: "Build it" })})`;
  });
  return eventId;
}

function fork(
  f: Fixture,
  sourceSessionId: string,
  actorSubjectId: string,
  options: { sourceEventId?: string; operationKey?: string } = {},
) {
  return forkSessionContent(client.db, {
    sourceWorkspaceId: f.workspaceId,
    sourceSessionId,
    actorSubjectId,
    destinationWorkspaceId: f.workspaceId,
    destinationVisibility: "user_private",
    workspaceSharedAcknowledged: false,
    operationKey: options.operationKey ?? `fork-${crypto.randomUUID()}`,
    ...(options.sourceEventId ? { sourceEventId: options.sourceEventId } : {}),
  });
}

async function sendFirstMessage(f: Fixture, sessionId: string, subjectId: string) {
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
        text: "Carry on",
        resources: [],
        reasoningEffortFallback: "medium",
        source: "user",
      }),
    ),
  );
  return await claimSessionWorkForAttempt(client.db, f.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

/** The fork's first message is accepted and its turn is admitted. */
async function firstMessageIsAdmitted(f: Fixture, sessionId: string, subjectId: string) {
  expect((await sendFirstMessage(f, sessionId, subjectId)).action).toBe("claimed");
}

const onTheMachine = (sandboxId: string) => ({
  activeSandboxId: sandboxId,
  activeEpoch: 1,
  workingDir: "/Users/alex/project",
});

describe("a fork runs on its source's machine", () => {
  test("the owner's whole-session fork of a chat on a workspace machine runs there", async () => {
    const f = await fixture();
    const sourceId = await chatOnMachine(f, f.team.sandboxId);
    await completedExchange(f, sourceId);
    const forked = await fork(f, sourceId, f.owner);
    expect(await readActiveSandbox(client.db, f.workspaceId, forked.sessionId)).toEqual(
      onTheMachine(f.team.sandboxId),
    );
    const [row] = await shared.admin<Array<{ sandbox_backend: string; sandbox_os: string }>>`
      select sandbox_backend, sandbox_os from sessions where id = ${forked.sessionId}`;
    expect(row).toEqual({ sandbox_backend: "selfhosted", sandbox_os: "macos" });
    await firstMessageIsAdmitted(f, forked.sessionId, f.owner);

    // Replaying the same fork moves nothing again.
    const operationKey = `fork-${crypto.randomUUID()}`;
    const first = await fork(f, sourceId, f.owner, { operationKey });
    const replay = await fork(f, sourceId, f.owner, { operationKey });
    expect(replay).toMatchObject({ sessionId: first.sessionId, replay: true });
    expect(await readActiveSandbox(client.db, f.workspaceId, first.sessionId)).toEqual(
      onTheMachine(f.team.sandboxId),
    );
  }, 180_000);

  test("a message-boundary fork runs on the source's machine", async () => {
    const f = await fixture();
    const sourceId = await chatOnMachine(f, f.team.sandboxId);
    const firstEventId = await completedExchange(f, sourceId);
    await completedExchange(f, sourceId);
    const forked = await fork(f, sourceId, f.owner, { sourceEventId: firstEventId });
    expect(forked.copiedHistoryItemCount).toBe(1);
    expect(await readActiveSandbox(client.db, f.workspaceId, forked.sessionId)).toEqual(
      onTheMachine(f.team.sandboxId),
    );
    await firstMessageIsAdmitted(f, forked.sessionId, f.owner);
  }, 180_000);

  test("the owner's fork of a chat on their personal machine stays on it under the same consent rule", async () => {
    const f = await fixture();
    const sourceId = await chatOnMachine(f, f.personal.sandboxId);
    const firstEventId = await completedExchange(f, sourceId);
    for (const sourceEventId of [undefined, firstEventId]) {
      const forked = await fork(f, sourceId, f.owner, sourceEventId ? { sourceEventId } : {});
      expect(await readActiveSandbox(client.db, f.workspaceId, forked.sessionId)).toEqual(
        onTheMachine(f.personal.sandboxId),
      );
      // A personal machine still needs its owner's approval for each chat, so
      // the fork's machine card offers the owner that ordinary approval.
      expect(
        await getSessionMachineAccess(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: forked.sessionId,
          subjectId: f.owner,
        }),
      ).toMatchObject({
        sandboxId: f.personal.sandboxId,
        machineName: "Alex's laptop",
        isOwner: true,
      });
      await expect(sendFirstMessage(f, forked.sessionId, f.owner)).rejects.toThrow();
    }
    // Exactly as the source itself behaves without that approval.
    await expect(sendFirstMessage(f, sourceId, f.owner)).rejects.toThrow();
  }, 180_000);

  test("another member's fork keeps a machine they may use and never borrows a personal one", async () => {
    const f = await fixture();
    const onTeam = await chatOnMachine(f, f.team.sandboxId);
    const teamFork = await fork(f, onTeam, f.member);
    expect(await readActiveSandbox(client.db, f.workspaceId, teamFork.sessionId)).toEqual(
      onTheMachine(f.team.sandboxId),
    );
    await firstMessageIsAdmitted(f, teamFork.sessionId, f.member);

    const onLaptop = await chatOnMachine(f, f.personal.sandboxId);
    const laptopFork = await fork(f, onLaptop, f.member);
    expect(await readActiveSandbox(client.db, f.workspaceId, laptopFork.sessionId)).toEqual({
      activeSandboxId: null,
      activeEpoch: 0,
      workingDir: null,
    });
  }, 180_000);
});
