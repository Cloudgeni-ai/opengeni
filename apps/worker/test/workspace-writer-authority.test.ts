// Every persistable /workspace writer records its exact authority tuple, and
// the two actors that previously had none - `direct` (API request) and
// `process` (retained yielded shell) - are fenced by it (migration 0277).
//
// The load-bearing asymmetry: an unattributed or revoked writer is refused a
// NEW mutation, but the running provider process behind it is never terminated
// and never re-owned.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  advanceWorkspaceGeneration,
  advanceWorkspaceGenerationForDirectRequest,
  advanceWorkspaceGenerationForRetainedProcess,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getRetainedProcess,
  initializeSessionStartAtomically,
  retainWorkspaceMutationProcess,
  SandboxWorkspaceMutationFencedError,
  type Database,
  type DbClient,
} from "@opengeni/db";
import { sandboxLeaseHolderIdForAttempt } from "../src/sandbox-resume";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;
const cleanupRows: Array<{ accountId: string; workspaceId: string }> = [];

type WorkspaceIds = { accountId: string; workspaceId: string; groupId: string };
type TurnFixture = {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  holderId: `turn-attempt:${string}`;
};

type AdmissionAuthorityRow = {
  initiator_kind: string;
  initiator_subject_id: string;
  initiating_human_subject_id: string | null;
  initiator_organization_membership_id: string | null;
  initiator_authorization_revision: string | number | null;
  authority_epoch: number | null;
  authority_visibility: string | null;
  authority_owner_organization_membership_id: string | null;
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("workspace-writer-authority");
  if (!shared) {
    available = false;
    if (requireRealDatabase) throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but no database");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
});

afterEach(async () => {
  if (!available) return;
  while (cleanupRows.length > 0) {
    const row = cleanupRows.pop()!;
    await admin`delete from managed_accounts where id = ${row.accountId}`.catch(() => undefined);
  }
});

afterAll(async () => {
  await client?.close();
  await shared?.release();
});

async function freshWorkspace(): Promise<WorkspaceIds> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('workspace-writer-authority') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'workspace-writer-authority') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  cleanupRows.push({ accountId: account!.id, workspaceId: workspace!.id });
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    groupId: crypto.randomUUID(),
  };
}

async function freshSession(ids: WorkspaceIds): Promise<string> {
  const session = await createSession(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    initialMessage: "attribute this writer",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  ids.groupId = session.sandboxGroupId;
  await initializeSessionStartAtomically(db, {
    accountId: ids.accountId,
    workspaceId: ids.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  return session.id;
}

async function freshTurn(ids: WorkspaceIds, sessionId: string): Promise<TurnFixture> {
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, ids.workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: `workspace-writer-${crypto.randomUUID()}`,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`Could not claim fixture: ${claim.reason}`);
  return {
    sessionId,
    turnId: claim.turn.id,
    attemptId,
    executionGeneration: claim.turn.executionGeneration,
    holderId: sandboxLeaseHolderIdForAttempt(attemptId),
  };
}

async function insertWarmLease(
  ids: WorkspaceIds,
  input: { sessionId: string; holderId: string; holderKind: "turn" | "direct" },
): Promise<{ leaseId: string; instanceId: string }> {
  const instanceId = `authority-box-${crypto.randomUUID()}`;
  const [lease] = await admin<{ id: string }[]>`
    insert into sandbox_leases (
      account_id, workspace_id, sandbox_group_id, liveness, refcount,
      turn_holders, viewer_holders, instance_id, backend, lease_epoch,
      resume_backend_id, resume_state, expires_at
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${ids.groupId}, 'warm', 1,
      ${input.holderKind === "turn" ? 1 : 0}, 0, ${instanceId}, 'local', 7,
      'local', ${JSON.stringify({
        backendId: "local",
        sessionState: { providerState: { sandboxId: instanceId } },
        workspaceArchive: "UNCHANGED_ARCHIVE",
      })}::text::jsonb, now() + interval '10 minutes'
    ) returning id`;
  await admin`
    insert into sandbox_lease_holders (
      account_id, workspace_id, lease_id, kind, holder_id, subject_id
    ) values (
      ${ids.accountId}, ${ids.workspaceId}, ${lease!.id}, ${input.holderKind},
      ${input.holderId}, ${input.sessionId}
    )`;
  return { leaseId: lease!.id, instanceId };
}

async function readAdmissionAuthority(admissionId: string): Promise<AdmissionAuthorityRow> {
  const [row] = await admin<AdmissionAuthorityRow[]>`
    select initiator_kind, initiator_subject_id, initiating_human_subject_id,
      initiator_organization_membership_id, initiator_authorization_revision,
      authority_epoch, authority_visibility, authority_owner_organization_membership_id
    from sandbox_workspace_mutation_admissions where id = ${admissionId}`;
  if (!row) throw new Error("admission vanished");
  return row;
}

/** A managed human of this organization. `active` requires a personal
 * workspace pointer, exactly as the 0263 lifecycle does. */
async function insertMembership(
  ids: WorkspaceIds,
  subjectId: string,
  status: "active" | "revoked" | "suspended",
): Promise<string> {
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${ids.accountId}, ${`personal-${subjectId}`}) returning id`;
  const [membership] = await admin<{ id: string }[]>`
    insert into organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id,
      authorization_revision, revoked_at
    ) values (
      ${ids.accountId}, ${subjectId}, 'member', ${status},
      ${status === "active" ? personal!.id : personal!.id},
      3, ${status === "revoked" ? admin`now()` : null}
    ) returning id`;
  return membership!.id;
}

describe("workspace writer authority attribution", () => {
  test("a turn admission records the frozen accepted-turn authority", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const sessionId = await freshSession(ids);
    const attempt = await freshTurn(ids, sessionId);
    const { instanceId } = await insertWarmLease(ids, {
      sessionId,
      holderId: attempt.holderId,
      holderKind: "turn",
    });
    const admission = await advanceWorkspaceGeneration(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      turnId: attempt.turnId,
      executionGeneration: attempt.executionGeneration,
      attemptId: attempt.attemptId,
      holderId: attempt.holderId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: 7,
      expectedInstanceId: instanceId,
      operation: `turnAuthority-${crypto.randomUUID()}`,
    });
    const recorded = await readAdmissionAuthority(admission.id);
    const [frozen] = await admin<
      { authority_epoch: number; authority_visibility: string; initiator_subject_id: string }[]
    >`
      select attempt.authority_epoch, attempt.authority_visibility, turn.initiator_subject_id
      from session_turn_attempts attempt
      join session_turns turn on turn.id = attempt.turn_id
      where attempt.id = ${attempt.attemptId}`;
    // Copied verbatim from the accepted turn, never re-derived from live state.
    expect(recorded.authority_epoch).toBe(frozen!.authority_epoch);
    expect(recorded.authority_visibility).toBe(frozen!.authority_visibility);
    // A turn frozen before migration 0096 has no causal initiator to copy, so
    // the admission records the honest sentinel rather than inventing one -
    // and turn work is admitted either way.
    if (frozen!.initiator_subject_id === "unattributed-legacy") {
      expect(recorded.initiator_kind).toBe("legacy_unattributed");
      expect(recorded.initiating_human_subject_id).toBeNull();
    } else {
      expect(recorded.initiator_subject_id).toBe(frozen!.initiator_subject_id);
      expect(recorded.initiator_kind).not.toBe("legacy_unattributed");
    }
  });

  test("a direct admission records its exact request principal", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const sessionId = await freshSession(ids);
    const requestId = crypto.randomUUID();
    const holderId = `direct:${requestId}`;
    const { instanceId } = await insertWarmLease(ids, {
      sessionId,
      holderId,
      holderKind: "direct",
    });
    const admission = await advanceWorkspaceGenerationForDirectRequest(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      requestId,
      holderId,
      initiatorSubjectId: "subject:direct-attributed",
      sandboxGroupId: ids.groupId,
      expectedEpoch: 7,
      expectedInstanceId: instanceId,
      routeTargetId: null,
      routeEpoch: 0,
      operation: `directAuthority-${crypto.randomUUID()}`,
    });
    const recorded = await readAdmissionAuthority(admission.id);
    expect(recorded.initiator_kind).toBe("subject");
    expect(recorded.initiator_subject_id).toBe("subject:direct-attributed");
    expect(recorded.authority_visibility).toBe("workspace_shared");
    expect(recorded.authority_epoch).toBeGreaterThan(0);
    // A principal with no membership row is not an organization human: it keeps
    // its subject attribution and is never given an invented grant.
    expect(recorded.initiating_human_subject_id).toBeNull();
    expect(recorded.initiator_organization_membership_id).toBeNull();
  });

  test("a direct admission binds an active organization grant and its revision", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const sessionId = await freshSession(ids);
    const subjectId = "subject:direct-granted";
    const membershipId = await insertMembership(ids, subjectId, "active");
    const requestId = crypto.randomUUID();
    const holderId = `direct:${requestId}`;
    const { instanceId } = await insertWarmLease(ids, {
      sessionId,
      holderId,
      holderKind: "direct",
    });
    const admission = await advanceWorkspaceGenerationForDirectRequest(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      requestId,
      holderId,
      initiatorSubjectId: subjectId,
      sandboxGroupId: ids.groupId,
      expectedEpoch: 7,
      expectedInstanceId: instanceId,
      routeTargetId: null,
      routeEpoch: 0,
      operation: `directGrant-${crypto.randomUUID()}`,
    });
    const recorded = await readAdmissionAuthority(admission.id);
    expect(recorded.initiating_human_subject_id).toBe(subjectId);
    expect(recorded.initiator_organization_membership_id).toBe(membershipId);
    expect(Number(recorded.initiator_authorization_revision)).toBe(3);
  });

  for (const status of ["revoked", "suspended"] as const) {
    test(`a ${status} grant fences a new direct mutation immediately`, async () => {
      if (!available) return;
      const ids = await freshWorkspace();
      const sessionId = await freshSession(ids);
      const subjectId = `subject:direct-${status}`;
      await insertMembership(ids, subjectId, status);
      const requestId = crypto.randomUUID();
      const holderId = `direct:${requestId}`;
      const { instanceId } = await insertWarmLease(ids, {
        sessionId,
        holderId,
        holderKind: "direct",
      });
      const attempt = advanceWorkspaceGenerationForDirectRequest(db, {
        accountId: ids.accountId,
        workspaceId: ids.workspaceId,
        sessionId,
        requestId,
        holderId,
        initiatorSubjectId: subjectId,
        sandboxGroupId: ids.groupId,
        expectedEpoch: 7,
        expectedInstanceId: instanceId,
        routeTargetId: null,
        routeEpoch: 0,
        operation: `directRevoked-${crypto.randomUUID()}`,
      });
      await expect(attempt).rejects.toThrow(SandboxWorkspaceMutationFencedError);
      await expect(attempt).rejects.toMatchObject({ code: "authority_revoked" });
      // Fail closed means no generation was consumed either.
      const [lease] = await admin<{ workspace_generation: number }[]>`
        select workspace_generation from sandbox_leases
        where workspace_id = ${ids.workspaceId} and sandbox_group_id = ${ids.groupId}`;
      expect(lease!.workspace_generation).toBe(0);
    });
  }

  test("a retained process inherits the admitted tuple and is fenced, not killed, when unattributed", async () => {
    if (!available) return;
    const ids = await freshWorkspace();
    const sessionId = await freshSession(ids);
    const requestId = crypto.randomUUID();
    const holderId = `direct:${requestId}`;
    const { instanceId } = await insertWarmLease(ids, {
      sessionId,
      holderId,
      holderKind: "direct",
    });
    const operation = `retainAuthority-${crypto.randomUUID()}`;
    const admission = await advanceWorkspaceGenerationForDirectRequest(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      requestId,
      holderId,
      initiatorSubjectId: "subject:retained-owner",
      sandboxGroupId: ids.groupId,
      expectedEpoch: 7,
      expectedInstanceId: instanceId,
      routeTargetId: null,
      routeEpoch: 0,
      operation,
    });
    const processId = crypto.randomUUID();
    const process = await retainWorkspaceMutationProcess(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      processId,
      providerSessionId: 91,
      admissionId: admission.id,
      admittedWorkspaceGeneration: admission.workspaceGeneration,
      operation,
      providerBinding: null,
      owner: {
        kind: "direct",
        requestId,
        holderId,
        initiatorSubjectId: "subject:retained-owner",
        sandboxGroupId: ids.groupId,
        expectedEpoch: 7,
        expectedInstanceId: instanceId,
        routeTargetId: null,
        routeEpoch: 0,
      },
    });
    const [inherited] = await admin<AdmissionAuthorityRow[]>`
      select initiator_kind, initiator_subject_id, initiating_human_subject_id,
        initiator_organization_membership_id, initiator_authorization_revision,
        authority_epoch, authority_visibility, authority_owner_organization_membership_id
      from sandbox_retained_processes where id = ${process.id}`;
    expect(inherited!.initiator_kind).toBe("subject");
    expect(inherited!.initiator_subject_id).toBe("subject:retained-owner");
    expect(inherited!.authority_epoch).toBeGreaterThan(0);

    // Simulate the pre-0277 row a rolling deploy leaves behind.
    await admin`
      update sandbox_retained_processes set
        initiator_kind = 'legacy_unattributed',
        initiator_subject_id = 'unattributed-legacy',
        initiating_human_subject_id = null,
        initiator_organization_membership_id = null,
        initiator_authorization_revision = null,
        authority_epoch = null,
        authority_visibility = null,
        authority_owner_organization_membership_id = null
      where id = ${process.id}`;
    const refused = advanceWorkspaceGenerationForRetainedProcess(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      processId: process.id,
      operation: `retainedStdin-${crypto.randomUUID()}`,
    });
    await expect(refused).rejects.toMatchObject({ code: "authority_unattributed" });
    // The running process is untouched: only its next mutation was refused.
    const stillActive = await getRetainedProcess(db, {
      accountId: ids.accountId,
      workspaceId: ids.workspaceId,
      sessionId,
      processId: process.id,
    });
    expect(stillActive?.state).toBe("active");
  });
});
