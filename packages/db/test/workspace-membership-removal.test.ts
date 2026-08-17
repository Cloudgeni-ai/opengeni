// Workspace-membership removal is the fenced SECURITY DEFINER teardown from
// migration 0278: the removed member's queued/live work in that workspace is
// cancelled and fenced, their private sessions' authority epochs advance, and
// the guards (self-removal, last admin, actor administration) fail closed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  grantWorkspaceAccess,
  listSelfOrganizationMemberships,
  removeWorkspaceMember,
  transitionSessionVisibility,
  type Database,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-membership-removal");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 4 });
  db = client.db;
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('workspace-membership-removal') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'membership-removal-workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function grantAdmin(workspace: Workspace): Promise<string> {
  const subjectId = `user:admin-${crypto.randomUUID()}`;
  await grantWorkspaceAccess(db, {
    ...workspace,
    subjectId,
    permissions: ["workspace:admin"],
  });
  return subjectId;
}

/** An active organization admin who is not a workspace member. */
async function grantOrgAdmin(workspace: Workspace): Promise<string> {
  const subjectId = `user:org-admin-${crypto.randomUUID()}`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${workspace.accountId}, ${`personal-${subjectId}`}) returning id`;
  await admin`
    insert into organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id, authorization_revision
    ) values (${workspace.accountId}, ${subjectId}, 'admin', 'active', ${personal!.id}, 1)`;
  return subjectId;
}

async function grantOrdinaryMember(workspace: Workspace, subjectId: string): Promise<void> {
  await grantWorkspaceAccess(db, {
    ...workspace,
    subjectId,
    permissions: ["sessions:read", "sessions:create"],
  });
}

async function insertQueuedTurn(
  workspace: Workspace,
  sessionId: string,
  initiatingHuman: string,
): Promise<string> {
  const turnId = crypto.randomUUID();
  await admin`
    insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id,
      temporal_workflow_id, status, execution_generation, position, prompt,
      model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
      initiator_subject_id, initiating_human_subject_id
    ) values (
      ${turnId}, ${workspace.accountId}, ${workspace.workspaceId}, ${sessionId},
      ${crypto.randomUUID()}, ${`removal-${crypto.randomUUID()}`},
      'queued', 1, 1, 'member work', 'test-model', 'medium', 'standard',
      'none', 'subject', ${initiatingHuman}, ${initiatingHuman}
    )`;
  return turnId;
}

function postgresCode(error: unknown): string | null {
  const seen = new Set<object>();
  let candidate: unknown = error;
  while (typeof candidate === "object" && candidate !== null && !seen.has(candidate)) {
    seen.add(candidate);
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === "string") return code;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return null;
}

async function expectRemovalRejection(
  attempt: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await attempt;
  } catch (error) {
    expect(postgresCode(error)).toBe(expectedCode);
    return;
  }
  throw new Error(`expected removal to be rejected with SQLSTATE ${expectedCode}`);
}

describe("workspace membership removal fencing", () => {
  test("cancels the removed member's queued turn, wakes the workflow, and leaves others alone", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const actor = await grantAdmin(workspace);
    const target = `user:removed-${crypto.randomUUID()}`;
    const bystander = `user:bystander-${crypto.randomUUID()}`;
    await grantOrdinaryMember(workspace, target);
    await grantOrdinaryMember(workspace, bystander);
    const targetSession = await createSession(db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initialMessage: "target work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: target },
      subjectId: target,
      model: "test-model",
      sandboxBackend: "none",
    });
    const bystanderSession = await createSession(db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initialMessage: "bystander work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: bystander },
      subjectId: bystander,
      model: "test-model",
      sandboxBackend: "none",
    });
    const targetTurn = await insertQueuedTurn(workspace, targetSession.id, target);
    const bystanderTurn = await insertQueuedTurn(workspace, bystanderSession.id, bystander);

    expect(
      await removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: actor,
        targetSubjectId: target,
      }),
    ).toBe(true);

    const [after] = await admin<
      Array<{
        membership: number;
        targetTurn: string;
        bystanderTurn: string;
        cancelEvents: number;
        wakeRows: number;
      }>
    >`
      select
        (select count(*)::int from workspace_memberships
          where workspace_id = ${workspace.workspaceId} and subject_id = ${target}) as membership,
        (select status from session_turns where id = ${targetTurn}) as "targetTurn",
        (select status from session_turns where id = ${bystanderTurn}) as "bystanderTurn",
        (select count(*)::int from session_events
          where session_id = ${targetSession.id} and type = 'turn.cancelled') as "cancelEvents",
        (select count(*)::int from session_workflow_wake_outbox
          where session_id = ${targetSession.id}) as "wakeRows"`;
    expect(after).toEqual({
      membership: 0,
      targetTurn: "cancelled",
      bystanderTurn: "queued",
      cancelEvents: 1,
      wakeRows: 1,
    });
  });

  test("advances the removed managed human's private-session authority epoch in that workspace only", async () => {
    if (!available) return;
    const ownerId = `removal-owner-${crypto.randomUUID()}`;
    const targetId = `removal-target-${crypto.randomUUID()}`;
    const ownerSubject = `user:${ownerId}`;
    const targetSubject = `user:${targetId}`;
    await ensureManagedAccessForUser(db, {
      userId: ownerId,
      email: `${ownerId}@example.test`,
      name: ownerId,
    });
    const [owner] = await listSelfOrganizationMemberships(db, ownerSubject);
    const organizationId = owner!.organizationId;
    const invitation = await createOrganizationInvitation(db, {
      organizationId,
      actorSubjectId: ownerSubject,
      operationId: crypto.randomUUID(),
      targetSubjectId: targetSubject,
      targetEmail: `${targetId}@example.test`,
      role: "member",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const member = (
      await acceptOrganizationInvitation(db, {
        organizationId,
        actorSubjectId: targetSubject,
        operationId: crypto.randomUUID(),
        invitationId: invitation.id,
        expectedRevision: invitation.revision,
      })
    ).membership;
    const [workspaceRow] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name, external_source, external_id)
      values (${organizationId}, 'removal shared', 'test', ${crypto.randomUUID()})
      returning id`;
    const workspaceId = workspaceRow!.id;
    await admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${organizationId}, ${workspaceId})`;
    const [otherWorkspaceRow] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name, external_source, external_id)
      values (${organizationId}, 'removal other', 'test', ${crypto.randomUUID()})
      returning id`;
    await admin`
      insert into workspace_inference_controls (account_id, workspace_id)
      values (${organizationId}, ${otherWorkspaceRow!.id})`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values
        (${organizationId}, ${workspaceId}, ${ownerSubject}, 'owner',
          '["workspace:admin"]'::jsonb),
        (${organizationId}, ${workspaceId}, ${targetSubject}, 'member',
          '["sessions:read"]'::jsonb),
        (${organizationId}, ${otherWorkspaceRow!.id}, ${targetSubject}, 'member',
          '["sessions:read"]'::jsonb)`;

    const privateSession = await createSession(db, {
      accountId: organizationId,
      workspaceId,
      initialMessage: "private work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });
    const transition = await transitionSessionVisibility(db, {
      workspaceId,
      sessionId: privateSession.id,
      actorSubjectId: targetSubject,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `private:${crypto.randomUUID()}`,
    });
    expect(transition.authorityEpoch).toBe(2);
    const otherSession = await createSession(db, {
      accountId: organizationId,
      workspaceId: otherWorkspaceRow!.id,
      initialMessage: "other-workspace work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: targetSubject },
      subjectId: targetSubject,
      model: "test-model",
      sandboxBackend: "none",
    });

    expect(
      await removeWorkspaceMember(db, {
        accountId: organizationId,
        workspaceId,
        actorSubjectId: ownerSubject,
        targetSubjectId: targetSubject,
      }),
    ).toBe(true);

    const [after] = await admin<
      Array<{
        epoch: number;
        revokedEvents: number;
        otherEpoch: number;
        otherMembership: number;
        orgStatus: string;
      }>
    >`
      select
        (select authority_epoch::int from sessions where id = ${privateSession.id}) as epoch,
        (select count(*)::int from session_events
          where session_id = ${privateSession.id}
            and type = 'session.authority.revoked') as "revokedEvents",
        (select authority_epoch::int from sessions where id = ${otherSession.id}) as "otherEpoch",
        (select count(*)::int from workspace_memberships
          where workspace_id = ${otherWorkspaceRow!.id}
            and subject_id = ${targetSubject}) as "otherMembership",
        (select status from organization_memberships where id = ${member.id}) as "orgStatus"`;
    expect(after).toEqual({
      epoch: 3,
      revokedEvents: 1,
      otherEpoch: 1,
      otherMembership: 1,
      orgStatus: "active",
    });
  });

  test("settles a requires_action turn with pending tool calls through the canonical protocol", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const actor = await grantAdmin(workspace);
    const target = `user:settled-${crypto.randomUUID()}`;
    await grantOrdinaryMember(workspace, target);
    const session = await createSession(db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initialMessage: "requires action work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: target },
      subjectId: target,
      model: "test-model",
      sandboxBackend: "none",
    });
    const turnId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const callId = `call-${crypto.randomUUID()}`;
    await admin`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, execution_generation, position, prompt,
        model, reasoning_effort, latency_mode, sandbox_backend, initiator_kind,
        initiator_subject_id, initiating_human_subject_id
      ) values (
        ${turnId}, ${workspace.accountId}, ${workspace.workspaceId}, ${session.id},
        ${crypto.randomUUID()}, ${`removal-${crypto.randomUUID()}`},
        'running', 1, 1, 'requires action work', 'test-model', 'medium',
        'standard', 'none', 'subject', ${target}, ${target}
      )`;
    await admin.begin(async (tx) => {
      await tx`update sessions set active_turn_id = ${turnId}, status = 'running'
        where id = ${session.id}`;
      await tx`update session_turns set active_attempt_id = ${attemptId}
        where id = ${turnId}`;
      await tx`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id, execution_generation,
          state, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, verified_control_revision, mcp_approval_policies
        ) values (
          ${attemptId}, ${workspace.accountId}, ${workspace.workspaceId},
          ${session.id}, ${turnId}, 1, 'running',
          ${`removal-${turnId}`}, ${`run-${attemptId}`},
          ${`activity-${attemptId}`}, 0, '{}'::jsonb
        )`;
      await tx`update session_turn_attempts
        set state = 'closed', outcome = 'requires_action', closed_at = now()
        where id = ${attemptId}`;
      await tx`update session_turns
        set status = 'requires_action', active_attempt_id = null
        where id = ${turnId}`;
      await tx`update sessions set status = 'requires_action' where id = ${session.id}`;
    });
    await admin`
      insert into session_pending_tool_calls (
        account_id, workspace_id, session_id, turn_id, execution_generation,
        attempt_id, call_id, call_type, call_item, call_item_codec_version
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, ${session.id},
        ${turnId}, 1, ${attemptId}, ${callId}, 'function_call',
        ${admin.json({
          type: "function_call",
          name: "request_human_input",
          callId,
          arguments: "{}",
        })},
        1
      )`;

    expect(
      await removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: actor,
        targetSubjectId: target,
      }),
    ).toBe(true);

    const [after] = await admin<
      Array<{ turn: string; pendingToolCalls: number; sessionStatus: string }>
    >`
      select
        (select status from session_turns where id = ${turnId}) as turn,
        (select count(*)::int from session_pending_tool_calls
          where turn_id = ${turnId}) as "pendingToolCalls",
        (select status from sessions where id = ${session.id}) as "sessionStatus"`;
    expect(after).toEqual({
      turn: "cancelled",
      pendingToolCalls: 0,
      sessionStatus: "idle",
    });
  });

  test("two concurrent removals of the two last administering members leave one standing", async () => {
    if (!available || !shared) return;
    const workspace = await freshWorkspace();
    const adminA = await grantAdmin(workspace);
    const adminB = await grantAdmin(workspace);
    // Two independent organization-admin actors race to remove A and B. The
    // roster locks serialize them: exactly one removal commits and the loser
    // fails closed on the last-admin guard (55000) - never zero admins left.
    const actorX = await grantOrgAdmin(workspace);
    const actorY = await grantOrgAdmin(workspace);
    const clientX = createDb(shared.appUrl, { max: 1 });
    const clientY = createDb(shared.appUrl, { max: 1 });
    try {
      const [first, second] = await Promise.allSettled([
        removeWorkspaceMember(clientX.db, {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          actorSubjectId: actorX,
          targetSubjectId: adminA,
        }),
        removeWorkspaceMember(clientY.db, {
          accountId: workspace.accountId,
          workspaceId: workspace.workspaceId,
          actorSubjectId: actorY,
          targetSubjectId: adminB,
        }),
      ]);
      const outcomes = [first!, second!];
      const fulfilled = outcomes.filter(
        (candidate): candidate is PromiseFulfilledResult<boolean> =>
          candidate.status === "fulfilled",
      );
      const rejected = outcomes.filter(
        (candidate): candidate is PromiseRejectedResult => candidate.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]!.value).toBe(true);
      expect(rejected).toHaveLength(1);
      expect(postgresCode(rejected[0]!.reason)).toBe("55000");
      const [roster] = await admin<{ admins: number }[]>`
        select count(*)::int as admins
        from workspace_memberships
        where workspace_id = ${workspace.workspaceId}
          and permissions ?| array['workspace:admin', 'members:manage']`;
      expect(roster!.admins).toBe(1);
    } finally {
      await clientX.close();
      await clientY.close();
    }
  });

  test("refuses self-removal, last-admin removal, and a non-administering actor", async () => {
    if (!available) return;
    const workspace = await freshWorkspace();
    const admin1 = await grantAdmin(workspace);
    const ordinary = `user:plain-${crypto.randomUUID()}`;
    await grantOrdinaryMember(workspace, ordinary);

    await expectRemovalRejection(
      removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: admin1,
        targetSubjectId: admin1,
      }),
      "55000",
    );
    await expectRemovalRejection(
      removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: ordinary,
        targetSubjectId: admin1,
      }),
      "42501",
    );

    // A second admin exists -> the first admin becomes removable; removing the
    // final administering member fails closed.
    const admin2 = await grantAdmin(workspace);
    expect(
      await removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: admin2,
        targetSubjectId: admin1,
      }),
    ).toBe(true);
    const outsideActor = await grantAdminInOtherContext(workspace, admin2);
    await expectRemovalRejection(
      removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: outsideActor,
        targetSubjectId: admin2,
      }),
      "55000",
    );
    // Removing a non-member is an idempotent no-op.
    expect(
      await removeWorkspaceMember(db, {
        accountId: workspace.accountId,
        workspaceId: workspace.workspaceId,
        actorSubjectId: admin2,
        targetSubjectId: `user:absent-${crypto.randomUUID()}`,
      }),
    ).toBe(false);
  });
});

/** An organization owner/admin may administer without workspace membership;
 * give the account an active org admin to act from outside the roster. */
async function grantAdminInOtherContext(
  workspace: Workspace,
  excludedSubject: string,
): Promise<string> {
  const subjectId = `user:org-admin-${crypto.randomUUID()}`;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${workspace.accountId}, ${`personal-${subjectId}`}) returning id`;
  await admin`
    insert into organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id, authorization_revision
    ) values (${workspace.accountId}, ${subjectId}, 'admin', 'active', ${personal!.id}, 1)`;
  void excludedSubject;
  return subjectId;
}
