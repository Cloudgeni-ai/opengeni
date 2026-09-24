import { skillCatalogContextItem, readSkillCatalogContext } from "@opengeni/contracts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import type postgres from "postgres";
import {
  addSessionSystemUpdate,
  appendSessionHistoryItems,
  applyContextCompaction,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createSessionWithIdempotencyKey,
  ensureManagedAccessForUser,
  forkSessionContent,
  getOrganizationPrivateSessionSettings,
  getSessionEventForSubject,
  getSessionForSubject,
  getOrCreateCompanyProfileSnapshot,
  grantWorkspaceAccess,
  nestedPostgresSqlState,
  openPrivateChildSessionCreateCapability,
  openPrivateSessionCreateCapability,
  peekSessionWork,
  enqueueSessionWorkflowWake,
  markSessionWorkflowWakeDelivered,
  removeWorkspaceMember,
  registerPendingSessionToolCall,
  resolveCompanyBrainContextSelection,
  setSubjectRlsContext,
  submitHumanPromptInTransaction,
  transitionSessionVisibility,
  updateOrganizationPrivateSessionSettings,
  withRlsContext,
  withWorkspaceSubjectSessionActivityRls,
  type DbClient,
} from "../src/index";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

type ManagedHuman = {
  subjectId: string;
  accountId: string;
  legacyWorkspaceId: string;
  personalWorkspaceId: string;
  organizationMembershipId: string;
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("personal-workspace-session-tenancy");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error(
        "[personal-workspace-session-tenancy] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 8 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function provisionManagedHuman(): Promise<ManagedHuman> {
  if (!client || !shared) throw new Error("test database unavailable");
  const userId = `pw-tenancy-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const context = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Personal workspace owner",
  });
  const legacyWorkspaceId = context.defaultWorkspaceId!;
  const personalGrant = context.workspaceGrants.find(
    (grant) => grant.workspaceId !== legacyWorkspaceId,
  );
  if (!personalGrant) throw new Error("managed human provisioned without a personal workspace");
  const [membership] = await shared.admin<Array<{ id: string }>>`
    select id from organization_memberships
    where account_id = ${personalGrant.accountId} and subject_id = ${subjectId}`;
  await shared.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (
      ${personalGrant.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test'
    ) on conflict (account_id) do nothing`;
  const privateSessionSettings = await getOrganizationPrivateSessionSettings(client.db, {
    organizationId: personalGrant.accountId,
    actorSubjectId: subjectId,
  });
  if (!privateSessionSettings.enabled) {
    await updateOrganizationPrivateSessionSettings(client.db, {
      organizationId: personalGrant.accountId,
      actorSubjectId: subjectId,
      enabled: true,
      expectedVersion: privateSessionSettings.version,
      operationId: crypto.randomUUID(),
    });
  }
  return {
    subjectId,
    accountId: personalGrant.accountId,
    legacyWorkspaceId,
    personalWorkspaceId: personalGrant.workspaceId,
    organizationMembershipId: membership!.id,
  };
}

/**
 * Mint a session owned by the human.
 *
 * Migration 0302 (#1631, now on `main`) repaired the owner-resolution half of
 * this defect: `guard_session_authority_write` accepts an active membership's
 * own `personal_workspace_id` pointer, so a session minted in the owner's
 * personal workspace is now attributed automatically. This fixture therefore
 * asserts that rather than hand-stamping the owner behind the lifecycle
 * capability, which is what it had to do before 0302 landed.
 *
 * Migration 0303 activates the canonical personal-workspace disjunction in
 * both lifecycle seams. The test activation row is inserted directly by the
 * migration-owner fixture; production activation must use the drained command.
 */
async function ownedSession(human: ManagedHuman, workspaceId: string): Promise<string> {
  if (!client || !shared) throw new Error("test database unavailable");
  const session = await createSession(client.db, {
    accountId: human.accountId,
    workspaceId,
    initialMessage: "personal workspace session",
    resources: [],
    metadata: {},
    createdBy: { kind: "subject", subjectId: human.subjectId },
    model: "test-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  const [owned] = await shared.admin<Array<{ owner: string | null }>>`
    select owner_organization_membership_id as "owner" from sessions where id = ${session.id}`;
  expect(owned?.owner).toBe(human.organizationMembershipId);
  return session.id;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitUntilBlockedBy(backendPid: number): Promise<void> {
  if (!shared) throw new Error("test database unavailable");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const [row] = await shared.admin<Array<{ blocked: boolean }>>`
      select exists (
        select 1 from pg_stat_activity activity
        where activity.datname = current_database()
          and ${backendPid} = any(pg_blocking_pids(activity.pid))
      ) as blocked`;
    if (row?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("workspace membership removal did not block on private create authority");
}

/**
 * Migration 0303 fixes the remaining access half with the exact authority-row
 * disjunction: the active membership's own personal_workspace_id pointer OR an
 * ordinary workspace_memberships row. No creator/name/default/permission
 * inference is accepted.
 */
describe("session tenancy SQL seams inside a managed human's own personal workspace", () => {
  test("an unavailable private-session observer preserves state and sees restored owner scope", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const workspaceId = human.legacyWorkspaceId;
    const { session } = await createSessionWithIdempotencyKey(client.db, {
      accountId: human.accountId,
      workspaceId,
      visibility: "user_private",
      initialMessage: "private accepted work",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human.subjectId },
      subjectId: human.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: crypto.randomUUID(),
    });
    const before =
      await shared.admin`select status, active_turn_id, last_sequence, direct_control_state
      from sessions where id = ${session.id}`;
    const hidden = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspaceId,
      `user:${crypto.randomUUID()}`,
      (db) => peekSessionWork(db, workspaceId, session.id, false, human.accountId),
    );
    expect(hidden).toEqual({ kind: "unavailable" });
    await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, human.subjectId, (db) =>
      enqueueSessionWorkflowWake(db, {
        accountId: human.accountId,
        workspaceId,
        sessionId: session.id,
        temporalWorkflowId: `session-${session.id}`,
        reason: "test_restore_observer",
      }),
    );
    const [wakeBefore] =
      await shared.admin`select * from session_workflow_wake_outbox where session_id = ${session.id}`;
    expect(wakeBefore).toBeDefined();
    const receipt = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspaceId,
      `user:${crypto.randomUUID()}`,
      (db) =>
        markSessionWorkflowWakeDelivered(db, {
          accountId: human.accountId,
          workspaceId,
          sessionId: session.id,
          temporalWorkflowId: `session-${session.id}`,
          wakeRevision: Number(wakeBefore!.wake_revision),
        }),
    );
    expect(receipt).toEqual({ action: "pending_admission", blocker: "session_unavailable" });
    const [wakeHidden] =
      await shared.admin`select * from session_workflow_wake_outbox where session_id = ${session.id}`;
    expect(wakeHidden).toEqual(wakeBefore);
    const visible = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspaceId,
      human.subjectId,
      (db) => peekSessionWork(db, workspaceId, session.id, false, human.accountId),
    );
    expect(visible.kind).not.toBe("unavailable");
    const restoredReceipt = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspaceId,
      human.subjectId,
      (db) =>
        markSessionWorkflowWakeDelivered(db, {
          accountId: human.accountId,
          workspaceId,
          sessionId: session.id,
          temporalWorkflowId: `session-${session.id}`,
          wakeRevision: Number(wakeBefore!.wake_revision),
        }),
    );
    expect(restoredReceipt).toEqual({ action: "acknowledged" });
    const [wakeRestored] =
      await shared.admin`select delivered_revision from session_workflow_wake_outbox where session_id = ${session.id}`;
    expect(Number(wakeRestored!.delivered_revision)).toBe(Number(wakeBefore!.wake_revision));
    const after =
      await shared.admin`select status, active_turn_id, last_sequence, direct_control_state
      from sessions where id = ${session.id}`;
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  test("creates an owner-bound private session atomically in shared and Personal workspaces", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();

    for (const workspaceId of [human.legacyWorkspaceId, human.personalWorkspaceId]) {
      const idempotencyKey = `private-create-${crypto.randomUUID()}`;
      const input = {
        accountId: human.accountId,
        workspaceId,
        visibility: "user_private" as const,
        initialMessage: "private from the first durable row",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject" as const, subjectId: human.subjectId },
        subjectId: human.subjectId,
        model: "test-model",
        reasoningEffort: "medium" as const,
        latencyMode: "standard" as const,
        sandboxBackend: "none" as const,
        createIdempotencyKey: idempotencyKey,
      };
      const created = await createSessionWithIdempotencyKey(client.db, input);
      const replay = await createSessionWithIdempotencyKey(client.db, input);
      expect(replay.session.id).toBe(created.session.id);

      const visible = await getSessionForSubject(
        client.db,
        workspaceId,
        created.session.id,
        human.subjectId,
      );
      expect(visible?.tenancy).toMatchObject({
        visibility: "private",
        authorityEpoch: 1,
        ownedByCurrentUser: true,
      });
      const [stored] = await shared.admin<
        Array<{
          visibility: string;
          requestedVisibility: string;
          ownerMembershipId: string | null;
          sandboxGroupId: string;
        }>
      >`
        select visibility,
          create_requested_visibility as "requestedVisibility",
          owner_organization_membership_id as "ownerMembershipId",
          sandbox_group_id as "sandboxGroupId"
        from sessions where id = ${created.session.id}`;
      expect(stored).toEqual({
        visibility: "user_private",
        requestedVisibility: "user_private",
        ownerMembershipId: human.organizationMembershipId,
        sandboxGroupId: created.session.id,
      });
    }
  }, 180_000);

  test("private internal-update attempts freeze the exact session owner for company context", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const created = await createSessionWithIdempotencyKey(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      visibility: "user_private",
      initialMessage: "private internal update authority",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human.subjectId },
      subjectId: human.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `private-internal-${crypto.randomUUID()}`,
    });
    const update = await addSessionSystemUpdate(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      sessionId: created.session.id,
      kind: "child_terminal_result",
      classification: "success",
      sourceId: crypto.randomUUID(),
      dedupeKey: `private-child-result:${crypto.randomUUID()}`,
      summary: "Private child completed",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
    expect(update).toMatchObject({ added: true, shouldWake: false });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, human.personalWorkspaceId, {
      sessionId: created.session.id,
      workflowId: `session-${created.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("private internal update was not claimed");
    expect(claim.turn).toMatchObject({
      source: "system",
      initiatingHumanSubjectId: human.subjectId,
    });
    const companyClaims = {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      sessionId: created.session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    };
    await getOrCreateCompanyProfileSnapshot(client.db, companyClaims);
    const companyContext = await resolveCompanyBrainContextSelection(client.db, companyClaims);
    expect(companyContext).toMatchObject({ receipt: { sessionRole: "root" } });
  }, 180_000);

  test("an exact private parent attempt creates a same-owner private child", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const parent = await createSessionWithIdempotencyKey(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      visibility: "user_private",
      initialMessage: "private parent",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human.subjectId },
      subjectId: human.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `private-parent-${crypto.randomUUID()}`,
    });
    const submitted = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      human.personalWorkspaceId,
      human.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: human.accountId,
            workspaceId: human.personalWorkspaceId,
            sessionId: parent.session.id,
            subjectId: human.subjectId,
            actor: { type: "human", subjectId: human.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "spawn privately",
            resources: [],
            model: "test-model",
            reasoningEffort: "medium",
            reasoningEffortFallback: "medium",
            source: "user",
          }),
        ),
    );
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, human.personalWorkspaceId, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed" || claim.turn.id !== submitted.turnId) {
      throw new Error("private parent attempt was not claimed");
    }
    const child = await createSession(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      visibility: "user_private",
      initialMessage: "private child",
      resources: [],
      metadata: {},
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      parentSessionId: parent.session.id,
      sandboxGroupId: parent.session.sandboxGroupId,
      createdByActor: {
        type: "agent_attempt",
        sessionId: parent.session.id,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
    });

    expect(
      await getSessionForSubject(client.db, human.personalWorkspaceId, child.id, human.subjectId),
    ).toMatchObject({
      parentSessionId: parent.session.id,
      sandboxGroupId: parent.session.sandboxGroupId,
      tenancy: {
        visibility: "private",
        ownedByCurrentUser: true,
        authorityEpoch: 1,
      },
    });
  }, 180_000);

  test("the database rejects a workspace-visible child under a private parent", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const parent = await createSessionWithIdempotencyKey(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      visibility: "user_private",
      initialMessage: "private parent for direct child fence",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human.subjectId },
      subjectId: human.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `private-parent-fence-${crypto.randomUUID()}`,
    });
    const childId = crypto.randomUUID();
    let childInsertState: string | null = null;
    let childInsertMessage = "";
    try {
      await shared.admin`insert into sessions
        select (pg_catalog.jsonb_populate_record(
          null::sessions,
          to_jsonb(source) || pg_catalog.jsonb_build_object(
            'id', ${childId}::uuid,
            'parent_session_id', ${parent.session.id}::uuid,
            'parent_turn_id', null,
            'sandbox_group_id', ${childId}::uuid,
            'visibility', 'workspace_shared',
            'create_requested_visibility', 'workspace_shared',
            'owner_organization_membership_id', null,
            'owner_subject_id', null,
            'create_idempotency_key', null,
            'nested_agent_depth', 1
          )
        )).*
        from sessions source where source.id = ${parent.session.id}::uuid`;
    } catch (error) {
      childInsertState = nestedPostgresSqlState(error);
      childInsertMessage = error instanceof Error ? error.message : String(error);
    }
    expect(childInsertState).toBe("42501");
    expect(childInsertMessage).toContain("child session authority must match its locked parent");
  }, 180_000);

  test("private child capability rejects stale attempts, wrong targets, wrong owners, and updates", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const parent = await createSessionWithIdempotencyKey(client.db, {
      accountId: human.accountId,
      workspaceId: human.personalWorkspaceId,
      visibility: "user_private",
      initialMessage: "private parent for negative capability tests",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human.subjectId },
      subjectId: human.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `private-parent-negative-${crypto.randomUUID()}`,
    });
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      human.personalWorkspaceId,
      human.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: human.accountId,
            workspaceId: human.personalWorkspaceId,
            sessionId: parent.session.id,
            subjectId: human.subjectId,
            actor: { type: "human", subjectId: human.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "spawn private children",
            resources: [],
            model: "test-model",
            reasoningEffort: "medium",
            reasoningEffortFallback: "medium",
            source: "user",
          }),
        ),
    );
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, human.personalWorkspaceId, {
      sessionId: parent.session.id,
      workflowId: `session-${parent.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("private parent turn was not claimed");
    const actor = {
      sessionId: parent.session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    };

    let staleState: string | null = null;
    try {
      await withRlsContext(
        client.db,
        { accountId: human.accountId, workspaceId: human.personalWorkspaceId },
        (tx) =>
          openPrivateChildSessionCreateCapability(tx, {
            accountId: human.accountId,
            workspaceId: human.personalWorkspaceId,
            sessionId: crypto.randomUUID(),
            parentSessionId: parent.session.id,
            actorTurnId: actor.turnId,
            actorAttemptId: crypto.randomUUID(),
            actorExecutionGeneration: actor.executionGeneration,
          }),
      );
    } catch (error) {
      staleState = nestedPostgresSqlState(error);
    }
    expect(staleState).toBe("42501");

    const expectCapabilityWriteDenied = async (
      mutation: "wrong_target" | "wrong_owner" | "update",
    ) => {
      const authorizedChildId = crypto.randomUUID();
      let state: string | null = null;
      try {
        await withRlsContext(
          client!.db,
          { accountId: human.accountId, workspaceId: human.personalWorkspaceId },
          async (tx) => {
            await openPrivateChildSessionCreateCapability(tx, {
              accountId: human.accountId,
              workspaceId: human.personalWorkspaceId,
              sessionId: authorizedChildId,
              parentSessionId: parent.session.id,
              actorTurnId: actor.turnId,
              actorAttemptId: actor.attemptId,
              actorExecutionGeneration: actor.executionGeneration,
            });
            if (mutation === "update") {
              await tx.execute(
                sql`update sessions set title = 'forbidden capability update'
                  where id = ${parent.session.id}::uuid`,
              );
              return;
            }
            const insertPrivateChild = async (insertedId: string, ownerSubjectId: string) =>
              await tx.execute(sql`insert into sessions
                select (pg_catalog.jsonb_populate_record(
                  null::sessions,
                  to_jsonb(source) || pg_catalog.jsonb_build_object(
                    'id', ${insertedId}::uuid,
                    'parent_session_id', ${parent.session.id}::uuid,
                    'parent_turn_id', ${actor.turnId}::uuid,
                    'sandbox_group_id', ${parent.session.sandboxGroupId}::uuid,
                    'visibility', 'user_private',
                    'create_requested_visibility', 'user_private',
                    'owner_organization_membership_id', ${human.organizationMembershipId}::uuid,
                    'owner_subject_id', ${ownerSubjectId}::text,
                    'create_idempotency_key', null,
                    'nested_agent_depth', 1
                  )
                )).*
                from sessions source where source.id = ${parent.session.id}::uuid`);
            await insertPrivateChild(
              mutation === "wrong_target" ? crypto.randomUUID() : authorizedChildId,
              mutation === "wrong_owner" ? `user:wrong-${crypto.randomUUID()}` : human.subjectId,
            );
          },
        );
      } catch (error) {
        state = nestedPostgresSqlState(error);
      }
      expect(state).toBe("42501");
    };
    await expectCapabilityWriteDenied("wrong_target");
    await expectCapabilityWriteDenied("wrong_owner");
    await expectCapabilityWriteDenied("update");
  }, 180_000);

  test("private-create authority is target-bound, INSERT-only, and requested visibility is immutable", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const existingSessionId = await ownedSession(human, human.legacyWorkspaceId);
    const requestedSessionId = crypto.randomUUID();

    let updateState: string | null = null;
    try {
      await withRlsContext(
        client.db,
        { accountId: human.accountId, workspaceId: human.legacyWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, human.subjectId);
          await openPrivateSessionCreateCapability(tx, {
            accountId: human.accountId,
            workspaceId: human.legacyWorkspaceId,
            sessionId: requestedSessionId,
            actorSubjectId: human.subjectId,
          });
          await tx.execute(sql`update sessions set visibility = 'user_private'
            where id = ${existingSessionId}::uuid`);
        },
      );
    } catch (error) {
      updateState = nestedPostgresSqlState(error);
    }
    expect(updateState).toBe("42501");

    let secondInsertState: string | null = null;
    try {
      await withRlsContext(
        client.db,
        { accountId: human.accountId, workspaceId: human.legacyWorkspaceId },
        async (tx) => {
          await setSubjectRlsContext(tx, human.subjectId);
          await openPrivateSessionCreateCapability(tx, {
            accountId: human.accountId,
            workspaceId: human.legacyWorkspaceId,
            sessionId: requestedSessionId,
            actorSubjectId: human.subjectId,
          });
          const insertRequestedPrivateSession = () =>
            tx.execute(sql`insert into sessions
              select (pg_catalog.jsonb_populate_record(
                null::sessions,
                to_jsonb(source) || pg_catalog.jsonb_build_object(
                  'id', ${requestedSessionId}::uuid,
                  'root_session_id', ${requestedSessionId}::uuid,
                  'sandbox_group_id', ${requestedSessionId}::uuid,
                  'visibility', 'user_private',
                  'create_requested_visibility', 'user_private',
                  'create_idempotency_key', null
                )
              )).*
              from sessions source where source.id = ${existingSessionId}::uuid`);
          await insertRequestedPrivateSession();
          await insertRequestedPrivateSession();
        },
      );
    } catch (error) {
      secondInsertState = nestedPostgresSqlState(error);
    }
    expect(secondInsertState).toBe("55000");

    let immutableState: string | null = null;
    try {
      await shared.admin`update sessions set create_requested_visibility = 'user_private'
        where id = ${existingSessionId}`;
    } catch (error) {
      immutableState = nestedPostgresSqlState(error);
    }
    expect(immutableState).toBe("42501");
  }, 180_000);

  test("workspace access removal waits for private create and settles the committed session", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const requestedSessionId = crypto.randomUUID();
    const removerSubjectId = `user:private-create-remover-${crypto.randomUUID()}`;
    const removerPersonalWorkspaceId = crypto.randomUUID();
    await shared.admin`
      insert into workspaces (id, account_id, name)
      values (${removerPersonalWorkspaceId}, ${human.accountId}, 'Removal actor Personal')`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id, authorization_revision
      ) values (
        ${human.accountId}, ${removerSubjectId}, 'admin', 'active',
        ${removerPersonalWorkspaceId}, 1
      )`;
    await grantWorkspaceAccess(client.db, {
      accountId: human.accountId,
      workspaceId: human.legacyWorkspaceId,
      subjectId: removerSubjectId,
      permissions: ["workspace:admin", "members:manage"],
    });
    const adminRoster = await shared.admin<Array<{ subjectId: string; permissions: string[] }>>`
      select subject_id as "subjectId", permissions from workspace_memberships membership
      where membership.account_id = ${human.accountId}
        and membership.workspace_id = ${human.legacyWorkspaceId}
        and membership.permissions ?| array['workspace:admin', 'members:manage']
      order by subject_id`;
    expect(Array.from(adminRoster)).toHaveLength(2);

    const createPrepared = deferred();
    const releaseCreate = deferred();
    let creatorBackendPid = 0;
    const create = createSessionWithIdempotencyKey(client.db, {
      accountId: human.accountId,
      workspaceId: human.legacyWorkspaceId,
      requestedSessionId,
      visibility: "user_private",
      initialMessage: "private create removal race",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject", subjectId: human.subjectId },
      subjectId: human.subjectId,
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createIdempotencyKey: `private-create-removal-${crypto.randomUUID()}`,
      beforeCreateCommit: async (tx) => {
        const [backend] = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid()::integer as pid`,
        );
        creatorBackendPid = backend!.pid;
        createPrepared.resolve();
        await releaseCreate.promise;
      },
    });

    await createPrepared.promise;
    let removalSettled = false;
    const removal = removeWorkspaceMember(client.db, {
      accountId: human.accountId,
      workspaceId: human.legacyWorkspaceId,
      actorSubjectId: removerSubjectId,
      targetSubjectId: human.subjectId,
    }).finally(() => {
      removalSettled = true;
    });
    await waitUntilBlockedBy(creatorBackendPid);
    expect(removalSettled).toBe(false);
    releaseCreate.resolve();
    expect((await create).session.id).toBe(requestedSessionId);
    expect(await removal).toBe(true);

    const [settled] = await shared.admin<
      Array<{ authorityEpoch: number; accessRows: number; revocationEvents: number }>
    >`
      select session.authority_epoch::int as "authorityEpoch",
        (select count(*)::int from workspace_memberships access
          where access.account_id = ${human.accountId}
            and access.workspace_id = ${human.legacyWorkspaceId}
            and access.subject_id = ${human.subjectId}) as "accessRows",
        (select count(*)::int from session_events event
          where event.session_id = session.id
            and event.type = 'session.authority.revoked') as "revocationEvents"
      from sessions session where session.id = ${requestedSessionId}`;
    expect(settled).toEqual({ authorityEpoch: 2, accessRows: 0, revocationEvents: 1 });
  }, 180_000);

  test("subject reads expose tenancy only after the organization's durable activation", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);
    await shared.admin`
      delete from session_tenancy_activations where account_id = ${human.accountId}`;

    const inert = await getSessionForSubject(
      client.db,
      human.personalWorkspaceId,
      sessionId,
      human.subjectId,
    );
    expect(inert?.tenancy).toBeUndefined();

    await shared.admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (
        ${human.accountId}, 1, ${"0".repeat(64)}, ${"1".repeat(64)}, 'database-test'
      )`;
    const activated = await getSessionForSubject(
      client.db,
      human.personalWorkspaceId,
      sessionId,
      human.subjectId,
    );
    expect(activated?.tenancy).toEqual({
      visibility: "workspace",
      authorityEpoch: 1,
      ownedByCurrentUser: true,
      fork: null,
    });
  }, 180_000);

  test("transition_session_visibility accepts the owner in their own personal workspace", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);

    const result = await transitionSessionVisibility(client.db, {
      workspaceId: human.personalWorkspaceId,
      sessionId,
      actorSubjectId: human.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `visibility-${crypto.randomUUID()}`,
    });
    expect(result.visibility).toBe("user_private");
    expect(result.eventId).toBeString();
    expect(result.eventSequence).toBe(1);
    const [session, event] = await Promise.all([
      getSessionForSubject(client.db, human.personalWorkspaceId, sessionId, human.subjectId),
      getSessionEventForSubject(
        client.db,
        human.personalWorkspaceId,
        human.subjectId,
        result.eventId!,
      ),
    ]);
    expect(session?.tenancy).toMatchObject({
      visibility: "private",
      authorityEpoch: 2,
      ownedByCurrentUser: true,
    });
    expect(event).toMatchObject({ id: result.eventId, sequence: result.eventSequence });
  }, 180_000);

  test("message forks accept valid fractional reasoning controls but reject malformed and compacted history", async () => {
    if (!shared || !client) throw new Error("test postgres unavailable");
    const human = await provisionManagedHuman();
    const workspaceId = human.personalWorkspaceId;
    const sourceSessionId = await ownedSession(human, workspaceId);
    const events: string[] = [];
    const controls: Record<string, postgres.JSONValue>[] = [];
    for (const [index, effort] of ["low", "high"].entries()) {
      const turnId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      events.push(eventId);
      await shared.admin`insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend
      ) values (${turnId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${eventId}, 'reasoning-fork-test', 'completed', ${index + 1}, 'Question',
        'gpt-6-astra', ${effort}, 'none')`;
      await shared.admin`insert into session_events (
        id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
      ) values (${eventId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${turnId}, ${index + 1}, 'user.message', '{"text":"Question"}')`;
      const control = {
        type: "unknown",
        providerData: { type: "configuration_update", reasoning: { effort } },
        opengeniReasoningConfiguration: { version: 1, baselineEffort: "low", effort, turnId },
      };
      controls.push(control);
      for (const [position, item] of [
        [index + 0.75, control],
        [index + 1, { type: "message", role: "user", content: "Question" }],
      ] as const) {
        await shared.admin`insert into session_history_items (
          account_id, workspace_id, session_id, turn_id, position, item
        ) values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId},
          ${position}, ${shared.admin.json(item)})`;
      }
    }
    const fork = (sourceEventId = events[1]!) =>
      forkSessionContent(client!.db, {
        sourceWorkspaceId: workspaceId,
        sourceSessionId,
        actorSubjectId: human.subjectId,
        destinationWorkspaceId: workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: crypto.randomUUID(),
        sourceEventId,
      });
    expect((await fork(events[0]!)).copiedHistoryItemCount).toBe(2);
    const switched = await fork();
    expect(switched.copiedHistoryItemCount).toBe(4);
    const rows = await shared.admin`select item from session_history_items
      where session_id = ${switched.sessionId} order by position`;
    expect(rows.filter((row) => row.item.type === "unknown").map((row) => row.item)).toEqual(
      controls,
    );
    for (const invalid of [
      { type: "unknown" },
      {
        ...controls[0],
        providerData: { type: "configuration_update", reasoning: { effort: "high" } },
      },
      { ...controls[0], opengeniReasoningConfiguration: { version: 1, effort: "low" } },
      { type: "compaction", encrypted_content: "test" },
    ]) {
      await shared.admin`update session_history_items set item = ${shared.admin.json(invalid)}
        where session_id = ${sourceSessionId} and position = 0.75`;
      await expect(fork()).rejects.toThrow("Session tenancy request is invalid");
    }
    await shared.admin`update session_history_items set item = ${shared.admin.json(controls[0]!)}, active = false
      where session_id = ${sourceSessionId} and position = 0.75`;
    await expect(fork()).rejects.toThrow("Session tenancy request is invalid");
  }, 180_000);

  test("message forks preserve catalog snapshots and reject malformed fractional catalog rows", async () => {
    if (!shared || !client) throw new Error("test postgres unavailable");
    const human = await provisionManagedHuman();
    const workspaceId = human.personalWorkspaceId;
    const sourceSessionId = await ownedSession(human, workspaceId);
    const events: string[] = [];
    const controls: Record<string, postgres.JSONValue>[] = [];
    for (const [index, effort] of ["low", "high"].entries()) {
      const turnId = crypto.randomUUID();
      const eventId = crypto.randomUUID();
      events.push(eventId);
      await shared.admin`insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
        status, position, prompt, model, reasoning_effort, sandbox_backend
      ) values (${turnId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${eventId}, 'reasoning-fork-test', 'completed', ${index + 1}, 'Question',
        'gpt-6-astra', ${effort}, 'none')`;
      await shared.admin`insert into session_events (
        id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
      ) values (${eventId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${turnId}, ${index + 1}, 'user.message', '{"text":"Question"}')`;
      const control = skillCatalogContextItem(effort) as Record<string, postgres.JSONValue>;
      controls.push(control);
      for (const [position, item] of [
        [index + 0.75, control],
        [index + 1, { type: "message", role: "user", content: "Question" }],
      ] as const) {
        await shared.admin`insert into session_history_items (
          account_id, workspace_id, session_id, turn_id, position, item
        ) values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId},
          ${position}, ${shared.admin.json(item)})`;
      }
    }
    const fork = (sourceEventId = events[1]!) =>
      forkSessionContent(client!.db, {
        sourceWorkspaceId: workspaceId,
        sourceSessionId,
        actorSubjectId: human.subjectId,
        destinationWorkspaceId: workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: crypto.randomUUID(),
        sourceEventId,
      });
    expect((await fork(events[0]!)).copiedHistoryItemCount).toBe(2);
    const switched = await fork();
    expect(switched.copiedHistoryItemCount).toBe(4);
    const rows = await shared.admin`select item from session_history_items
      where session_id = ${switched.sessionId} order by position`;
    expect(
      rows.filter((row) => readSkillCatalogContext(row.item) !== null).map((row) => row.item),
    ).toEqual(controls);
    for (const invalid of [
      { ...controls[0], role: "user" },
      { ...controls[0], content: "unmarked developer instructions" },
      { ...controls[0], content: "<opengeni_skill_catalog>\nmissing close" },
      { type: "compaction", encrypted_content: "test" },
    ]) {
      await shared.admin`update session_history_items set item = ${shared.admin.json(invalid)}
        where session_id = ${sourceSessionId} and position = 0.75`;
      await expect(fork()).rejects.toThrow("Session tenancy request is invalid");
    }
    await shared.admin`update session_history_items set item = ${shared.admin.json(controls[0]!)}, active = false
      where session_id = ${sourceSessionId} and position = 0.75`;
    await expect(fork()).rejects.toThrow("Session tenancy request is invalid");
  }, 180_000);

  test("active message forks preserve source execution, ordered prefix, authority and replay", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const workspaceId = human.personalWorkspaceId;
    const sourceSessionId = await ownedSession(human, workspaceId);
    const submitted = await withWorkspaceSubjectSessionActivityRls(
      client.db,
      workspaceId,
      human.subjectId,
      (db) =>
        db.transaction((tx) =>
          submitHumanPromptInTransaction(tx as unknown as typeof db, {
            accountId: human.accountId,
            workspaceId,
            sessionId: sourceSessionId,
            subjectId: human.subjectId,
            actor: { type: "human", subjectId: human.subjectId },
            operationKey: crypto.randomUUID(),
            delivery: "send",
            text: "Active question",
            resources: [],
            model: "test-model",
            reasoningEffort: "medium",
            reasoningEffortFallback: "medium",
            source: "user",
          }),
        ),
    );
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
      sessionId: sourceSessionId,
      workflowId: `session-${sourceSessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed" || claim.turn.id !== submitted.turnId) {
      throw new Error("active fork fixture was not claimed");
    }
    const authority = {
      accountId: human.accountId,
      workspaceId,
      sessionId: sourceSessionId,
      turnId: claim.turn.id,
      expectedExecutionGeneration: claim.turn.executionGeneration,
      expectedAttemptId: attemptId,
    };
    // Use the real writer seams, including their attempt and shared tenancy fences.
    const [last] = await shared.admin`select coalesce(max(position), 0)::integer as position
      from session_history_items where session_id = ${sourceSessionId}`;
    const boundary = Number(last!.position) + 1;
    const orderedItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Retained answer" }],
      providerData: { z: 1, a: 2 },
    };
    expect(
      await appendSessionHistoryItems(client.db, {
        ...authority,
        items: [{ position: boundary, item: orderedItem }],
      }),
    ).toBe(true);
    const replyEventId = crypto.randomUUID();
    await shared.admin`insert into session_events
      (id, account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select ${replyEventId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${claim.turn.id}, coalesce(max(sequence), 0) + 1, 'agent.message.completed',
        '{"text":"Retained answer"}' from session_events where session_id = ${sourceSessionId}`;
    expect(
      await registerPendingSessionToolCall(client.db, {
        accountId: human.accountId,
        workspaceId,
        sessionId: sourceSessionId,
        turnId: claim.turn.id,
        executionGeneration: claim.turn.executionGeneration,
        attemptId,
        callId: "pending-after-boundary",
        callType: "function_call",
        callItem: {
          type: "function_call",
          call_id: "pending-after-boundary",
          name: "test",
          arguments: "{}",
        },
      }),
    ).toMatchObject({ accepted: true, registered: true });
    expect(
      await appendSessionHistoryItems(client.db, {
        ...authority,
        items: [
          {
            position: boundary + 1,
            item: {
              type: "function_call",
              call_id: "unfinished-suffix",
              name: "test",
              arguments: "{}",
            },
          },
        ],
      }),
    ).toBe(true);
    const input = {
      sourceWorkspaceId: workspaceId,
      sourceSessionId,
      actorSubjectId: human.subjectId,
      destinationWorkspaceId: workspaceId,
      destinationVisibility: "user_private" as const,
      workspaceSharedAcknowledged: false,
      operationKey: crypto.randomUUID(),
      sourceEventId: replyEventId,
    };
    const sourceBefore =
      await shared.admin`select to_jsonb(s) as value from sessions s where id = ${sourceSessionId}`;
    const attemptBefore =
      await shared.admin`select to_jsonb(a) as value from session_turn_attempts a where id = ${attemptId}`;
    const pendingBefore =
      await shared.admin`select to_jsonb(p) as value from session_pending_tool_calls p where session_id = ${sourceSessionId}`;
    const fork = await forkSessionContent(client.db, input);
    const prefix = await shared.admin`select item_ordered::text as item, active, position
      from session_history_items where session_id = ${sourceSessionId} and position <= ${boundary} order by position`;
    const copied = await shared.admin`select item_ordered::text as item, active, position
      from session_history_items where session_id = ${fork.sessionId} order by position`;
    expect(copied).toEqual(prefix);
    expect(fork.copiedHistoryItemCount).toBe(prefix.length);
    expect(copied.at(-1)!.item).toContain('"z":1,"a":2');
    expect([
      ...(await shared.admin`select to_jsonb(s) as value from sessions s where id = ${sourceSessionId}`),
    ]).toEqual([...sourceBefore]);
    expect([
      ...(await shared.admin`select to_jsonb(a) as value from session_turn_attempts a where id = ${attemptId}`),
    ]).toEqual([...attemptBefore]);
    expect([
      ...(await shared.admin`select to_jsonb(p) as value from session_pending_tool_calls p where session_id = ${sourceSessionId}`),
    ]).toEqual([...pendingBefore]);
    expect(
      await shared.admin`select id from session_turn_attempts where session_id = ${fork.sessionId}`,
    ).toHaveLength(0);
    expect(
      await shared.admin`select id from session_pending_tool_calls where session_id = ${fork.sessionId}`,
    ).toHaveLength(0);
    await shared.admin`update session_history_items set position = -10
      where session_id = ${sourceSessionId} and position = ${boundary + 1}`;
    await expect(
      forkSessionContent(client.db, {
        ...input,
        operationKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Session tenancy request is invalid");
    await shared.admin`update session_history_items set position = ${boundary + 1}
      where session_id = ${sourceSessionId} and position = -10`;
    // A compacted suffix is not part of either earlier message's copy, even
    // while the source turn is still executing.
    await shared.admin`insert into session_history_items
      (account_id, workspace_id, session_id, turn_id, position, item, active)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${claim.turn.id}, ${boundary + 3},
        ${shared.admin.json({ type: "message", role: "user", content: "Later secret" })}, false)`;
    await shared.admin`insert into session_history_items
      (account_id, workspace_id, session_id, turn_id, position, item)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${claim.turn.id}, ${boundary + 3.5},
        ${shared.admin.json({ type: "compaction", content: "Later summary" })})`;
    const activeAnswerFork = await forkSessionContent(client.db, {
      ...input,
      operationKey: crypto.randomUUID(),
    });
    expect(activeAnswerFork.copiedHistoryItemCount).toBe(prefix.length);
    const userFork = await forkSessionContent(client.db, {
      ...input,
      sourceEventId: claim.turn.triggerEventId!,
      operationKey: crypto.randomUUID(),
    });
    expect(userFork.copiedHistoryItemCount).toBe(prefix.length - 1);
    await shared.admin`delete from session_history_items where session_id = ${sourceSessionId}
      and position in (${boundary + 3}, ${boundary + 3.5})`;
    expect(
      await appendSessionHistoryItems(client.db, {
        ...authority,
        items: [
          {
            position: boundary + 2,
            item: {
              type: "function_call_output",
              call_id: "unfinished-suffix",
              output: "continued",
            },
          },
        ],
      }),
    ).toBe(true);
    // Whole-session copying retains its stronger quiescence requirement.
    const { sourceEventId: _boundaryEvent, ...wholeSessionInput } = input;
    await expect(
      forkSessionContent(client.db, {
        ...wholeSessionInput,
        operationKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      forkSessionContent(client.db, {
        ...input,
        sourceEventId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    const stranger = await provisionManagedHuman();
    await expect(
      forkSessionContent(client.db, {
        ...input,
        actorSubjectId: stranger.subjectId,
      }),
    ).rejects.toThrow();
    // A racing compaction uses the real writer and must wait behind the fork's
    // already-held exclusive tenancy fence. No timing-only assertion is used.
    const entered = deferred();
    const release = deferred();
    let pid = 0;
    const heldFork = withRlsContext(
      client.db,
      {
        accountId: human.accountId,
        workspaceId,
      },
      async (db) => {
        await setSubjectRlsContext(db, human.subjectId);
        await db.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`session-tenancy:${workspaceId}`}, 0))`,
        );
        const backend = await db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pid = backend[0]!.pid;
        const result = await forkSessionContent(db, {
          ...input,
          operationKey: crypto.randomUUID(),
        });
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    // Surface setup failure without leaving the test waiting on a deferred.
    await Promise.race([
      entered.promise,
      heldFork.then(() => {
        throw new Error("fork did not hold transaction");
      }),
    ]);
    const compaction = applyContextCompaction(client.db, {
      ...authority,
      replacementItems: [],
      summaryItem: { type: "message", role: "assistant", content: "Compacted later content" },
    });
    try {
      await waitUntilBlockedBy(pid);
    } finally {
      release.resolve();
    }
    const stableFork = await heldFork;
    expect((await compaction).applied).toBe(true);
    expect([
      ...(await shared.admin`select item_ordered::text as item, active, position
      from session_history_items where session_id = ${stableFork.sessionId} order by position`),
    ]).toEqual([...prefix]);
    // Real compaction deactivates the entire old history and appends a new
    // model-facing summary. A subsequent completed message still has a safe
    // boundary in that current active history, even while the turn runs.
    const postCompactionMessage = crypto.randomUUID();
    const [historyTail] = await shared.admin<Array<{ position: number }>>`
      select max(position)::integer as position from session_history_items
      where session_id = ${sourceSessionId}`;
    const afterPosition = historyTail!.position + 1;
    await shared.admin`insert into session_history_items
      (account_id, workspace_id, session_id, turn_id, position, item)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${claim.turn.id}, ${afterPosition},
        ${shared.admin.json({ type: "message", role: "assistant", content: "After compaction" })})`;
    await shared.admin`insert into session_events
      (id, account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      select ${postCompactionMessage}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${claim.turn.id}, coalesce(max(sequence), 0) + 1, 'agent.message.completed',
        '{"text":"After compaction"}' from session_events where session_id = ${sourceSessionId}`;
    const postCompactionFork = await forkSessionContent(client.db, {
      ...input,
      sourceEventId: postCompactionMessage,
      operationKey: crypto.randomUUID(),
    });
    expect(postCompactionFork.copiedHistoryItemCount).toBe(2);
    const postCompactionHistory = await shared.admin<Array<{ active: boolean; item: unknown }>>`
      select active, item from session_history_items
      where session_id = ${postCompactionFork.sessionId} order by position`;
    expect(postCompactionHistory.every((row) => row.active)).toBe(true);
    expect(JSON.stringify(postCompactionHistory)).not.toContain("Retained answer");
    expect(JSON.stringify(postCompactionHistory)).toContain("After compaction");
    await expect(
      forkSessionContent(client.db, {
        ...input,
        operationKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Session tenancy request is invalid");
    expect(await forkSessionContent(client.db, input)).toEqual({ ...fork, replay: true });
  }, 180_000);

  test("message forks ignore later compaction, but reject unsafe copied history", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const workspaceId = human.personalWorkspaceId;
    const sourceSessionId = await ownedSession(human, workspaceId);
    const turnId = crypto.randomUUID();
    const userEventId = crypto.randomUUID();
    const replyEventId = crypto.randomUUID();
    await shared.admin`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend
    ) values (${turnId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
      ${userEventId}, 'prefix-compaction-fork-test', 'completed', 1,
      'Earlier question', 'test-model', 'medium', 'none')`;
    for (const [index, event] of [
      { id: userEventId, type: "user.message", text: "Earlier question" },
      { id: replyEventId, type: "agent.message.completed", text: "Earlier answer" },
    ].entries()) {
      await shared.admin`insert into session_events
        (id, account_id, workspace_id, session_id, turn_id, sequence, type, payload)
        values (${event.id}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
          ${turnId}, ${index + 1}, ${event.type}, ${shared.admin.json({ text: event.text })})`;
      await shared.admin`insert into session_history_items
        (account_id, workspace_id, session_id, turn_id, position, item)
        values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
          ${turnId}, ${index + 1}, ${shared.admin.json({
            type: "message",
            role: index === 0 ? "user" : "assistant",
            content: event.text,
          })})`;
    }
    // A later compaction supersedes only the suffix. Neither the inactive row
    // nor its summary can appear in a fork through the earlier messages.
    await shared.admin`insert into session_history_items
      (account_id, workspace_id, session_id, turn_id, position, item, active)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${turnId}, 3, ${shared.admin.json({ type: "message", role: "user", content: "Later secret" })}, false)`;
    await shared.admin`insert into session_history_items
      (account_id, workspace_id, session_id, turn_id, position, item)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${turnId}, 3.5, ${shared.admin.json({ type: "compaction", content: "Later summary" })})`;
    const fork = (sourceEventId: string, operationKey = crypto.randomUUID()) =>
      forkSessionContent(client!.db, {
        sourceWorkspaceId: workspaceId,
        sourceSessionId,
        actorSubjectId: human.subjectId,
        destinationWorkspaceId: workspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        sourceEventId,
        operationKey,
      });
    for (const eventId of [userEventId, replyEventId]) {
      const idleFork = await fork(eventId);
      expect(idleFork.copiedHistoryItemCount).toBe(eventId === userEventId ? 1 : 2);
      const rows = await shared.admin`select item from session_history_items
        where session_id = ${idleFork.sessionId} order by position`;
      expect(rows).toHaveLength(idleFork.copiedHistoryItemCount);
      expect(JSON.stringify(rows)).not.toContain("Later secret");
      expect(JSON.stringify(rows)).not.toContain("Later summary");
    }
    await shared.admin`update session_history_items set active = false
      where session_id = ${sourceSessionId} and position = 1`;
    await expect(fork(replyEventId)).rejects.toThrow("Session tenancy request is invalid");
    await expect(fork(userEventId)).rejects.toThrow("Session tenancy request is invalid");
    // Model-facing history after an actual compaction consists of new active
    // rows, while every older row is inactive. Its receipt authenticates the
    // opaque checkpoint, and both later user/assistant boundaries can copy it.
    await shared.admin`update session_history_items set active = false
      where session_id = ${sourceSessionId}`;
    await shared.admin`insert into session_history_items
      (account_id, workspace_id, session_id, turn_id, position, item)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, 4,
        ${shared.admin.json({ type: "compaction", encrypted_content: "checkpoint" })})`;
    const compactedEventId = crypto.randomUUID();
    await shared.admin`insert into session_events
      (id, account_id, workspace_id, session_id, turn_id, sequence, type, payload)
      values (${compactedEventId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
        ${turnId}, 3, 'session.context.compacted', ${shared.admin.json({ summaryPosition: 4 })})`;
    const nextTurnId = crypto.randomUUID();
    const nextUserEventId = crypto.randomUUID();
    const nextReplyEventId = crypto.randomUUID();
    await shared.admin`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend
    ) values (${nextTurnId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
      ${nextUserEventId}, 'prefix-compaction-next-turn', 'completed', 2,
      'Later question', 'test-model', 'medium', 'none')`;
    for (const [index, event] of [
      { id: nextUserEventId, type: "user.message", text: "Later question" },
      { id: nextReplyEventId, type: "agent.message.completed", text: "Later answer" },
    ].entries()) {
      await shared.admin`insert into session_events
        (id, account_id, workspace_id, session_id, turn_id, sequence, type, payload)
        values (${event.id}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
          ${nextTurnId}, ${index + 4}, ${event.type}, ${shared.admin.json({ text: event.text })})`;
      await shared.admin`insert into session_history_items
        (account_id, workspace_id, session_id, turn_id, position, item)
        values (${human.accountId}, ${workspaceId}, ${sourceSessionId},
          ${nextTurnId}, ${index + 5}, ${shared.admin.json({
            type: "message",
            role: index === 0 ? "user" : "assistant",
            content: event.text,
          })})`;
    }
    for (const eventId of [nextUserEventId, nextReplyEventId]) {
      const compactedFork = await fork(eventId);
      expect(compactedFork.copiedHistoryItemCount).toBe(eventId === nextUserEventId ? 2 : 3);
      const rows = await shared.admin<Array<{ active: boolean; item: unknown }>>`
        select active, item from session_history_items
        where session_id = ${compactedFork.sessionId} order by position`;
      expect(rows.every((row) => row.active)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain("Earlier answer");
      expect(JSON.stringify(rows)).not.toContain("Later secret");
    }
    await shared.admin`delete from session_events where id = ${compactedEventId}`;
    await expect(fork(nextReplyEventId)).rejects.toThrow("Session tenancy request is invalid");
  }, 180_000);

  test("message fork copies the exact prefix and replays the same boundary", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const workspaceId = human.personalWorkspaceId;
    const sourceSessionId = await ownedSession(human, workspaceId);
    const turnId = crypto.randomUUID();
    const userEventId = crypto.randomUUID();
    const replyEventId = crypto.randomUUID();
    await shared.admin`insert into session_turns (
      id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
      status, position, prompt, model, reasoning_effort, sandbox_backend
    ) values (${turnId}, ${human.accountId}, ${workspaceId}, ${sourceSessionId},
      ${userEventId}, 'message-fork-test', 'completed', 1, 'First question', 'test-model', 'medium', 'none')`;
    for (const [index, event] of [
      { id: userEventId, type: "user.message", text: "First question" },
      { id: replyEventId, type: "agent.message.completed", text: "First answer" },
    ].entries()) {
      await shared.admin`insert into session_events (id, account_id, workspace_id, session_id, turn_id, sequence, type, payload)
        values (${event.id}, ${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, ${index + 1}, ${event.type}, ${shared.admin.json({ text: event.text })})`;
    }
    for (const [index, item] of [
      { type: "message", role: "user", content: [{ type: "input_text", text: "First question" }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Later answer must not be copied" }],
      },
    ].entries()) {
      await shared.admin`insert into session_history_items (account_id, workspace_id, session_id, turn_id, position, item)
        values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, ${index + 1}, ${shared.admin.json(item)})`;
    }
    const input = {
      sourceWorkspaceId: workspaceId,
      sourceSessionId,
      actorSubjectId: human.subjectId,
      destinationWorkspaceId: workspaceId,
      destinationVisibility: "user_private" as const,
      workspaceSharedAcknowledged: false,
      operationKey: crypto.randomUUID(),
      sourceEventId: replyEventId,
    };
    const fork = await forkSessionContent(client.db, input);
    expect(fork.copiedHistoryItemCount).toBe(2);
    const rows =
      await shared.admin`select item from session_history_items where session_id = ${fork.sessionId} order by position`;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("Later answer");
    expect((await forkSessionContent(client.db, input)).sessionId).toBe(fork.sessionId);
    await expect(
      forkSessionContent(client.db, { ...input, sourceEventId: userEventId }),
    ).rejects.toThrow();
    const userFork = await forkSessionContent(client.db, {
      ...input,
      sourceEventId: userEventId,
      operationKey: crypto.randomUUID(),
    });
    expect(userFork.copiedHistoryItemCount).toBe(1);
    await expect(
      forkSessionContent(client.db, {
        ...input,
        sourceEventId: crypto.randomUUID(),
        operationKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    // Exercise persisted SDK identities, provider identities, and all supported tool pairs.
    const completedPairs: [postgres.JSONValue, postgres.JSONValue][] = [
      [
        { type: "function_call", callId: "fn", name: "test", arguments: "{}" },
        { type: "function_call_result", callId: "fn", name: "test", output: "done" },
      ],
      [
        { type: "computer_call", callId: "pc", action: { type: "screenshot" } },
        { type: "computer_call_result", callId: "pc", output: "done" },
      ],
      [
        { type: "shell_call", call_id: "sh" },
        { type: "shell_call_output", call_id: "sh", output: [] },
      ],
      [
        { type: "apply_patch_call", id: "patch" },
        { type: "apply_patch_call_output", callId: "patch", output: "done" },
      ],
      [
        { type: "tool_search_call", id: "item-search", providerData: { call_id: "search" } },
        { type: "tool_search_output", providerData: { callId: "search" }, tools: [] },
      ],
    ];
    for (const [call, result] of completedPairs) {
      await shared.admin`insert into session_history_items (account_id, workspace_id, session_id, turn_id, position, item)
        values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, -2, ${shared.admin.json(call)})`;
      await expect(
        forkSessionContent(client.db, { ...input, operationKey: crypto.randomUUID() }),
      ).rejects.toThrow();
      // A matching result before its call cannot settle this prefix.
      await shared.admin`insert into session_history_items (account_id, workspace_id, session_id, turn_id, position, item)
        values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, -3, ${shared.admin.json(result)})`;
      await expect(
        forkSessionContent(client.db, { ...input, operationKey: crypto.randomUUID() }),
      ).rejects.toThrow();
      await shared.admin`update session_history_items set position = -1 where session_id = ${sourceSessionId} and position = -3`;
      const pairedFork = await forkSessionContent(client.db, {
        ...input,
        operationKey: crypto.randomUUID(),
      });
      expect(pairedFork.copiedHistoryItemCount).toBe(4);
      await shared.admin`delete from session_history_items where session_id = ${sourceSessionId} and position < 0`;
    }
    await shared.admin`insert into session_history_items (account_id, workspace_id, session_id, turn_id, position, item)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, 0,
        ${shared.admin.json({ type: "function_call", call_id: "unfinished", name: "test", arguments: "{}" })})`;
    await expect(
      forkSessionContent(client.db, { ...input, operationKey: crypto.randomUUID() }),
    ).rejects.toThrow();
    await shared.admin`delete from session_history_items where session_id = ${sourceSessionId} and position = 0`;
    await shared.admin`insert into session_history_items (account_id, workspace_id, session_id, turn_id, position, item)
      values (${human.accountId}, ${workspaceId}, ${sourceSessionId}, ${turnId}, 4,
        ${shared.admin.json({ type: "message", role: "assistant", content: [{ type: "output_text", text: "First answer" }] })})`;
    await expect(
      forkSessionContent(client.db, { ...input, operationKey: crypto.randomUUID() }),
    ).rejects.toThrow();
    await shared.admin`delete from session_history_items where session_id = ${sourceSessionId} and position = 4`;
    const [count] =
      await shared.admin`select count(*)::integer as total from sessions where forked_from_session_id = ${sourceSessionId}`;
    expect(count?.total).toBe(2 + completedPairs.length);
    await shared.admin`update session_history_items set active = false where session_id = ${sourceSessionId} and position = 1`;
    await expect(
      forkSessionContent(client.db, { ...input, operationKey: crypto.randomUUID() }),
    ).rejects.toThrow();
    // An already committed receipt remains recoverable after source compaction.
    expect((await forkSessionContent(client.db, input)).sessionId).toBe(fork.sessionId);
  }, 180_000);

  test("fork_session_content accepts the owner's own personal workspace as source", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.personalWorkspaceId);

    const result = await forkSessionContent(client.db, {
      sourceWorkspaceId: human.personalWorkspaceId,
      sourceSessionId: sessionId,
      actorSubjectId: human.subjectId,
      destinationWorkspaceId: human.personalWorkspaceId,
      destinationVisibility: "user_private",
      workspaceSharedAcknowledged: false,
      operationKey: `fork-${crypto.randomUUID()}`,
    });
    expect(result.visibility).toBe("user_private");
    expect(result.eventId).toBeString();
    expect(result.eventSequence).toBe(1);
  }, 180_000);

  test("the same operations succeed in an ordinary workspace, so the seam is not simply broken", async () => {
    if (!shared || !client) return;
    const human = await provisionManagedHuman();
    const sessionId = await ownedSession(human, human.legacyWorkspaceId);

    const result = await transitionSessionVisibility(client.db, {
      workspaceId: human.legacyWorkspaceId,
      sessionId,
      actorSubjectId: human.subjectId,
      targetVisibility: "user_private",
      expectedAuthorityEpoch: 1,
      operationKey: `visibility-${crypto.randomUUID()}`,
    });
    expect(result.visibility).toBe("user_private");
    expect(result.ownerOrganizationMembershipId).toBe(human.organizationMembershipId);
  }, 180_000);

  test("another human never transitions a session in someone else's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    const sessionId = await ownedSession(owner, owner.personalWorkspaceId);

    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: owner.personalWorkspaceId,
        sessionId,
        actorSubjectId: intruder.subjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `visibility-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("another human never forks out of someone else's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    const sessionId = await ownedSession(owner, owner.personalWorkspaceId);

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: owner.personalWorkspaceId,
        sourceSessionId: sessionId,
        actorSubjectId: intruder.subjectId,
        destinationWorkspaceId: intruder.personalWorkspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: `fork-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("nobody forks INTO another human's personal workspace", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const intruder = await provisionManagedHuman();
    const sessionId = await ownedSession(intruder, intruder.personalWorkspaceId);

    await expect(
      forkSessionContent(client.db, {
        sourceWorkspaceId: intruder.personalWorkspaceId,
        sourceSessionId: sessionId,
        actorSubjectId: intruder.subjectId,
        destinationWorkspaceId: owner.personalWorkspaceId,
        destinationVisibility: "user_private",
        workspaceSharedAcknowledged: false,
        operationKey: `fork-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);

  test("an ordinary workspace with no membership row still denies the human", async () => {
    if (!shared || !client) return;
    const owner = await provisionManagedHuman();
    const stranger = await provisionManagedHuman();
    // The stranger's LEGACY workspace is an ordinary workspace, not anyone's
    // personal-workspace pointer, so the pointer disjunct must not reach it.
    const sessionId = await ownedSession(stranger, stranger.legacyWorkspaceId);

    await expect(
      transitionSessionVisibility(client.db, {
        workspaceId: stranger.legacyWorkspaceId,
        sessionId,
        actorSubjectId: owner.subjectId,
        targetVisibility: "user_private",
        expectedAuthorityEpoch: 1,
        operationKey: `visibility-${crypto.randomUUID()}`,
      }),
    ).rejects.toThrow();
  }, 180_000);
});
