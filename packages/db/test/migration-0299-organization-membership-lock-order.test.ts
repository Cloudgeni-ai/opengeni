import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type postgres from "postgres";
import {
  acceptOrganizationInvitation,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  listSelfOrganizationMemberships,
  nestedPostgresSqlState,
  transitionSessionVisibility,
  updateOrganizationMember,
  type DbClient,
} from "../src";

// Before migration 0299 the organization membership lifecycle locked
// `managed_accounts` FOR UPDATE and only then reached for `workspaces`, while
// every ordinary workspace writer locks its `workspaces` row first and then
// reaches `managed_accounts` implicitly through the account FK check of a row it
// inserts. `FOR KEY SHARE` (what an FK check takes) conflicts with `FOR UPDATE`,
// so the two orders formed a cycle and Postgres aborted one side with 40P01:
//
//   ordinary workspace writer       holds workspaces       waits managed_accounts
//   prepare_organization_membership holds managed_accounts waits workspaces
//
// 0299 replaces the organization-row `FOR UPDATE` with a transaction-scoped
// advisory lock keyed on the organization id and downgrades the row lock to
// `FOR KEY SHARE`.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const lifecycleSignatures = [
  "prepare_organization_membership_protocol_settlements(jsonb)",
  "organization_membership_command_0263(jsonb)",
  "organization_membership_command(jsonb)",
] as const;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0299-organization-membership-lock-order");
  if (!shared && requireRealDatabase) {
    throw new Error("migration 0299 requires PostgreSQL");
  }
  if (shared) client = createDb(shared.appUrl, { max: 12 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

/**
 * Wait until at least `expected` backends in this database are blocked on the
 * given lock class, or fail. Bounded, and deliberately not a bare sleep: the
 * next step of each probe is only meaningful once the other side has genuinely
 * parked on its lock.
 */
async function waitForBlockedBackends(
  admin: postgres.Sql,
  lockType: "relation" | "transactionid" | "tuple" | "advisory",
  expected = 1,
): Promise<void> {
  // The pgvector container is shared by every parallel test file, so scope the
  // observation to this file's own database through the waiting backend.
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const rows = await admin<Array<{ blocked: number }>>`
      select count(*)::int as blocked
      from pg_locks lock_row
      join pg_stat_activity activity on activity.pid = lock_row.pid
      where not lock_row.granted
        and lock_row.locktype = ${lockType}
        and activity.datname = current_database()`;
    if ((rows[0]?.blocked ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`no backend parked on a ${lockType} lock within the probe window`);
}

/**
 * PostgreSQL's own deadlock counter for this database. Client SQLSTATEs can be
 * swallowed by a bounded application-level `40P01` replay (see PR #1594), so the
 * regression evidence is taken from the server, which counts the cycle whether
 * or not anybody retried it.
 */
async function deadlockCount(admin: postgres.Sql): Promise<number> {
  const [row] = await admin<Array<{ deadlocks: number }>>`
    select deadlocks::int as deadlocks
    from pg_stat_database
    where datname = current_database()`;
  return row?.deadlocks ?? 0;
}

async function provisionOrganization() {
  if (!client || !shared) throw new Error("test database unavailable");
  const ownerId = `lockorder-owner-${crypto.randomUUID()}`;
  const targetId = `lockorder-target-${crypto.randomUUID()}`;
  const ownerSubject = `user:${ownerId}`;
  const targetSubject = `user:${targetId}`;
  await ensureManagedAccessForUser(client.db, {
    userId: ownerId,
    email: `${ownerId}@example.test`,
    name: ownerId,
  });
  const [owner] = await listSelfOrganizationMemberships(client.db, ownerSubject);
  const organizationId = owner!.organizationId;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId,
    actorSubjectId: ownerSubject,
    operationId: crypto.randomUUID(),
    targetSubjectId: targetSubject,
    targetEmail: `${targetId}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const member = (
    await acceptOrganizationInvitation(client.db, {
      organizationId,
      actorSubjectId: targetSubject,
      operationId: crypto.randomUUID(),
      invitationId: invitation.id,
      expectedRevision: invitation.revision,
    })
  ).membership;
  const workspaceId = crypto.randomUUID();
  await shared.admin`
    insert into workspaces (id, account_id, name, external_source, external_id)
    values (${workspaceId}, ${organizationId}, 'Lock order shared', 'test', ${crypto.randomUUID()})`;
  await shared.admin`
    insert into workspace_inference_controls (account_id, workspace_id)
    values (${organizationId}, ${workspaceId})`;
  await shared.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role)
    values
      (${organizationId}, ${workspaceId}, ${ownerSubject}, 'owner'),
      (${organizationId}, ${workspaceId}, ${targetSubject}, 'member')`;
  return { organizationId, ownerSubject, targetSubject, member, workspaceId };
}

async function createOwnedSession(input: {
  organizationId: string;
  workspaceId: string;
  ownerSubject: string;
}): Promise<string> {
  if (!client) throw new Error("test database unavailable");
  const session = await createSession(client.db, {
    accountId: input.organizationId,
    workspaceId: input.workspaceId,
    initialMessage: "lock order probe",
    resources: [],
    metadata: {},
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    createdBy: { kind: "subject", subjectId: input.ownerSubject },
    subjectId: input.ownerSubject,
    model: "test-model",
    sandboxBackend: "none",
  });
  return session.id;
}

describe("migration 0299 organization membership lock order", () => {
  test(
    "every membership lifecycle entry point takes the advisory organization fence " +
      "instead of a conflicting managed_accounts row lock",
    async () => {
      if (!shared) return;
      for (const signature of lifecycleSignatures) {
        const [row] = await shared.admin<Array<{ definition: string | null }>>`
          select pg_get_functiondef(to_regprocedure(${signature})) as definition`;
        const definition = row?.definition;
        expect(definition).toBeTruthy();
        expect(definition).toContain(
          "pg_advisory_xact_lock(pg_catalog.hashtextextended(\n    'organization-membership:' || account_id_value::text, 0\n  ))",
        );
        expect(definition).toContain("FROM managed_accounts account");
        // The organization row lock must never conflict with the FK
        // `FOR KEY SHARE` an ordinary workspace writer takes on the same row.
        expect(/FROM managed_accounts account[^;]*FOR UPDATE/.test(definition!)).toBe(false);
      }
    },
    180_000,
  );

  test(
    "downgrading the organization row lock changes no row visibility under a " +
      "NOSUPERUSER NOBYPASSRLS reader",
    async () => {
      if (!shared) return;
      // The harness migrates as superuser, where FORCE RLS never engages, so
      // assert the one property the downgrade could in principle have moved -
      // which rows the lifecycle can see - against a role that RLS genuinely
      // applies to. PostgreSQL evaluates the same SELECT + UPDATE policy set for
      // every row-locking clause, so `FOR KEY SHARE` and `FOR UPDATE` are
      // visibility-identical; this pins that rather than assuming it.
      const [posture] = await shared.admin<Array<{ enabled: boolean; forced: boolean }>>`
        select relrowsecurity as enabled, relforcerowsecurity as forced
        from pg_class where oid = 'managed_accounts'::regclass`;
      const probeRole = `lock_order_probe_${crypto.randomUUID().replaceAll("-", "_")}`;
      const probe = await shared.admin.reserve();
      try {
        await shared.admin.unsafe(`CREATE ROLE ${probeRole} NOSUPERUSER NOBYPASSRLS NOLOGIN`);
        // `FOR UPDATE` needs UPDATE (or SELECT FOR UPDATE) privilege; grant both
        // so privilege, not policy, is never the reason the two differ.
        await shared.admin.unsafe(`GRANT SELECT, UPDATE ON managed_accounts TO ${probeRole}`);
        await probe`begin`;
        await probe.unsafe(`set local role ${probeRole}`);
        const [keyShare] = await probe<Array<{ visible: number }>>`
          select count(*)::int as visible
          from (select 1 from managed_accounts for key share) locked`;
        const [forUpdate] = await probe<Array<{ visible: number }>>`
          select count(*)::int as visible
          from (select 1 from managed_accounts for update) locked`;
        const [plain] = await probe<Array<{ visible: number }>>`
          select count(*)::int as visible from managed_accounts`;
        await probe`rollback`;
        expect(keyShare!.visible).toBe(forUpdate!.visible);
        expect(keyShare!.visible).toBe(plain!.visible);
        // `managed_accounts` carries no row policy at all today, which is why
        // the downgrade cannot move visibility. If that ever changes, this
        // assertion is the prompt to re-derive the claim above rather than
        // assume it.
        expect(posture).toMatchObject({ enabled: false, forced: false });
      } finally {
        await probe`rollback`.catch(() => undefined);
        probe.release();
        await shared.admin
          .unsafe(`REVOKE ALL ON managed_accounts FROM ${probeRole}`)
          .catch(() => undefined);
        await shared.admin.unsafe(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => undefined);
      }
    },
    180_000,
  );

  test("an ordinary workspace-row holder and a membership suspend no longer form a cycle", async () => {
    if (!shared || !client) return;
    const org = await provisionOrganization();
    // Exactly the first row lock a live workspace-scoped lifecycle function
    // such as `confirm_remember_knowledge_claim` (0274) takes.
    const holder = await shared.admin.reserve();
    let holderSqlState: string | null = null;
    let lifecycleFailure: unknown;
    const deadlocksBefore = await deadlockCount(shared.admin);
    try {
      await holder`begin`;
      await holder`select 1 from workspaces where id = ${org.workspaceId} for update`;

      const lifecycle = updateOrganizationMember(client.db, {
        organizationId: org.organizationId,
        actorSubjectId: org.ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: org.member.id,
        transition: {
          kind: "suspend",
          expectedAuthorizationRevision: org.member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }).catch((error: unknown) => {
        lifecycleFailure = error;
        return null;
      });

      // The lifecycle now parks on `workspaces FOR KEY SHARE`.
      await waitForBlockedBackends(shared.admin, "transactionid");

      // Exactly the FK check every ordinary session/event/turn insert performs.
      try {
        await holder`select 1 from managed_accounts where id = ${org.organizationId} for key share`;
      } catch (error) {
        holderSqlState = nestedPostgresSqlState(error);
      }
      await holder`commit`.catch(() => undefined);
      const settled = await lifecycle;

      expect(holderSqlState).toBeNull();
      expect(lifecycleFailure).toBeUndefined();
      expect(settled?.status).toBe("suspended");
      expect(await deadlockCount(shared.admin)).toBe(deadlocksBefore);
    } finally {
      await holder`rollback`.catch(() => undefined);
      holder.release();
    }
  }, 180_000);

  test("concurrent membership transitions and session-visibility writers never deadlock", async () => {
    if (!shared || !client) return;
    const org = await provisionOrganization();
    const iterations = 24;
    const visibilityWritersPerIteration = 3;
    let revision = org.member.authorizationRevision;
    let suspended = false;
    let deadlocks = 0;
    const deadlocksBefore = await deadlockCount(shared.admin);
    const observedStates = new Map<string, number>();
    const note = (state: string | null) => {
      if (!state) return;
      observedStates.set(state, (observedStates.get(state) ?? 0) + 1);
      if (state === "40P01") deadlocks += 1;
    };

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const sessionIds = await Promise.all(
        Array.from({ length: visibilityWritersPerIteration }, () =>
          createOwnedSession({
            organizationId: org.organizationId,
            workspaceId: org.workspaceId,
            ownerSubject: org.ownerSubject,
          }),
        ),
      );
      const kind = suspended ? ("reactivate" as const) : ("suspend" as const);
      const results = await Promise.allSettled([
        updateOrganizationMember(client.db, {
          organizationId: org.organizationId,
          actorSubjectId: org.ownerSubject,
          operationId: crypto.randomUUID(),
          membershipId: org.member.id,
          transition: {
            kind,
            expectedAuthorizationRevision: revision,
            operationId: crypto.randomUUID(),
          },
        }),
        ...sessionIds.map((sessionId) =>
          transitionSessionVisibility(client!.db, {
            workspaceId: org.workspaceId,
            sessionId,
            actorSubjectId: org.ownerSubject,
            targetVisibility: "user_private",
            expectedAuthorityEpoch: 1,
            operationKey: `lock-order:${crypto.randomUUID()}`,
          }),
        ),
      ]);
      const membershipResult = results[0]!;
      if (membershipResult.status === "fulfilled") {
        revision = membershipResult.value.authorizationRevision;
        suspended = !suspended;
      } else {
        note(nestedPostgresSqlState(membershipResult.reason));
      }
      for (const result of results.slice(1)) {
        if (result.status === "rejected") note(nestedPostgresSqlState(result.reason));
      }
    }

    const serverDeadlocks = (await deadlockCount(shared.admin)) - deadlocksBefore;
    const summary = [...observedStates.entries()]
      .map(([state, count]) => `${state}=${count}`)
      .sort()
      .join(" ");
    console.log(
      `[membership lock order] ${iterations} iterations x ${visibilityWritersPerIteration} concurrent ` +
        `visibility writers: clientDeadlocks=${deadlocks} serverDeadlocks=${serverDeadlocks} ` +
        `states={${summary}}`,
    );
    expect(serverDeadlocks).toBe(0);
    expect(deadlocks).toBe(0);
  }, 600_000);

  test("the advisory organization fence still serializes concurrent membership commands", async () => {
    if (!shared || !client) return;
    const org = await provisionOrganization();
    const fence = await shared.admin.reserve();
    let settled = false;
    let fenceBackendPid = 0;
    try {
      await fence`begin`;
      const [fenceBackend] = await fence<Array<{ pid: number }>>`
          select pg_backend_pid()::int as pid`;
      fenceBackendPid = fenceBackend!.pid;
      await fence`select pg_advisory_xact_lock(hashtextextended(
          ${`organization-membership:${org.organizationId}`}, 0))`;

      const command = updateOrganizationMember(client.db, {
        organizationId: org.organizationId,
        actorSubjectId: org.ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: org.member.id,
        transition: {
          kind: "change_role",
          role: "admin",
          expectedAuthorizationRevision: org.member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      });
      const observed = command.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );

      // The command must be parked on exactly the advisory key this fence
      // holds, not on some other lock that merely happens to be contended.
      await waitForBlockedBackends(shared.admin, "advisory");
      const [match] = await shared.admin<Array<{ matching: number }>>`
          select count(*)::int as matching
          from pg_locks waiting
          join pg_stat_activity waiter on waiter.pid = waiting.pid
          join pg_locks held
            on held.locktype = 'advisory'
            and held.granted
            and held.classid = waiting.classid
            and held.objid = waiting.objid
            and held.objsubid = waiting.objsubid
          join pg_stat_activity holder on holder.pid = held.pid
          where waiting.locktype = 'advisory'
            and not waiting.granted
            and waiter.datname = current_database()
            and holder.datname = current_database()
            and held.pid = ${fenceBackendPid}`;
      expect(match?.matching).toBeGreaterThanOrEqual(1);
      expect(settled).toBe(false);

      await fence`commit`;
      const updated = await observed;
      expect(updated.role).toBe("admin");
    } finally {
      await fence`rollback`.catch(() => undefined);
      fence.release();
    }
  }, 180_000);

  test("CAS still rejects the losing side of two concurrent transitions", async () => {
    if (!client) return;
    const org = await provisionOrganization();
    const concurrent = await Promise.allSettled([
      updateOrganizationMember(client.db, {
        organizationId: org.organizationId,
        actorSubjectId: org.ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: org.member.id,
        transition: {
          kind: "change_role",
          role: "admin",
          expectedAuthorizationRevision: org.member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }),
      updateOrganizationMember(client.db, {
        organizationId: org.organizationId,
        actorSubjectId: org.ownerSubject,
        operationId: crypto.randomUUID(),
        membershipId: org.member.id,
        transition: {
          kind: "change_role",
          role: "member",
          expectedAuthorizationRevision: org.member.authorizationRevision,
          operationId: crypto.randomUUID(),
        },
      }),
    ]);
    expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = concurrent.find((result) => result.status === "rejected");
    expect(nestedPostgresSqlState((rejected as PromiseRejectedResult).reason)).toBe("40001");
  }, 180_000);
});
