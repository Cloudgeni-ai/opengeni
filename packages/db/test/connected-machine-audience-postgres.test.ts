import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  changeMachineAudience,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationInvitation,
  createScheduledTask,
  createSession,
  ensureManagedAccessForUser,
  getLiveEnrollmentConnection,
  initializeSessionStartAtomically,
  previewMachineAudienceChange,
  resolvePersonalMachineConnectionForAttempt,
  setActiveSandbox,
  settleSessionAttemptInterruptions,
  type DbClient,
  type MachineAudienceItem,
  type MachineAudiencePreviewRecord,
} from "../src/index";

// Who can use a Connected Machine (Workspace or Only me) changes in place: the
// same enrollment, sandbox, credentials and live connection stay, so chats,
// schedules and the installed agent are never re-registered. These tests run
// the real migrated schema under the FORCE-RLS app role.
let shared: SharedTestDatabase;
let client: DbClient;
let app: postgres.Sql;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("connected-machine-audience");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4 });
  app = postgres(shared.appUrl, { max: 2, prepare: false, onnotice: () => undefined });
}, 180_000);

afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function organization() {
  const ownerUserId = `audience-owner-${crypto.randomUUID()}`;
  const memberUserId = `audience-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUserId}`;
  const member = `user:${memberUserId}`;
  const ownerAccess = await ensureManagedAccessForUser(client.db, {
    userId: ownerUserId,
    email: `${ownerUserId}@example.test`,
    name: "Machine owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUserId,
    email: `${memberUserId}@example.test`,
    name: "Workspace member",
  });
  const grant = ownerAccess.workspaceGrants.find(
    (candidate) => candidate.workspaceId === ownerAccess.defaultWorkspaceId,
  );
  if (!grant) throw new Error("owner has no shared workspace grant");
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUserId}@example.test`,
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
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member',
      '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'machine-audience-test')`;
  await shared.admin`
    insert into organization_private_session_settings (
      account_id, enabled, version, updated_by_membership_id
    ) values (${accountId}, true, 1, null)
    on conflict (account_id) do update set enabled = true`;
  return { accountId, workspaceId, owner, member };
}

type Org = Awaited<ReturnType<typeof organization>>;

async function asActor<T>(
  org: Org,
  subjectId: string,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await app.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${org.accountId}, true),
      set_config('opengeni.workspace_id', ${org.workspaceId}, true),
      set_config('opengeni.subject_id', ${subjectId}, true)`;
    return await callback(tx);
  })) as T;
}

/** A connected Workspace machine with a live agent connection. */
async function workspaceMachine(org: Org, pubkey = `ed25519:audience-${crypto.randomUUID()}`) {
  const machine = await asActor(org, org.owner, async (tx) => {
    const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(
        ${org.accountId}::uuid, ${org.workspaceId}::uuid, 'workspace', ${pubkey},
        true, false, 'linux', 'x86_64', 'Build box', false
      )`;
    return row!;
  });
  await shared.admin`
    update enrollments set connection_instance_id = 'connection-1',
      connection_generation = 3,
      connection_lease_expires_at = now() + interval '1 hour',
      workspace_root = '/srv/build'
    where id = ${machine.enrollmentId}`;
  return { ...machine, pubkey };
}

async function machineRow(enrollmentId: string) {
  const [row] = await shared.admin<
    Array<{
      scope: string;
      generation: number;
      credentialGeneration: number;
      connectionInstanceId: string | null;
      connectionGeneration: number;
      ownerMembershipId: string | null;
      status: string;
    }>
  >`
    select authority_scope as scope, generation::int as generation,
      credential_generation as "credentialGeneration",
      connection_instance_id as "connectionInstanceId",
      connection_generation as "connectionGeneration",
      owner_organization_membership_id as "ownerMembershipId", status
    from enrollments where id = ${enrollmentId}`;
  return row!;
}

async function sandboxIdsFor(enrollmentId: string) {
  const rows = await shared.admin<Array<{ id: string }>>`
    select id::text as id from sandboxes where enrollment_id = ${enrollmentId} order by id`;
  return rows.map((row) => row.id);
}

/** A started chat attached to the machine. */
async function chatOnMachine(
  org: Org,
  machine: { sandboxId: string },
  subjectId: string,
  visibility: "user_private" | "workspace_shared",
  title: string,
) {
  const session = await createSession(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    initialMessage: title,
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId },
    subjectId,
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    visibility,
  } as never);
  await initializeSessionStartAtomically(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
  } as never);
  const routed = await setActiveSandbox(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    sessionId: session.id,
    targetSandboxId: machine.sandboxId,
    expectedEpoch: session.activeEpoch,
  });
  expect(routed.swapped).toBe(true);
  await shared.admin`
    update sessions set title = ${title}, title_source = 'user' where id = ${session.id}`;
  return session;
}

/** Claim the chat's queued turn: a running attempt like a live worker's. */
async function runTurn(org: Org, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, org.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`turn was not claimed: ${claimed.reason}`);
  return {
    turnId: claimed.turn.id,
    attemptId,
    executionGeneration: claimed.turn.executionGeneration,
  };
}

async function scheduleOnMachine(
  org: Org,
  machine: { sandboxId: string },
  subjectId: string,
  visibility: "user_private" | "workspace_shared",
  name: string,
) {
  return await createScheduledTask(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    name,
    status: "active",
    visibility,
    schedule: { type: "manual" },
    temporalScheduleId: `audience-${crypto.randomUUID()}`,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    agentConfig: {
      prompt: "Run the nightly build",
      resources: [],
      tools: [],
      metadata: {},
      sandboxBackend: "selfhosted",
      machineTarget: { targetSandboxId: machine.sandboxId },
    },
    metadata: {},
    createdBy: { kind: "subject", subjectId },
  } as never);
}

function preview(
  org: Org,
  machine: { enrollmentId: string },
  input: {
    subjectId?: string;
    target: "only_me" | "workspace";
    ownerSubjectId?: string | null;
    schedulesMayBeOnlyMe?: boolean;
  },
) {
  return previewMachineAudienceChange(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    subjectId: input.subjectId ?? org.owner,
    enrollmentId: machine.enrollmentId,
    target: input.target,
    ownerSubjectId:
      input.ownerSubjectId === undefined
        ? input.target === "only_me"
          ? org.owner
          : null
        : input.ownerSubjectId,
    schedulesMayBeOnlyMe: input.schedulesMayBeOnlyMe ?? true,
  });
}

function change(
  org: Org,
  machine: { enrollmentId: string },
  input: Parameters<typeof preview>[2] & { expectedGeneration: number },
) {
  return changeMachineAudience(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    subjectId: input.subjectId ?? org.owner,
    enrollmentId: machine.enrollmentId,
    target: input.target,
    ownerSubjectId:
      input.ownerSubjectId === undefined
        ? input.target === "only_me"
          ? org.owner
          : null
        : input.ownerSubjectId,
    schedulesMayBeOnlyMe: input.schedulesMayBeOnlyMe ?? true,
    expectedGeneration: input.expectedGeneration,
  });
}

function previewOf(value: Awaited<ReturnType<typeof preview>>): MachineAudiencePreviewRecord {
  if (typeof value === "string") throw new Error(`preview refused: ${value}`);
  return value;
}

function itemFor(items: MachineAudienceItem[], id: string) {
  return items.find((item) => item.sessionId === id || item.scheduledTaskId === id);
}

async function attachedSandbox(sessionId: string) {
  const [row] = await shared.admin<Array<{ activeSandboxId: string | null }>>`
    select active_sandbox_id::text as "activeSandboxId" from sessions where id = ${sessionId}`;
  return row?.activeSandboxId ?? null;
}

function resolveForOwner(
  org: Org,
  machine: { enrollmentId: string },
  sessionId: string,
  turn: Awaited<ReturnType<typeof runTurn>>,
) {
  return resolvePersonalMachineConnectionForAttempt(client.db, {
    accountId: org.accountId,
    workspaceId: org.workspaceId,
    subjectId: org.owner,
    sessionId,
    turnId: turn.turnId,
    attemptId: turn.attemptId,
    executionGeneration: turn.executionGeneration,
    enrollmentId: machine.enrollmentId,
    requireActiveSandbox: true,
  });
}

/** An agent command still running on the machine in this chat. */
async function runningCommand(org: Org, machine: { enrollmentId: string }, sessionId: string) {
  const opId = `op-${crypto.randomUUID()}`;
  await shared.admin`
    insert into session_background_commands (
      account_id, workspace_id, session_id, provider, control_workspace_id, enrollment_id,
      connection_instance_id, op_id, state, command_preview, command_text
    ) values (
      ${org.accountId}, ${org.workspaceId}, ${sessionId}, 'connected_machine',
      ${org.workspaceId}, ${machine.enrollmentId}, 'connection-1', ${opId}, 'running',
      'make all', 'make all'
    )`;
  return opId;
}

async function commandState(opId: string) {
  const [row] = await shared.admin<Array<{ state: string }>>`
    select state from session_background_commands where op_id = ${opId}`;
  return row?.state;
}

async function scheduleRow(id: string) {
  const [row] = await shared.admin<Array<{ status: string; visibility: string }>>`
    select status, visibility from scheduled_tasks where id = ${id}`;
  return row;
}

async function turnRow(turnId: string) {
  const [row] = await shared.admin<
    Array<{ status: string; activeAttemptId: string | null; cancelReason: string | null }>
  >`
    select status, active_attempt_id::text as "activeAttemptId",
      cancel_reason as "cancelReason"
    from session_turns where id = ${turnId}`;
  return row;
}

describe("changing who can use a Connected Machine in place", () => {
  test("one confirmation narrows to Only me and applies every default", async () => {
    const org = await organization();
    const machine = await workspaceMachine(org);
    // The owner's own work.
    const ownerPrivate = await chatOnMachine(org, machine, org.owner, "user_private", "My notes");
    const ownerTurn = await runTurn(org, ownerPrivate.id);
    const ownerCommand = await runningCommand(org, machine, ownerPrivate.id);
    const ownerShared = await chatOnMachine(
      org,
      machine,
      org.owner,
      "workspace_shared",
      "Release prep",
    );
    // A turn another member started in the owner's shared chat.
    const ownerSharedBusy = await chatOnMachine(
      org,
      machine,
      org.owner,
      "workspace_shared",
      "Shared triage",
    );
    // Fixture shortcut: the queued turn becomes one the member started (a
    // trigger otherwise keeps a turn's initiator fixed once accepted).
    await shared.admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`
        update session_turns set initiating_human_subject_id = ${org.member}
        where session_id = ${ownerSharedBusy.id}`;
    });
    const memberTurnInOwnerChat = await runTurn(org, ownerSharedBusy.id);
    // Another member's work.
    const memberShared = await chatOnMachine(
      org,
      machine,
      org.member,
      "workspace_shared",
      "Team build",
    );
    const memberTurn = await runTurn(org, memberShared.id);
    const memberCommand = await runningCommand(org, machine, memberShared.id);
    const memberPrivate = await chatOnMachine(
      org,
      machine,
      org.member,
      "user_private",
      "Member diary",
    );
    const ownerWorkspaceSchedule = await scheduleOnMachine(
      org,
      machine,
      org.owner,
      "workspace_shared",
      "Nightly build",
    );
    const ownerOnlyMeSchedule = await scheduleOnMachine(
      org,
      machine,
      org.owner,
      "user_private",
      "My cleanup",
    );
    const memberSchedule = await scheduleOnMachine(
      org,
      machine,
      org.member,
      "workspace_shared",
      "Member checks",
    );
    const before = await machineRow(machine.enrollmentId);

    const listed = previewOf(await preview(org, machine, { target: "only_me" }));
    expect(listed).toMatchObject({
      enrollmentId: machine.enrollmentId,
      sandboxId: machine.sandboxId,
      currentAudience: "workspace",
      targetAudience: "only_me",
      ownerSubjectId: org.owner,
      generation: before.generation,
      ready: true,
      summary: {
        keptChats: 1,
        keptSharedChats: 2,
        movedOffChats: 2,
        schedulesMadeOnlyMe: 1,
        schedulesPaused: 1,
        stoppedTurns: 2,
        stoppedCommands: 1,
        notifiedPeople: 1,
      },
    });
    // The owner's own Only me chat and schedule need nothing, so they are
    // counted, not listed.
    expect(itemFor(listed.items, ownerPrivate.id)).toBeUndefined();
    expect(itemFor(listed.items, ownerOnlyMeSchedule.id)).toBeUndefined();
    expect(itemFor(listed.items, ownerShared.id)).toMatchObject({
      action: "keep",
      relation: "owner_shared",
      stopsTurn: false,
    });
    expect(itemFor(listed.items, ownerSharedBusy.id)).toMatchObject({
      action: "keep",
      relation: "owner_shared",
      stopsTurn: true,
    });
    expect(itemFor(listed.items, memberShared.id)).toMatchObject({
      action: "move_off",
      relation: "other_member",
      title: "Team build",
      stopsTurn: true,
      stopsCommands: 1,
    });
    // Another member's private chat is listed without its title or owner.
    expect(itemFor(listed.items, memberPrivate.id)).toMatchObject({
      action: "move_off",
      title: null,
      ownerSubjectId: null,
      stopsTurn: false,
    });
    expect(itemFor(listed.items, ownerWorkspaceSchedule.id)).toMatchObject({
      kind: "schedule",
      action: "make_only_me",
      name: "Nightly build",
    });
    expect(itemFor(listed.items, memberSchedule.id)).toMatchObject({
      action: "pause",
      relation: "other_member",
    });
    // Previewing changes nothing.
    expect(await machineRow(machine.enrollmentId)).toEqual(before);
    expect(await attachedSandbox(memberShared.id)).toBe(machine.sandboxId);

    // A stale generation is refused without writing.
    expect(
      await change(org, machine, {
        target: "only_me",
        expectedGeneration: before.generation - 1,
      }),
    ).toEqual({ outcome: "stale", generation: before.generation });
    expect(await turnRow(memberTurn.turnId)).toMatchObject({ status: "running" });

    // One confirmation does all of it.
    const changed = await change(org, machine, {
      target: "only_me",
      expectedGeneration: before.generation,
    });
    expect(changed).toMatchObject({
      outcome: "changed",
      enrollmentId: machine.enrollmentId,
      sandboxId: machine.sandboxId,
      previousAudience: "workspace",
      audience: "only_me",
      ownerSubjectId: org.owner,
      generation: before.generation + 1,
      summary: listed.summary,
      reauthorizedAttemptIds: [ownerTurn.attemptId],
      pausedScheduleIds: [memberSchedule.id],
      onlyMeScheduleIds: [ownerWorkspaceSchedule.id],
    });
    if (changed.outcome !== "changed") throw new Error("unreachable");
    expect(new Set(changed.detachedSessionIds)).toEqual(
      new Set([memberShared.id, memberPrivate.id]),
    );
    expect(new Set(changed.keptSessionIds)).toEqual(
      new Set([ownerPrivate.id, ownerShared.id, ownerSharedBusy.id]),
    );
    expect(new Set(changed.stoppedAttemptIds)).toEqual(
      new Set([memberTurn.attemptId, memberTurnInOwnerChat.attemptId]),
    );

    // Same machine, same sandbox, same credentials and live connection.
    const after = await machineRow(machine.enrollmentId);
    expect(after).toMatchObject({
      scope: "user",
      status: "active",
      generation: before.generation + 1,
      credentialGeneration: before.credentialGeneration,
      connectionInstanceId: before.connectionInstanceId,
      connectionGeneration: before.connectionGeneration,
    });
    expect(await sandboxIdsFor(machine.enrollmentId)).toEqual([machine.sandboxId]);

    // Chats: the owner's stay (shared ones stay shared); the others move off.
    expect(await attachedSandbox(ownerPrivate.id)).toBe(machine.sandboxId);
    expect(await attachedSandbox(ownerShared.id)).toBe(machine.sandboxId);
    expect(await attachedSandbox(ownerSharedBusy.id)).toBe(machine.sandboxId);
    expect(await attachedSandbox(memberShared.id)).toBeNull();
    expect(await attachedSandbox(memberPrivate.id)).toBeNull();
    const visibilities = await shared.admin<Array<{ id: string; visibility: string }>>`
      select id::text as id, visibility from sessions
      where id in (${ownerShared.id}, ${ownerSharedBusy.id})`;
    expect(visibilities.map((row) => row.visibility)).toEqual([
      "workspace_shared",
      "workspace_shared",
    ]);
    const grants = await shared.admin<Array<{ sessionId: string; context: string }>>`
      select session_id::text as "sessionId", context
      from organization_user_resource_grants
      where account_id = ${org.accountId} and action = 'connected_machine.use'
        and status = 'active' and mode = 'session'`;
    expect(new Map(grants.map((row) => [row.sessionId, row.context]))).toEqual(
      new Map([
        [ownerPrivate.id, "user_private"],
        [ownerShared.id, "workspace_shared"],
        [ownerSharedBusy.id, "workspace_shared"],
      ]),
    );

    // Other people's running turns stop for good, through the same
    // interruption a revoked membership uses; their workflows are woken.
    const interruptions = await shared.admin<Array<{ attemptId: string; kind: string }>>`
      select attempt_id::text as "attemptId", kind from session_attempt_interruptions
      where account_id = ${org.accountId}`;
    expect(new Set(interruptions.map((row) => row.attemptId))).toEqual(
      new Set([memberTurn.attemptId, memberTurnInOwnerChat.attemptId]),
    );
    expect(new Set(interruptions.map((row) => row.kind))).toEqual(new Set(["authority_change"]));
    const wakes = await shared.admin<Array<{ sessionId: string }>>`
      select session_id::text as "sessionId" from session_workflow_wake_outbox
      where reason = 'connected_machine_audience_changed' and account_id = ${org.accountId}`;
    expect(new Set(wakes.map((row) => row.sessionId))).toEqual(
      new Set([memberShared.id, ownerSharedBusy.id]),
    );
    const settled = await settleSessionAttemptInterruptions(
      client.db,
      org.workspaceId,
      memberShared.id,
      memberTurn.attemptId,
    );
    expect(settled.outcome).toBe("cancelled");
    expect(await turnRow(memberTurn.turnId)).toMatchObject({
      status: "cancelled",
      cancelReason: "authority_changed",
    });
    expect(await commandState(memberCommand)).toBe("stopping");

    // The owner's running operation is untouched and still reaches the machine.
    expect(await turnRow(ownerTurn.turnId)).toEqual({
      status: "running",
      activeAttemptId: ownerTurn.attemptId,
      cancelReason: null,
    });
    expect(await commandState(ownerCommand)).toBe("running");
    expect(await resolveForOwner(org, machine, ownerPrivate.id, ownerTurn)).toMatchObject({
      id: machine.enrollmentId,
      scope: "user",
      connectionInstanceId: "connection-1",
    });

    // Schedules: the owner's becomes Only me, the member's pauses and its
    // Temporal schedule is queued to follow.
    expect(await scheduleRow(ownerWorkspaceSchedule.id)).toEqual({
      status: "active",
      visibility: "user_private",
    });
    expect(await scheduleRow(ownerOnlyMeSchedule.id)).toEqual({
      status: "active",
      visibility: "user_private",
    });
    expect(await scheduleRow(memberSchedule.id)).toEqual({
      status: "paused",
      visibility: "workspace_shared",
    });
    const [outbox] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from scheduled_task_schedule_outbox
      where task_id = ${memberSchedule.id}`;
    expect(outbox?.count).toBe(1);

    // One inbox notice for the member, none for the person who switched it.
    const notices = await shared.admin<
      Array<{ recipient: string; title: string; body: string; sessionId: string }>
    >`
      select recipient_subject_id as recipient, title, body, session_id::text as "sessionId"
      from opengeni_private.inbox_items
      where account_id = ${org.accountId} and kind = 'notification'
        and source_key like 'connected-machine-audience:%'`;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      recipient: org.member,
      title: "Build box is no longer shared",
    });
    expect(notices[0]!.body).toContain("Moved off it: 2 chats.");
    expect(notices[0]!.body).toContain("Paused: 1 schedule.");
    expect(notices[0]!.body).toContain("Stopped: 2 running turns.");
    expect(notices[0]!.body).toContain("Nothing moves back on its own");

    // The member no longer sees the machine; the owner still does.
    const visible = async (subjectId: string) =>
      await asActor(org, subjectId, async (tx) => {
        const rows = await tx<Array<{ id: string }>>`
          select value->>'id' as id from list_scoped_enrollments(
            ${org.accountId}::uuid, ${org.workspaceId}::uuid, null, 'active'
          ) value`;
        return rows.map((row) => row.id);
      });
    expect(await visible(org.member)).not.toContain(machine.enrollmentId);
    expect(await visible(org.owner)).toContain(machine.enrollmentId);
    const [audit] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from audit_events
      where target_id = ${machine.enrollmentId}
        and action = 'connected_machine.audience_changed'`;
    expect(audit?.count).toBe(1);
  }, 120_000);

  test("the owner's Workspace schedules pause when they can't have Only me schedules", async () => {
    const org = await organization();
    const machine = await workspaceMachine(org);
    const schedule = await scheduleOnMachine(
      org,
      machine,
      org.owner,
      "workspace_shared",
      "Nightly build",
    );
    const listed = previewOf(
      await preview(org, machine, { target: "only_me", schedulesMayBeOnlyMe: false }),
    );
    expect(itemFor(listed.items, schedule.id)).toMatchObject({ action: "pause" });
    expect(listed.summary).toMatchObject({ schedulesMadeOnlyMe: 0, schedulesPaused: 1 });
    const changed = await change(org, machine, {
      target: "only_me",
      schedulesMayBeOnlyMe: false,
      expectedGeneration: listed.generation,
    });
    expect(changed).toMatchObject({ outcome: "changed", pausedScheduleIds: [schedule.id] });
    expect(await scheduleRow(schedule.id)).toEqual({
      status: "paused",
      visibility: "workspace_shared",
    });
    // The person making the change gets no notice about their own schedule.
    const [notices] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from opengeni_private.inbox_items
      where account_id = ${org.accountId} and source_key like 'connected-machine-audience:%'`;
    expect(notices?.count).toBe(0);
  }, 120_000);

  test("an admin narrows the machine for another member", async () => {
    const org = await organization();
    const machine = await workspaceMachine(org);
    const ownerChat = await chatOnMachine(org, machine, org.owner, "user_private", "Admin notes");
    const memberChat = await chatOnMachine(org, machine, org.member, "user_private", "Mine");
    const listed = previewOf(
      await preview(org, machine, { target: "only_me", ownerSubjectId: org.member }),
    );
    expect(listed).toMatchObject({
      ownerSubjectId: org.member,
      summary: { keptChats: 1, movedOffChats: 1, notifiedPeople: 0 },
    });
    const changed = await change(org, machine, {
      target: "only_me",
      ownerSubjectId: org.member,
      expectedGeneration: listed.generation,
    });
    expect(changed).toMatchObject({
      outcome: "changed",
      ownerSubjectId: org.member,
      detachedSessionIds: [ownerChat.id],
      keptSessionIds: [memberChat.id],
    });
    expect(await attachedSandbox(memberChat.id)).toBe(machine.sandboxId);
  }, 120_000);

  test("running work survives Workspace to Only me to Workspace to Only me", async () => {
    const org = await organization();
    const machine = await workspaceMachine(org);
    const chat = await chatOnMachine(org, machine, org.owner, "user_private", "Long build");
    const turn = await runTurn(org, chat.id);
    const command = await runningCommand(org, machine, chat.id);
    const original = await machineRow(machine.enrollmentId);
    expect(original.scope).toBe("workspace");

    // Workspace -> Only me. The running attempt was admitted on a Workspace
    // machine, so it had no personal authorization; the switch gives it one.
    const narrowed = await change(org, machine, {
      target: "only_me",
      expectedGeneration: original.generation,
    });
    expect(narrowed).toMatchObject({
      outcome: "changed",
      reauthorizedAttemptIds: [turn.attemptId],
      stoppedAttemptIds: [],
    });
    expect(await resolveForOwner(org, machine, chat.id, turn)).toMatchObject({
      id: machine.enrollmentId,
      scope: "user",
      connectionInstanceId: "connection-1",
    });
    expect(await commandState(command)).toBe("running");

    // Only me -> Workspace (the owner shares it back). The same attempt now
    // reaches the machine through the workspace route; the personal route is
    // closed because the machine is no longer personal.
    const widened = await change(org, machine, {
      target: "workspace",
      expectedGeneration: original.generation + 1,
    });
    expect(widened).toMatchObject({
      outcome: "changed",
      previousAudience: "only_me",
      audience: "workspace",
      generation: original.generation + 2,
      stoppedAttemptIds: [],
    });
    expect(
      await getLiveEnrollmentConnection(client.db, org.workspaceId, machine.enrollmentId),
    ).toMatchObject({ id: machine.enrollmentId, scope: "workspace" });
    await expect(resolveForOwner(org, machine, chat.id, turn)).rejects.toThrow();
    const revoked = await shared.admin<Array<{ status: string }>>`
      select status from organization_user_resource_grants
      where account_id = ${org.accountId} and session_id = ${chat.id}`;
    expect(revoked.map((row) => row.status)).toEqual(["revoked"]);

    // Workspace -> Only me again: the attempt's earlier authorization row is
    // refreshed to the new authority instead of staying stale.
    const again = await change(org, machine, {
      target: "only_me",
      expectedGeneration: original.generation + 2,
    });
    expect(again).toMatchObject({ outcome: "changed", generation: original.generation + 3 });
    expect(await resolveForOwner(org, machine, chat.id, turn)).toMatchObject({
      id: machine.enrollmentId,
      connectionInstanceId: "connection-1",
    });

    const final = await machineRow(machine.enrollmentId);
    expect(final).toMatchObject({
      credentialGeneration: original.credentialGeneration,
      connectionInstanceId: original.connectionInstanceId,
      connectionGeneration: original.connectionGeneration,
    });
    expect(await sandboxIdsFor(machine.enrollmentId)).toEqual([machine.sandboxId]);
    expect(await attachedSandbox(chat.id)).toBe(machine.sandboxId);
    expect(await commandState(command)).toBe("running");
    expect(await turnRow(turn.turnId)).toEqual({
      status: "running",
      activeAttemptId: turn.attemptId,
      cancelReason: null,
    });
    const [interruptions] = await shared.admin<Array<{ count: number }>>`
      select count(*)::int as count from session_attempt_interruptions
      where attempt_id = ${turn.attemptId}`;
    expect(interruptions?.count).toBe(0);
  }, 120_000);

  test("the same computer connected a second time blocks; a removed record is retired", async () => {
    const org = await organization();
    const machine = await workspaceMachine(org);
    const twin = await asActor(org, org.owner, async (tx) => {
      const [row] = await tx<Array<{ enrollmentId: string }>>`
        select enrollment_id as "enrollmentId" from finalize_scoped_enrollment(
          ${org.accountId}::uuid, ${org.workspaceId}::uuid, 'user', ${machine.pubkey},
          true, false, 'linux', 'x86_64', 'Build box (personal)', false
        )`;
      return row!;
    });
    const blocked = previewOf(await preview(org, machine, { target: "only_me" }));
    expect(blocked.ready).toBe(false);
    expect(blocked.items).toEqual([
      { kind: "duplicate_connection", enrollmentId: twin.enrollmentId, action: "remove_first" },
    ]);
    const before = await machineRow(machine.enrollmentId);
    const refused = await change(org, machine, {
      target: "only_me",
      expectedGeneration: before.generation,
    });
    expect(refused.outcome).toBe("blocked");
    expect(await machineRow(machine.enrollmentId)).toEqual(before);

    // Once that copy is removed, its record is retired by the switch.
    await shared.admin`
      update enrollments set status = 'revoked', revoked_at = now(), generation = generation + 1
      where id = ${twin.enrollmentId}`;
    const listed = previewOf(await preview(org, machine, { target: "only_me" }));
    expect(listed).toMatchObject({ ready: true, retiredRecordCount: 1, items: [] });
    const changed = await change(org, machine, {
      target: "only_me",
      expectedGeneration: listed.generation,
    });
    expect(changed).toMatchObject({
      outcome: "changed",
      retiredEnrollmentIds: [twin.enrollmentId],
    });
    // Reconnecting as Only me now finds this machine, not a new record.
    const reconnected = await asActor(org, org.owner, async (tx) => {
      const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${org.accountId}::uuid, ${org.workspaceId}::uuid, 'user', ${machine.pubkey},
          true, false, 'linux', 'x86_64', 'Build box', false
        )`;
      return row!;
    });
    expect(reconnected).toEqual({
      enrollmentId: machine.enrollmentId,
      sandboxId: machine.sandboxId,
    });
  }, 120_000);

  test("only the owner shares an Only me machine; chats elsewhere move off", async () => {
    const org = await organization();
    const machine = await workspaceMachine(org);
    const narrowed = await change(org, machine, { target: "only_me", expectedGeneration: 1 });
    expect(narrowed.outcome).toBe("changed");
    // The owner's chat in the owner's personal workspace uses the machine.
    const [personal] = await shared.admin<Array<{ workspaceId: string }>>`
      select personal_workspace_id::text as "workspaceId" from organization_memberships
      where account_id = ${org.accountId} and subject_id = ${org.owner}`;
    const elsewhere = await createSession(client.db, {
      accountId: org.accountId,
      workspaceId: personal!.workspaceId,
      initialMessage: "Personal workspace chat",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: org.owner },
      subjectId: org.owner,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    } as never);
    await shared.admin`
      update sessions set active_sandbox_id = ${machine.sandboxId} where id = ${elsewhere.id}`;

    expect(await preview(org, machine, { subjectId: org.member, target: "workspace" })).toBe(
      "not_machine_owner",
    );
    const listed = previewOf(await preview(org, machine, { target: "workspace" }));
    expect(listed).toMatchObject({
      currentAudience: "only_me",
      ready: true,
      summary: { movedOffChats: 1, notifiedPeople: 0 },
    });
    expect(itemFor(listed.items, elsewhere.id)).toMatchObject({
      relation: "other_workspace",
      action: "move_off",
    });
    const widened = await change(org, machine, {
      target: "workspace",
      expectedGeneration: listed.generation,
    });
    expect(widened).toMatchObject({
      outcome: "changed",
      audience: "workspace",
      detachedSessionIds: [elsewhere.id],
    });
    expect(await attachedSandbox(elsewhere.id)).toBeNull();
    expect(await machineRow(machine.enrollmentId)).toMatchObject({
      scope: "workspace",
      ownerMembershipId: null,
    });
    expect(await preview(org, machine, { target: "workspace" })).toBe("already_target");
  }, 120_000);
});
