import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  createDb,
  createSession,
  createSessionWithIdempotencyKey,
  ensureManagedAccessForUser,
  forkSessionContent,
  getSessionEventForSubject,
  getSessionForSubject,
  grantWorkspaceAccess,
  nestedPostgresSqlState,
  openPrivateSessionCreateCapability,
  removeWorkspaceMember,
  setSubjectRlsContext,
  transitionSessionVisibility,
  withRlsContext,
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
